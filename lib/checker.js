// Runs reachability checks for one target across its probe locations.
//
// Providers:
//   - local:      this server fetches the URL directly (pseudo-country "LOCAL")
//   - globalping: real probes per country/ISP via api.globalping.io
//   - simulated:  synthetic results, for demos and UI work without network
//
// Every check produces an entry:
//   { t, status: 'up'|'degraded'|'down'|'unknown', ms, httpCode, error, city,
//     phases: {dns,tcp,tls,ttfb,download}|null, size, certDays, redirects,
//     finalUrl, edge, contentOk }
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { promises as dns } from 'node:dns';
import { locKey } from './store.js';

const GP_API = 'https://api.globalping.io/v1';
const GP_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_REDIRECTS = 5;
const MAX_BODY = 512 * 1024;
let gpBlockedUntil = 0;
let gpLastError = null;

export function globalpingStatus() {
  return Date.now() < gpBlockedUntil
    ? { available: false, error: gpLastError, retryAt: gpBlockedUntil }
    : { available: true };
}

// down: nothing usable came back, server errored, or expected content missing.
// degraded: responded but badly (4xx or slower than threshold).
// unknown: the check itself could not run.
export function classify(o, degradedMs) {
  if (o.unknown) return 'unknown';
  if (o.error != null || o.httpCode == null) return 'down';
  if (o.contentOk === false) return 'down';
  if (o.httpCode >= 500) return 'down';
  if (o.httpCode >= 400) return 'degraded';
  if (o.ms != null && o.ms > degradedMs) return 'degraded';
  return 'up';
}

const edgeHeader = (headers = {}) =>
  headers['cf-ray'] ? `cloudflare ${headers['cf-ray']}`
  : headers['x-served-by'] ?? headers['x-vercel-id'] ?? headers['x-amz-cf-pop'] ?? headers['server'] ?? null;

const certDaysLeft = (validTo) => {
  const t = Date.parse(validTo);
  return Number.isNaN(t) ? null : Math.floor((t - Date.now()) / 86400000);
};

// ---- local provider ---------------------------------------------------------
// Uses node:http(s) directly (not fetch) so we can time each phase from socket
// events: DNS lookup -> TCP connect -> TLS handshake -> first byte -> download.

function singleRequest(url, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const started = performance.now();
    const marks = {};
    let settled = false;
    const done = (out) => { if (!settled) { settled = true; resolve(out); } };

    const req = (isHttps ? httpsRequest : httpRequest)(u, {
      method: 'GET',
      headers: { 'user-agent': 'MirNin-Monitor/0.2 (+reachability check)', accept: '*/*' },
    }, (res) => {
      marks.ttfb = performance.now();
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_BODY) chunks.push(chunk);
      });
      res.on('end', () => {
        const end = performance.now();
        const cert = isHttps ? res.socket.getPeerCertificate?.() : null;
        done({
          httpCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          size,
          certDays: cert?.valid_to ? certDaysLeft(cert.valid_to) : null,
          ms: Math.round(end - started),
          phases: {
            dns: Math.round((marks.dns ?? started) - started),
            tcp: Math.round((marks.tcp ?? marks.dns ?? started) - (marks.dns ?? started)),
            tls: Math.round((marks.tls ?? marks.tcp ?? started) - (marks.tcp ?? started)),
            ttfb: Math.round(marks.ttfb - (marks.tls ?? marks.tcp ?? started)),
            download: Math.round(end - marks.ttfb),
          },
          error: null,
        });
      });
      res.on('error', (err) => done({ error: err.message }));
    });

    req.setTimeout(timeoutMs, () => { req.destroy(); done({ error: `timeout after ${timeoutMs} ms` }); });
    req.on('socket', (socket) => {
      socket.once('lookup', () => { marks.dns = performance.now(); });
      socket.once('connect', () => { marks.tcp = performance.now(); });
      socket.once('secureConnect', () => { marks.tls = performance.now(); });
    });
    req.on('error', (err) => done({ error: err.code ?? err.message ?? 'request failed' }));
    req.end();
  });
}

async function checkLocal(target, settings) {
  const timeoutMs = settings.timeoutMs ?? 10000;
  const started = performance.now();
  let url = target.url;
  let res = null;
  let redirects = 0;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    res = await singleRequest(url, timeoutMs);
    if (res.error != null) return { ms: null, httpCode: null, error: res.error, redirects, finalUrl: url };
    if ([301, 302, 303, 307, 308].includes(res.httpCode) && res.headers.location) {
      url = new URL(res.headers.location, url).href;
      redirects++;
      continue;
    }
    break;
  }
  return {
    ms: Math.round(performance.now() - started),
    httpCode: res.httpCode,
    error: null,
    phases: res.phases,
    size: res.size,
    certDays: res.certDays,
    redirects,
    finalUrl: url,
    edge: edgeHeader(res.headers),
    contentOk: target.expectText ? res.body.includes(target.expectText) : null,
  };
}

// ---- Globalping provider ----------------------------------------------------

class GpUnavailable extends Error {}

async function gpFetch(path, init) {
  const headers = { 'content-type': 'application/json', ...(init?.headers ?? {}) };
  if (process.env.GLOBALPING_TOKEN) headers.authorization = `Bearer ${process.env.GLOBALPING_TOKEN}`;
  const res = await fetch(GP_API + path, { ...init, headers, signal: AbortSignal.timeout(15000) });
  if (res.status === 429) throw new GpUnavailable('Globalping rate limit reached (add GLOBALPING_TOKEN for a higher limit)');
  if (!res.ok && res.status !== 202) {
    const body = await res.text().catch(() => '');
    throw new Error(`Globalping ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function gpMeasure(body) {
  const created = await gpFetch('/measurements', { method: 'POST', body: JSON.stringify(body) });
  let m;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    m = await gpFetch(`/measurements/${created.id}`);
    if (m.status !== 'in-progress') break;
  }
  return m;
}

const gpLocation = (loc) => ({ country: loc.country, ...(loc.isp ? { network: loc.isp } : {}), limit: 1 });

async function checkGlobalping(target, locs) {
  const u = new URL(target.url);
  const m = await gpMeasure({
    type: 'http',
    target: u.hostname,
    inProgressUpdates: false,
    locations: locs.map(gpLocation),
    measurementOptions: {
      protocol: u.protocol === 'http:' ? 'HTTP' : 'HTTPS',
      ...(u.port ? { port: Number(u.port) } : {}),
      request: { method: 'GET', path: u.pathname || '/', query: u.search.slice(1) },
    },
  });

  // Results arrive in the order of the requested locations array.
  return locs.map((loc, i) => {
    const r = m.results?.[i];
    if (!r) return { unknown: true, error: `no probe available for ${loc.country}${loc.isp ? ' on ' + loc.isp : ''} right now` };
    const ok = r.result?.status === 'finished';
    if (!ok) {
      return {
        ms: null, httpCode: null,
        error: r.result?.rawOutput?.trim().slice(0, 120) || r.result?.status || 'probe reported failure',
        city: r.probe?.city ?? null, network: r.probe?.network ?? null,
      };
    }
    const tm = r.result.timings ?? {};
    const body = r.result.rawBody ?? '';
    const tlsInfo = r.result.tls ?? null;
    return {
      ms: Math.round(tm.total ?? 0),
      httpCode: r.result.statusCode ?? null,
      error: null,
      city: r.probe?.city ?? null,
      network: r.probe?.network ?? null,
      phases: {
        dns: Math.round(tm.dns ?? 0), tcp: Math.round(tm.tcp ?? 0), tls: Math.round(tm.tls ?? 0),
        ttfb: Math.round(tm.firstByte ?? 0), download: Math.round(tm.download ?? 0),
      },
      size: body ? Buffer.byteLength(body) : null,
      certDays: tlsInfo?.expiresAt ? certDaysLeft(tlsInfo.expiresAt) : null,
      redirects: 0,
      finalUrl: target.url,
      edge: edgeHeader(r.result.headers ?? {}),
      // rawBody is truncated by the API; only trust a positive match.
      contentOk: target.expectText ? (body.includes(target.expectText) ? true : (body ? false : null)) : null,
    };
  });
}

// ---- simulated provider -----------------------------------------------------
// Deterministic base latency per (target, location) plus jitter, rare bounded
// incidents. Demo scenario: any location pinned to a provider matching
// /magti/i simulates an ISP-level content block (HTTP 200, wrong content).

const simState = new Map();

const hashOf = (s) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };

function simFor(targetId, key) {
  if (!simState.has(`${targetId}:${key}`)) {
    const h = hashOf(`${targetId}:${key}`);
    simState.set(`${targetId}:${key}`, { base: 40 + (h % 260), mode: 'up', ticks: 0, cert: 40 + (h % 160) });
  }
  return simState.get(`${targetId}:${key}`);
}

function checkSimulated(target, loc) {
  const key = locKey(loc);
  const s = simFor(target.id, key);
  if (loc.isp && /magti/i.test(loc.isp)) {
    return {
      ms: 62, httpCode: 200, error: null, city: 'Tbilisi', phases: { dns: 8, tcp: 12, tls: 18, ttfb: 20, download: 4 },
      size: 1450, certDays: s.cert, redirects: 0, finalUrl: target.url, edge: 'sim-block-page',
      contentOk: false,
    };
  }
  if (s.mode === 'up') {
    const r = Math.random();
    if (r < 0.01) { s.mode = 'down'; s.ticks = 2 + Math.floor(Math.random() * 3); }
    else if (r < 0.05) { s.mode = 'degraded'; s.ticks = 2 + Math.floor(Math.random() * 4); }
  } else if (--s.ticks <= 0) s.mode = 'up';

  if (s.mode === 'down') return { ms: null, httpCode: 503, error: 'simulated outage', city: null };
  const factor = s.mode === 'degraded' ? 3 + Math.random() * 2 : 1;
  const ms = Math.max(12, Math.round(s.base * factor * (0.85 + Math.random() * 0.3)));
  const dnsMs = 4 + Math.round(Math.random() * 20);
  const tcp = Math.round(ms * 0.2), tls = Math.round(ms * 0.3), ttfb = Math.round(ms * 0.32);
  return {
    ms, httpCode: 200, error: null, city: null,
    phases: { dns: dnsMs, tcp, tls, ttfb, download: Math.max(1, ms - dnsMs - tcp - tls - ttfb) },
    size: 12000 + (hashOf(key) % 20000), certDays: s.cert, redirects: 0, finalUrl: target.url,
    edge: `sim-edge-${loc.country.toLowerCase()}`,
    contentOk: target.expectText ? true : null,
  };
}

// ---- main entry -------------------------------------------------------------

// Returns [{ key, loc, entry }] for every location configured on the target.
export async function runChecks(target, settings) {
  const t = Date.now();
  const provider = settings.provider ?? 'auto';
  const degradedMs = target.degradedMs ?? settings.degradedMs ?? 2000;
  const out = [];

  const remote = target.locations.filter((l) => l.country !== 'LOCAL');
  const localLoc = target.locations.find((l) => l.country === 'LOCAL');

  const finish = (loc, o) => {
    out.push({
      key: locKey(loc), loc,
      entry: {
        t,
        status: classify(o, degradedMs),
        ms: o.ms ?? null, httpCode: o.httpCode ?? null,
        error: o.contentOk === false && o.error == null ? 'expected content not found in response' : (o.error ?? null),
        city: o.city ?? null,
        network: o.network ?? null,
        phases: o.phases ?? null, size: o.size ?? null, certDays: o.certDays ?? null,
        redirects: o.redirects ?? 0, finalUrl: o.finalUrl ?? null, edge: o.edge ?? null,
        contentOk: o.contentOk ?? null,
      },
    });
  };

  const jobs = [];
  if (localLoc) jobs.push(checkLocal(target, settings).then((o) => finish(localLoc, o)));

  if (remote.length > 0) {
    if (provider === 'simulated') {
      for (const loc of remote) finish(loc, checkSimulated(target, loc));
    } else if (Date.now() < gpBlockedUntil) {
      for (const loc of remote) finish(loc, { unknown: true, error: `probe network unavailable: ${gpLastError}` });
    } else {
      jobs.push(checkGlobalping(target, remote)
        .then((results) => results.forEach((o, i) => finish(remote[i], o)))
        .catch((err) => {
          gpBlockedUntil = Date.now() + GP_COOLDOWN_MS;
          gpLastError = err.message;
          for (const loc of remote) finish(loc, { unknown: true, error: `probe network unavailable: ${err.message}` });
        }));
    }
  }

  await Promise.all(jobs);
  return out;
}

// ---- failure diagnostics ----------------------------------------------------
// Fired when a location transitions to down: answer "is it DNS, the network
// path, or the HTTP layer?" from that same vantage point.

async function diagnoseLocal(target) {
  const u = new URL(target.url);
  const diag = { from: 'this server' };
  const dnsStart = performance.now();
  try {
    const addrs = await dns.lookup(u.hostname, { all: true });
    diag.dns = { ok: true, ms: Math.round(performance.now() - dnsStart), resolved: addrs.map((a) => a.address).slice(0, 4) };
  } catch (err) {
    diag.dns = { ok: false, error: err.code ?? err.message };
  }
  diag.tcp = await new Promise((resolve) => {
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    const started = performance.now();
    const sock = netConnect({ host: u.hostname, port, timeout: 5000 });
    sock.on('connect', () => { sock.destroy(); resolve({ ok: true, ms: Math.round(performance.now() - started) }); });
    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, error: 'connect timeout' }); });
    sock.on('error', (err) => resolve({ ok: false, error: err.code ?? err.message }));
  });
  return diag;
}

async function diagnoseGlobalping(target, loc) {
  const u = new URL(target.url);
  const diag = { from: `${loc.country}${loc.isp ? ' · ' + loc.isp : ''}` };
  const [pingM, dnsM] = await Promise.all([
    gpMeasure({ type: 'ping', target: u.hostname, locations: [gpLocation(loc)] }).catch(() => null),
    gpMeasure({ type: 'dns', target: u.hostname, locations: [gpLocation(loc)] }).catch(() => null),
  ]);
  const ping = pingM?.results?.[0]?.result;
  if (ping?.stats) diag.ping = { ok: ping.stats.loss < 100, lossPct: ping.stats.loss, avgMs: ping.stats.avg };
  else diag.ping = { ok: false, error: 'no ping result' };
  const d = dnsM?.results?.[0]?.result;
  const answers = d?.answers ?? d?.hops?.[0]?.answers ?? [];
  if (d?.status === 'finished' && answers.length) {
    diag.dns = { ok: true, ms: Math.round(d.timings?.total ?? 0), resolved: answers.map((a) => a.value).slice(0, 4) };
  } else diag.dns = { ok: false, error: d?.status ?? 'no dns result' };
  return diag;
}

function diagnoseSimulated(loc) {
  if (loc.isp && /magti/i.test(loc.isp)) {
    return {
      from: `${loc.country} · ${loc.isp} (simulated)`,
      dns: { ok: true, ms: 9, resolved: ['203.0.113.10'] },
      ping: { ok: false, lossPct: 100, avgMs: null },
      note: 'DNS resolves correctly but ICMP is dropped and HTTP is intercepted — consistent with in-network filtering.',
    };
  }
  return {
    from: `${loc.country}${loc.isp ? ' · ' + loc.isp : ''} (simulated)`,
    dns: { ok: true, ms: 12, resolved: ['203.0.113.10'] },
    ping: { ok: false, lossPct: 100, avgMs: null },
    note: 'Host unreachable at the network layer — consistent with a server or routing outage.',
  };
}

export async function runDiagnostics(target, loc, settings) {
  try {
    if (loc.country === 'LOCAL') return await diagnoseLocal(target);
    if ((settings.provider ?? 'auto') === 'simulated') return diagnoseSimulated(loc);
    if (Date.now() < gpBlockedUntil) return { from: 'unavailable', error: `probe network unavailable: ${gpLastError}` };
    return await diagnoseGlobalping(target, loc);
  } catch (err) {
    return { from: 'error', error: err.message };
  }
}
