// Runs each enabled target's checks on its own interval.
// Ticks once a second; a target runs when due and never overlaps itself.
import { runChecks } from './checker.js';

export class Scheduler {
  constructor(store, onResults) {
    this.store = store;
    this.onResults = onResults; // (target, [{country, entry}]) => void
    this.nextRunAt = new Map();
    this.running = new Set();
    this.timer = null;
  }

  start() {
    // First run shortly after boot so the dashboard fills quickly.
    const soon = Date.now() + 1500;
    for (const t of this.store.config.targets) this.nextRunAt.set(t.id, soon);
    this.timer = setInterval(() => this.#tick(), 1000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  // Called when targets are added/edited: schedule new ones, drop stale ones.
  sync() {
    const ids = new Set(this.store.config.targets.map((t) => t.id));
    for (const id of this.nextRunAt.keys()) if (!ids.has(id)) this.nextRunAt.delete(id);
    for (const t of this.store.config.targets) {
      if (!this.nextRunAt.has(t.id)) this.nextRunAt.set(t.id, Date.now() + 1500);
    }
  }

  runNow(targetId) {
    this.nextRunAt.set(targetId, Date.now());
  }

  getNextRunAt(targetId) {
    return this.nextRunAt.get(targetId) ?? null;
  }

  #tick() {
    const now = Date.now();
    for (const target of this.store.config.targets) {
      if (!target.enabled) continue;
      if (this.running.has(target.id)) continue;
      if ((this.nextRunAt.get(target.id) ?? 0) > now) continue;

      this.nextRunAt.set(target.id, now + target.intervalSeconds * 1000);
      this.running.add(target.id);
      runChecks(target, this.store.config.settings)
        .then((results) => {
          for (const { country, entry } of results) this.store.addResult(target.id, country, entry);
          this.onResults(target, results);
        })
        .catch((err) => console.error(`Check failed for ${target.name}:`, err))
        .finally(() => this.running.delete(target.id));
    }
  }
}
