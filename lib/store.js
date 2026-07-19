// Config (targets + settings), raw check results, hourly rollups, and incidents,
// persisted as JSON under data/. Raw results are kept ~48h; rollups 90 days.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveRules } from './rules.js';

const RAW_RETENTION_MS = 48 * 60 * 60 * 1000;
const ROLLUP_RETENTION_H = 90 * 24;
const INCIDENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_RAW = 4000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A location is a country plus an optional network provider (ISP).
// Key examples: "GE", "GE@MagtiCom", "LOCAL".
export const locKey = (loc) => (loc.isp ? `${loc.country}@${loc.isp}` : loc.country);
export const parseLocKey = (key) => {
  const at = key.indexOf('@');
  return at === -1 ? { country: key, isp: null } : { country: key.slice(0, at), isp: key.slice(at + 1) };
};

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.configPath = join(dataDir, 'config.json');
    this.resultsPath = join(dataDir, 'results.json');
    this.rollupsPath = join(dataDir, 'rollups.json');
    this.dailyPath = join(dataDir, 'rollups-daily.json');
    this.incidentsPath = join(dataDir, 'incidents.json');
    mkdirSync(dataDir, { recursive: true });

    this.config = this.#readJson(this.configPath) ?? { targets: [], settings: {} };
    this.config.settings = {
      provider: 'auto', degradedMs: 2000, timeoutMs: 10000, globalpingToken: null,
      ...this.config.settings,
    };
    this.config.settings.alerts = {
      enabled: true, webhookUrl: null, minConsecutiveFails: 2,
      ...(this.config.settings.alerts ?? {}),
    };
    this.#migrateConfig();
    // results:  { [targetId]: { [locKey]: entry[] } }
    this.results = this.#readJson(this.resultsPath) ?? {};
    // rollups:  { [targetId]: { [locKey]: { [hourEpoch]: {n,up,deg,down,unk,msSum,msN,p50,p95} } } }
    this.rollups = this.#readJson(this.rollupsPath) ?? {};
    // daily rollups, kept FOREVER. Only holds days that have expired out of the
    // hourly window (hours are folded in before deletion); recent days are
    // always derived from hourly on demand, so nothing is ever double-counted.
    this.daily = this.#readJson(this.dailyPath) ?? {};
    // incidents: [{id, targetId, loc, startT, endT|null, checks, error, diag}]
    this.incidents = this.#readJson(this.incidentsPath) ?? [];
    // latency samples for the current hour, to compute p50/p95 at rollover
    this.hourSamples = new Map(); // `${targetId}:${locKey}:${hour}` -> number[]
    this.dirty = false;
  }

  // Config migrations: v1 country lists -> location objects; v4 flat targets ->
  // projects/categories; old degradedMs fields -> rules overrides.
  #migrateConfig() {
    let changed = false;
    for (const t of this.config.targets) {
      if (!t.locations && Array.isArray(t.countries)) {
        t.locations = t.countries.map((c) => ({ country: c, isp: null }));
        delete t.countries;
        changed = true;
      }
      if (!t.checkType) { t.checkType = 'http'; changed = true; }
      if (t.degradedMs != null) {
        t.rules = { latencyMs: t.degradedMs, ...(t.rules ?? {}) };
        delete t.degradedMs;
        changed = true;
      }
    }
    if (!Array.isArray(this.config.projects) || this.config.projects.length === 0) {
      this.config.projects = [{ id: 'p-general', name: 'General', webhookUrl: null, rules: null }];
      this.config.categories = [{ id: 'c-general', projectId: 'p-general', name: 'General', rules: null }];
      changed = true;
    }
    this.config.categories ??= [];
    const firstCat = this.config.categories[0]?.id;
    for (const t of this.config.targets) {
      if (!t.categoryId || !this.config.categories.some((c) => c.id === t.categoryId)) {
        t.categoryId = firstCat;
        changed = true;
      }
    }
    if (this.config.settings.degradedMs != null) {
      this.config.settings.rules = {
        latencyMs: this.config.settings.degradedMs,
        timeoutMs: this.config.settings.timeoutMs ?? 10000,
        ...(this.config.settings.rules ?? {}),
      };
      delete this.config.settings.degradedMs;
      delete this.config.settings.timeoutMs;
      changed = true;
    }
    this.config.settings.rules ??= {};
    if (changed) this.saveConfig();
  }

  // ---- hierarchy & rules ----------------------------------------------------

  categoryOf(target) { return this.config.categories.find((c) => c.id === target.categoryId) ?? null; }
  projectOf(target) {
    const cat = this.categoryOf(target);
    return this.config.projects.find((p) => p.id === cat?.projectId) ?? this.config.projects[0] ?? null;
  }

  ruleLayers(target) {
    const cat = this.categoryOf(target);
    const proj = this.projectOf(target);
    return [
      { label: 'project', rules: proj?.rules },
      { label: 'category', rules: cat?.rules },
      { label: 'target', rules: target.rules },
    ];
  }

  effectiveRulesFor(target) {
    return effectiveRules(this.config.settings.rules, ...this.ruleLayers(target).map((l) => l.rules));
  }

  targetIdsForScope(projectId, categoryId) {
    const ids = new Set();
    for (const t of this.config.targets) {
      const cat = this.categoryOf(t);
      if (categoryId && t.categoryId !== categoryId) continue;
      if (projectId && cat?.projectId !== projectId) continue;
      ids.add(t.id);
    }
    return ids;
  }

  // Location's 7-day median latency, for adaptive thresholds: the median of
  // that tile's hourly p50 values.
  baseline7d(targetId, key) {
    const cutoff = Math.floor((Date.now() - 7 * DAY) / HOUR);
    const v = [];
    for (const [h, s] of Object.entries(this.rollups[targetId]?.[key] ?? {})) {
      if (Number(h) >= cutoff && s.p50 != null) v.push(s.p50);
    }
    if (v.length < 6) return null; // not enough history to trust a baseline
    v.sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  }

  // Re-classify the raw window (~48h) of one target under a new policy and
  // rebuild the hourly rollups those raw checks cover. Older aggregates keep
  // their original classification.
  reclassifyTarget(targetId, classifyEntry /* (key, entry) => status */) {
    const byKey = this.results[targetId] ?? {};
    for (const [key, list] of Object.entries(byKey)) {
      const touchedHours = new Set();
      for (const e of list) {
        e.status = classifyEntry(key, e);
        touchedHours.add(Math.floor(e.t / HOUR));
      }
      const table = this.rollups[targetId]?.[key];
      if (!table) continue;
      for (const hour of touchedHours) {
        const entries = list.filter((e) => Math.floor(e.t / HOUR) === hour);
        const ms = entries.map((e) => e.ms).filter((x) => x != null).sort((a, b) => a - b);
        table[hour] = {
          n: entries.length,
          up: entries.filter((e) => e.status === 'up').length,
          deg: entries.filter((e) => e.status === 'degraded').length,
          down: entries.filter((e) => e.status === 'down').length,
          unk: entries.filter((e) => e.status === 'unknown').length,
          msSum: ms.reduce((a, b) => a + b, 0),
          msN: ms.length,
          p50: ms.length ? ms[Math.floor(ms.length / 2)] : null,
          p95: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] : null,
        };
      }
    }
    this.dirty = true;
  }

  #readJson(path) {
    try {
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    } catch (err) {
      console.error(`Could not read ${path}, starting fresh:`, err.message);
      return null;
    }
  }

  #writeJson(path, value) {
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  }

  saveConfig() { this.#writeJson(this.configPath, this.config); }

  flush() {
    if (!this.dirty) return;
    this.#writeJson(this.resultsPath, this.results);
    this.#writeJson(this.rollupsPath, this.rollups);
    this.#writeJson(this.dailyPath, this.daily);
    this.#writeJson(this.incidentsPath, this.incidents);
    this.dirty = false;
  }

  // ---- raw results ----------------------------------------------------------

  addResult(targetId, key, entry) {
    const list = ((this.results[targetId] ??= {})[key] ??= []);
    list.push(entry);
    const cutoff = Date.now() - RAW_RETENTION_MS;
    while (list.length > MAX_RAW || (list.length && list[0].t < cutoff)) list.shift();
    this.#rollup(targetId, key, entry);
    this.dirty = true;
  }

  history(targetId, key, limit = 60) {
    return (this.results[targetId]?.[key] ?? []).slice(-limit);
  }

  fullHistory(targetId, key) {
    return this.results[targetId]?.[key] ?? [];
  }

  removeTarget(targetId) {
    delete this.results[targetId];
    delete this.rollups[targetId];
    this.incidents = this.incidents.filter((i) => i.targetId !== targetId);
    this.dirty = true;
  }

  // ---- rollups --------------------------------------------------------------

  #rollup(targetId, key, entry) {
    const hour = Math.floor(entry.t / HOUR);
    const slot = (((this.rollups[targetId] ??= {})[key] ??= {})[hour] ??= {
      n: 0, up: 0, deg: 0, down: 0, unk: 0, msSum: 0, msN: 0, p50: null, p95: null,
    });
    slot.n++;
    if (entry.status === 'up') slot.up++;
    else if (entry.status === 'degraded') slot.deg++;
    else if (entry.status === 'down') slot.down++;
    else slot.unk++;
    if (entry.ms != null) {
      slot.msSum += entry.ms;
      slot.msN++;
      const sKey = `${targetId}:${key}:${hour}`;
      const samples = this.hourSamples.get(sKey) ?? [];
      samples.push(entry.ms);
      this.hourSamples.set(sKey, samples);
      const sorted = [...samples].sort((a, b) => a - b);
      slot.p50 = sorted[Math.floor(sorted.length / 2)];
      slot.p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }
    // drop sample buffers and stale rollups from past hours
    for (const k of this.hourSamples.keys()) {
      if (!k.endsWith(`:${hour}`)) this.hourSamples.delete(k);
    }
    const minHour = hour - ROLLUP_RETENTION_H;
    for (const h of Object.keys(this.rollups[targetId][key])) {
      if (Number(h) < minHour) {
        this.#freezeIntoDaily(targetId, key, Number(h), this.rollups[targetId][key][h]);
        delete this.rollups[targetId][key][h];
      }
    }
  }

  #freezeIntoDaily(targetId, key, hour, s) {
    const day = Math.floor(hour / 24);
    const d = (((this.daily[targetId] ??= {})[key] ??= {})[day] ??= { n: 0, up: 0, deg: 0, down: 0, unk: 0, msSum: 0, msN: 0 });
    d.n += s.n; d.up += s.up; d.deg += s.deg; d.down += s.down; d.unk += s.unk;
    d.msSum += s.msSum; d.msN += s.msN;
  }

  // Per-day series merged across every (target, location) that passes the
  // filter, for the last `days` days. Combines frozen dailies with days
  // derived from the live hourly window.
  dailySeries(days, filter = {}) {
    const today = Math.floor(Date.now() / DAY);
    const first = today - days + 1;
    const out = new Map();
    const want = (tid, key) =>
      (!filter.targets || filter.targets.has(tid)) &&
      (!filter.countries || filter.countries.has(parseLocKey(key).country));
    const fold = (day, s) => {
      if (day < first || day > today) return;
      const d = out.get(day) ?? { n: 0, up: 0, deg: 0, down: 0, unk: 0, msSum: 0, msN: 0 };
      d.n += s.n; d.up += s.up; d.deg += s.deg; d.down += s.down; d.unk += s.unk;
      d.msSum += s.msSum; d.msN += s.msN;
      out.set(day, d);
    };
    for (const [tid, byKey] of Object.entries(this.daily)) {
      for (const [key, byDay] of Object.entries(byKey)) {
        if (!want(tid, key)) continue;
        for (const [day, s] of Object.entries(byDay)) fold(Number(day), s);
      }
    }
    for (const [tid, byKey] of Object.entries(this.rollups)) {
      for (const [key, byHour] of Object.entries(byKey)) {
        if (!want(tid, key)) continue;
        for (const [hour, s] of Object.entries(byHour)) fold(Math.floor(Number(hour) / 24), s);
      }
    }
    const series = [];
    for (let day = first; day <= today; day++) {
      series.push({ day, t: day * DAY, ...(out.get(day) ?? { n: 0, up: 0, deg: 0, down: 0, unk: 0, msSum: 0, msN: 0 }) });
    }
    return series;
  }

  // Aggregate over a time window, grouped by an arbitrary key function of
  // (targetId, locKey). Uses hourly data (window must be within retention).
  aggregate(windowMs, groupFn) {
    const cutoffHour = Math.floor((Date.now() - windowMs) / HOUR);
    const groups = new Map();
    for (const [tid, byKey] of Object.entries(this.rollups)) {
      for (const [key, byHour] of Object.entries(byKey)) {
        const g = groupFn(tid, key);
        if (g == null) continue;
        const acc = groups.get(g) ?? { n: 0, up: 0, deg: 0, down: 0, unk: 0, msSum: 0, msN: 0 };
        for (const [hour, s] of Object.entries(byHour)) {
          if (Number(hour) < cutoffHour) continue;
          acc.n += s.n; acc.up += s.up; acc.deg += s.deg; acc.down += s.down; acc.unk += s.unk;
          acc.msSum += s.msSum; acc.msN += s.msN;
        }
        groups.set(g, acc);
      }
    }
    return groups;
  }

  rollupRange(targetId, key, hours) {
    const now = Math.floor(Date.now() / HOUR);
    const out = [];
    const table = this.rollups[targetId]?.[key] ?? {};
    for (let h = now - hours + 1; h <= now; h++) {
      out.push({ hour: h, t: h * HOUR, ...(table[h] ?? { n: 0, up: 0, deg: 0, down: 0, unk: 0, msSum: 0, msN: 0, p50: null, p95: null }) });
    }
    return out;
  }

  // Share of non-down checks in a window; 'unknown' excluded from the denominator.
  uptime(targetId, key, windowMs) {
    const cutoffHour = Math.floor((Date.now() - windowMs) / HOUR);
    let known = 0, ok = 0;
    for (const [h, s] of Object.entries(this.rollups[targetId]?.[key] ?? {})) {
      if (Number(h) < cutoffHour) continue;
      known += s.n - s.unk;
      ok += s.up + s.deg;
    }
    return known === 0 ? null : (100 * ok) / known;
  }

  // ---- incidents ------------------------------------------------------------

  openIncident(targetId, loc) {
    return this.incidents.find((i) => i.targetId === targetId && i.loc === loc && i.endT == null);
  }

  // Called for every new entry. Returns:
  //   opened  — incident that just started (caller triggers diagnostics)
  //   ongoing — the open incident after this entry, if any (caller may alert)
  //   closed  — incident that just ended (caller may send recovery alert)
  trackIncident(targetId, loc, entry) {
    const open = this.openIncident(targetId, loc);
    if (entry.status === 'down') {
      if (open) {
        open.checks++;
        open.error = entry.error ?? open.error;
        this.dirty = true;
        return { opened: null, ongoing: open, closed: null };
      }
      const incident = {
        id: `${targetId}:${loc}:${entry.t}`, targetId, loc,
        startT: entry.t, endT: null, checks: 1,
        error: entry.error ?? (entry.httpCode != null ? `HTTP ${entry.httpCode}` : 'check failed'),
        diag: null, alertedAt: null,
      };
      this.incidents.push(incident);
      const cutoff = Date.now() - INCIDENT_RETENTION_MS;
      this.incidents = this.incidents.filter((i) => i.endT == null || i.endT >= cutoff);
      this.dirty = true;
      return { opened: incident, ongoing: incident, closed: null };
    }
    if (open && (entry.status === 'up' || entry.status === 'degraded')) {
      open.endT = entry.t;
      this.dirty = true;
      return { opened: null, ongoing: null, closed: open };
    }
    return { opened: null, ongoing: null, closed: null };
  }

  attachDiagnosis(incidentId, diag) {
    const incident = this.incidents.find((i) => i.id === incidentId);
    if (incident) { incident.diag = diag; this.dirty = true; }
  }

  incidentsFor(targetId, limit = 20) {
    return this.incidents
      .filter((i) => i.targetId === targetId)
      .sort((a, b) => b.startT - a.startT)
      .slice(0, limit);
  }
}
