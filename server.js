// MirNin Monitor — multi-country, multi-ISP reachability monitoring.
// Zero-dependency Node.js server: REST API + SSE live stream + static dashboard.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { Store, locKey, parseLocKey } from './lib/store.js';
import { Scheduler } from './lib/scheduler.js';
import { Alerter } from './lib/alerts.js';
import { globalpingStatus } from './lib/checker.js';
import { classifyWith, validateRules, effectiveRules, rulesProvenance, DEFAULT_RULES } from './lib/rules.js';
import { CHECK_TYPES } from './lib/linkchecks.js';
import { COUNTRIES, isValidCountry } from './lib/countries.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 4000);
const DAY = 24 * 60 * 60 * 1000;

const store = new Store(process.env.DATA_DIR ?? join(ROOT, 'data'));
const sseClients = new Set();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

const alerter = new Alerter(store);

const scheduler = new Scheduler(
  store,
  alerter,
  (target, results) => broadcast('result', {
    targetId: target.id,
    nextRunAt: scheduler.getNextRunAt(target.id),
    results: results.map(({ key, entry }) => ({
      key, entry,
      uptime24h: store.uptime(target.id, key, DAY),
    })),
  }),
  (target, incident) => broadcast('incident', { targetId: target.id, incidentId: incident.id }),
);

// --- auth --------------------------------------------------------------------
// Enabled by setting ADMIN_PASSWORD. Sessions are HMAC-signed expiry cookies;
// the signing secret is generated once and persisted under data/.

const AUTH_ENABLED = Boolean(process.env.ADMIN_PASSWORD);
const SECRET_PATH = join(process.env.DATA_DIR ?? join(ROOT, 'data'), '.session-secret');
let sessionSecret;
if (existsSync(SECRET_PATH)) sessionSecret = readFileSync(SECRET_PATH, 'utf8');
else { sessionSecret = randomBytes(32).toString('hex'); writeFileSync(SECRET_PATH, sessionSecret, { mode: 0o600 }); }

const sign = (exp) => createHmac('sha256', sessionSecret).update(String(exp)).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function hasValidSession(req) {
  const cookie = /(?:^|;\s*)mm_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  if (!cookie) return false;
  const [exp, sig] = cookie.split('.');
  return Boolean(exp && sig) && Number(exp) > Date.now() && safeEqual(sig, sign(exp));
}

const PUBLIC_API = new Set(['/api/login', '/api/healthz']);

// --- validation --------------------------------------------------------------

const MIN_INTERVAL = 30;

function parseLocations(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 30) return null;
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const country = String(item?.country ?? '').toUpperCase().trim();
    if (!isValidCountry(country)) return null;
    let isp = item?.isp == null ? null : String(item.isp).trim().slice(0, 60);
    if (isp === '' || country === 'LOCAL') isp = null;
    const key = locKey({ country, isp });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ country, isp });
  }
  return out.length ? out : null;
}

function validateTarget(body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 60) errors.push('name is required (max 60 characters)');
    else out.name = name;
  }
  if (body.url !== undefined || !partial) {
    let u;
    try { u = new URL(String(body.url ?? '')); } catch { /* handled below */ }
    if (!u || !['http:', 'https:'].includes(u.protocol)) errors.push('url must start with http:// or https://');
    else out.url = u.href;
  }
  if (body.intervalSeconds !== undefined || !partial) {
    const n = Number(body.intervalSeconds);
    if (!Number.isInteger(n) || n < MIN_INTERVAL || n > 86400) {
      errors.push(`intervalSeconds must be between ${MIN_INTERVAL} and 86400`);
    } else out.intervalSeconds = n;
  }
  const checkType = body.checkType ?? (partial ? undefined : 'http');
  if (checkType !== undefined) {
    if (!Object.hasOwn(CHECK_TYPES, checkType)) errors.push('unknown checkType');
    else out.checkType = checkType;
  }
  const effectiveType = out.checkType ?? checkType ?? 'http';
  if (effectiveType === 'http') {
    if (body.locations !== undefined || !partial) {
      const locations = parseLocations(body.locations);
      if (!locations) errors.push('locations must be a non-empty list of {country, isp?} with known country codes');
      else out.locations = locations;
    }
  } else {
    // non-http checks run domain-wide from a single vantage
    out.locations = [{ country: 'GLOBAL', isp: null }];
    if (body.expectedFinalUrl !== undefined) {
      const s = String(body.expectedFinalUrl ?? '').trim().slice(0, 500);
      out.expectedFinalUrl = s === '' ? null : s;
    }
    if (body.expectParams !== undefined) {
      out.expectParams = String(body.expectParams ?? '').slice(0, 200) || null;
    }
  }
  if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);
  if (body.categoryId !== undefined) {
    if (!store.config.categories.some((c) => c.id === body.categoryId)) errors.push('unknown category');
    else out.categoryId = body.categoryId;
  }
  if (body.rules !== undefined) {
    const r = validateRules(body.rules ?? {});
    errors.push(...r.errors);
    if (r.errors.length === 0) {
      const cleaned = Object.fromEntries(Object.entries(r.out).filter(([, v]) => v !== null));
      out.rules = Object.keys(cleaned).length ? cleaned : null;
    }
  }
  if (body.expectText !== undefined) {
    const s = String(body.expectText ?? '').slice(0, 200);
    out.expectText = s.trim() === '' ? null : s;
  }
  return { errors, out };
}

// --- rules reclassification --------------------------------------------------

// Entry -> raw facts for re-classification. The synthetic content-mismatch
// message must not read as a network error, and 'unknown' stays unknown.
function outcomeOf(e) {
  return {
    unknown: e.status === 'unknown',
    error: e.contentOk === false && e.error === 'expected content not found in response' ? null : e.error,
    httpCode: e.httpCode, ms: e.ms, contentOk: e.contentOk,
  };
}

function reclassify(targetIds = null) {
  for (const t of store.config.targets) {
    if (targetIds && !targetIds.has(t.id)) continue;
    if (t.checkType && t.checkType !== 'http') continue; // link checks self-classify
    const rules = store.effectiveRulesFor(t);
    store.reclassifyTarget(t.id, (key, e) => classifyWith(outcomeOf(e), rules, store.baseline7d(t.id, key)));
  }
}

// --- API ---------------------------------------------------------------------

function stateSnapshot() {
  const s = store.config.settings;
  return {
    countries: COUNTRIES,
    checkTypes: CHECK_TYPES,
    authEnabled: AUTH_ENABLED,
    defaultRules: DEFAULT_RULES,
    // a project inherits from global; a category from global + its project
    projects: store.config.projects.map((p) => ({
      ...p, inheritedRules: effectiveRules(store.config.settings.rules),
    })),
    categories: store.config.categories.map((c) => ({
      ...c,
      inheritedRules: effectiveRules(store.config.settings.rules,
        store.config.projects.find((p) => p.id === c.projectId)?.rules),
    })),
    settings: {
      ...s,
      // never echo the full token back to the browser
      globalpingToken: s.globalpingToken ? '••••' + s.globalpingToken.slice(-4) : null,
    },
    globalping: globalpingStatus(),
    targets: store.config.targets.map((t) => ({
      ...t,
      effectiveRules: store.effectiveRulesFor(t),
      // what the target would inherit if it had no overrides of its own —
      // the admin form shows these as placeholders
      inheritedRules: effectiveRules(store.config.settings.rules,
        store.projectOf(t)?.rules, store.categoryOf(t)?.rules),
      rulesProvenance: rulesProvenance([
        { label: 'global', rules: store.config.settings.rules },
        ...store.ruleLayers(t),
      ]),
      nextRunAt: scheduler.getNextRunAt(t.id),
      incidents: store.incidentsFor(t.id, 12),
      results: Object.fromEntries(t.locations.map((loc) => {
        const key = locKey(loc);
        return [key, {
          loc,
          history: store.history(t.id, key, 60),
          uptime24h: store.uptime(t.id, key, DAY),
          uptime7d: store.uptime(t.id, key, 7 * DAY),
          uptime30d: store.uptime(t.id, key, 30 * DAY),
        }];
      })),
    })),
  };
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

const json = (res, code, value) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

// Cache of Globalping probe networks per country, for the admin "providers
// with live probes" hint. Refreshed at most every 10 minutes.
let probeCache = { t: 0, byCountry: null };
async function probeNetworks(country) {
  if (Date.now() - probeCache.t > 10 * 60 * 1000) {
    const res = await fetch('https://api.globalping.io/v1/probes', { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`probes list unavailable (${res.status})`);
    const probes = await res.json();
    const byCountry = {};
    for (const p of probes) {
      const c = p.location?.country;
      const n = p.location?.network;
      if (!c || !n) continue;
      (byCountry[c] ??= new Set()).add(n);
    }
    probeCache = { t: Date.now(), byCountry };
  }
  return [...(probeCache.byCountry[country] ?? [])].sort();
}

async function handleApi(req, res, url) {
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/healthz') {
    return json(res, 200, { ok: true, targets: store.config.targets.length, uptimeSec: Math.round(process.uptime()) });
  }

  if (req.method === 'POST' && path === '/api/login') {
    if (!AUTH_ENABLED) return json(res, 200, { ok: true, authEnabled: false });
    const body = await readBody(req);
    if (!safeEqual(body.password ?? '', process.env.ADMIN_PASSWORD)) {
      return json(res, 401, { errors: ['wrong password'] });
    }
    const exp = Date.now() + 7 * 24 * 3600e3;
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': `mm_session=${exp}.${sign(exp)}; Max-Age=${7 * 24 * 3600}; Path=/; HttpOnly; SameSite=Lax`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (AUTH_ENABLED && !PUBLIC_API.has(path) && !hasValidSession(req)) {
    return json(res, 401, { errors: ['authentication required'] });
  }

  if (req.method === 'POST' && path === '/api/logout') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': 'mm_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === 'POST' && path === '/api/alerts/test') {
    const result = await alerter.send(`✅ Test alert from MirNin Monitor — webhook is wired up. (${new Date().toLocaleString()})`);
    return json(res, result.ok ? 200 : 502, result.ok ? { ok: true } : { errors: [result.error] });
  }

  if (req.method === 'GET' && path === '/api/state') return json(res, 200, stateSnapshot());

  if (req.method === 'GET' && path === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  // Full raw history (48h) + hourly rollups (30d) for one tile — used by the
  // focus view's range selector and heatmap.
  if (req.method === 'GET' && path === '/api/history') {
    const targetId = url.searchParams.get('target');
    const key = url.searchParams.get('loc');
    const target = store.config.targets.find((t) => t.id === targetId);
    if (!target || !key) return json(res, 404, { errors: ['target or loc not found'] });
    return json(res, 200, {
      raw: store.fullHistory(targetId, key).slice(-2000),
      rollups: store.rollupRange(targetId, key, 30 * 24),
    });
  }

  if (req.method === 'GET' && path === '/api/stats') {
    return json(res, 200, buildStats(url.searchParams.get('project'), url.searchParams.get('category')));
  }

  if (req.method === 'GET' && path === '/api/report') return handleReport(res, url);

  // ---- projects & categories ----
  if (req.method === 'POST' && path === '/api/projects') {
    const body = await readBody(req);
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 60) return json(res, 400, { errors: ['project name is required (max 60 chars)'] });
    const webhookUrl = String(body.webhookUrl ?? '').trim();
    if (webhookUrl && !/^https?:\/\//.test(webhookUrl)) return json(res, 400, { errors: ['webhook URL must start with http(s)://'] });
    let rules = null;
    if (body.rules !== undefined) {
      const r = validateRules(body.rules ?? {});
      if (r.errors.length) return json(res, 400, { errors: r.errors });
      const cleaned = Object.fromEntries(Object.entries(r.out).filter(([, v]) => v !== null));
      rules = Object.keys(cleaned).length ? cleaned : null;
    }
    const project = { id: randomUUID(), name, webhookUrl: webhookUrl || null, rules };
    store.config.projects.push(project);
    store.config.categories.push({ id: randomUUID(), projectId: project.id, name: 'General', rules: null });
    store.saveConfig();
    broadcast('config', {});
    return json(res, 201, project);
  }
  const projMatch = path.match(/^\/api\/projects\/([\w-]+)$/);
  if (projMatch) {
    const project = store.config.projects.find((p) => p.id === projMatch[1]);
    if (!project) return json(res, 404, { errors: ['project not found'] });
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (body.name !== undefined) {
        const name = String(body.name ?? '').trim();
        if (!name || name.length > 60) return json(res, 400, { errors: ['project name is required (max 60 chars)'] });
        project.name = name;
      }
      if (body.webhookUrl !== undefined) {
        const u = String(body.webhookUrl ?? '').trim();
        if (u && !/^https?:\/\//.test(u)) return json(res, 400, { errors: ['webhook URL must start with http(s)://'] });
        project.webhookUrl = u || null;
      }
      if (body.rules !== undefined) {
        const r = validateRules(body.rules ?? {});
        if (r.errors.length) return json(res, 400, { errors: r.errors });
        const cleaned = Object.fromEntries(Object.entries(r.out).filter(([, v]) => v !== null));
        project.rules = Object.keys(cleaned).length ? cleaned : null;
        reclassify(store.targetIdsForScope(project.id, null));
      }
      store.saveConfig();
      broadcast('config', {});
      return json(res, 200, project);
    }
    if (req.method === 'DELETE') {
      if (store.config.projects.length === 1) return json(res, 400, { errors: ['the last project cannot be deleted'] });
      const targetIds = store.targetIdsForScope(project.id, null);
      const cascade = url.searchParams.get('cascade') === '1';
      if (targetIds.size > 0 && !cascade) {
        return json(res, 400, { errors: ['project still contains URLs — delete with confirmation, or move them first'] });
      }
      if (cascade) {
        for (const id of targetIds) store.removeTarget(id);
        store.config.targets = store.config.targets.filter((t) => !targetIds.has(t.id));
      }
      store.config.projects = store.config.projects.filter((p) => p.id !== project.id);
      store.config.categories = store.config.categories.filter((c) => c.projectId !== project.id);
      store.saveConfig();
      scheduler.sync();
      broadcast('config', {});
      return json(res, 200, { ok: true });
    }
  }
  if (req.method === 'POST' && path === '/api/categories') {
    const body = await readBody(req);
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 60) return json(res, 400, { errors: ['category name is required (max 60 chars)'] });
    if (!store.config.projects.some((p) => p.id === body.projectId)) return json(res, 400, { errors: ['unknown project'] });
    const category = { id: randomUUID(), projectId: body.projectId, name, rules: null };
    store.config.categories.push(category);
    store.saveConfig();
    broadcast('config', {});
    return json(res, 201, category);
  }
  const catMatch = path.match(/^\/api\/categories\/([\w-]+)$/);
  if (catMatch) {
    const category = store.config.categories.find((c) => c.id === catMatch[1]);
    if (!category) return json(res, 404, { errors: ['category not found'] });
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (body.name !== undefined) {
        const name = String(body.name ?? '').trim();
        if (!name || name.length > 60) return json(res, 400, { errors: ['category name is required (max 60 chars)'] });
        category.name = name;
      }
      if (body.projectId !== undefined && body.projectId !== category.projectId) {
        if (!store.config.projects.some((p) => p.id === body.projectId)) return json(res, 400, { errors: ['unknown project'] });
        category.projectId = body.projectId; // its targets move with it (they reference the category)
      }
      if (body.rules !== undefined) {
        const r = validateRules(body.rules ?? {});
        if (r.errors.length) return json(res, 400, { errors: r.errors });
        const cleaned = Object.fromEntries(Object.entries(r.out).filter(([, v]) => v !== null));
        category.rules = Object.keys(cleaned).length ? cleaned : null;
      }
      store.saveConfig();
      reclassify(store.targetIdsForScope(null, category.id));
      broadcast('config', {});
      return json(res, 200, category);
    }
    if (req.method === 'DELETE') {
      const inCat = store.config.targets.filter((t) => t.categoryId === category.id);
      const reassignTo = url.searchParams.get('reassignTo');
      const cascade = url.searchParams.get('cascade') === '1';
      if (inCat.length > 0) {
        if (reassignTo) {
          const dest = store.config.categories.find((c) => c.id === reassignTo && c.id !== category.id);
          if (!dest) return json(res, 400, { errors: ['reassignTo must be another existing category'] });
          const moved = inCat.map((t) => t.id);
          for (const t of inCat) t.categoryId = dest.id;
          reclassify(new Set(moved)); // effective rules may differ under the new category/project
        } else if (cascade) {
          const ids = inCat.map((t) => t.id);
          for (const id of ids) store.removeTarget(id);
          store.config.targets = store.config.targets.filter((t) => !ids.includes(t.id));
        } else {
          return json(res, 400, { errors: ['category still contains URLs — reassign or delete them first'] });
        }
      }
      // keep at least one category per project
      const siblings = store.config.categories.filter((c) => c.projectId === category.projectId && c.id !== category.id);
      if (siblings.length === 0) return json(res, 400, { errors: ['a project must keep at least one category'] });
      store.config.categories = store.config.categories.filter((c) => c.id !== category.id);
      store.saveConfig();
      scheduler.sync();
      broadcast('config', {});
      return json(res, 200, { ok: true });
    }
  }

  // ---- rules preview: reclassify the last 24h under a draft policy ----
  // Accepts { targetId | projectId | categoryId, rules } — the draft replaces
  // that level's layer and every affected target's checks are re-counted.
  if (req.method === 'POST' && path === '/api/rules-preview') {
    const body = await readBody(req);
    const draft = validateRules(body.rules ?? {});
    if (draft.errors.length) return json(res, 400, { errors: draft.errors });
    const draftLayer = Object.fromEntries(Object.entries(draft.out).filter(([, v]) => v !== null));

    let affected;
    let rulesFor;
    if (body.targetId) {
      const target = store.config.targets.find((t) => t.id === body.targetId);
      if (!target) return json(res, 404, { errors: ['target not found'] });
      affected = [target];
      rulesFor = () => effectiveRules(store.config.settings.rules, store.projectOf(target)?.rules, store.categoryOf(target)?.rules, draftLayer);
    } else if (body.projectId) {
      if (!store.config.projects.some((p) => p.id === body.projectId)) return json(res, 404, { errors: ['project not found'] });
      const ids = store.targetIdsForScope(body.projectId, null);
      affected = store.config.targets.filter((t) => ids.has(t.id));
      rulesFor = (t) => effectiveRules(store.config.settings.rules, draftLayer, store.categoryOf(t)?.rules, t.rules);
    } else if (body.categoryId) {
      if (!store.config.categories.some((c) => c.id === body.categoryId)) return json(res, 404, { errors: ['category not found'] });
      const ids = store.targetIdsForScope(null, body.categoryId);
      affected = store.config.targets.filter((t) => ids.has(t.id));
      rulesFor = (t) => effectiveRules(store.config.settings.rules, store.projectOf(t)?.rules, draftLayer, t.rules);
    } else return json(res, 400, { errors: ['need targetId, projectId, or categoryId'] });

    const cutoff = Date.now() - DAY;
    const count = () => ({ up: 0, degraded: 0, down: 0, unknown: 0, total: 0 });
    const current = count(), withDraft = count();
    for (const target of affected) {
      const proposed = rulesFor(target);
      for (const [key, list] of Object.entries(store.results[target.id] ?? {})) {
        const baseline = store.baseline7d(target.id, key);
        for (const e of list) {
          if (e.t < cutoff) continue;
          current[e.status]++; current.total++;
          withDraft[classifyWith(outcomeOf(e), proposed, baseline)]++; withDraft.total++;
        }
      }
    }
    return json(res, 200, { current, withDraft });
  }

  const probeMatch = path.match(/^\/api\/probes\/([A-Z]{2})$/);
  if (req.method === 'GET' && probeMatch) {
    try {
      return json(res, 200, { country: probeMatch[1], networks: await probeNetworks(probeMatch[1]) });
    } catch (err) {
      return json(res, 200, { country: probeMatch[1], networks: null, error: err.message });
    }
  }

  if (req.method === 'POST' && path === '/api/targets') {
    const { errors, out } = validateTarget(await readBody(req));
    if (errors.length) return json(res, 400, { errors });
    const target = { id: randomUUID(), enabled: true, checkType: 'http', expectText: null, expectedFinalUrl: null, expectParams: null, rules: null, categoryId: store.config.categories[0]?.id, ...out };
    store.config.targets.push(target);
    store.saveConfig();
    scheduler.sync();
    broadcast('config', {});
    return json(res, 201, target);
  }

  const targetMatch = path.match(/^\/api\/targets\/([\w-]+)(\/check)?$/);
  if (targetMatch) {
    const target = store.config.targets.find((t) => t.id === targetMatch[1]);
    if (!target) return json(res, 404, { errors: ['target not found'] });

    if (req.method === 'POST' && targetMatch[2] === '/check') {
      scheduler.runNow(target.id);
      return json(res, 202, { ok: true });
    }
    if (req.method === 'PUT' && !targetMatch[2]) {
      const { errors, out } = validateTarget(await readBody(req), { partial: true });
      if (errors.length) return json(res, 400, { errors });
      Object.assign(target, out);
      store.saveConfig();
      scheduler.sync();
      if ('rules' in out || 'expectText' in out || 'categoryId' in out) reclassify(new Set([target.id]));
      broadcast('config', {});
      return json(res, 200, target);
    }
    if (req.method === 'DELETE' && !targetMatch[2]) {
      store.config.targets = store.config.targets.filter((t) => t.id !== target.id);
      store.removeTarget(target.id);
      store.saveConfig();
      scheduler.sync();
      broadcast('config', {});
      return json(res, 200, { ok: true });
    }
  }

  if (req.method === 'PUT' && path === '/api/settings') {
    const body = await readBody(req);
    const s = store.config.settings;
    if (body.provider !== undefined) {
      if (!['auto', 'globalping', 'simulated'].includes(body.provider)) {
        return json(res, 400, { errors: ['provider must be auto, globalping, or simulated'] });
      }
      s.provider = body.provider;
    }
    if (body.globalpingToken !== undefined) {
      const t = String(body.globalpingToken ?? '').trim();
      if (!t.startsWith('••••')) s.globalpingToken = t === '' ? null : t.slice(0, 200);
    }
    if (body.rules !== undefined) {
      const r = validateRules(body.rules ?? {});
      if (r.errors.length) return json(res, 400, { errors: r.errors });
      for (const [k, v] of Object.entries(r.out)) {
        if (v === null) delete s.rules[k];
        else s.rules[k] = v;
      }
      reclassify();
    }
    if (body.alerts !== undefined && typeof body.alerts === 'object') {
      const a = body.alerts;
      if (a.webhookUrl !== undefined) {
        const u = String(a.webhookUrl ?? '').trim();
        if (u !== '' && !/^https?:\/\//.test(u)) return json(res, 400, { errors: ['webhook URL must start with http:// or https://'] });
        s.alerts.webhookUrl = u === '' ? null : u.slice(0, 500);
      }
      if (a.minConsecutiveFails !== undefined) {
        const n = Number(a.minConsecutiveFails);
        if (!Number.isInteger(n) || n < 1 || n > 20) return json(res, 400, { errors: ['minConsecutiveFails must be 1–20'] });
        s.alerts.minConsecutiveFails = n;
      }
      if (a.enabled !== undefined) s.alerts.enabled = Boolean(a.enabled);
    }
    store.saveConfig();
    broadcast('config', {});
    return json(res, 200, { ok: true });
  }

  json(res, 404, { errors: ['not found'] });
}

// --- statistics & reports ----------------------------------------------------

const pct = (acc) => {
  const known = acc.n - acc.unk;
  return known > 0 ? (100 * (acc.up + acc.deg)) / known : null;
};
const avgMs = (acc) => (acc.msN > 0 ? Math.round(acc.msSum / acc.msN) : null);
const targetName = (id) => store.config.targets.find((t) => t.id === id)?.name ?? id;

function buildStats(projectId = null, categoryId = null) {
  const tset = projectId || categoryId ? store.targetIdsForScope(projectId, categoryId) : null;
  const inScope = (tid) => !tset || tset.has(tid);
  const agg = (windowMs, groupFn) => store.aggregate(windowMs, (tid, key) => (inScope(tid) ? groupFn(tid, key) : null));

  const overall = {};
  for (const [label, ms] of [['24h', DAY], ['7d', 7 * DAY], ['30d', 30 * DAY]]) {
    const acc = agg(ms, () => 'all').get('all') ?? { n: 0, unk: 0, up: 0, deg: 0, msSum: 0, msN: 0 };
    overall[label] = { uptime: pct(acc), checks: acc.n, avgMs: avgMs(acc) };
  }
  const cutoff30 = Date.now() - 30 * DAY;
  const recent = store.incidents.filter((i) => i.startT >= cutoff30 && inScope(i.targetId));
  const closed = recent.filter((i) => i.endT != null);
  const mttrMs = closed.length ? closed.reduce((a, i) => a + (i.endT - i.startT), 0) / closed.length : null;

  const byCountry = [...agg(30 * DAY, (tid, key) => parseLocKey(key).country)]
    .map(([country, acc]) => ({
      country,
      uptime30d: pct(acc), avgMs: avgMs(acc), checks: acc.n,
      incidents: recent.filter((i) => parseLocKey(i.loc).country === country).length,
    }))
    .filter((r) => r.checks > 0)
    .sort((a, b) => (a.uptime30d ?? 101) - (b.uptime30d ?? 101));

  const byTarget = [...agg(30 * DAY, (tid) => tid)]
    .map(([tid, acc]) => ({
      id: tid, name: targetName(tid),
      uptime30d: pct(acc), avgMs: avgMs(acc), checks: acc.n,
      incidents: recent.filter((i) => i.targetId === tid).length,
    }))
    .filter((r) => store.config.targets.some((t) => t.id === r.id))
    .sort((a, b) => (a.uptime30d ?? 101) - (b.uptime30d ?? 101));

  // Category breakdown when scoped to a project; project comparison when global.
  let byCategory = null;
  let byProject = null;
  if (projectId) {
    byCategory = [...agg(30 * DAY, (tid) => store.config.targets.find((t) => t.id === tid)?.categoryId)]
      .map(([cid, acc]) => ({
        id: cid,
        name: store.config.categories.find((c) => c.id === cid)?.name ?? cid,
        uptime30d: pct(acc), avgMs: avgMs(acc), checks: acc.n,
        incidents: recent.filter((i) => store.config.targets.find((t) => t.id === i.targetId)?.categoryId === cid).length,
      }))
      .filter((r) => r.checks > 0)
      .sort((a, b) => (a.uptime30d ?? 101) - (b.uptime30d ?? 101));
  } else if (!categoryId) {
    const projOf = (tid) => {
      const t = store.config.targets.find((x) => x.id === tid);
      return t ? store.projectOf(t)?.id : null;
    };
    const perProj = agg(30 * DAY, (tid) => projOf(tid));
    byProject = store.config.projects.map((p) => {
      const acc = perProj.get(p.id) ?? { n: 0, unk: 0, up: 0, deg: 0, msSum: 0, msN: 0 };
      return {
        id: p.id, name: p.name,
        uptime30d: pct(acc), avgMs: avgMs(acc), checks: acc.n,
        incidents: store.incidents.filter((i) => i.startT >= cutoff30 && projOf(i.targetId) === p.id).length,
        days: store.dailySeries(371, { targets: store.targetIdsForScope(p.id, null) }),
      };
    }).sort((a, b) => (a.uptime30d ?? 101) - (b.uptime30d ?? 101));
  }

  return {
    scope: { projectId, categoryId },
    overall,
    incidents30d: { count: recent.length, open: recent.filter((i) => i.endT == null).length, mttrMs },
    days: store.dailySeries(371, tset ? { targets: tset } : {}),
    byCountry,
    byTarget,
    byCategory,
    byProject,
  };
}

function parseReportFilters(url) {
  const q = url.searchParams;
  const now = Date.now();
  const parseDate = (s, fallback) => {
    if (!s) return fallback;
    const t = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
    return Number.isNaN(t) ? fallback : t;
  };
  const csv = (s) => (s ? new Set(s.split(',').map((x) => x.trim()).filter(Boolean)) : null);
  let targets = csv(q.get('targets'));
  const projectId = q.get('project'), categoryId = q.get('category');
  if (projectId || categoryId) {
    const scoped = store.targetIdsForScope(projectId, categoryId);
    targets = targets ? new Set([...targets].filter((t) => scoped.has(t))) : scoped;
  }
  return {
    from: parseDate(q.get('from'), now - 30 * DAY),
    to: parseDate(q.get('to'), now) + (q.get('to')?.length === 10 ? DAY - 1 : 0), // inclusive end date
    targets,
    countries: csv(q.get('countries')),
    scope: ['summary', 'raw', 'incidents'].includes(q.get('scope')) ? q.get('scope') : 'summary',
    granularity: q.get('granularity') === 'hourly' ? 'hourly' : 'daily',
    format: q.get('format') === 'csv' ? 'csv' : 'json',
    limit: Math.min(Number(q.get('limit')) || 100000, 100000),
  };
}

function reportRows(f) {
  const want = (tid, key) =>
    (!f.targets || f.targets.has(tid)) &&
    (!f.countries || f.countries.has(parseLocKey(key).country));
  const rows = [];

  if (f.scope === 'incidents') {
    for (const i of store.incidents) {
      if (i.startT < f.from || i.startT > f.to || !want(i.targetId, i.loc)) continue;
      rows.push({
        started: new Date(i.startT).toISOString(),
        ended: i.endT ? new Date(i.endT).toISOString() : 'ongoing',
        durationMin: i.endT ? Math.round((i.endT - i.startT) / 60000) : null,
        target: targetName(i.targetId), location: i.loc,
        failedChecks: i.checks, error: i.error ?? '',
        diagnosis: i.diag?.note ?? (i.diag ? 'attached' : ''),
      });
    }
    rows.sort((a, b) => (a.started < b.started ? 1 : -1));
    return rows;
  }

  if (f.scope === 'raw') {
    for (const [tid, byKey] of Object.entries(store.results)) {
      for (const [key, list] of Object.entries(byKey)) {
        if (!want(tid, key)) continue;
        for (const e of list) {
          if (e.t < f.from || e.t > f.to) continue;
          rows.push({
            time: new Date(e.t).toISOString(), target: targetName(tid), location: key,
            status: e.status, ms: e.ms, httpCode: e.httpCode, error: e.error ?? '',
          });
        }
      }
    }
    rows.sort((a, b) => (a.time < b.time ? 1 : -1));
    return rows;
  }

  // summary: one row per period × target × location
  const HOUR_MS = 3600e3;
  const step = f.granularity === 'hourly' ? HOUR_MS : DAY;
  const bucketOf = (t) => Math.floor(t / step);
  const acc = new Map(); // `${bucket}|${tid}|${key}` -> counters
  const fold = (bucket, tid, key, s) => {
    const t = bucket * step;
    if (t + step <= f.from || t > f.to) return;
    const id = `${bucket}|${tid}|${key}`;
    const a = acc.get(id) ?? { bucket, tid, key, n: 0, up: 0, deg: 0, down: 0, unk: 0, msSum: 0, msN: 0 };
    a.n += s.n; a.up += s.up; a.deg += s.deg; a.down += s.down; a.unk += s.unk;
    a.msSum += s.msSum; a.msN += s.msN;
    acc.set(id, a);
  };
  for (const [tid, byKey] of Object.entries(store.rollups)) {
    for (const [key, byHour] of Object.entries(byKey)) {
      if (!want(tid, key)) continue;
      for (const [hour, s] of Object.entries(byHour)) fold(bucketOf(Number(hour) * HOUR_MS), tid, key, s);
    }
  }
  if (f.granularity === 'daily') {
    for (const [tid, byKey] of Object.entries(store.daily)) {
      for (const [key, byDay] of Object.entries(byKey)) {
        if (!want(tid, key)) continue;
        for (const [day, s] of Object.entries(byDay)) fold(Number(day), tid, key, s);
      }
    }
  }
  for (const a of acc.values()) {
    rows.push({
      period: new Date(a.bucket * step).toISOString().slice(0, f.granularity === 'hourly' ? 13 : 10),
      target: targetName(a.tid), location: a.key,
      checks: a.n, up: a.up, degraded: a.deg, down: a.down, noData: a.unk,
      uptimePct: pct(a) == null ? '' : pct(a).toFixed(3),
      avgMs: avgMs(a) ?? '',
    });
  }
  rows.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : a.target.localeCompare(b.target)));
  return rows;
}

function toCsv(rows) {
  if (rows.length === 0) return 'no data for these filters\n';
  const cols = Object.keys(rows[0]);
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => escape(r[c])).join(','))].join('\n') + '\n';
}

function handleReport(res, url) {
  const f = parseReportFilters(url);
  const rows = reportRows(f).slice(0, f.limit);
  const stamp = new Date().toISOString().slice(0, 10);
  if (f.format === 'csv') {
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="mirnin-report-${f.scope}-${stamp}.csv"`,
    });
    return res.end(toCsv(rows));
  }
  if (url.searchParams.get('download') === '1') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="mirnin-report-${f.scope}-${stamp}.json"`,
    });
    return res.end(JSON.stringify({ filters: { ...f, targets: f.targets && [...f.targets], countries: f.countries && [...f.countries] }, rows }, null, 2));
  }
  json(res, 200, { total: rows.length, rows });
}

// --- static files ------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

async function serveStatic(res, path) {
  const rel = path === '/' ? 'index.html' : path.slice(1);
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { errors: ['forbidden'] });
  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    json(res, 404, { errors: ['not found'] });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(`${req.method} ${url.pathname} failed:`, err.message);
    if (!res.headersSent) json(res, 500, { errors: [err.message] });
  }
});

server.listen(PORT, () => {
  console.log(`MirNin Monitor running at http://localhost:${PORT}`);
  console.log(`Targets: ${store.config.targets.length}, provider: ${store.config.settings.provider}`);
});

scheduler.start();
setInterval(() => store.flush(), 30000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}
