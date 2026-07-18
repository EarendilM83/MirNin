// Config (targets + settings) and check results, persisted as JSON under data/.
// Results live in memory and are flushed to disk periodically and on shutdown.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const RETENTION_MS = 25 * 60 * 60 * 1000; // a bit over the 24h uptime window
const MAX_ENTRIES = 2000;

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.configPath = join(dataDir, 'config.json');
    this.resultsPath = join(dataDir, 'results.json');
    mkdirSync(dataDir, { recursive: true });

    this.config = this.#readJson(this.configPath) ?? {
      targets: [],
      settings: { provider: 'auto', degradedMs: 2000, timeoutMs: 10000 },
    };
    // results: { [targetId]: { [country]: entry[] } }
    this.results = this.#readJson(this.resultsPath) ?? {};
    this.dirty = false;
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

  saveConfig() {
    this.#writeJson(this.configPath, this.config);
  }

  flushResults() {
    if (!this.dirty) return;
    this.#writeJson(this.resultsPath, this.results);
    this.dirty = false;
  }

  addResult(targetId, country, entry) {
    const perTarget = (this.results[targetId] ??= {});
    const list = (perTarget[country] ??= []);
    list.push(entry);
    const cutoff = Date.now() - RETENTION_MS;
    while (list.length > MAX_ENTRIES || (list.length && list[0].t < cutoff)) list.shift();
    this.dirty = true;
  }

  removeTargetResults(targetId) {
    delete this.results[targetId];
    this.dirty = true;
  }

  history(targetId, country, limit = 60) {
    return (this.results[targetId]?.[country] ?? []).slice(-limit);
  }

  // Share of non-down checks over the last 24h; 'unknown' checks are excluded
  // from the denominator (no data is not the same as downtime).
  uptime24h(targetId, country) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const known = (this.results[targetId]?.[country] ?? [])
      .filter((e) => e.t >= cutoff && e.status !== 'unknown');
    if (known.length === 0) return null;
    const ok = known.filter((e) => e.status !== 'down').length;
    return (100 * ok) / known.length;
  }
}
