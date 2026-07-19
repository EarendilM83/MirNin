/* MirNin Monitor dashboard: projects → categories → URLs, live over SSE. */
(() => {
  const $ = (q, el = document) => el.querySelector(q);
  const $$ = (q, el = document) => [...el.querySelectorAll(q)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const STATUS_LABEL = { up: 'Operational', degraded: 'Degraded', down: 'Down', unknown: 'No data' };
  const STATUS_RANK = { down: 0, degraded: 1, unknown: 2, up: 3 };
  const HIST_POINTS = 40;
  const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };
  const CERT_WARN_DAYS = 21;
  const RULE_KEYS = ['passedCodes', 'degradedCodes', 'treat403', 'latencyMode', 'latencyMs', 'adaptiveFactor', 'timeoutMs', 'contentFail'];

  const state = {
    data: null,
    nav: { scope: 'all', projectId: null, categoryId: null, targetId: null },
    lens: 'dash',            // 'dash' | 'stats'
    view: 'grid',            // 'grid' | 'list'
    sideOpen: new Set(),
    stats: null, statsKey: null, statsAt: 0,
    focus: null, range: '1h', focusData: null,
    editing: null, editLocs: [], hintCountry: null,
    cmdkSel: 0,
  };

  // ---------- helpers --------------------------------------------------------

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
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

  const projects = () => state.data.projects ?? [];
  const categories = (projectId) => (state.data.categories ?? []).filter((c) => !projectId || c.projectId === projectId);
  const categoryById = (id) => (state.data.categories ?? []).find((c) => c.id === id);
  const projectById = (id) => projects().find((p) => p.id === id);
  const projectOfTarget = (t) => projectById(categoryById(t.categoryId)?.projectId);
  const targetById = (id) => state.data.targets.find((t) => t.id === id);

  function targetsInScope(nav = state.nav) {
    return state.data.targets.filter((t) => {
      if (nav.targetId) return t.id === nav.targetId;
      if (nav.scope === 'category') return t.categoryId === nav.categoryId;
      if (nav.scope === 'project') return categoryById(t.categoryId)?.projectId === nav.projectId;
      return true;
    });
  }

  function locLabel(loc) {
    const c = state.data.countries[loc.country] ?? { name: loc.country, flag: '' };
    return { flag: c.flag, name: c.name, isp: loc.isp };
  }

  const tiles = (t) => Object.entries(t.results ?? {});
  const latestOf = (slot) => slot.history[slot.history.length - 1] ?? null;

  function worstStatus(t) {
    let worst = null;
    for (const [, slot] of tiles(t)) {
      const s = latestOf(slot)?.status;
      if (s && (worst == null || STATUS_RANK[s] < STATUS_RANK[worst])) worst = s;
    }
    return worst ?? 'unknown';
  }

  function worstOfTargets(list) {
    let worst = null;
    for (const t of list) {
      const s = worstStatus(t);
      if (worst == null || STATUS_RANK[s] < STATUS_RANK[worst]) worst = s;
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

  // ---------- navigation -----------------------------------------------------

  function setNav(nav, lens) {
    state.nav = { scope: 'all', projectId: null, categoryId: null, targetId: null, ...nav };
    if (lens) state.lens = lens;
    if (state.nav.projectId) state.sideOpen.add(state.nav.projectId);
    if (state.nav.categoryId) {
      const c = categoryById(state.nav.categoryId);
      if (c) { state.nav.projectId = c.projectId; state.sideOpen.add(c.projectId); }
    }
    if (state.nav.targetId) {
      const t = targetById(state.nav.targetId);
      if (t) {
        state.nav.categoryId = t.categoryId;
        state.nav.projectId = categoryById(t.categoryId)?.projectId ?? null;
        if (state.nav.projectId) state.sideOpen.add(state.nav.projectId);
      }
      state.lens = 'dash';
    }
    render();
  }

  // ---------- rendering ------------------------------------------------------

  function render() {
    if (!state.data) return;
    renderHeader();
    renderSidebar();
    renderCrumb();
    renderLens();
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

  function renderSidebar() {
    const nav = state.nav;
    let html = `<button class="side-item" data-nav-all aria-current="${nav.scope === 'all' && !nav.targetId}">
      <span class="sdot" data-s="${worstOfTargets(state.data.targets)}"></span><span class="sname">All projects</span></button>
      <div class="side-sep"></div>`;
    for (const p of projects()) {
      const pTargets = state.data.targets.filter((t) => categoryById(t.categoryId)?.projectId === p.id);
      const open = state.sideOpen.has(p.id);
      html += `<button class="side-item" data-nav-proj="${p.id}"
          aria-current="${nav.scope === 'project' && nav.projectId === p.id && !nav.targetId}">
        <span class="sdot" data-s="${worstOfTargets(pTargets)}"></span>
        <span class="sname">${esc(p.name)}</span>
        <span class="chev ${open ? 'open' : ''}" data-toggle-proj="${p.id}">▸</span></button>`;
      if (open) {
        html += '<div class="side-cats">';
        for (const c of categories(p.id)) {
          const cTargets = state.data.targets.filter((t) => t.categoryId === c.id);
          html += `<button class="side-item cat" data-nav-cat="${c.id}"
              aria-current="${nav.scope === 'category' && nav.categoryId === c.id && !nav.targetId}">
            <span class="sdot" data-s="${worstOfTargets(cTargets)}"></span>
            <span class="sname">${esc(c.name)}</span>
            <span class="cat-meta">${cTargets.length || ''}</span></button>`;
        }
        html += `<button class="side-add" data-add-cat="${p.id}">+ category</button></div>`;
      }
    }
    html += `<div class="side-sep"></div><button class="side-add" data-add-proj>+ New project</button>`;
    $('#sidebar').innerHTML = html;
  }

  function renderCrumb() {
    const { projectId, categoryId, targetId, scope } = state.nav;
    const parts = [`<a href="#" data-nav-all>All projects</a>`];
    if (projectId && scope !== 'all') parts.push(`<a href="#" data-nav-proj="${projectId}">${esc(projectById(projectId)?.name ?? '')}</a>`);
    if (categoryId && (scope === 'category' || targetId)) parts.push(`<a href="#" data-nav-cat="${categoryId}">${esc(categoryById(categoryId)?.name ?? '')}</a>`);
    if (targetId) parts.push(`<span class="cur">${esc(targetById(targetId)?.name ?? '')}</span>`);
    else if (parts.length > 1) parts[parts.length - 1] = parts[parts.length - 1].replace('<a ', '<a class="cur" ');
    $('#crumb').innerHTML = parts.join(' <span aria-hidden="true">/</span> ');
  }

  function renderLens() {
    const inTarget = Boolean(state.nav.targetId);
    $('#lens').style.visibility = inTarget ? 'hidden' : 'visible';
    for (const b of $$('#lens [data-lens]')) b.setAttribute('aria-pressed', String(state.lens === b.dataset.lens));
    $('#layout-seg').style.visibility = inTarget || state.lens === 'stats' ? 'hidden' : 'visible';
    $('#btn-grid').setAttribute('aria-pressed', String(state.view === 'grid'));
    $('#btn-list').setAttribute('aria-pressed', String(state.view === 'list'));
  }

  function renderSummary() {
    if (state.lens === 'stats' && !state.nav.targetId) { $('#summary').innerHTML = ''; return; }
    const scoped = targetsInScope();
    const statuses = scoped.flatMap((t) => tiles(t).map(([, s]) => latestOf(s)?.status ?? 'unknown'));
    if (statuses.length === 0) { $('#summary').innerHTML = ''; return; }
    const count = (s) => statuses.filter((x) => x === s).length;
    const lat = scoped.flatMap((t) => tiles(t).map(([, s]) => latestOf(s)?.ms)).filter((x) => x != null).sort((a, b) => a - b);
    const median = lat.length ? lat[Math.floor(lat.length / 2)] : null;
    $('#summary').innerHTML = `
      <div class="stat"><div class="label">Operational</div><div class="value">${count('up')}<small> / ${statuses.length} probes</small></div></div>
      <div class="stat"><div class="label">Degraded</div><div class="value ${count('degraded') ? 'warn-c' : ''}">${count('degraded')}</div></div>
      <div class="stat"><div class="label">Down</div><div class="value ${count('down') ? 'crit-c' : ''}">${count('down')}</div></div>
      <div class="stat"><div class="label">No data</div><div class="value">${count('unknown')}</div></div>
      <div class="stat"><div class="label">Median latency</div><div class="value">${median != null ? Math.round(median) : '—'}<small> ms</small></div></div>`;
  }

  function renderMain() {
    const main = $('#main');
    if (state.data.targets.length === 0 && state.nav.scope === 'all') {
      main.innerHTML = `
        <div class="empty">
          <h2>No URLs monitored yet</h2>
          <p>Add the first URL you want to watch — your platform's home page or a health endpoint — pick countries (optionally specific providers like Magti or Silknet), and how often to check.</p>
          <button class="primary" id="empty-add">+ Add URL</button>
        </div>`;
      $('#empty-add').onclick = () => openTargetModal(null);
      $('#foot').textContent = '';
      return;
    }
    if (state.nav.targetId) {
      const t = targetById(state.nav.targetId);
      if (!t) { setNav({ scope: 'all' }); return; }
      renderTargetView(main, t);
      return;
    }
    if (state.lens === 'stats') { renderStats(main); return; }
    if (state.view === 'list') { renderList(main); return; }
    if (state.nav.scope === 'all') renderDashAll(main);
    else renderDashProject(main);
    $('#foot').textContent = 'Click a card to drill in. ⌘K jumps anywhere.';
  }

  // ---------- dashboards -----------------------------------------------------

  function renderDashAll(main) {
    main.innerHTML = `<div class="grid">${projects().map((p) => {
      const pTargets = state.data.targets.filter((t) => categoryById(t.categoryId)?.projectId === p.id);
      const s = worstOfTargets(pTargets);
      const lat = pTargets.map(medianLatency).filter((x) => x != null).sort((a, b) => a - b);
      const med = lat.length ? lat[Math.floor(lat.length / 2)] : null;
      const openInc = pTargets.reduce((a, t) => a + (t.incidents ?? []).filter((i) => i.endT == null).length, 0);
      return `
        <button class="tile proj-card" data-status="${s}" data-nav-proj="${p.id}">
          <span class="tile-head"><span class="cname">${esc(p.name)}</span>
            <span class="ccode mono">${pTargets.length} URL${pTargets.length === 1 ? '' : 's'}</span></span>
          <span class="tile-metric"><span class="lat mono">${med != null ? Math.round(med) : '—'}</span><span class="unit">ms</span>${pill(s)}</span>
          ${openInc ? `<span class="badge block">${openInc} open incident${openInc > 1 ? 's' : ''}</span>` : ''}
          <span class="cats-row">${categories(p.id).map((c) => {
            const ct = state.data.targets.filter((t) => t.categoryId === c.id);
            return `<span class="cdot"><i class="sdot" data-s="${worstOfTargets(ct)}"></i>${esc(c.name)}</span>`;
          }).join('')}</span>
          <span class="tile-foot"><span>${pTargets.filter((t) => worstStatus(t) === 'up').length} healthy · ${pTargets.filter((t) => ['down', 'degraded'].includes(worstStatus(t))).length} with issues</span></span>
        </button>`;
    }).join('')}</div>`;
  }

  function targetCard(t) {
    const s = worstStatus(t);
    const med = medianLatency(t);
    const divs = divergences(t);
    const cert = minCertDays(t);
    let host = t.url;
    try { host = new URL(t.url).host; } catch { /* keep raw */ }
    return `
      <button class="tile" data-status="${s}" data-nav-target="${t.id}">
        <span class="tile-head"><span class="cname">${esc(t.name)}</span><span class="ccode mono">${esc(host)}</span></span>
        <span class="tile-metric"><span class="lat mono">${med != null ? Math.round(med) : '—'}</span><span class="unit">ms</span>${pill(s)}</span>
        ${divs.length ? `<span class="badge block">ISP split in ${divs.map((d) => d.country).join(', ')}</span>` : ''}
        ${cert != null && cert < CERT_WARN_DAYS ? `<span class="badge cert">cert expires in ${cert} d</span>` : ''}
        <span class="ov-countries">${tiles(t).map(([key, slot]) => `
          <span class="cdot"><i data-s="${latestOf(slot)?.status ?? 'unknown'}"></i>${slot.loc.country === 'LOCAL' ? 'local' : esc(slot.loc.country + (slot.loc.isp ? '·' + slot.loc.isp : ''))}</span>`).join('')}
        </span>
        <span class="tile-foot"><span>every ${intervalLabel(t.intervalSeconds)}${t.enabled ? '' : ' · paused'}</span><span class="countdown" data-count="${t.id}"></span></span>
      </button>`;
  }

  function renderDashProject(main) {
    const { scope, projectId, categoryId } = state.nav;
    const cats = scope === 'category' ? [categoryById(categoryId)].filter(Boolean) : categories(projectId);
    const p = projectById(projectId);
    main.innerHTML = `
      ${p ? `<div class="target-bar"><span>${p.webhookUrl ? 'Alerts → project webhook' : 'Alerts → global webhook'}</span>
        <span class="actions"><button class="ghost" data-edit-proj="${p.id}">Project settings</button></span></div>` : ''}
      ${cats.map((c) => {
        const cTargets = state.data.targets.filter((t) => t.categoryId === c.id);
        return `
        <section class="cat-section">
          <div class="cat-head">
            <h3>${esc(c.name)}</h3>
            <span class="cat-meta">${cTargets.length} URL${cTargets.length === 1 ? '' : 's'}</span>
            <span class="cat-actions">
              <button class="mini" data-add-url-cat="${c.id}">+ URL</button>
              <button class="mini" data-edit-cat="${c.id}">rename</button>
              ${cTargets.length === 0 ? `<button class="mini" data-del-cat="${c.id}">delete</button>` : ''}
            </span>
          </div>
          ${cTargets.length === 0
            ? '<p class="none-note">No URLs yet — add the first one.</p>'
            : `<div class="grid">${cTargets.map(targetCard).join('')}</div>`}
        </section>`;
      }).join('')}`;
  }

  // ---------- target view (location tiles) -----------------------------------

  function locTileHTML(t, key, slot) {
    const e = latestOf(slot);
    const s = e?.status ?? 'unknown';
    const li = locLabel(slot.loc);
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

  function renderTargetView(main, t) {
    const incidents = t.incidents ?? [];
    const customRules = Object.keys(t.rules ?? {}).length;
    main.innerHTML = `
      <div class="target-bar">
        <span class="url mono">${esc(t.url)}</span>
        <span>· every ${intervalLabel(t.intervalSeconds)}</span>
        ${t.expectText ? `<span>· expects “${esc(t.expectText)}”</span>` : ''}
        ${customRules ? `<span>· <span class="rules-note-custom">${customRules} custom rule${customRules > 1 ? 's' : ''}</span></span>` : ''}
        <span class="countdown" data-count="${t.id}"></span>
        <span class="actions">
          <button class="ghost" data-check="${t.id}">Check now</button>
          <button class="ghost" data-pause="${t.id}">${t.enabled ? 'Pause' : 'Resume'}</button>
          <button class="ghost" data-edit="${t.id}">Edit</button>
        </span>
      </div>
      ${divergeBanner(t)}
      <div class="grid">${tiles(t).map(([key, slot]) => locTileHTML(t, key, slot)).join('')}</div>
      <div class="incidents">
        <h3>Recent incidents</h3>
        ${incidents.length === 0 ? '<p class="none-note">No incidents recorded for this target.</p>' : `
        <div class="list-card"><table>
          <thead><tr><th>Started</th><th>Duration</th><th>Location</th><th>What failed</th></tr></thead>
          <tbody>${incidents.map((i) => {
            const loc = t.results[i.loc]?.loc ?? { country: i.loc, isp: null };
            const li = locLabel(loc);
            return `<tr>
              <td class="mono">${fmtDay(i.startT)}</td>
              <td class="mono">${i.endT ? fmtDuration(i.endT - i.startT) : 'ongoing · ' + fmtDuration(Date.now() - i.startT)}</td>
              <td>${li.flag} ${esc(li.name)}${li.isp ? ' · ' + esc(li.isp) : ''}</td>
              <td>${esc(i.error ?? '')}${i.diag ? ' · diagnosis attached' : ''}</td></tr>`;
          }).join('')}</tbody>
        </table></div>`}
      </div>`;
    $('#foot').textContent = 'Click a location tile to pin it: latency anatomy, week heatmap, and check log.';
  }

  function renderList(main) {
    const rows = [];
    for (const t of targetsInScope()) {
      for (const [key, slot] of tiles(t)) {
        const e = latestOf(slot);
        const li = locLabel(slot.loc);
        rows.push(`
          <tr data-clickable data-focus-target="${t.id}" data-focus-key="${esc(key)}">
            <td>${esc(projectOfTarget(t)?.name ?? '')}</td>
            <td>${esc(t.name)}</td>
            <td>${li.flag} ${esc(li.name)}${li.isp ? ' · ' + esc(li.isp) : ''}</td>
            <td>${pill(e?.status ?? 'unknown')}</td>
            <td class="num mono">${fmtMs(e?.ms)}</td>
            <td class="num mono">${fmtMs(p95Of(slot))}</td>
            <td class="num mono">${fmtUptime(slot.uptime24h)}</td>
            <td class="num mono">${fmtUptime(slot.uptime30d)}</td>
            <td class="num mono">${e ? fmtTime(e.t) : '—'}</td>
          </tr>`);
      }
    }
    main.innerHTML = `
      <div class="list-card">
        <h3>All probes in scope</h3>
        <table>
          <thead><tr><th>Project</th><th>Target</th><th>Location</th><th>Status</th>
            <th class="num">Latency</th><th class="num">p95</th>
            <th class="num">Uptime 24 h</th><th class="num">Uptime 30 d</th><th class="num">Last check</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>`;
    $('#foot').textContent = 'Click a row to open its full history.';
  }

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

  const dayClass = (d) => {
    const known = d.n - d.unk;
    if (known <= 0) return '';
    const downRatio = d.down / known;
    return downRatio >= 0.01 ? 'c' : d.down > 0 || d.deg / known >= 0.005 ? 'w' : 'g';
  };

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

  // ---------- statistics -----------------------------------------------------

  function statsParams() {
    const { scope, projectId, categoryId } = state.nav;
    const p = new URLSearchParams();
    if (scope === 'project' && projectId) p.set('project', projectId);
    if (scope === 'category' && categoryId) p.set('category', categoryId);
    return p;
  }

  async function renderStats(main) {
    $('#foot').textContent = 'Statistics are scoped to the selection in the sidebar. The calendar fills as history accumulates.';
    const key = statsParams().toString();
    if (!state.stats || state.statsKey !== key || Date.now() - state.statsAt > 30000) {
      main.innerHTML = '<p class="none-note">Loading statistics…</p>';
      try {
        const res = await fetch('/api/stats' + (key ? '?' + key : ''));
        state.stats = await res.json();
        state.statsKey = key;
        state.statsAt = Date.now();
      } catch { main.innerHTML = '<p class="none-note">Could not load statistics.</p>'; return; }
      if (state.lens !== 'stats' || statsParams().toString() !== key) return;
    }
    const s = state.stats;
    const fmtU = (u) => (u == null ? '—' : u.toFixed(u >= 99.995 ? 0 : 2) + '%');
    const fmtMttr = (ms) => (ms == null ? '—' : ms < 3600e3 ? Math.round(ms / 60000) + ' m' : (ms / 3600e3).toFixed(1) + ' h');
    const breakdownTable = (title, rows, nameOf) => !rows?.length ? '' : `
      <div class="list-card">
        <h3>${title}</h3>
        <table><thead><tr><th>Name</th><th class="num">Uptime</th><th class="num">Avg ms</th><th class="num">Incidents</th></tr></thead>
        <tbody>${rows.map((r) =>
          `<tr><td>${nameOf(r)}</td><td class="num mono ${r.uptime30d != null && r.uptime30d < 99 ? 'crit-c' : ''}">${fmtU(r.uptime30d)}</td><td class="num mono">${r.avgMs ?? '—'}</td><td class="num mono">${r.incidents}</td></tr>`
        ).join('')}</tbody></table>
      </div>`;

    main.innerHTML = `
      <div class="summary stats-cards">
        <div class="stat"><div class="label">Uptime · 24 h</div><div class="value">${fmtU(s.overall['24h'].uptime)}</div></div>
        <div class="stat"><div class="label">Uptime · 7 d</div><div class="value">${fmtU(s.overall['7d'].uptime)}</div></div>
        <div class="stat"><div class="label">Uptime · 30 d</div><div class="value">${fmtU(s.overall['30d'].uptime)}</div></div>
        <div class="stat"><div class="label">Checks · 30 d</div><div class="value">${s.overall['30d'].checks.toLocaleString()}</div></div>
        <div class="stat"><div class="label">Incidents · 30 d</div><div class="value ${s.incidents30d.open ? 'crit-c' : ''}">${s.incidents30d.count}${s.incidents30d.open ? `<small> (${s.incidents30d.open} open)</small>` : ''}</div></div>
        <div class="stat"><div class="label">Avg repair time</div><div class="value">${fmtMttr(s.incidents30d.mttrMs)}</div></div>
      </div>

      <div class="list-card cal-card">
        <h3>The year at a glance</h3>
        ${calendarHTML(s.days)}
        <div class="heat-legend">
          <span><span class="sw" style="background:var(--good);opacity:.55"></span>clean day</span>
          <span><span class="sw" style="background:var(--warn)"></span>brief issues / degradation</span>
          <span><span class="sw" style="background:var(--crit)"></span>real downtime (≥1% of checks)</span>
          <span><span class="sw" style="background:var(--grid-line)"></span>no data</span>
        </div>
        ${s.byProject?.length > 1 ? `
          <h3 class="inner-h">Per project</h3>
          ${s.byProject.map((p) => `
            <div class="mini-cal-row">
              <span class="pname">${esc(p.name)}</span>
              <span class="mini-cal">${p.days.slice(-364).map((d) => `<i class="${dayClass(d)}"></i>`).join('')}</span>
              <span class="mono" style="font-size:12px">${fmtU(p.uptime30d)} · 30 d</span>
            </div>`).join('')}` : ''}
      </div>

      <div class="stats-cols">
        ${breakdownTable('By project · 30 d', s.byProject, (r) => esc(r.name))}
        ${breakdownTable('By category · 30 d', s.byCategory, (r) => esc(r.name))}
        ${breakdownTable('By country · 30 d', s.byCountry, (r) => {
          const c = state.data.countries[r.country] ?? { name: r.country, flag: '' };
          return `${c.flag} ${esc(c.name)}`;
        })}
        ${breakdownTable('By target · 30 d', s.byTarget, (r) => esc(r.name))}
      </div>

      <div class="list-card report-card">
        <h3>Download a report ${state.nav.scope !== 'all' ? '<span class="hint-inline">— scoped to your current selection</span>' : ''}</h3>
        <div class="report-form">
          <label class="field"><span>Data</span>
            <select id="rep-scope">
              <option value="summary">Check summary (per period × target × location)</option>
              <option value="incidents">Incidents</option>
              <option value="raw">Raw checks (last 48 h only)</option>
            </select></label>
          <label class="field"><span>Granularity</span>
            <select id="rep-gran"><option value="daily">Daily</option><option value="hourly">Hourly</option></select></label>
          <label class="field"><span>From</span><input type="date" id="rep-from"></label>
          <label class="field"><span>To</span><input type="date" id="rep-to"></label>
        </div>
        <div class="report-form">
          <div class="field"><span>Targets <em class="hint-inline">none selected = all in scope</em></span>
            <div class="chips" id="rep-targets">${targetsInScope().map((t) =>
              `<button type="button" data-rep-t="${t.id}" aria-pressed="false">${esc(t.name)}</button>`).join('')}</div></div>
          <div class="field"><span>Countries <em class="hint-inline">none selected = all</em></span>
            <div class="chips" id="rep-countries">${[...new Set(targetsInScope().flatMap((t) => t.locations.map((l) => l.country)))].map((c) =>
              `<button type="button" data-rep-c="${c}" aria-pressed="false">${(state.data.countries[c] ?? { flag: '' }).flag} ${c}</button>`).join('')}</div></div>
        </div>
        <div class="report-actions">
          <button class="ghost" id="rep-preview">Preview</button>
          <button class="primary" id="rep-csv">Download CSV</button>
          <button class="ghost" id="rep-json">Download JSON</button>
          <span class="test-result" id="rep-count"></span>
        </div>
        <div class="table-scroll" id="rep-result"></div>
      </div>`;

    const today = new Date();
    $('#rep-to').value = today.toISOString().slice(0, 10);
    $('#rep-from').value = new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10);
    for (const b of $$('[data-rep-t],[data-rep-c]', main)) {
      b.onclick = () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    }
    const reportUrl = (extra) => {
      const p = new URLSearchParams({
        scope: $('#rep-scope').value, granularity: $('#rep-gran').value,
        from: $('#rep-from').value, to: $('#rep-to').value, ...extra,
      });
      for (const [k, v] of statsParams()) p.set(k, v);
      const ts = $$('[data-rep-t][aria-pressed="true"]', main).map((b) => b.dataset.repT);
      const cs = $$('[data-rep-c][aria-pressed="true"]', main).map((b) => b.dataset.repC);
      if (ts.length) p.set('targets', ts.join(','));
      if (cs.length) p.set('countries', cs.join(','));
      return '/api/report?' + p.toString();
    };
    $('#rep-csv').onclick = () => { location.href = reportUrl({ format: 'csv' }); };
    $('#rep-json').onclick = () => { location.href = reportUrl({ format: 'json', download: '1' }); };
    $('#rep-preview').onclick = async () => {
      $('#rep-count').textContent = 'loading…'; $('#rep-count').className = 'test-result';
      const res = await fetch(reportUrl({ limit: '15' }));
      if (!res.ok) { $('#rep-count').textContent = 'failed'; $('#rep-count').className = 'test-result fail'; return; }
      const data = await res.json();
      $('#rep-count').textContent = `${data.total >= 15 ? 'first 15 of many' : data.total + ' rows'}`;
      if (data.rows.length === 0) { $('#rep-result').innerHTML = '<p class="none-note">No data for these filters.</p>'; return; }
      const cols = Object.keys(data.rows[0]);
      $('#rep-result').innerHTML = `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${data.rows.map((r) => `<tr>${cols.map((c) => `<td class="mono">${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    };
  }

  function calendarHTML(days) {
    const cells = [];
    const firstDow = (new Date(days[0].t).getDay() + 6) % 7; // Monday = 0
    for (let i = 0; i < firstDow; i++) cells.push('<i class="pad"></i>');
    for (const d of days) {
      const known = d.n - d.unk;
      const cls = dayClass(d);
      const date = new Date(d.t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
      const tip = known > 0
        ? `${date}: ${d.n.toLocaleString()} checks · ${d.down} down · ${d.deg} degraded`
        : `${date}: no data`;
      cells.push(`<i class="${cls}" title="${esc(tip)}"></i>`);
    }
    const dows = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].map((d) => `<span class="dow">${d}</span>`).join('');
    return `<div class="cal-scroll"><div class="cal-dows">${dows}</div><div class="cal">${cells.join('')}</div></div>`;
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
    const t = targetById(state.focus.targetId);
    const slot = t?.results?.[state.focus.key];
    if (!slot) { state.focus = null; overlay.hidden = true; return; }
    const key = state.focus.key;
    const li = locLabel(slot.loc);
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
    for (const b of $$('[data-range]')) {
      b.onclick = () => { state.range = b.dataset.range; renderFocus(); };
    }
    hookTooltip(series);

    $('#focus-strip').innerHTML = tiles(t).map(([k, sl]) => {
      const le = latestOf(sl);
      const kli = locLabel(sl.loc);
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
    for (const el of $$('[data-count]')) {
      const t = targetById(el.dataset.count);
      if (!t || !t.enabled || !t.nextRunAt) { el.textContent = ''; continue; }
      const secs = Math.max(0, Math.round((t.nextRunAt - Date.now()) / 1000));
      el.textContent = secs === 0 ? 'checking…' : `next in ${secs} s`;
    }
  }, 1000);

  // ---------- target modal ---------------------------------------------------

  function openTargetModal(target, presetCategoryId) {
    state.editing = target;
    const form = $('#target-form');
    $('#modal-title').textContent = target ? 'Edit target' : 'Add URL';
    $('#btn-delete').hidden = !target;
    $('#form-error').hidden = true;
    $('#providers-hint').hidden = true;
    $('#rules-preview-out').textContent = '';
    $('#btn-rules-preview').style.display = target ? '' : 'none';
    form.name.value = target?.name ?? '';
    form.url.value = target?.url ?? '';
    form.intervalSeconds.value = String(target?.intervalSeconds ?? 300);
    form.expectText.value = target?.expectText ?? '';

    // category options grouped by project
    $('#t-category').innerHTML = projects().map((p) =>
      `<optgroup label="${esc(p.name)}">${categories(p.id).map((c) =>
        `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
    form.categoryId.value = target?.categoryId ?? presetCategoryId ?? state.nav.categoryId
      ?? categories(state.nav.projectId)[0]?.id ?? state.data.categories[0]?.id;

    // rules: values = own overrides only, placeholders = inherited
    const inherited = target?.inheritedRules
      ?? { ...state.data.defaultRules, ...Object.fromEntries(Object.entries(state.data.settings.rules ?? {}).filter(([, v]) => v != null)) };
    const own = target?.rules ?? {};
    form.r_passedCodes.value = own.passedCodes ?? '';
    form.r_passedCodes.placeholder = inherited.passedCodes;
    form.r_degradedCodes.value = own.degradedCodes ?? '';
    form.r_degradedCodes.placeholder = inherited.degradedCodes;
    form.r_treat403.checked = own.treat403 ?? inherited.treat403;
    form.r_treat403.dataset.inherited = String(inherited.treat403);
    form.r_latencyMode.value = own.latencyMode ?? '';
    form.r_latencyMs.value = own.latencyMs ?? '';
    form.r_latencyMs.placeholder = inherited.latencyMs;
    form.r_adaptiveFactor.value = own.adaptiveFactor ?? '';
    form.r_adaptiveFactor.placeholder = inherited.adaptiveFactor;
    form.r_timeoutMs.value = own.timeoutMs ?? '';
    form.r_timeoutMs.placeholder = inherited.timeoutMs;
    form.r_contentFail.value = own.contentFail ?? '';
    const customCount = Object.keys(own).length;
    $('#rules-note').textContent = customCount ? `— ${customCount} custom` : '— using defaults';
    $('#rules-note').className = customCount ? 'hint-inline rules-note-custom' : 'hint-inline';
    $('#rules-acc').open = customCount > 0;

    state.editLocs = (target?.locations ?? [{ country: 'LOCAL', isp: null }, { country: 'GE', isp: null }, { country: 'DE', isp: null }])
      .map((l) => ({ country: l.country, isp: l.isp }));
    renderLocRows();
    $('#target-overlay').hidden = false;
    form.name.focus();
  }

  function collectRulesDraft() {
    const form = $('#target-form');
    const draft = {};
    const setIf = (k, v) => { if (v !== '' && v != null) draft[k] = v; else draft[k] = null; };
    setIf('passedCodes', form.r_passedCodes.value.trim());
    setIf('degradedCodes', form.r_degradedCodes.value.trim());
    draft.treat403 = form.r_treat403.checked === (form.r_treat403.dataset.inherited === 'true') ? null : form.r_treat403.checked;
    setIf('latencyMode', form.r_latencyMode.value);
    setIf('latencyMs', form.r_latencyMs.value === '' ? null : Number(form.r_latencyMs.value));
    setIf('adaptiveFactor', form.r_adaptiveFactor.value === '' ? null : Number(form.r_adaptiveFactor.value));
    setIf('timeoutMs', form.r_timeoutMs.value === '' ? null : Number(form.r_timeoutMs.value));
    setIf('contentFail', form.r_contentFail.value);
    return draft;
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
    for (const sel of $$('[data-loc-country]')) {
      sel.onchange = () => {
        const i = Number(sel.dataset.locCountry);
        state.editLocs[i].country = sel.value;
        if (sel.value === 'LOCAL') state.editLocs[i].isp = null;
        renderLocRows();
        if (sel.value !== 'LOCAL') showProviderHint(sel.value, i);
      };
    }
    for (const inp of $$('[data-loc-isp]')) {
      inp.oninput = () => { state.editLocs[Number(inp.dataset.locIsp)].isp = inp.value.trim() || null; };
      inp.onfocus = () => {
        const l = state.editLocs[Number(inp.dataset.locIsp)];
        if (l.country !== 'LOCAL') showProviderHint(l.country, Number(inp.dataset.locIsp));
      };
    }
    for (const btn of $$('[data-loc-rm]')) {
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
      if (state.hintCountry !== country) return;
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

  async function submitTargetModal(ev) {
    ev.preventDefault();
    const form = $('#target-form');
    const body = {
      name: form.name.value,
      url: form.url.value,
      intervalSeconds: Number(form.intervalSeconds.value),
      expectText: form.expectText.value,
      categoryId: form.categoryId.value,
      locations: state.editLocs,
      rules: collectRulesDraft(),
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
    state.editing = null;
    await refresh();
    setNav({ targetId: saved.id });
  }

  // ---------- project & category modals --------------------------------------

  let editingProject = null;
  let editingCategory = null;
  let categoryProjectId = null;

  function openProjectModal(project) {
    editingProject = project;
    $('#project-title').textContent = project ? 'Project settings' : 'New project';
    $('#btn-project-delete').hidden = !project;
    $('#project-error').hidden = true;
    $('#project-form').name.value = project?.name ?? '';
    $('#project-form').webhookUrl.value = project?.webhookUrl ?? '';
    $('#project-overlay').hidden = false;
    $('#project-form').name.focus();
  }

  function openCategoryModal(category, projectId) {
    editingCategory = category;
    categoryProjectId = projectId ?? category?.projectId;
    $('#category-title').textContent = category ? 'Rename category' : 'New category';
    $('#btn-category-delete').hidden = !category;
    $('#category-error').hidden = true;
    $('#category-form').name.value = category?.name ?? '';
    $('#category-overlay').hidden = false;
    $('#category-form').name.focus();
  }

  async function apiCall(url, method, body, errEl) {
    const res = await fetch(url, {
      method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ errors: ['request failed'] }));
      if (errEl) { errEl.hidden = false; errEl.textContent = (err.errors ?? ['request failed']).join('. '); }
      return null;
    }
    return res.json();
  }

  // ---------- quick jump (⌘K) ------------------------------------------------

  function cmdkEntries(query) {
    const q = query.toLowerCase();
    const out = [];
    for (const p of projects()) out.push({ label: p.name, path: 'project', nav: { scope: 'project', projectId: p.id } });
    for (const c of state.data.categories) {
      out.push({ label: c.name, path: projectById(c.projectId)?.name ?? '', nav: { scope: 'category', categoryId: c.id } });
    }
    for (const t of state.data.targets) {
      const p = projectOfTarget(t);
      out.push({ label: t.name, path: `${p?.name ?? ''} / ${categoryById(t.categoryId)?.name ?? ''}`, nav: { targetId: t.id } });
    }
    return q ? out.filter((e) => (e.label + ' ' + e.path).toLowerCase().includes(q)) : out;
  }

  function renderCmdk() {
    const entries = cmdkEntries($('#cmdk-input').value).slice(0, 12);
    state.cmdkSel = Math.min(state.cmdkSel, Math.max(0, entries.length - 1));
    $('#cmdk-list').innerHTML = entries.length === 0
      ? '<p class="none-note" style="padding:10px 12px">Nothing matches.</p>'
      : entries.map((e, i) => `
        <button class="cmdk-item" data-cmdk="${i}" aria-selected="${i === state.cmdkSel}">
          <span>${esc(e.label)}</span><span class="path">${esc(e.path)}</span>
        </button>`).join('');
    for (const b of $$('[data-cmdk]')) {
      b.onclick = () => { closeCmdk(); setNav(entries[Number(b.dataset.cmdk)].nav); };
    }
  }

  function openCmdk() {
    state.cmdkSel = 0;
    $('#cmdk-overlay').hidden = false;
    $('#cmdk-input').value = '';
    renderCmdk();
    $('#cmdk-input').focus();
  }
  const closeCmdk = () => { $('#cmdk-overlay').hidden = true; };

  // ---------- data -----------------------------------------------------------

  async function refresh() {
    const res = await fetch('/api/state');
    if (res.status === 401) { $('#login-overlay').hidden = false; $('#login-form').password.focus(); return; }
    $('#login-overlay').hidden = true;
    state.data = await res.json();
    // heal stale navigation after deletions
    if (state.nav.targetId && !targetById(state.nav.targetId)) state.nav = { scope: 'all', projectId: null, categoryId: null, targetId: null };
    if (state.nav.categoryId && !categoryById(state.nav.categoryId)) state.nav = { scope: 'all', projectId: null, categoryId: null, targetId: null };
    if (state.nav.projectId && !projectById(state.nav.projectId)) state.nav = { scope: 'all', projectId: null, categoryId: null, targetId: null };
    render();
  }

  function applyResultEvent(msg) {
    const t = targetById(msg.targetId);
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
    const toggle = ev.target.closest('[data-toggle-proj]');
    if (toggle) {
      ev.stopPropagation();
      const id = toggle.dataset.toggleProj;
      state.sideOpen.has(id) ? state.sideOpen.delete(id) : state.sideOpen.add(id);
      renderSidebar();
      return;
    }
    if (ev.target.closest('[data-nav-all]')) { ev.preventDefault(); setNav({ scope: 'all' }); return; }
    const np = ev.target.closest('[data-nav-proj]');
    if (np) { ev.preventDefault(); setNav({ scope: 'project', projectId: np.dataset.navProj }); return; }
    const nc = ev.target.closest('[data-nav-cat]');
    if (nc) { ev.preventDefault(); setNav({ scope: 'category', categoryId: nc.dataset.navCat }); return; }
    const nt = ev.target.closest('[data-nav-target]');
    if (nt) { setNav({ targetId: nt.dataset.navTarget }); return; }

    if (ev.target.closest('[data-add-proj]')) { openProjectModal(null); return; }
    const ac = ev.target.closest('[data-add-cat]');
    if (ac) { openCategoryModal(null, ac.dataset.addCat); return; }
    const ep = ev.target.closest('[data-edit-proj]');
    if (ep) { openProjectModal(projectById(ep.dataset.editProj)); return; }
    const ec = ev.target.closest('[data-edit-cat]');
    if (ec) { openCategoryModal(categoryById(ec.dataset.editCat)); return; }
    const dc = ev.target.closest('[data-del-cat]');
    if (dc) {
      const c = categoryById(dc.dataset.delCat);
      if (c && confirm(`Delete empty category "${c.name}"?`)) {
        await apiCall(`/api/categories/${c.id}`, 'DELETE');
        await refresh();
      }
      return;
    }
    const au = ev.target.closest('[data-add-url-cat]');
    if (au) { openTargetModal(null, au.dataset.addUrlCat); return; }

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
      const t = targetById(pause.dataset.pause);
      await fetch(`/api/targets/${t.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !t.enabled }) });
      return;
    }
    const edit = ev.target.closest('[data-edit]');
    if (edit) { openTargetModal(targetById(edit.dataset.edit)); return; }

    if (ev.target === $('#focus-overlay') || ev.target.classList?.contains('focus-wrap')) {
      state.focus = null; state.focusData = null; renderFocus();
    }
    if (ev.target === $('#target-overlay')) { $('#target-overlay').hidden = true; state.editing = null; }
    if (ev.target === $('#settings-overlay')) { $('#settings-overlay').hidden = true; }
    if (ev.target === $('#project-overlay')) { $('#project-overlay').hidden = true; }
    if (ev.target === $('#category-overlay')) { $('#category-overlay').hidden = true; }
    if (ev.target === $('#cmdk-overlay')) closeCmdk();
  });

  document.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      $('#cmdk-overlay').hidden ? openCmdk() : closeCmdk();
      return;
    }
    if (!$('#cmdk-overlay').hidden) {
      const entries = cmdkEntries($('#cmdk-input').value).slice(0, 12);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); state.cmdkSel = Math.min(state.cmdkSel + 1, entries.length - 1); renderCmdk(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); state.cmdkSel = Math.max(state.cmdkSel - 1, 0); renderCmdk(); }
      else if (ev.key === 'Enter' && entries[state.cmdkSel]) { closeCmdk(); setNav(entries[state.cmdkSel].nav); }
      else if (ev.key === 'Escape') closeCmdk();
      return;
    }
    if (ev.key !== 'Escape') return;
    if (!$('#settings-overlay').hidden) $('#settings-overlay').hidden = true;
    else if (!$('#project-overlay').hidden) $('#project-overlay').hidden = true;
    else if (!$('#category-overlay').hidden) $('#category-overlay').hidden = true;
    else if (!$('#target-overlay').hidden) { $('#target-overlay').hidden = true; state.editing = null; }
    else if (state.focus) { state.focus = null; state.focusData = null; renderFocus(); }
  });

  $('#cmdk-input')?.addEventListener('input', () => { state.cmdkSel = 0; renderCmdk(); });
  $('#btn-search').onclick = openCmdk;

  $('#btn-add').onclick = () => openTargetModal(null);
  $('#btn-add-loc').onclick = () => { state.editLocs.push({ country: 'GE', isp: null }); renderLocRows(); };
  $('#btn-cancel').onclick = () => { $('#target-overlay').hidden = true; state.editing = null; };
  $('#target-form').onsubmit = submitTargetModal;
  $('#btn-delete').onclick = async () => {
    if (!state.editing) return;
    if (!confirm(`Stop monitoring "${state.editing.name}" and delete its history?`)) return;
    await fetch(`/api/targets/${state.editing.id}`, { method: 'DELETE' });
    $('#target-overlay').hidden = true;
    state.editing = null;
    await refresh();
  };
  $('#btn-rules-preview').onclick = async () => {
    if (!state.editing) return;
    const out = $('#rules-preview-out');
    out.textContent = 'computing…'; out.className = 'test-result';
    const res = await fetch('/api/rules-preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetId: state.editing.id, rules: collectRulesDraft() }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      out.textContent = (err.errors ?? ['preview failed']).join(', ');
      out.className = 'test-result fail';
      return;
    }
    const { current, withDraft } = await res.json();
    const fmt = (c) => c.total === 0 ? 'no checks yet' :
      `${Math.round(100 * c.up / c.total)}% ok · ${Math.round(100 * c.degraded / c.total)}% degraded · ${Math.round(100 * c.down / c.total)}% down`;
    out.textContent = `last 24 h — now: ${fmt(current)} → with these rules: ${fmt(withDraft)}`;
    out.className = 'test-result ok';
  };

  $('#btn-grid').onclick = () => { state.view = 'grid'; render(); };
  $('#btn-list').onclick = () => { state.view = 'list'; render(); };
  for (const b of $$('#lens [data-lens]')) {
    b.onclick = () => { state.lens = b.dataset.lens; render(); };
  }
  $('#provider').onchange = async (ev) => {
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: ev.target.value === 'simulated' ? 'simulated' : 'auto' }) });
  };

  // project modal wiring
  $('#btn-project-cancel').onclick = () => { $('#project-overlay').hidden = true; };
  $('#project-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const form = $('#project-form');
    const body = { name: form.name.value, webhookUrl: form.webhookUrl.value };
    const saved = editingProject
      ? await apiCall(`/api/projects/${editingProject.id}`, 'PUT', body, $('#project-error'))
      : await apiCall('/api/projects', 'POST', body, $('#project-error'));
    if (!saved) return;
    $('#project-overlay').hidden = true;
    await refresh();
    setNav({ scope: 'project', projectId: saved.id });
  };
  $('#btn-project-delete').onclick = async () => {
    if (!editingProject) return;
    if (!confirm(`Delete project "${editingProject.name}"? (must be empty)`)) return;
    const ok = await apiCall(`/api/projects/${editingProject.id}`, 'DELETE', null, $('#project-error'));
    if (!ok) return;
    $('#project-overlay').hidden = true;
    setNav({ scope: 'all' });
    await refresh();
  };

  // category modal wiring
  $('#btn-category-cancel').onclick = () => { $('#category-overlay').hidden = true; };
  $('#category-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const name = $('#category-form').name.value;
    const saved = editingCategory
      ? await apiCall(`/api/categories/${editingCategory.id}`, 'PUT', { name }, $('#category-error'))
      : await apiCall('/api/categories', 'POST', { name, projectId: categoryProjectId }, $('#category-error'));
    if (!saved) return;
    $('#category-overlay').hidden = true;
    await refresh();
  };
  $('#btn-category-delete').onclick = async () => {
    if (!editingCategory) return;
    const ok = await apiCall(`/api/categories/${editingCategory.id}`, 'DELETE', null, $('#category-error'));
    if (!ok) return;
    $('#category-overlay').hidden = true;
    await refresh();
  };

  // settings modal
  $('#btn-settings').onclick = () => {
    const form = $('#settings-form');
    const s = state.data.settings;
    const eff = { ...state.data.defaultRules, ...Object.fromEntries(Object.entries(s.rules ?? {}).filter(([, v]) => v != null)) };
    form.d_passedCodes.value = eff.passedCodes;
    form.d_degradedCodes.value = eff.degradedCodes;
    form.d_treat403.checked = eff.treat403;
    form.d_latencyMode.value = eff.latencyMode;
    form.d_latencyMs.value = eff.latencyMs;
    form.d_adaptiveFactor.value = eff.adaptiveFactor;
    form.d_timeoutMs.value = eff.timeoutMs;
    form.d_contentFail.value = eff.contentFail;
    form.webhookUrl.value = s.alerts?.webhookUrl ?? '';
    form.minConsecutiveFails.value = String(s.alerts?.minConsecutiveFails ?? 2);
    form.alertsEnabled.checked = s.alerts?.enabled !== false;
    form.globalpingToken.value = s.globalpingToken ?? '';
    $('#settings-error').hidden = true;
    $('#test-result').textContent = '';
    $('#settings-overlay').hidden = false;
  };
  $('#btn-settings-cancel').onclick = () => { $('#settings-overlay').hidden = true; };
  $('#settings-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const form = $('#settings-form');
    const res = await fetch('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        globalpingToken: form.globalpingToken.value,
        rules: {
          passedCodes: form.d_passedCodes.value,
          degradedCodes: form.d_degradedCodes.value,
          treat403: form.d_treat403.checked,
          latencyMode: form.d_latencyMode.value,
          latencyMs: Number(form.d_latencyMs.value),
          adaptiveFactor: Number(form.d_adaptiveFactor.value),
          timeoutMs: Number(form.d_timeoutMs.value),
          contentFail: form.d_contentFail.value,
        },
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

  // login
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
    location.reload();
  };

  // ---------- boot -----------------------------------------------------------

  refresh().then(connectEvents);
})();
