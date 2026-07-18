/* MirNin Monitor dashboard: renders live state from /api/state + /api/events. */
(() => {
  const $ = (q, el = document) => el.querySelector(q);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const STATUS_LABEL = { up: 'Operational', degraded: 'Degraded', down: 'Down', unknown: 'No data' };
  const STATUS_RANK = { down: 0, degraded: 1, unknown: 2, up: 3 };
  const HIST_POINTS = 40;
  const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
  const CERT_WARN_DAYS = 21;

  const state = {
    data: null,           // /api/state payload
    tab: 'overview',
    view: 'grid',         // 'grid' | 'list'
    focus: null,          // { targetId, key } | null
    range: '1h',
    focusData: null,      // { raw, rollups } for the focused tile
    editing: null,
    editLocs: [],         // [{country, isp}] rows in the modal
    hintCountry: null,
  };

  // ---------- helpers --------------------------------------------------------

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const locKey = (loc) => (loc.isp ? `${loc.country}@${loc.isp}` : loc.country);
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtDay = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtMs = (ms) => (ms == null ? '—' : `${Math.round(ms)} ms`);
  const fmtUptime = (u) => (u == null ? '—' : `${u.toFixed(u >= 99.995 ? 0 : 2)}%`);
  const intervalLabel = (s) => (s < 60 ? `${s} s` : s < 3600 ? `${s / 60} min` : `${s / 3600} h`);

  function fmtDuration(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m} m`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h} h ${m % 60} m` : `${Math.floor(h / 24)} d ${h % 24} h`;
  }

  function locLabel(loc, countries) {
    const c = countries[loc.country] ?? { name: loc.country, flag: '' };
    return { flag: c.flag, name: c.name, isp: loc.isp };
  }

  const tiles = (t) => Object.entries(t.results ?? {}); // [key, slot]
  const latestOf = (slot) => slot.history[slot.history.length - 1] ?? null;

  function worstStatus(t) {
    let worst = null;
    for (const [, slot] of tiles(t)) {
      const s = latestOf(slot)?.status;
      if (s && (worst == null || STATUS_RANK[s] < STATUS_RANK[worst])) worst = s;
    }
    return worst ?? 'unknown';
  }

  function medianLatency(t) {
    const v = tiles(t).map(([, s]) => latestOf(s)?.ms).filter((x) => x != null).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  }

  function p95Of(slot) {
    const v = slot.history.map((e) => e.ms).filter((x) => x != null).sort((a, b) => a - b);
    return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.95))] : null;
  }

  function minCertDays(t) {
    const v = tiles(t).map(([, s]) => latestOf(s)?.certDays).filter((x) => x != null);
    return v.length ? Math.min(...v) : null;
  }

  // Providers inside one country disagreeing = suspected ISP-level problem.
  function divergences(t) {
    const byCountry = {};
    for (const [key, slot] of tiles(t)) {
      if (slot.loc.country === 'LOCAL') continue;
      (byCountry[slot.loc.country] ??= []).push({ key, loc: slot.loc, status: latestOf(slot)?.status });
    }
    const out = [];
    for (const [country, locs] of Object.entries(byCountry)) {
      if (locs.length < 2) continue;
      const failing = locs.filter((l) => l.status === 'down');
      const healthy = locs.filter((l) => l.status === 'up');
      if (failing.length && healthy.length) out.push({ country, failing, healthy });
    }
    return out;
  }

  const pill = (s) => `<span class="pill" data-s="${s}"><span class="dot" aria-hidden="true"></span>${STATUS_LABEL[s]}</span>`;

  // ---------- sparkline / charts ---------------------------------------------

  function sparkSVG(history, w, h, big, maxPoints = HIST_POINTS) {
    const hist = history.slice(-maxPoints);
    const n = Math.max(hist.length, 2);
    const pad = big ? 14 : 3;
    const max = Math.max(...hist.map((x) => x.ms || 0), 60) * 1.15;
    const X = (i) => pad + (i / (n - 1)) * (w - pad * 2);
    const Y = (v) => h - pad - (v / max) * (h - pad * 2);
    const band = (w - pad * 2) / (n - 1);

    let d = '';
    let pen = false;
    let out = `<svg class="${big ? 'bigchart' : 'spark'}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="latency history">`;
    if (big) {
      for (const f of [0.25, 0.5, 0.75]) {
        out += `<line x1="${pad}" x2="${w - pad}" y1="${Y(max * f).toFixed(1)}" y2="${Y(max * f).toFixed(1)}" stroke="${css('--grid-line')}" stroke-width="1"/>`;
      }
    }
    hist.forEach((pt, i) => {
      if (pt.ms == null) {
        const col = pt.status === 'unknown' ? css('--muted') : css('--crit');
        out += `<rect x="${(X(i) - band / 2).toFixed(1)}" y="${pad}" width="${band.toFixed(1)}" height="${h - pad * 2}" fill="${col}" opacity="0.18"/>`;
        pen = false;
        return;
      }
      d += (pen ? ' L' : ' M') + X(i).toFixed(1) + ' ' + Y(pt.ms).toFixed(1);
      pen = true;
    });
    out += `<path d="${d.trim()}" fill="none" stroke="${css('--accent')}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
    const lastPt = hist[hist.length - 1];
    if (lastPt && lastPt.ms != null) {
      const col = lastPt.status === 'up' ? css('--accent') : css(`--${{ degraded: 'warn', down: 'crit' }[lastPt.status] ?? 'muted'}`);
      out += `<circle cx="${X(hist.length - 1).toFixed(1)}" cy="${Y(lastPt.ms).toFixed(1)}" r="${big ? 4 : 3}" fill="${col}" stroke="${css('--surface')}" stroke-width="2"/>`;
    }
    return out + '</svg>';
  }

  const rollupToEntry = (r) => ({
    t: r.t,
    ms: r.p50 ?? (r.msN ? Math.round(r.msSum / r.msN) : null),
    status: r.n === 0 ? 'unknown' : r.down > 0 ? 'down' : r.deg > 0 ? 'degraded' : 'up',
  });

  function chartSeries() {
    if (!state.focusData) return [];
    const win = RANGES[state.range];
    if (state.range === '7d' || state.range === '30d') {
      const hours = win / 3600e3;
      return state.focusData.rollups.slice(-hours).map(rollupToEntry);
    }
    const cutoff = Date.now() - win;
    return state.focusData.raw.filter((e) => e.t >= cutoff);
  }

  function phaseBar(phases) {
    if (!phases) return '';
    const parts = [
      ['dns', 'DNS', '--ph-dns'], ['tcp', 'Connect', '--ph-tcp'], ['tls', 'TLS', '--ph-tls'],
      ['ttfb', 'First byte', '--ph-ttfb'], ['download', 'Download', '--ph-dl'],
    ];
    const total = Math.max(1, parts.reduce((a, [k]) => a + Math.max(0, phases[k] ?? 0), 0));
    const bar = parts.map(([k, , v]) =>
      `<i style="width:${(100 * Math.max(0, phases[k] ?? 0) / total).toFixed(1)}%;background:var(${v})" title="${k} ${phases[k] ?? 0} ms"></i>`).join('');
    const legend = parts.map(([k, label, v]) =>
      `<span><span class="sw" style="background:var(${v})"></span>${label} <b class="mono">${phases[k] ?? 0} ms</b></span>`).join('');
    return `<div class="phase-wrap"><div class="phase-bar" role="img" aria-label="latency phases">${bar}</div>
      <div class="phase-legend">${legend}</div></div>`;
  }

  function heatmap(rollups) {
    const cells = rollups.slice(-7 * 24);
    if (!cells.some((c) => c.n > 0)) return '';
    let html = '<div class="heat"><span></span>';
    for (let h = 0; h < 24; h++) html += `<span class="collab">${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>`;
    const days = [];
    for (let i = 0; i < cells.length; i += 24) days.push(cells.slice(i, i + 24));
    for (const day of days) {
      const lab = new Date(day[0].t).toLocaleDateString([], { weekday: 'short' });
      html += `<span class="rowlab">${lab}</span>`;
      for (const c of day) {
        const cls = c.n === 0 ? '' : c.down > 0 ? 'c' : c.deg > 0 ? 'w' : 'g';
        const tip = c.n === 0 ? 'no data' : `${new Date(c.t).toLocaleString()}: ${c.up}/${c.n} ok${c.down ? `, ${c.down} down` : ''}${c.deg ? `, ${c.deg} degraded` : ''}`;
        html += `<i class="${cls}" title="${esc(tip)}"></i>`;
      }
    }
    html += '</div><div class="heat-legend"><span><span class="sw" style="background:var(--good);opacity:.55"></span>all passed</span><span><span class="sw" style="background:var(--warn)"></span>some degraded</span><span><span class="sw" style="background:var(--crit)"></span>downtime</span><span><span class="sw" style="background:var(--grid-line)"></span>no data</span></div>';
    return `<h3 class="inner-h">Week at a glance — status by hour</h3>${html}`;
  }

  // ---------- rendering ------------------------------------------------------

  function render() {
    if (!state.data) return;
    renderHeader();
    renderTabs();
    renderSummary();
    renderMain();
    renderFocus();
  }

  function renderHeader() {
    $('#provider').value = state.data.settings.provider === 'simulated' ? 'simulated' : 'auto';
    const note = $('#net-note');
    const gp = state.data.globalping;
    const hasRemote = state.data.targets.some((t) => t.locations.some((l) => l.country !== 'LOCAL'));
    if (!gp.available && state.data.settings.provider !== 'simulated' && hasRemote) {
      note.hidden = false;
      note.textContent = 'Probe network unreachable — country checks show “No data” until it recovers';
    } else if (!state.data.authEnabled) {
      note.hidden = false;
      note.textContent = 'Unprotected — set ADMIN_PASSWORD to require a login';
    } else note.hidden = true;
  }

  function renderTabs() {
    const tabs = [{ id: 'overview', label: 'Overview' }].concat(
      state.data.targets.map((t) => ({ id: t.id, label: t.name, status: worstStatus(t), paused: !t.enabled }))
    );
    $('#tabs').innerHTML = tabs.map((t) => `
      <button role="tab" data-tab="${t.id}" aria-selected="${state.tab === t.id}">
        ${t.status ? `<span class="tab-dot" data-s="${t.status}"></span>` : ''}${esc(t.label)}${t.paused ? ' (paused)' : ''}
      </button>`).join('');
  }

  function renderSummary() {
    const scoped = state.data.targets.filter((t) => state.tab === 'overview' || state.tab === t.id);
    const statuses = scoped.flatMap((t) => tiles(t).map(([, s]) => latestOf(s)?.status ?? 'unknown'));
    const count = (s) => statuses.filter((x) => x === s).length;
    const lat = scoped.flatMap((t) => tiles(t).map(([, s]) => latestOf(s)?.ms)).filter((x) => x != null).sort((a, b) => a - b);
    const median = lat.length ? lat[Math.floor(lat.length / 2)] : null;
    $('#summary').innerHTML = state.data.targets.length === 0 ? '' : `
      <div class="stat"><div class="label">Operational</div><div class="value">${count('up')}<small> / ${statuses.length} probes</small></div></div>
      <div class="stat"><div class="label">Degraded</div><div class="value ${count('degraded') ? 'warn-c' : ''}">${count('degraded')}</div></div>
      <div class="stat"><div class="label">Down</div><div class="value ${count('down') ? 'crit-c' : ''}">${count('down')}</div></div>
      <div class="stat"><div class="label">No data</div><div class="value">${count('unknown')}</div></div>
      <div class="stat"><div class="label">Median latency</div><div class="value">${median != null ? Math.round(median) : '—'}<small> ms</small></div></div>`;
  }

  function renderMain() {
    const main = $('#main');
    if (state.data.targets.length === 0) {
      main.innerHTML = `
        <div class="empty">
          <h2>No URLs monitored yet</h2>
          <p>Add the first URL you want to watch — your platform's home page or a health endpoint — pick countries (optionally specific providers like Magti or Silknet), and how often to check.</p>
          <button class="primary" id="empty-add">+ Add URL</button>
        </div>`;
      $('#empty-add').onclick = () => openModal(null);
      $('#foot').textContent = '';
      return;
    }
    if (state.view === 'list') { renderList(main); return; }
    if (state.tab === 'overview') renderOverview(main);
    else renderTarget(main, state.data.targets.find((t) => t.id === state.tab));
    $('#foot').textContent = 'Click any tile to pin it: latency anatomy, week heatmap, and incident history. Tabs switch between monitored URLs.';
  }

  function divergeBanner(t) {
    const divs = divergences(t);
    if (!divs.length) return '';
    return divs.map((d) => {
      const cname = (state.data.countries[d.country] ?? { name: d.country }).name;
      const failing = d.failing.map((f) => f.loc.isp ?? 'unpinned').join(', ');
      const healthy = d.healthy.map((f) => f.loc.isp ?? 'unpinned').join(', ');
      return `<div class="diverge">⚠️ <b>Suspected ISP-level block in ${esc(cname)}:</b>
        <span>${esc(failing)} failing while ${esc(healthy)} ${d.healthy.length > 1 ? 'are' : 'is'} healthy.</span></div>`;
    }).join('');
  }

  function renderOverview(main) {
    main.innerHTML = `<div class="grid">${state.data.targets.map((t) => {
      const s = worstStatus(t);
      const med = medianLatency(t);
      const host = new URL(t.url).host;
      const divs = divergences(t);
      const cert = minCertDays(t);
      return `
        <button class="tile" data-status="${s}" data-open-target="${t.id}">
          <span class="tile-head"><span class="cname">${esc(t.name)}</span><span class="ccode mono">${esc(host)}</span></span>
          <span class="tile-metric"><span class="lat mono">${med != null ? Math.round(med) : '—'}</span><span class="unit">ms</span>${pill(s)}</span>
          ${divs.length ? `<span class="badge block">ISP split in ${divs.map((d) => d.country).join(', ')}</span>` : ''}
          ${cert != null && cert < CERT_WARN_DAYS ? `<span class="badge cert">cert expires in ${cert} d</span>` : ''}
          <span class="ov-countries">${tiles(t).map(([key, slot]) => `
            <span class="cdot"><i data-s="${latestOf(slot)?.status ?? 'unknown'}"></i>${slot.loc.country === 'LOCAL' ? 'local' : esc(slot.loc.country + (slot.loc.isp ? '·' + slot.loc.isp : ''))}</span>`).join('')}
          </span>
          <span class="tile-foot"><span>every ${intervalLabel(t.intervalSeconds)}${t.enabled ? '' : ' · paused'}</span><span class="countdown" data-count="${t.id}"></span></span>
        </button>`;
    }).join('')}</div>`;
  }

  function tileHTML(t, key, slot) {
    const e = latestOf(slot);
    const s = e?.status ?? 'unknown';
    const li = locLabel(slot.loc, state.data.countries);
    const divs = divergences(t);
    const isSplit = divs.some((d) => d.failing.some((f) => f.key === key));
    return `
      <button class="tile" data-status="${s}" data-focus-target="${t.id}" data-focus-key="${esc(key)}">
        <span class="tile-head"><span class="flag" aria-hidden="true">${li.flag}</span><span class="cname">${esc(li.name)}</span>
          <span class="ccode mono">${esc(li.isp ?? e?.network ?? e?.city ?? '')}</span></span>
        <span class="tile-metric"><span class="lat mono">${e?.ms != null ? Math.round(e.ms) : '—'}</span><span class="unit">ms</span>${pill(s)}</span>
        ${isSplit ? '<span class="badge block">Only this provider failing here</span>' : ''}
        ${e?.certDays != null && e.certDays < CERT_WARN_DAYS ? `<span class="badge cert">cert expires in ${e.certDays} d</span>` : ''}
        ${sparkSVG(slot.history, 200, 36, false)}
        ${e?.error ? `<span class="tile-err" title="${esc(e.error)}">${esc(e.error)}</span>` : ''}
        <span class="tile-foot"><span>uptime ${fmtUptime(slot.uptime24h)}${e?.certDays != null && e.certDays >= CERT_WARN_DAYS ? ` · cert ${e.certDays} d` : ''}</span><span>${e ? fmtTime(e.t) : 'waiting for first check'}</span></span>
      </button>`;
  }

  function renderTarget(main, t) {
    if (!t) { state.tab = 'overview'; renderMain(); return; }
    const incidents = t.incidents ?? [];
    main.innerHTML = `
      <div class="target-bar">
        <span class="url mono">${esc(t.url)}</span>
        <span>· every ${intervalLabel(t.intervalSeconds)}</span>
        ${t.expectText ? `<span>· expects “${esc(t.expectText)}”</span>` : ''}
        <span class="countdown" data-count="${t.id}"></span>
        <span class="actions">
          <button class="ghost" data-check="${t.id}">Check now</button>
          <button class="ghost" data-pause="${t.id}">${t.enabled ? 'Pause' : 'Resume'}</button>
          <button class="ghost" data-edit="${t.id}">Edit</button>
        </span>
      </div>
      ${divergeBanner(t)}
      <div class="grid">${tiles(t).map(([key, slot]) => tileHTML(t, key, slot)).join('')}</div>
      <div class="incidents">
        <h3>Recent incidents</h3>
        ${incidents.length === 0 ? '<p class="none-note">No incidents recorded for this target.</p>' : `
        <div class="list-card"><table>
          <thead><tr><th>Started</th><th>Duration</th><th>Location</th><th>What failed</th></tr></thead>
          <tbody>${incidents.map((i) => {
            const loc = t.results[i.loc]?.loc ?? { country: i.loc, isp: null };
            const li = locLabel(loc, state.data.countries);
            return `<tr>
              <td class="mono">${fmtDay(i.startT)}</td>
              <td class="mono">${i.endT ? fmtDuration(i.endT - i.startT) : 'ongoing · ' + fmtDuration(Date.now() - i.startT)}</td>
              <td>${li.flag} ${esc(li.name)}${li.isp ? ' · ' + esc(li.isp) : ''}</td>
              <td>${esc(i.error ?? '')}${i.diag ? ' · diagnosis attached' : ''}</td></tr>`;
          }).join('')}</tbody>
        </table></div>`}
      </div>`;
  }

  function renderList(main) {
    const rows = [];
    for (const t of state.data.targets) {
      if (state.tab !== 'overview' && state.tab !== t.id) continue;
      for (const [key, slot] of tiles(t)) {
        const e = latestOf(slot);
        const li = locLabel(slot.loc, state.data.countries);
        rows.push(`
          <tr data-clickable data-focus-target="${t.id}" data-focus-key="${esc(key)}">
            <td>${esc(t.name)}</td>
            <td>${li.flag} ${esc(li.name)}${li.isp ? ' · ' + esc(li.isp) : ''}</td>
            <td>${pill(e?.status ?? 'unknown')}</td>
            <td class="num mono">${fmtMs(e?.ms)}</td>
            <td class="num mono">${fmtMs(p95Of(slot))}</td>
            <td class="num mono">${fmtUptime(slot.uptime24h)}</td>
            <td class="num mono">${fmtUptime(slot.uptime30d)}</td>
            <td class="num mono">${e?.certDays ?? '—'}</td>
            <td class="num mono">${e ? fmtTime(e.t) : '—'}</td>
          </tr>`);
      }
    }
    main.innerHTML = `
      <div class="list-card">
        <h3>All probes</h3>
        <table>
          <thead><tr><th>Target</th><th>Location</th><th>Status</th>
            <th class="num">Latency</th><th class="num">p95</th>
            <th class="num">Uptime 24 h</th><th class="num">Uptime 30 d</th>
            <th class="num">Cert (days)</th><th class="num">Last check</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>`;
    $('#foot').textContent = 'Click a row to open its full history.';
  }

  // ---------- focus overlay --------------------------------------------------

  async function loadFocusData() {
    if (!state.focus) return;
    const { targetId, key } = state.focus;
    try {
      const res = await fetch(`/api/history?target=${encodeURIComponent(targetId)}&loc=${encodeURIComponent(key)}`);
      state.focusData = res.ok ? await res.json() : null;
    } catch { state.focusData = null; }
    renderFocus();
  }

  function renderFocus() {
    const overlay = $('#focus-overlay');
    if (!state.focus) { overlay.hidden = true; return; }
    const t = state.data.targets.find((x) => x.id === state.focus.targetId);
    const slot = t?.results?.[state.focus.key];
    if (!slot) { state.focus = null; overlay.hidden = true; return; }
    const key = state.focus.key;
    const li = locLabel(slot.loc, state.data.countries);
    const hist = slot.history;
    const e = latestOf(slot);
    const s = e?.status ?? 'unknown';
    const series = state.focusData ? chartSeries() : hist;
    const tileIncidents = (t.incidents ?? []).filter((i) => i.loc === key);
    const openIncident = tileIncidents.find((i) => i.endT == null);
    const diag = openIncident?.diag ?? tileIncidents.find((i) => i.diag)?.diag;

    overlay.hidden = false;
    $('#focus-main').innerHTML = `
      <div class="focus-head">
        <span class="flag" aria-hidden="true">${li.flag}</span>
        <div><h2>${esc(li.name)}${li.isp ? ' · ' + esc(li.isp) : ''}</h2>
          <div class="probe">${esc(t.name)} · ${esc(t.url)}${e?.city ? ` · probe: ${esc(e.city)}` : ''}${e?.network && !li.isp ? ` · ${esc(e.network)}` : ''}</div></div>
        <span class="ranges" style="margin-left:auto">${Object.keys(RANGES).map((r) =>
          `<button data-range="${r}" aria-pressed="${state.range === r}">${r}</button>`).join('')}</span>
        <button class="ghost close" id="focus-close">Close</button>
      </div>
      <div class="focus-stats">
        <div class="fs"><div class="label">Status</div><div class="value">${pill(s)}</div></div>
        <div class="fs"><div class="label">Latency</div><div class="value mono">${fmtMs(e?.ms)}</div></div>
        <div class="fs"><div class="label">p95 · recent</div><div class="value mono">${fmtMs(p95Of(slot))}</div></div>
        <div class="fs"><div class="label">Uptime · 24 h</div><div class="value mono">${fmtUptime(slot.uptime24h)}</div></div>
        <div class="fs"><div class="label">Uptime · 30 d</div><div class="value mono">${fmtUptime(slot.uptime30d)}</div></div>
        ${e?.certDays != null ? `<div class="fs"><div class="label">Certificate</div><div class="value mono ${e.certDays < CERT_WARN_DAYS ? 'crit-c' : ''}">${e.certDays} d</div></div>` : ''}
        ${e?.edge || e?.size != null ? `<div class="fs"><div class="label">Served by</div><div class="value mono" style="font-size:14px">${esc(e.edge ?? '—')}${e.size != null ? ` · ${(e.size / 1024).toFixed(1)} kB` : ''}${e.redirects ? ` · ${e.redirects} redirect${e.redirects > 1 ? 's' : ''}` : ''}</div></div>` : ''}
      </div>
      <div class="bigchart-wrap" id="bigwrap">${sparkSVG(series, 720, 190, true, state.range === '30d' ? 720 : state.range === '7d' ? 168 : 120)}<div class="chart-tip" id="tip"></div></div>
      ${phaseBar(e?.phases)}
      ${state.focusData ? heatmap(state.focusData.rollups) : ''}
      ${diag ? renderDiag(diag, openIncident) : ''}
      <div class="log"><h3>Recent checks</h3>
        <table><thead><tr><th>Time</th><th>Result</th><th class="num">Latency</th><th class="num">Response</th></tr></thead>
        <tbody>${hist.slice(-10).reverse().map((h) => `
          <tr><td class="mono">${fmtTime(h.t)}</td><td>${pill(h.status)}</td>
          <td class="num mono">${fmtMs(h.ms)}</td>
          <td class="num mono">${h.httpCode != null && h.contentOk !== false ? 'HTTP ' + h.httpCode : esc(h.error ?? '—')}</td></tr>`).join('')}
        </tbody></table>
      </div>`;
    $('#focus-close').onclick = () => { state.focus = null; state.focusData = null; renderFocus(); };
    for (const b of document.querySelectorAll('[data-range]')) {
      b.onclick = () => { state.range = b.dataset.range; renderFocus(); };
    }
    hookTooltip(series);

    $('#focus-strip').innerHTML = tiles(t).map(([k, sl]) => {
      const le = latestOf(sl);
      const kli = locLabel(sl.loc, state.data.countries);
      return `
        <button class="strip-tile" data-focus-target="${t.id}" data-focus-key="${esc(k)}" aria-current="${k === key}">
          <span aria-hidden="true">${kli.flag}</span><span class="cname">${esc(kli.name)}${kli.isp ? ' · ' + esc(kli.isp) : ''}</span>
          <span class="pill" data-s="${le?.status ?? 'unknown'}"><span class="dot" aria-hidden="true"></span></span>
          <span class="lat mono">${le?.ms != null ? Math.round(le.ms) : '—'}</span>
        </button>`;
    }).join('');
  }

  function renderDiag(diag, openIncident) {
    const items = [];
    if (diag.dns) items.push(`DNS: ${diag.dns.ok ? `resolves in ${diag.dns.ms} ms → <span class="mono">${esc((diag.dns.resolved ?? []).join(', '))}</span> ✓` : `failed (${esc(diag.dns.error ?? 'unknown')})`}`);
    if (diag.ping) items.push(`Ping: ${diag.ping.ok ? `${diag.ping.lossPct ?? 0}% loss, avg ${fmtMs(diag.ping.avgMs)}` : `<b>${diag.ping.lossPct ?? 100}% packet loss</b>`}`);
    if (diag.tcp) items.push(`TCP connect: ${diag.tcp.ok ? `${diag.tcp.ms} ms ✓` : `failed (${esc(diag.tcp.error ?? 'unknown')})`}`);
    if (diag.error) items.push(esc(diag.error));
    let verdict = diag.note ?? '';
    if (!verdict && diag.dns && diag.ping) {
      if (diag.dns.ok && !diag.ping.ok) verdict = 'DNS is clean but the network path drops traffic — points at routing or in-network filtering, not your server.';
      else if (!diag.dns.ok) verdict = 'DNS itself fails from this vantage — users there cannot even find the server.';
    }
    return `<div class="diag">
      <h4>Automatic diagnosis · from ${esc(diag.from ?? 'probe')}${openIncident ? ' · incident ongoing' : ''}</h4>
      <ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>
      ${verdict ? `<div class="verdict">Verdict: ${esc(verdict)}</div>` : ''}
    </div>`;
  }

  function hookTooltip(series) {
    const wrap = $('#bigwrap');
    const tip = $('#tip');
    const svg = wrap.querySelector('svg');
    const maxPts = state.range === '30d' ? 720 : state.range === '7d' ? 168 : 120;
    const pts = series.slice(-maxPts);
    wrap.addEventListener('mousemove', (ev) => {
      if (pts.length === 0) return;
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(((ev.clientX - r.left) / r.width) * (pts.length - 1))));
      const h = pts[i];
      tip.style.display = 'block';
      const when = state.range === '7d' || state.range === '30d' ? fmtDay(h.t) : fmtTime(h.t);
      tip.innerHTML = `<span class="t-time mono">${when}</span> · ${h.ms == null ? esc(h.error ?? 'no response') : Math.round(h.ms) + ' ms'} · ${STATUS_LABEL[h.status]}`;
      tip.style.left = Math.min(ev.clientX - r.left + 12, r.width - 190) + 'px';
      tip.style.top = '10px';
    });
    wrap.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }

  // ---------- countdowns -----------------------------------------------------

  setInterval(() => {
    if (!state.data) return;
    for (const el of document.querySelectorAll('[data-count]')) {
      const t = state.data.targets.find((x) => x.id === el.dataset.count);
      if (!t || !t.enabled || !t.nextRunAt) { el.textContent = ''; continue; }
      const secs = Math.max(0, Math.round((t.nextRunAt - Date.now()) / 1000));
      el.textContent = secs === 0 ? 'checking…' : `next in ${secs} s`;
    }
  }, 1000);

  // ---------- admin modal ----------------------------------------------------

  function openModal(target) {
    state.editing = target;
    const form = $('#target-form');
    $('#modal-title').textContent = target ? 'Edit target' : 'Add URL';
    $('#btn-delete').hidden = !target;
    $('#form-error').hidden = true;
    $('#providers-hint').hidden = true;
    form.name.value = target?.name ?? '';
    form.url.value = target?.url ?? '';
    form.intervalSeconds.value = String(target?.intervalSeconds ?? 300);
    form.degradedMs.value = String(target?.degradedMs ?? 2000);
    form.expectText.value = target?.expectText ?? '';
    state.editLocs = (target?.locations ?? [{ country: 'LOCAL', isp: null }, { country: 'GE', isp: null }, { country: 'DE', isp: null }])
      .map((l) => ({ country: l.country, isp: l.isp }));
    renderLocRows();
    $('#target-overlay').hidden = false;
    form.name.focus();
  }

  function renderLocRows() {
    const opts = (sel) => Object.entries(state.data.countries)
      .map(([code, c]) => `<option value="${code}" ${code === sel ? 'selected' : ''}>${c.flag} ${esc(c.name)}</option>`).join('');
    $('#loc-rows').innerHTML = state.editLocs.map((l, i) => `
      <div class="loc-row">
        <select data-loc-country="${i}" aria-label="Country">${opts(l.country)}</select>
        <input data-loc-isp="${i}" aria-label="Provider (optional)" placeholder="any provider"
          value="${esc(l.isp ?? '')}" ${l.country === 'LOCAL' ? 'disabled' : ''}>
        <button type="button" class="rm" data-loc-rm="${i}" aria-label="Remove location">✕</button>
      </div>`).join('');
    for (const sel of document.querySelectorAll('[data-loc-country]')) {
      sel.onchange = () => {
        const i = Number(sel.dataset.locCountry);
        state.editLocs[i].country = sel.value;
        if (sel.value === 'LOCAL') state.editLocs[i].isp = null;
        renderLocRows();
        if (sel.value !== 'LOCAL') showProviderHint(sel.value, i);
      };
    }
    for (const inp of document.querySelectorAll('[data-loc-isp]')) {
      inp.oninput = () => { state.editLocs[Number(inp.dataset.locIsp)].isp = inp.value.trim() || null; };
      inp.onfocus = () => {
        const l = state.editLocs[Number(inp.dataset.locIsp)];
        if (l.country !== 'LOCAL') showProviderHint(l.country, Number(inp.dataset.locIsp));
      };
    }
    for (const btn of document.querySelectorAll('[data-loc-rm]')) {
      btn.onclick = () => { state.editLocs.splice(Number(btn.dataset.locRm), 1); renderLocRows(); };
    }
  }

  async function showProviderHint(country, rowIdx) {
    const hint = $('#providers-hint');
    state.hintCountry = country;
    hint.hidden = false;
    const cname = (state.data.countries[country] ?? { name: country }).name;
    hint.textContent = `Looking up providers with live probes in ${cname}…`;
    try {
      const res = await fetch(`/api/probes/${country}`);
      const data = await res.json();
      if (state.hintCountry !== country) return; // user moved on
      if (!data.networks) { hint.textContent = `Provider list unavailable (${data.error ?? 'no network access'}). You can still type a provider name.`; return; }
      if (data.networks.length === 0) { hint.textContent = `No probes online in ${cname} right now — checks there will report “No data”.`; return; }
      hint.innerHTML = `Providers with live probes in ${esc(cname)}: ` +
        data.networks.slice(0, 12).map((n) => `<span class="chip" data-fill-isp="${esc(n)}" data-fill-row="${rowIdx}">${esc(n)}</span>`).join('');
      for (const chip of hint.querySelectorAll('[data-fill-isp]')) {
        chip.onclick = () => {
          const i = Number(chip.dataset.fillRow);
          if (state.editLocs[i]) { state.editLocs[i].isp = chip.dataset.fillIsp; renderLocRows(); }
        };
      }
    } catch {
      if (state.hintCountry === country) hint.textContent = 'Provider list unavailable. You can still type a provider name.';
    }
  }

  async function submitModal(ev) {
    ev.preventDefault();
    const form = $('#target-form');
    const body = {
      name: form.name.value,
      url: form.url.value,
      intervalSeconds: Number(form.intervalSeconds.value),
      degradedMs: Number(form.degradedMs.value),
      expectText: form.expectText.value,
      locations: state.editLocs,
    };
    const res = state.editing
      ? await fetch(`/api/targets/${state.editing.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      : await fetch('/api/targets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ errors: ['request failed'] }));
      $('#form-error').hidden = false;
      $('#form-error').textContent = (err.errors ?? ['request failed']).join('. ');
      return;
    }
    const saved = await res.json();
    $('#target-overlay').hidden = true;
    if (!state.editing) state.tab = saved.id;
    state.editing = null;
    await refresh();
  }

  // ---------- data -----------------------------------------------------------

  async function refresh() {
    const res = await fetch('/api/state');
    if (res.status === 401) { $('#login-overlay').hidden = false; $('#login-form').password.focus(); return; }
    $('#login-overlay').hidden = true;
    state.data = await res.json();
    if (state.tab !== 'overview' && !state.data.targets.some((t) => t.id === state.tab)) state.tab = 'overview';
    render();
  }

  function applyResultEvent(msg) {
    const t = state.data?.targets.find((x) => x.id === msg.targetId);
    if (!t) return;
    t.nextRunAt = msg.nextRunAt;
    for (const { key, entry, uptime24h } of msg.results) {
      const slot = t.results[key];
      if (!slot) continue;
      slot.history.push(entry);
      if (slot.history.length > 60) slot.history.shift();
      slot.uptime24h = uptime24h;
    }
    if (state.focus && state.focus.targetId === t.id && state.focusData) {
      const mine = msg.results.find((r) => r.key === state.focus.key);
      if (mine) state.focusData.raw.push(mine.entry);
    }
    render();
  }

  function connectEvents() {
    const es = new EventSource('/api/events');
    es.addEventListener('result', (ev) => applyResultEvent(JSON.parse(ev.data)));
    es.addEventListener('config', () => refresh());
    es.addEventListener('incident', () => refresh());
  }

  // ---------- event wiring ---------------------------------------------------

  document.addEventListener('click', async (ev) => {
    const tab = ev.target.closest('[data-tab]');
    if (tab) { state.tab = tab.dataset.tab; render(); return; }

    const open = ev.target.closest('[data-open-target]');
    if (open) { state.tab = open.dataset.openTarget; render(); return; }

    const focus = ev.target.closest('[data-focus-target]');
    if (focus) {
      state.focus = { targetId: focus.dataset.focusTarget, key: focus.dataset.focusKey };
      state.focusData = null;
      renderFocus();
      loadFocusData();
      return;
    }
    const check = ev.target.closest('[data-check]');
    if (check) { await fetch(`/api/targets/${check.dataset.check}/check`, { method: 'POST' }); return; }

    const pause = ev.target.closest('[data-pause]');
    if (pause) {
      const t = state.data.targets.find((x) => x.id === pause.dataset.pause);
      await fetch(`/api/targets/${t.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !t.enabled }) });
      return;
    }
    const edit = ev.target.closest('[data-edit]');
    if (edit) { openModal(state.data.targets.find((x) => x.id === edit.dataset.edit)); return; }

    if (ev.target === $('#focus-overlay')) { state.focus = null; state.focusData = null; renderFocus(); }
    if (ev.target === $('#target-overlay')) { $('#target-overlay').hidden = true; state.editing = null; }
    if (ev.target === $('#settings-overlay')) { $('#settings-overlay').hidden = true; }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!$('#settings-overlay').hidden) { $('#settings-overlay').hidden = true; }
    else if (!$('#target-overlay').hidden) { $('#target-overlay').hidden = true; state.editing = null; }
    else if (state.focus) { state.focus = null; state.focusData = null; renderFocus(); }
  });

  $('#btn-add').onclick = () => openModal(null);
  $('#btn-add-loc').onclick = () => { state.editLocs.push({ country: 'GE', isp: null }); renderLocRows(); };
  $('#btn-cancel').onclick = () => { $('#target-overlay').hidden = true; state.editing = null; };
  $('#target-form').onsubmit = submitModal;
  $('#btn-delete').onclick = async () => {
    if (!state.editing) return;
    if (!confirm(`Stop monitoring "${state.editing.name}" and delete its history?`)) return;
    await fetch(`/api/targets/${state.editing.id}`, { method: 'DELETE' });
    $('#target-overlay').hidden = true;
    state.editing = null;
    state.tab = 'overview';
    await refresh();
  };
  $('#btn-grid').onclick = () => { state.view = 'grid'; syncSeg(); render(); };
  $('#btn-list').onclick = () => { state.view = 'list'; syncSeg(); render(); };
  const syncSeg = () => {
    $('#btn-grid').setAttribute('aria-pressed', String(state.view === 'grid'));
    $('#btn-list').setAttribute('aria-pressed', String(state.view === 'list'));
  };
  $('#provider').onchange = async (ev) => {
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: ev.target.value === 'simulated' ? 'simulated' : 'auto' }) });
  };

  // ---------- settings modal -------------------------------------------------

  $('#btn-settings').onclick = () => {
    const form = $('#settings-form');
    const s = state.data.settings;
    form.webhookUrl.value = s.alerts?.webhookUrl ?? '';
    form.minConsecutiveFails.value = String(s.alerts?.minConsecutiveFails ?? 2);
    form.alertsEnabled.checked = s.alerts?.enabled !== false;
    form.globalpingToken.value = s.globalpingToken ?? '';
    $('#settings-error').hidden = true;
    $('#test-result').textContent = '';
    $('#settings-overlay').hidden = false;
    form.webhookUrl.focus();
  };
  $('#btn-settings-cancel').onclick = () => { $('#settings-overlay').hidden = true; };
  $('#settings-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const form = $('#settings-form');
    const res = await fetch('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        globalpingToken: form.globalpingToken.value,
        alerts: {
          webhookUrl: form.webhookUrl.value,
          minConsecutiveFails: Number(form.minConsecutiveFails.value),
          enabled: form.alertsEnabled.checked,
        },
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ errors: ['request failed'] }));
      $('#settings-error').hidden = false;
      $('#settings-error').textContent = (err.errors ?? ['request failed']).join('. ');
      return;
    }
    $('#settings-overlay').hidden = true;
    await refresh();
  };
  $('#btn-test-alert').onclick = async () => {
    const out = $('#test-result');
    // save the webhook first so the test uses what's in the box
    const form = $('#settings-form');
    await fetch('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alerts: { webhookUrl: form.webhookUrl.value } }),
    });
    out.textContent = 'sending…'; out.className = 'test-result';
    const res = await fetch('/api/alerts/test', { method: 'POST' });
    if (res.ok) { out.textContent = 'delivered ✓'; out.className = 'test-result ok'; }
    else {
      const err = await res.json().catch(() => ({}));
      out.textContent = `failed: ${(err.errors ?? ['unreachable']).join(', ')}`;
      out.className = 'test-result fail';
    }
  };

  // ---------- login ----------------------------------------------------------

  $('#login-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('#login-form').password.value }),
    });
    if (!res.ok) {
      $('#login-error').hidden = false;
      $('#login-error').textContent = 'Wrong password.';
      return;
    }
    location.reload(); // fresh boot with the session cookie (also reconnects SSE)
  };

  // ---------- boot -----------------------------------------------------------

  refresh().then(connectEvents);
})();
