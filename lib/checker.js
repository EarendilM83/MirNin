// Runs reachability checks for one target across its probe locations.
//
// Providers:
//   - local:      this server fetches the URL directly (pseudo-country "LOCAL")
//   - globalping: real probes in each country via api.globalping.io
//   - simulated:  synthetic results, for demos and UI work without network
//
// Every check produces an entry:
//   { t, status: 'up'|'degraded'|'down'|'unknown', ms, httpCode, error, city }

const GP_API = 'https://api.globalping.io/v1';
const GP_COOLDOWN_MS = 5 * 60 * 1000;
let gpBlockedUntil = 0;
let gpLastError = null;

export function globalpingStatus() {
  return Date.now() < gpBlockedUntil
    ? { available: false, error: gpLastError, retryAt: gpBlockedUntil }
    : { available: true };
}

// A result is "down" when nothing usable came back or the server errored,
// "degraded" when it responded but badly (client error or slower than the
// target's threshold), "unknown" when the check itself could not run.
export function classify(outcome, degradedMs) {
  if (outcome.unknown) return 'unknown';
  if (outcome.error != null || outcome.httpCode == null) return 'down';
  if (outcome.httpCode >= 500) return 'down';
  if (outcome.httpCode >= 400) return 'degraded';
  if (outcome.ms != null && outcome.ms > degradedMs) return 'degraded';
  return 'up';
}

async function checkLocal(target, settings) {
  const timeoutMs = settings.timeoutMs ?? 10000;
  const started = performance.now();
  try {
    const res = await fetch(target.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'MirNin-Monitor/0.1 (+reachability check)' },
    });
    await res.arrayBuffer();
    return { ms: Math.round(performance.now() - started), httpCode: res.status, error: null };
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      ms: null,
      httpCode: null,
      error: timedOut ? `timeout after ${timeoutMs} ms` : (err.cause?.code ?? err.message ?? 'request failed'),
    };
  }
}

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

class GpUnavailable extends Error {}

async function checkGlobalping(target, countries) {
  const u = new URL(target.url);
  const created = await gpFetch('/measurements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'http',
      target: u.hostname,
      inProgressUpdates: false,
      locations: countries.map((c) => ({ country: c })),
      measurementOptions: {
        protocol: u.protocol === 'http:' ? 'HTTP' : 'HTTPS',
        ...(u.port ? { port: Number(u.port) } : {}),
        request: { method: 'GET', path: u.pathname || '/', query: u.search.slice(1) },
      },
    }),
  });

  let measurement;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    measurement = await gpFetch(`/measurements/${created.id}`);
    if (measurement.status !== 'in-progress') break;
  }

  const byCountry = new Map();
  for (const r of measurement.results ?? []) {
    const code = r.probe?.country;
    if (!code || byCountry.has(code)) continue;
    const ok = r.result?.status === 'finished';
    byCountry.set(code, {
      ms: ok ? Math.round(r.result.timings?.total ?? 0) : null,
      httpCode: ok ? (r.result.statusCode ?? null) : null,
      error: ok ? null : (r.result?.rawOutput?.slice(0, 120) || r.result?.status || 'probe reported failure'),
      city: r.probe?.city ?? null,
    });
  }
  // A country Globalping had no probe for still needs an answer.
  return countries.map((code) => byCountry.get(code) ?? {
    unknown: true, ms: null, httpCode: null, error: 'no probe available in this country right now',
  });
}

// --- simulated provider ------------------------------------------------------
// Deterministic base latency per (target, country) plus jitter, with rare
// bounded incidents, so the UI can be exercised without any network.
const simState = new Map();

function simFor(targetId, country) {
  const key = `${targetId}:${country}`;
  if (!simState.has(key)) {
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    simState.set(key, { base: 40 + (h % 260), mode: 'up', ticks: 0 });
  }
  return simState.get(key);
}

function checkSimulated(target, country) {
  const s = simFor(target.id, country);
  if (s.mode === 'up') {
    const r = Math.random();
    if (r < 0.01) { s.mode = 'down'; s.ticks = 2 + Math.floor(Math.random() * 3); }
    else if (r < 0.05) { s.mode = 'degraded'; s.ticks = 2 + Math.floor(Math.random() * 4); }
  } else if (--s.ticks <= 0) {
    s.mode = 'up';
  }
  if (s.mode === 'down') return { ms: null, httpCode: 503, error: 'simulated outage' };
  const factor = s.mode === 'degraded' ? 3 + Math.random() * 2 : 1;
  return {
    ms: Math.max(10, Math.round(s.base * factor * (0.85 + Math.random() * 0.3))),
    httpCode: 200,
    error: null,
  };
}

// -----------------------------------------------------------------------------

// Returns [{ country, entry }] for every country configured on the target.
export async function runChecks(target, settings) {
  const t = Date.now();
  const provider = settings.provider ?? 'auto';
  const degradedMs = target.degradedMs ?? settings.degradedMs ?? 2000;
  const out = [];

  const remote = target.countries.filter((c) => c !== 'LOCAL');
  const wantsLocal = target.countries.includes('LOCAL');

  const finish = (country, outcome) => {
    out.push({
      country,
      entry: {
        t,
        status: classify(outcome, degradedMs),
        ms: outcome.ms ?? null,
        httpCode: outcome.httpCode ?? null,
        error: outcome.error ?? null,
        city: outcome.city ?? null,
      },
    });
  };

  const localJob = wantsLocal
    ? checkLocal(target, settings).then((o) => finish('LOCAL', o))
    : Promise.resolve();

  let remoteJob = Promise.resolve();
  if (remote.length > 0) {
    if (provider === 'simulated') {
      for (const c of remote) finish(c, checkSimulated(target, c));
    } else if (Date.now() < gpBlockedUntil) {
      for (const c of remote) finish(c, { unknown: true, error: `probe network unavailable: ${gpLastError}` });
    } else {
      remoteJob = checkGlobalping(target, remote)
        .then((results) => results.forEach((o, i) => finish(remote[i], o)))
        .catch((err) => {
          gpBlockedUntil = Date.now() + GP_COOLDOWN_MS;
          gpLastError = err.message;
          for (const c of remote) finish(c, { unknown: true, error: `probe network unavailable: ${err.message}` });
        });
    }
  }

  await Promise.all([localJob, remoteJob]);
  return out;
}
