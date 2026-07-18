/* MirNin Monitor dashboard: renders live state from /api/state + /api/events. */
(() => {
  const $ = (q, el = document) => el.querySelector(q);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const STATUS_LABEL = { up: 'Operational', degraded: 'Degraded', down: 'Down', unknown: 'No data' };
  const STATUS_RANK = { down: 0, degraded: 1, unknown: 2, up: 3 };
  const HIST_POINTS = 40;

  const state = {
    data: null,          // /api/state payload
    tab: 'overview',     // 'overview' | targetId
    view: 'grid',        // 'grid' | 'list'
    focus: null,         // { targetId, country } | null
    editing: null,       // target being edited in the modal, or null
    chipSel: new Set(),  // selected countries in the modal
  };

  // ---------- helpers --------------------------------------------------------

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtMs = (ms) => (ms == null ? '—' : `${ms} ms`);
  const fmtUptime = (u) => (u == null ? '—' : `${u.toFixed(u >= 99.995 ? 0 : 2)}%`);
  const intervalLabel = (s) => (s < 60 ? `${s} s` : s < 3600 ? `${s / 60} min` : `${s / 3600} h`);

  function latest(target, country) {
    const h = target.results?.[country]?.history ?? [];
    return h[h.length - 1] ?? null;
  }

  function worstStatus(target) {
    let worst = null;
    for (const c of target.countries) {
      const s = latest(target, c)?.status;
      if (s && (worst == null || STATUS_RANK[s] < STATUS_RANK[worst])) worst = s;
    }
    return worst ?? 'unknown';
  }

  function medianLatency(target) {
    const v = target.countries.map((c) => latest(target, c)?.ms).filter((x) => x != null).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  }

  function p95(target, country) {
    const v = (target.results?.[country]?.history ?? []).map((e) => e.ms).filter((x) => x != null).sort((a, b) => a - b);
    return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.95))] : null;
  }

  const pill = (s) => `<span class="pill" data-s="${s}"><span class="dot" aria-hidden="true"></span>${STATUS_LABEL[s]}</span>`;
  const countryOf = (code) => state.data.countries[code] ?? { name: code, flag: '' };

  // ---------- sparkline ------------------------------------------------------

  function sparkSVG(history, w, h, big) {
    const hist = history.slice(-HIST_POINTS);
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
    const hasRemote = state.data.targets.some((t) => t.countries.some((c) => c !== 'LOCAL'));
    if (!gp.available && state.data.settings.provider !== 'simulated' && hasRemote) {
      note.hidden = false;
      note.textContent = 'Probe network unreachable — country checks show “No data” until it recovers';
    } else {
      note.hidden = true;
    }
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
    const tiles = [];
    for (const t of state.data.targets) {
      if (state.tab !== 'overview' && state.tab !== t.id) continue;
      for (const c of t.countries) tiles.push(latest(t, c)?.status ?? 'unknown');
    }
    const count = (s) => tiles.filter((x) => x === s).length;
    const lat = [];
    for (const t of state.data.targets) {
      if (state.tab !== 'overview' && state.tab !== t.id) continue;
      for (const c of t.countries) {
        const ms = latest(t, c)?.ms;
        if (ms != null) lat.push(ms);
      }
    }
    lat.sort((a, b) => a - b);
    const median = lat.length ? lat[Math.floor(lat.length / 2)] : null;
    $('#summary').innerHTML = state.data.targets.length === 0 ? '' : `
      <div class="stat"><div class="label">Operational</div><div class="value">${count('up')}<small> / ${tiles.length} probes</small></div></div>
      <div class="stat"><div class="label">Degraded</div><div class="value ${count('degraded') ? 'warn-c' : ''}">${count('degraded')}</div></div>
      <div class="stat"><div class="label">Down</div><div class="value ${count('down') ? 'crit-c' : ''}">${count('down')}</div></div>
      <div class="stat"><div class="label">No data</div><div class="value">${count('unknown')}</div></div>
      <div class="stat"><div class="label">Median latency</div><div class="value">${median ?? '—'}<small> ms</small></div></div>`;
  }

  function renderMain() {
    const main = $('#main');
    if (state.data.targets.length === 0) {
      main.innerHTML = `
        <div class="empty">
          <h2>No URLs monitored yet</h2>
          <p>Add the first URL you want to watch — your platform's home page or a health endpoint — pick the countries to check from, and how often.</p>
          <button class="primary" id="empty-add">+ Add URL</button>
        </div>`;
      $('#empty-add').onclick = () => openModal(null);
      $('#foot').textContent = '';
      return;
    }
    if (state.view === 'list') { renderList(main); return; }
    if (state.tab === 'overview') renderOverview(main);
    else renderTarget(main, state.data.targets.find((t) => t.id === state.tab));
    $('#foot').textContent = 'Click any tile to pin it and see its full history. Tabs switch between monitored URLs.';
  }

  function renderOverview(main) {
    main.innerHTML = `<div class="grid">${state.data.targets.map((t) => {
      const s = worstStatus(t);
      const med = medianLatency(t);
      const host = new URL(t.url).host;
      return `
        <button class="tile" data-status="${s}" data-open-target="${t.id}">
          <span class="tile-head"><span class="cname">${esc(t.name)}</span><span class="ccode mono">${esc(host)}</span></span>
          <span class="tile-metric"><span class="lat mono">${med ?? '—'}</span><span class="unit">ms</span>${pill(s)}</span>
          <span class="ov-countries">${t.countries.map((c) => `
            <span class="cdot"><i data-s="${latest(t, c)?.status ?? 'unknown'}"></i>${c === 'LOCAL' ? 'local' : c}</span>`).join('')}
          </span>
          <span class="tile-foot"><span>every ${intervalLabel(t.intervalSeconds)}${t.enabled ? '' : ' · paused'}</span><span class="countdown" data-count="${t.id}"></span></span>
        </button>`;
    }).join('')}</div>`;
  }

  function renderTarget(main, t) {
    if (!t) { state.tab = 'overview'; renderMain(); return; }
    main.innerHTML = `
      <div class="target-bar">
        <span class="url mono">${esc(t.url)}</span>
        <span>· every ${intervalLabel(t.intervalSeconds)}</span>
        <span class="countdown" data-count="${t.id}"></span>
        <span class="actions">
          <button class="ghost" data-check="${t.id}">Check now</button>
          <button class="ghost" data-pause="${t.id}">${t.enabled ? 'Pause' : 'Resume'}</button>
          <button class="ghost" data-edit="${t.id}">Edit</button>
        </span>
      </div>
      <div class="grid">${t.countries.map((c) => {
        const e = latest(t, c);
        const s = e?.status ?? 'unknown';
        const info = countryOf(c);
        return `
          <button class="tile" data-status="${s}" data-focus-target="${t.id}" data-focus-country="${c}">
            <span class="tile-head"><span class="flag" aria-hidden="true">${info.flag}</span><span class="cname">${esc(info.name)}</span>
              <span class="ccode mono">${esc(e?.city ?? '')}</span></span>
            <span class="tile-metric"><span class="lat mono">${e?.ms ?? '—'}</span><span class="unit">ms</span>${pill(s)}</span>
            ${sparkSVG(t.results?.[c]?.history ?? [], 200, 36, false)}
            ${e?.error ? `<span class="tile-err" title="${esc(e.error)}">${esc(e.error)}</span>` : ''}
            <span class="tile-foot"><span>uptime ${fmtUptime(t.results?.[c]?.uptime24h)}</span><span>${e ? fmtTime(e.t) : 'waiting for first check'}</span></span>
          </button>`;
      }).join('')}</div>`;
  }

  function renderList(main) {
    const rows = [];
    for (const t of state.data.targets) {
      if (state.tab !== 'overview' && state.tab !== t.id) continue;
      for (const c of t.countries) {
        const e = latest(t, c);
        const info = countryOf(c);
        rows.push(`
          <tr data-clickable data-focus-target="${t.id}" data-focus-country="${c}">
            <td>${esc(t.name)}</td>
            <td>${info.flag} ${esc(info.name)}</td>
            <td>${pill(e?.status ?? 'unknown')}</td>
            <td class="num mono">${fmtMs(e?.ms)}</td>
            <td class="num mono">${fmtMs(p95(t, c))}</td>
            <td class="num mono">${fmtUptime(t.results?.[c]?.uptime24h)}</td>
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
            <th class="num">Uptime 24 h</th><th class="num">Last check</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>`;
    $('#foot').textContent = 'Click a row to open its full history.';
  }

  // ---------- focus overlay --------------------------------------------------

  function renderFocus() {
    const overlay = $('#focus-overlay');
    if (!state.focus) { overlay.hidden = true; return; }
    const t = state.data.targets.find((x) => x.id === state.focus.targetId);
    if (!t || !t.countries.includes(state.focus.country)) { state.focus = null; overlay.hidden = true; return; }
    const c = state.focus.country;
    const info = countryOf(c);
    const hist = t.results?.[c]?.history ?? [];
    const e = hist[hist.length - 1];
    const s = e?.status ?? 'unknown';

    overlay.hidden = false;
    $('#focus-main').innerHTML = `
      <div class="focus-head">
        <span class="flag" aria-hidden="true">${info.flag}</span>
        <div><h2>${esc(info.name)}</h2>
          <div class="probe">${esc(t.name)} · ${esc(t.url)}${e?.city ? ` · probe: ${esc(e.city)}` : ''}</div></div>
        <button class="ghost close" id="focus-close">Close</button>
      </div>
      <div class="focus-stats">
        <div class="fs"><div class="label">Status</div><div class="value">${pill(s)}</div></div>
        <div class="fs"><div class="label">Latency</div><div class="value mono">${fmtMs(e?.ms)}</div></div>
        <div class="fs"><div class="label">p95 · recent</div><div class="value mono">${fmtMs(p95(t, c))}</div></div>
        <div class="fs"><div class="label">Uptime · 24 h</div><div class="value mono">${fmtUptime(t.results?.[c]?.uptime24h)}</div></div>
      </div>
      <div class="bigchart-wrap" id="bigwrap">${sparkSVG(hist, 720, 190, true)}<div class="chart-tip" id="tip"></div></div>
      <div class="log"><h3>Recent checks</h3>
        <table><thead><tr><th>Time</th><th>Result</th><th class="num">Latency</th><th class="num">Response</th></tr></thead>
        <tbody>${hist.slice(-10).reverse().map((h) => `
          <tr><td class="mono">${fmtTime(h.t)}</td><td>${pill(h.status)}</td>
          <td class="num mono">${fmtMs(h.ms)}</td>
          <td class="num mono">${h.httpCode != null ? 'HTTP ' + h.httpCode : esc(h.error ?? '—')}</td></tr>`).join('')}
        </tbody></table>
      </div>`;
    $('#focus-close').onclick = () => { state.focus = null; renderFocus(); };
    hookTooltip(hist);

    $('#focus-strip').innerHTML = t.countries.map((x) => {
      const le = latest(t, x);
      const xi = countryOf(x);
      return `
        <button class="strip-tile" data-focus-target="${t.id}" data-focus-country="${x}" aria-current="${x === c}">
          <span aria-hidden="true">${xi.flag}</span><span class="cname">${esc(xi.name)}</span>
          <span class="pill" data-s="${le?.status ?? 'unknown'}"><span class="dot" aria-hidden="true"></span></span>
          <span class="lat mono">${le?.ms ?? '—'}</span>
        </button>`;
    }).join('');
  }

  function hookTooltip(hist) {
    const wrap = $('#bigwrap');
    const tip = $('#tip');
    const svg = wrap.querySelector('svg');
    const pts = hist.slice(-HIST_POINTS);
    wrap.addEventListener('mousemove', (ev) => {
      if (pts.length === 0) return;
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(((ev.clientX - r.left) / r.width) * (pts.length - 1))));
      const h = pts[i];
      tip.style.display = 'block';
      tip.innerHTML = `<span class="t-time mono">${fmtTime(h.t)}</span> · ${h.ms == null ? esc(h.error ?? 'no response') : h.ms + ' ms'} · ${STATUS_LABEL[h.status]}`;
      tip.style.left = Math.min(ev.clientX - r.left + 12, r.width - 180) + 'px';
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
    form.name.value = target?.name ?? '';
    form.url.value = target?.url ?? '';
    form.intervalSeconds.value = String(target?.intervalSeconds ?? 300);
    form.degradedMs.value = String(target?.degradedMs ?? 2000);
    state.chipSel = new Set(target?.countries ?? ['LOCAL', 'GE', 'DE', 'US']);
    renderChips();
    $('#target-overlay').hidden = false;
    form.name.focus();
  }

  function renderChips() {
    $('#country-chips').innerHTML = Object.entries(state.data.countries).map(([code, c]) => `
      <button type="button" data-chip="${code}" aria-pressed="${state.chipSel.has(code)}">${c.flag} ${esc(c.name)}</button>`).join('');
  }

  async function submitModal(ev) {
    ev.preventDefault();
    const form = $('#target-form');
    const body = {
      name: form.name.value,
      url: form.url.value,
      intervalSeconds: Number(form.intervalSeconds.value),
      degradedMs: Number(form.degradedMs.value),
      countries: [...state.chipSel],
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
    state.data = await res.json();
    if (state.tab !== 'overview' && !state.data.targets.some((t) => t.id === state.tab)) state.tab = 'overview';
    render();
  }

  function applyResultEvent(msg) {
    const t = state.data?.targets.find((x) => x.id === msg.targetId);
    if (!t) return;
    t.nextRunAt = msg.nextRunAt;
    for (const { country, entry, uptime24h } of msg.results) {
      const slot = (t.results[country] ??= { history: [], uptime24h: null });
      slot.history.push(entry);
      if (slot.history.length > 60) slot.history.shift();
      slot.uptime24h = uptime24h;
    }
    render();
  }

  function connectEvents() {
    const es = new EventSource('/api/events');
    es.addEventListener('result', (ev) => applyResultEvent(JSON.parse(ev.data)));
    es.addEventListener('config', () => refresh());
  }

  // ---------- event wiring ---------------------------------------------------

  document.addEventListener('click', async (ev) => {
    const chip = ev.target.closest('[data-chip]');
    if (chip) {
      const code = chip.dataset.chip;
      state.chipSel.has(code) ? state.chipSel.delete(code) : state.chipSel.add(code);
      chip.setAttribute('aria-pressed', String(state.chipSel.has(code)));
      return;
    }
    const tab = ev.target.closest('[data-tab]');
    if (tab) { state.tab = tab.dataset.tab; render(); return; }

    const open = ev.target.closest('[data-open-target]');
    if (open) { state.tab = open.dataset.openTarget; render(); return; }

    const focus = ev.target.closest('[data-focus-target]');
    if (focus) {
      state.focus = { targetId: focus.dataset.focusTarget, country: focus.dataset.focusCountry };
      renderFocus();
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

    if (ev.target === $('#focus-overlay')) { state.focus = null; renderFocus(); }
    if (ev.target === $('#target-overlay')) { $('#target-overlay').hidden = true; state.editing = null; }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!$('#target-overlay').hidden) { $('#target-overlay').hidden = true; state.editing = null; }
    else if (state.focus) { state.focus = null; renderFocus(); }
  });

  $('#btn-add').onclick = () => openModal(null);
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

  // ---------- boot -----------------------------------------------------------

  refresh().then(connectEvents);
})();
