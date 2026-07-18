// MirNin Monitor — multi-country reachability monitoring.
// Zero-dependency Node.js server: REST API + SSE live stream + static dashboard.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from './lib/store.js';
import { Scheduler } from './lib/scheduler.js';
import { globalpingStatus } from './lib/checker.js';
import { COUNTRIES, isValidCountry } from './lib/countries.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 4000);

const store = new Store(process.env.DATA_DIR ?? join(ROOT, 'data'));
const sseClients = new Set();

const scheduler = new Scheduler(store, (target, results) => {
  broadcast('result', {
    targetId: target.id,
    nextRunAt: scheduler.getNextRunAt(target.id),
    results: results.map(({ country, entry }) => ({
      country,
      entry,
      uptime24h: store.uptime24h(target.id, country),
    })),
  });
});

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

// --- validation --------------------------------------------------------------

const MIN_INTERVAL = 30;

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
  if (body.countries !== undefined || !partial) {
    const list = Array.isArray(body.countries) ? [...new Set(body.countries)] : [];
    if (list.length === 0 || list.length > 30 || !list.every(isValidCountry)) {
      errors.push('countries must be a non-empty list of known location codes');
    } else out.countries = list;
  }
  if (body.enabled !== undefined) out.enabled = Boolean(body.enabled);
  if (body.degradedMs !== undefined) {
    const n = Number(body.degradedMs);
    if (!Number.isInteger(n) || n < 100 || n > 60000) errors.push('degradedMs must be 100–60000');
    else out.degradedMs = n;
  }
  return { errors, out };
}

// --- API ---------------------------------------------------------------------

function stateSnapshot() {
  return {
    countries: COUNTRIES,
    settings: store.config.settings,
    globalping: globalpingStatus(),
    targets: store.config.targets.map((t) => ({
      ...t,
      nextRunAt: scheduler.getNextRunAt(t.id),
      results: Object.fromEntries(t.countries.map((c) => [c, {
        history: store.history(t.id, c),
        uptime24h: store.uptime24h(t.id, c),
      }])),
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

async function handleApi(req, res, path) {
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

  if (req.method === 'POST' && path === '/api/targets') {
    const { errors, out } = validateTarget(await readBody(req));
    if (errors.length) return json(res, 400, { errors });
    const target = { id: randomUUID(), enabled: true, ...out };
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
      store.removeTargetResults(target.id);
      store.saveConfig();
      scheduler.sync();
      broadcast('config', {});
      return json(res, 200, { ok: true });
    }
  }

  if (req.method === 'PUT' && path === '/api/settings') {
    const body = await readBody(req);
    if (body.provider !== undefined) {
      if (!['auto', 'globalping', 'simulated'].includes(body.provider)) {
        return json(res, 400, { errors: ['provider must be auto, globalping, or simulated'] });
      }
      store.config.settings.provider = body.provider;
    }
    store.saveConfig();
    broadcast('config', {});
    return json(res, 200, store.config.settings);
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
  const path = new URL(req.url, 'http://x').pathname;
  try {
    if (path.startsWith('/api/')) await handleApi(req, res, path);
    else await serveStatic(res, path);
  } catch (err) {
    console.error(`${req.method} ${path} failed:`, err.message);
    if (!res.headersSent) json(res, 500, { errors: [err.message] });
  }
});

server.listen(PORT, () => {
  console.log(`MirNin Monitor running at http://localhost:${PORT}`);
  console.log(`Targets: ${store.config.targets.length}, provider: ${store.config.settings.provider}`);
});

scheduler.start();
setInterval(() => store.flushResults(), 30000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flushResults();
    process.exit(0);
  });
}
