// Runs each enabled target's checks on its own interval.
// Ticks once a second; a target runs when due and never overlaps itself.
// On a fresh transition to down, fires diagnostics from the same location
// and attaches the result to the incident.
import { runChecks, runDiagnostics } from './checker.js';

export class Scheduler {
  constructor(store, alerter, onResults, onDiagnosis) {
    this.store = store;
    this.alerter = alerter;
    this.onResults = onResults;      // (target, [{key, loc, entry}]) => void
    this.onDiagnosis = onDiagnosis;  // (target, incident) => void
    this.nextRunAt = new Map();
    this.running = new Set();
    this.timer = null;
  }

  start() {
    const soon = Date.now() + 1500;
    for (const t of this.store.config.targets) this.nextRunAt.set(t.id, soon);
    this.timer = setInterval(() => this.#tick(), 1000);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  sync() {
    const ids = new Set(this.store.config.targets.map((t) => t.id));
    for (const id of this.nextRunAt.keys()) if (!ids.has(id)) this.nextRunAt.delete(id);
    for (const t of this.store.config.targets) {
      if (!this.nextRunAt.has(t.id)) this.nextRunAt.set(t.id, Date.now() + 1500);
    }
  }

  runNow(targetId) { this.nextRunAt.set(targetId, Date.now()); }

  getNextRunAt(targetId) { return this.nextRunAt.get(targetId) ?? null; }

  #tick() {
    const now = Date.now();
    for (const target of this.store.config.targets) {
      if (!target.enabled) continue;
      if (this.running.has(target.id)) continue;
      if ((this.nextRunAt.get(target.id) ?? 0) > now) continue;

      this.nextRunAt.set(target.id, now + target.intervalSeconds * 1000);
      this.running.add(target.id);
      const ctx = {
        rules: this.store.effectiveRulesFor(target),
        baselineFor: (key) => this.store.baseline7d(target.id, key),
      };
      runChecks(target, this.store.config.settings, ctx)
        .then((results) => {
          for (const { key, loc, entry } of results) {
            this.store.addResult(target.id, key, entry);
            const tracked = this.store.trackIncident(target.id, key, entry);
            if (tracked.opened) this.#diagnose(target, loc, tracked.opened);
            this.alerter.evaluate(target, loc, tracked)
              .catch((err) => console.error('Alert evaluation failed:', err));
          }
          this.onResults(target, results);
        })
        .catch((err) => console.error(`Check failed for ${target.name}:`, err))
        .finally(() => this.running.delete(target.id));
    }
  }

  #diagnose(target, loc, incident) {
    runDiagnostics(target, loc, this.store.config.settings)
      .then((diag) => {
        this.store.attachDiagnosis(incident.id, diag);
        this.onDiagnosis(target, incident);
      })
      .catch((err) => console.error(`Diagnostics failed for ${target.name}/${incident.loc}:`, err));
  }
}
