// Status rules: what counts as Operational / Degraded / Down.
//
// A policy is a small object; global defaults live in settings.rules and any
// project, category, or target may override individual fields. The effective
// policy is the merge down that chain. Checks store raw facts (code, ms,
// timeout, content match); classification applies a policy to facts, so rules
// can change and recent history can be re-classified.

export const DEFAULT_RULES = {
  passedCodes: '200-399',     // HTTP codes that count as reachable
  degradedCodes: '400-499',   // HTTP codes that count as degraded
  treat403: false,            // "our WAF blocks probes": 403 counts as passed
  latencyMode: 'fixed',       // 'fixed' | 'adaptive'
  latencyMs: 2000,            // fixed threshold
  adaptiveFactor: 3,          // adaptive: slower than N x location's 7d median
  timeoutMs: 10000,
  contentFail: 'down',        // missing expected text: 'down'|'degraded'|'ignore'
};

const RULE_FIELDS = Object.keys(DEFAULT_RULES);

// "200-299, 301, 403" -> [[200,299],[301,301],[403,403]]; null if invalid.
export function parseCodes(spec) {
  const parts = String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ranges = [];
  for (const p of parts) {
    const m = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(p);
    if (!m) return null;
    const lo = Number(m[1]), hi = Number(m[2] ?? m[1]);
    if (hi < lo) return null;
    ranges.push([lo, hi]);
  }
  return ranges;
}

const codeIn = (spec, code) => {
  const ranges = parseCodes(spec) ?? [];
  return ranges.some(([lo, hi]) => code >= lo && code <= hi);
};

// Validate a partial override object; returns {errors, out} with only known,
// well-formed fields. Empty-string / null values mean "clear the override".
export function validateRules(body) {
  const errors = [];
  const out = {};
  if (typeof body !== 'object' || body == null) return { errors: ['rules must be an object'], out };
  for (const [k, vRaw] of Object.entries(body)) {
    if (!RULE_FIELDS.includes(k)) continue;
    if (vRaw === null || vRaw === '') { out[k] = null; continue; } // clear override
    let v = vRaw;
    if (k === 'passedCodes' || k === 'degradedCodes') {
      if (parseCodes(v) == null) { errors.push(`${k}: use HTTP codes/ranges like "200-299, 301"`); continue; }
      v = String(v);
    } else if (k === 'latencyMode') {
      if (!['fixed', 'adaptive'].includes(v)) { errors.push('latencyMode must be fixed or adaptive'); continue; }
    } else if (k === 'contentFail') {
      if (!['down', 'degraded', 'ignore'].includes(v)) { errors.push('contentFail must be down, degraded, or ignore'); continue; }
    } else if (k === 'treat403') {
      v = Boolean(v);
    } else { // numeric fields
      v = Number(v);
      const limits = { latencyMs: [100, 60000], adaptiveFactor: [1.5, 20], timeoutMs: [1000, 60000] };
      const [lo, hi] = limits[k];
      if (!Number.isFinite(v) || v < lo || v > hi) { errors.push(`${k} must be between ${lo} and ${hi}`); continue; }
    }
    out[k] = v;
  }
  return { errors, out };
}

// Merge the inheritance chain; later objects win, null/undefined fields fall through.
export function effectiveRules(...layers) {
  const out = { ...DEFAULT_RULES };
  for (const layer of layers) {
    if (!layer) continue;
    for (const k of RULE_FIELDS) {
      if (layer[k] !== undefined && layer[k] !== null) out[k] = layer[k];
    }
  }
  return out;
}

// Which layer each effective field came from, for "default/custom" provenance in the UI.
export function rulesProvenance(layers /* [{label, rules}] */) {
  const out = {};
  for (const k of RULE_FIELDS) {
    out[k] = 'default';
    for (const { label, rules } of layers) {
      if (rules && rules[k] !== undefined && rules[k] !== null) out[k] = label;
    }
  }
  return out;
}

// Classify one check outcome under a policy.
// baselineMs: the location's 7-day median latency (for adaptive mode).
export function classifyWith(o, rules, baselineMs) {
  if (o.unknown) return 'unknown';
  if (o.error != null || o.httpCode == null) return 'down';

  let status;
  const code = o.httpCode;
  if (rules.treat403 && code === 403) status = 'up';
  else if (codeIn(rules.passedCodes, code)) status = 'up';
  else if (codeIn(rules.degradedCodes, code)) status = 'degraded';
  else status = 'down';

  if (o.contentOk === false && rules.contentFail !== 'ignore') {
    status = rules.contentFail === 'down' ? 'down' : worstOf(status, 'degraded');
  }
  if (status !== 'down' && o.ms != null) {
    const threshold = rules.latencyMode === 'adaptive' && baselineMs
      ? baselineMs * rules.adaptiveFactor
      : rules.latencyMs;
    if (o.ms > threshold) status = worstOf(status, 'degraded');
  }
  return status;
}

const RANK = { down: 0, degraded: 1, unknown: 2, up: 3 };
const worstOf = (a, b) => (RANK[a] <= RANK[b] ? a : b);
