// Link-health check types beyond plain reachability: redirect chains,
// deep SSL, domain expiry (RDAP), and DNS blocklists. Each returns
//   { status, ms, error, detail }
// where detail carries the type-specific data the UI visualizes. All use
// only Node's standard library; a simulated variant drives offline demos.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { promises as dns } from 'node:dns';

export const CHECK_TYPES = {
  http: { label: 'Reachability', glyph: '🌍', perLocation: true },
  redirect: { label: 'Redirect / link', glyph: '↪', perLocation: false },
  ssl: { label: 'SSL certificate', glyph: '🔒', perLocation: false },
  domain: { label: 'Domain expiry', glyph: '📅', perLocation: false },
  blocklist: { label: 'DNS blocklist', glyph: '🛡', perLocation: false },
  crawl: { label: 'Broken-link crawl', glyph: '🔗', perLocation: false },
};

const CRAWL_MAX_PAGES = 40;
const CRAWL_MAX_LINKS = 500;
const CRAWL_BUDGET_MS = 25000;

const CERT_WARN_DAYS = 14;
const DOMAIN_WARN_DAYS = 30;
const MAX_HOPS = 8;

const daysUntil = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((t - Date.now()) / 86400000);
};

// ---- redirect / tracking-link chain -----------------------------------------

function oneHop(url, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ error: 'invalid URL' }); }
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const started = performance.now();
    const req = lib(u, { method: 'GET', headers: { 'user-agent': 'MirNin-Monitor/0.3' } }, (res) => {
      res.resume(); // drain
      resolve({
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
        location: res.headers.location ? new URL(res.headers.location, u).href : null,
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ error: `timeout after ${timeoutMs} ms` }); });
    req.on('error', (err) => resolve({ error: err.code ?? err.message }));
    req.end();
  });
}

async function checkRedirect(target, timeoutMs) {
  const hops = [];
  let url = target.url;
  let totalMs = 0;
  for (let i = 0; i < MAX_HOPS; i++) {
    const h = await oneHop(url, timeoutMs);
    if (h.error) { hops.push({ n: i + 1, url, error: h.error }); break; }
    totalMs += h.ms;
    hops.push({ n: i + 1, url, status: h.status, ms: h.ms, location: h.location });
    if (![301, 302, 303, 307, 308].includes(h.status) || !h.location) break;
    url = h.location;
  }
  const last = hops[hops.length - 1];
  const finalUrl = last?.error ? null : (last?.location ?? last?.url ?? url);
  const expected = target.expectedFinalUrl?.trim() || null;
  const finalOk = !expected || (finalUrl != null && finalUrl.startsWith(expected));
  // tracking params that must survive to the final URL
  const wanted = (target.expectParams ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const params = wanted.map((name) => ({ name, present: finalUrl != null && new URL(finalUrl).searchParams.has(name) }));
  const paramsOk = params.every((p) => p.present);
  const brokeHop = hops.find((h) => h.error || h.status >= 400);
  const detail = { hops, finalUrl, expectedFinalUrl: expected, finalOk, params, paramsOk, totalMs };
  return { ms: totalMs || null, error: brokeHop?.error ?? null, detail };
}

function classifyRedirect(detail) {
  if (detail.hops.some((h) => h.error || h.status >= 500)) return 'down';
  if (!detail.finalOk) return 'down';
  if (detail.hops.some((h) => h.status >= 400)) return 'down';
  if (!detail.paramsOk) return 'degraded';
  return 'up';
}

// ---- deep SSL ---------------------------------------------------------------

function checkSslReal(target, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(target.url);
    const started = performance.now();
    const socket = tlsConnect({
      host: u.hostname, port: u.port ? Number(u.port) : 443, servername: u.hostname,
      timeout: timeoutMs, rejectUnauthorized: false,
    }, () => {
      const cert = socket.getPeerCertificate(true);
      const handshakeMs = Math.round(performance.now() - started);
      const authorized = socket.authorized;
      const authError = socket.authorizationError ? String(socket.authorizationError) : null;
      const names = (cert.subjectaltname ?? '').split(',').map((s) => s.replace(/^\s*DNS:/, '').trim()).filter(Boolean);
      const hostnameMatch = names.some((n) =>
        n === u.hostname || (n.startsWith('*.') && u.hostname.endsWith(n.slice(1))));
      socket.end();
      resolve({
        ms: handshakeMs, error: null,
        detail: {
          daysLeft: cert.valid_to ? daysUntil(cert.valid_to) : null,
          validTo: cert.valid_to ?? null,
          issuer: cert.issuer?.O ?? cert.issuer?.CN ?? 'unknown',
          altNames: names.slice(0, 8),
          hostnameMatch, chainValid: authorized, authError, handshakeMs,
        },
      });
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ ms: null, error: `timeout after ${timeoutMs} ms`, detail: null }); });
    socket.on('error', (err) => resolve({ ms: null, error: err.code ?? err.message, detail: null }));
  });
}

function classifySsl(detail, error) {
  if (error || !detail) return 'down';
  if (detail.daysLeft != null && detail.daysLeft <= 0) return 'down';
  if (!detail.chainValid || !detail.hostnameMatch) return 'down';
  if (detail.daysLeft != null && detail.daysLeft < CERT_WARN_DAYS) return 'degraded';
  return 'up';
}

// ---- domain expiry (RDAP) ---------------------------------------------------

async function checkDomainReal(target, timeoutMs) {
  const host = new URL(target.url).hostname.replace(/^www\./, '');
  const res = await fetch(`https://rdap.org/domain/${host}`, {
    headers: { accept: 'application/rdap+json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return { ms: null, error: `RDAP ${res.status}`, detail: null };
  const data = await res.json();
  const expEvent = (data.events ?? []).find((e) => e.eventAction === 'expiration');
  const expiry = expEvent?.eventDate ?? null;
  const ns = (data.nameservers ?? []).map((n) => n.ldhName).filter(Boolean).slice(0, 6);
  const registrar = (data.entities ?? []).find((e) => (e.roles ?? []).includes('registrar'))?.handle
    ?? (data.entities ?? [])[0]?.handle ?? 'unknown';
  return {
    ms: null, error: null,
    detail: { daysLeft: expiry ? daysUntil(expiry) : null, expiry, registrar, nameservers: ns, statuses: data.status ?? [] },
  };
}

function classifyDomain(detail, error) {
  if (error || !detail) return 'unknown'; // RDAP unreachable ≠ domain broken
  if (detail.daysLeft == null) return 'unknown';
  if (detail.daysLeft <= 0) return 'down';
  if (detail.daysLeft < DOMAIN_WARN_DAYS) return 'degraded';
  return 'up';
}

// ---- DNS blocklist ----------------------------------------------------------

// Advisory (degraded) vs hard (down) reputation zones. Gambling/content lists
// matter most for reachability from filtered ISPs/resolvers.
const RBL_ZONES = [
  { zone: 'zen.spamhaus.org', label: 'Spamhaus ZEN', severity: 'down' },
  { zone: 'b.barracudacentral.org', label: 'Barracuda', severity: 'down' },
  { zone: 'dnsbl.sorbs.net', label: 'SORBS', severity: 'degraded' },
  { zone: 'bl.spamcop.net', label: 'SpamCop', severity: 'degraded' },
];

async function checkBlocklistReal(target, timeoutMs) {
  const host = new URL(target.url).hostname;
  let ip;
  try { ip = (await dns.resolve4(host))[0]; } catch (err) { return { ms: null, error: `cannot resolve ${host}: ${err.code ?? err.message}`, detail: null }; }
  const reversed = ip.split('.').reverse().join('.');
  const checked = await Promise.all(RBL_ZONES.map(async (z) => {
    try {
      await dns.resolve4(`${reversed}.${z.zone}`);
      return { ...z, listed: true };
    } catch { return { ...z, listed: false }; }
  }));
  const listedOn = checked.filter((c) => c.listed);
  return { ms: null, error: null, detail: { resolvedIp: ip, checked, listedOn: listedOn.map((c) => c.label), hardHit: listedOn.some((c) => c.severity === 'down') } };
}

function classifyBlocklist(detail, error) {
  if (error || !detail) return 'unknown';
  if (detail.hardHit) return 'down';
  if (detail.listedOn.length) return 'degraded';
  return 'up';
}

// ---- broken-link crawler ----------------------------------------------------
// Same-origin BFS over internal pages (capped), checking every link found
// (internal + external) once. Reports broken links with their source page and
// anchor text. Zero-dep; bounded by page/link caps and a wall-clock budget.

function fetchPage(url, timeoutMs, method = 'GET') {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ error: 'invalid URL' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve({ skip: true });
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = lib(u, { method, headers: { 'user-agent': 'MirNin-Monitor/0.3 (link crawler)' } }, (res) => {
      const ct = res.headers['content-type'] ?? '';
      const isHtml = ct.includes('text/html');
      if (method === 'HEAD' || !isHtml) { res.resume(); return resolve({ status: res.statusCode, contentType: ct }); }
      let body = '';
      res.on('data', (c) => { if (body.length < 512 * 1024) body += c; });
      res.on('end', () => resolve({ status: res.statusCode, contentType: ct, body }));
      res.on('error', (err) => resolve({ error: err.code ?? err.message }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ error: `timeout` }); });
    req.on('error', (err) => resolve({ error: err.code ?? err.message }));
    req.end();
  });
}

function extractLinks(baseUrl, html) {
  const out = [];
  const re = /<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*?>(.*?)<\/a>/gis;
  let m;
  while ((m = re.exec(html)) && out.length < 200) {
    let href = m[1].trim();
    if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, baseUrl).href; } catch { continue; }
    const anchor = m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
    out.push({ url: abs.split('#')[0], anchor });
  }
  return out;
}

async function checkCrawl(target, timeoutMs) {
  const start = performance.now();
  const origin = new URL(target.url).origin;
  const maxPages = Math.min(target.maxPages ?? CRAWL_MAX_PAGES, CRAWL_MAX_PAGES);
  const toVisit = [target.url.split('#')[0]];
  const visited = new Set();
  const linkStatus = new Map(); // url -> {status|error, source, anchor}
  let pagesCrawled = 0;

  while (toVisit.length && pagesCrawled < maxPages && performance.now() - start < CRAWL_BUDGET_MS) {
    const page = toVisit.shift();
    if (visited.has(page)) continue;
    visited.add(page);
    const res = await fetchPage(page, timeoutMs, 'GET');
    pagesCrawled++;
    if (res.error || !res.body) continue;
    for (const { url, anchor } of extractLinks(page, res.body)) {
      if (!linkStatus.has(url) && linkStatus.size < CRAWL_MAX_LINKS) linkStatus.set(url, { source: page, anchor, pending: true });
      if (url.startsWith(origin) && !visited.has(url) && !toVisit.includes(url) && toVisit.length + visited.size < maxPages) toVisit.push(url);
    }
  }

  // check each unique link (HEAD, fall back to GET on 405) with light parallelism
  const links = [...linkStatus.keys()];
  const CONC = 8;
  for (let i = 0; i < links.length; i += CONC) {
    if (performance.now() - start > CRAWL_BUDGET_MS) break;
    await Promise.all(links.slice(i, i + CONC).map(async (url) => {
      let r = await fetchPage(url, timeoutMs, 'HEAD');
      if (r.status === 405 || r.status === 501) r = await fetchPage(url, timeoutMs, 'GET');
      const rec = linkStatus.get(url);
      rec.pending = false;
      rec.status = r.status ?? null;
      rec.error = r.error ?? null;
      rec.broken = Boolean(r.error) || (r.status != null && r.status >= 400);
    }));
  }

  const checked = links.filter((u) => !linkStatus.get(u).pending);
  const broken = checked.filter((u) => linkStatus.get(u).broken).map((u) => {
    const r = linkStatus.get(u);
    return { url: u, status: r.status, error: r.error, source: r.source, anchor: r.anchor };
  });
  const healthPct = checked.length ? (100 * (checked.length - broken.length)) / checked.length : 100;
  return { ms: Math.round(performance.now() - start), error: null, detail: {
    startUrl: target.url, pagesCrawled, linksChecked: checked.length,
    brokenCount: broken.length, healthPct, broken: broken.slice(0, 50),
  } };
}

function classifyCrawl(detail) {
  if (!detail) return 'down';
  if (detail.brokenCount === 0) return 'up';
  return detail.brokenCount / Math.max(1, detail.linksChecked) >= 0.02 ? 'down' : 'degraded';
}

// ---- simulated variants -----------------------------------------------------

const hashOf = (s) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };

function simulate(target) {
  const h = hashOf(target.id + target.checkType);
  const host = (() => { try { return new URL(target.url).hostname; } catch { return target.url; } })();
  if (target.checkType === 'redirect') {
    const broken = /promo|track|aff/i.test(target.name) && h % 3 === 0;
    const paramsDropped = !broken && h % 4 === 0;
    const hops = [
      { n: 1, url: target.url, status: 302, ms: 40 + (h % 30), location: `https://track.example/click?cid=${h % 999}` },
      { n: 2, url: `https://track.example/click?cid=${h % 999}`, ...(broken
        ? { error: 'ECONNREFUSED' }
        : { status: 302, ms: 60 + (h % 40), location: `https://app.${host}/landing${paramsDropped ? '' : '?utm_source=promo&cid=' + (h % 999)}` }) },
    ];
    if (!broken) hops.push({ n: 3, url: hops[1].location, status: 200, ms: 80 + (h % 50), location: null });
    const finalUrl = broken ? null : hops[hops.length - 1].url;
    const params = ['utm_source', 'cid'].map((name) => ({ name, present: !broken && !paramsDropped }));
    const detail = { hops, finalUrl, expectedFinalUrl: `https://app.${host}/landing`, finalOk: !broken, params, paramsOk: !broken && !paramsDropped, totalMs: hops.reduce((a, x) => a + (x.ms || 0), 0) };
    return { ms: detail.totalMs, error: broken ? 'ECONNREFUSED at hop 2' : null, detail };
  }
  if (target.checkType === 'ssl') {
    const daysLeft = [92, 9, 240, 47][h % 4];
    return { ms: 30 + (h % 40), error: null, detail: {
      daysLeft, validTo: new Date(Date.now() + daysLeft * 86400000).toUTCString(),
      issuer: ["Let's Encrypt", 'DigiCert', 'Cloudflare Inc'][h % 3],
      altNames: [host, `*.${host}`], hostnameMatch: true, chainValid: true, authError: null, handshakeMs: 30 + (h % 40) } };
  }
  if (target.checkType === 'domain') {
    const daysLeft = [318, 12, 205, 64][h % 4];
    return { ms: null, error: null, detail: {
      daysLeft, expiry: new Date(Date.now() + daysLeft * 86400000).toISOString(),
      registrar: ['Namecheap', 'GoDaddy', 'Gandi'][h % 3],
      nameservers: [`ns1.${host}`, `ns2.${host}`], statuses: ['clientTransferProhibited'] } };
  }
  if (target.checkType === 'blocklist') {
    const gambling = /casino|jack|bet|fortune/i.test(host + target.name);
    const listed = gambling && h % 2 === 0;
    const checked = RBL_ZONES.map((z, i) => ({ ...z, listed: listed && i === 0 }));
    return { ms: null, error: null, detail: {
      resolvedIp: `203.0.113.${h % 254}`, checked,
      listedOn: checked.filter((c) => c.listed).map((c) => c.label), hardHit: listed } };
  }
  if (target.checkType === 'crawl') {
    const pages = 18 + (h % 20);
    const links = pages * (7 + (h % 6));
    const brokenN = h % 3 === 0 ? 0 : 1 + (h % 5);
    const sections = ['/games', '/promotions', '/help', '/blog', '/'];
    const broken = Array.from({ length: brokenN }, (_, i) => ({
      url: `https://app.${host}${sections[(h + i) % sections.length]}/page-${(h + i) % 90}`,
      status: [404, 404, 500, 403, 0][(h + i) % 5] || null,
      error: (h + i) % 5 === 4 ? 'ECONNREFUSED' : null,
      source: `https://app.${host}${sections[(h + i * 3) % sections.length]}`,
      anchor: ['Play now', 'Terms', 'Deposit', 'Read more', 'Support'][(h + i) % 5],
    }));
    return { ms: 400 + (h % 900), error: null, detail: {
      startUrl: target.url, pagesCrawled: pages, linksChecked: links,
      brokenCount: brokenN, healthPct: 100 * (links - brokenN) / links, broken } };
  }
  return { ms: null, error: 'unknown check type', detail: null };
}

// ---- dispatch ---------------------------------------------------------------

const CLASSIFIERS = { redirect: (d, e) => classifyRedirect(d), ssl: classifySsl, domain: classifyDomain, blocklist: classifyBlocklist, crawl: (d) => classifyCrawl(d) };

export async function runLinkCheck(target, settings, timeoutMs) {
  const type = target.checkType;
  let r;
  try {
    if ((settings.provider ?? 'auto') === 'simulated') {
      r = simulate(target);
    } else if (type === 'redirect') r = await checkRedirect(target, timeoutMs);
    else if (type === 'ssl') r = await checkSslReal(target, timeoutMs);
    else if (type === 'domain') r = await checkDomainReal(target, timeoutMs);
    else if (type === 'blocklist') r = await checkBlocklistReal(target, timeoutMs);
    else if (type === 'crawl') r = await checkCrawl(target, timeoutMs);
    else return { t: Date.now(), status: 'unknown', ms: null, error: 'unknown check type', checkType: type, detail: null };
  } catch (err) {
    r = { ms: null, error: err.message ?? 'check failed', detail: null };
  }
  const status = r.error && type !== 'domain' && type !== 'blocklist'
    ? 'down'
    : CLASSIFIERS[type](r.detail, r.error);
  return { t: Date.now(), status, ms: r.ms ?? null, error: r.error ?? null, checkType: type, detail: r.detail };
}
