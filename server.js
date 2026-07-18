// MirNin Monitor — multi-country, multi-ISP reachability monitoring.
// Zero-dependency Node.js server: REST API + SSE live stream + static dashboard.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { Store, locKey } from './lib/store.js';
import { Scheduler } from './lib/scheduler.js';
import { Alerter } from './lib/alerts.js';
import { globalpingStatus } from './lib/checker.js';
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
  if (body.locations !== undefined || !partial) {
    const locations = parseLocations(body.locations);
    if (!locations) errors.push('locations must be a non-empty list of {country, isp?} with known country codes');
    else out.locations = locations;
  }
  if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);
  if (body.degradedMs !== undefined) {
    const n = Number(body.degradedMs);
    if (!Number.isInteger(n) || n < 100 || n > 60000) errors.push('degradedMs must be 100–60000');
    else out.degradedMs = n;
  }
  if (body.expectText !== undefined) {
    const s = String(body.expectText ?? '').slice(0, 200);
    out.expectText = s.trim() === '' ? null : s;
  }
  return { errors, out };
}

// --- API ---------------------------------------------------------------------

function stateSnapshot() {
  const s = store.config.settings;
  return {
    countries: COUNTRIES,
    authEnabled: AUTH_ENABLED,
    settings: {
      ...s,
      // never echo the full token back to the browser
      globalpingToken: s.globalpingToken ? '••••' + s.globalpingToken.slice(-4) : null,
    },
    globalping: globalpingStatus(),
    targets: store.config.targets.map((t) => ({
      ...t,
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
    const target = { id: randomUUID(), enabled: true, expectText: null, ...out };
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
