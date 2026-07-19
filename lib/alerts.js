// Webhook alerting: fires when an incident reaches N consecutive failed
// checks, and again on recovery. Payload is {text} JSON, which Slack incoming
// webhooks accept natively; Telegram/Discord/etc. work via their webhook
// bridges or a tiny relay.

const locName = (loc) => loc.country === 'LOCAL' ? 'this server' : `${loc.country}${loc.isp ? ' · ' + loc.isp : ''}`;

function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} m`;
}

export class Alerter {
  constructor(store) {
    this.store = store;
  }

  #settings() {
    const a = this.store.config.settings.alerts ?? {};
    return {
      enabled: a.enabled !== false,
      webhookUrl: a.webhookUrl ?? null,
      minConsecutiveFails: a.minConsecutiveFails ?? 2,
    };
  }

  // Per-project webhooks override the global one; alerts fall back gracefully.
  webhookFor(target) {
    return (target && this.store.projectOf(target)?.webhookUrl) || this.#settings().webhookUrl;
  }

  prefixFor(target) {
    if (!target) return '';
    const proj = this.store.projectOf(target);
    const cat = this.store.categoryOf(target);
    return proj ? `[${proj.name}${cat ? ' · ' + cat.name : ''}] ` : '';
  }

  async send(text, webhookUrl = this.#settings().webhookUrl) {
    if (!webhookUrl) return { ok: false, error: 'no webhook URL configured' };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) return { ok: true };
        if (attempt === 1) return { ok: false, error: `webhook responded ${res.status}` };
      } catch (err) {
        if (attempt === 1) return { ok: false, error: err.message };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, error: 'unreachable' };
  }

  // Called by the scheduler after each entry is tracked.
  async evaluate(target, loc, { ongoing, closed }) {
    const s = this.#settings();
    const webhook = this.webhookFor(target);
    if (!s.enabled || !webhook) return;
    const prefix = this.prefixFor(target);

    if (ongoing && !ongoing.alertedAt && ongoing.checks >= s.minConsecutiveFails) {
      ongoing.alertedAt = Date.now();
      this.store.dirty = true;
      const diagNote = ongoing.diag?.note ?? null;
      const result = await this.send(
        `🔴 ${prefix}${target.name} is DOWN from ${locName(loc)} — ${ongoing.error ?? 'check failed'}` +
        ` (${ongoing.checks} consecutive checks, since ${new Date(ongoing.startT).toLocaleTimeString()})` +
        (diagNote ? `\nDiagnosis: ${diagNote}` : ''),
        webhook,
      );
      if (!result.ok) console.error('Alert webhook failed:', result.error);
    }

    if (closed?.alertedAt) {
      const result = await this.send(
        `🟢 ${prefix}Recovered: ${target.name} from ${locName(loc)} after ${fmtDuration(closed.endT - closed.startT)}.`,
        webhook,
      );
      if (!result.ok) console.error('Recovery webhook failed:', result.error);
    }
  }
}
