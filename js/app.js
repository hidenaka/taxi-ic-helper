import { loadAllData } from './data-loader.js';
import { judgeRoute } from './judge.js';
import { createGeoWatcher, findNearestICs, entryGivesCompanyPayDeduction } from './geo.js';
import { buildSearchEntries, buildValueToIcIdMap } from './search.js';

const state = {
  data: null,
  selected: {
    outerRoute: 'none',
    entryIcId: null,
    exitIcId: null,
    viaGaikan: false,
    shutokoRouteId: null
  },
  lastResult: null
};

const DAILY_BASE_KM = 365;
const LOG_KEY_PREFIX = 'taxi_ic_helper:deduction_log:';
const NEAREST_SUGGEST_COUNT = 4;

const geoState = {
  watcher: null,
  enabled: true,
  initialEntrySet: false,
};

async function init() {
  state.data = await loadAllData();
  icValueIndex = buildSearchIndex();
  populateExitFavorites();
  populateAllIcSelects();
  setEntryIc('maihama');     // calls updateOuterRouteOptions internally
  setExitIc('kukou_chuou');
  updateShutokoRouteOptions();
  wireEvents();
  update();
  renderSessionLog();
  initGeo();
}

// ---- GPS (v0.2) ----
function initGeo() {
  geoState.watcher = createGeoWatcher({
    onUpdate: (pos) => onGeoUpdate(pos),
    onState: (s) => onGeoState(s),
  });
  geoState.watcher.start();
}

function onGeoState(s) {
  const root = document.getElementById('geo-status');
  root.classList.remove('measuring', 'denied', 'error', 'idle', 'unsupported');
  root.classList.add(s);
  const loc = document.getElementById('geo-location');
  const acc = document.getElementById('geo-accuracy');
  const toggle = document.getElementById('btn-geo-toggle');
  switch (s) {
    case 'measuring':
      loc.textContent = '📍 計測中…';
      acc.textContent = '';
      toggle.textContent = 'GPSオフ';
      toggle.setAttribute('aria-pressed', 'true');
      break;
    case 'denied':
      loc.textContent = '📍 GPS拒否（手動モード）';
      acc.textContent = '';
      hideGeoSuggest();
      break;
    case 'error':
      loc.textContent = '📍 GPSエラー';
      acc.textContent = '';
      hideGeoSuggest();
      break;
    case 'unsupported':
      loc.textContent = '📍 この端末はGPS非対応';
      acc.textContent = '';
      hideGeoSuggest();
      break;
    case 'idle':
      loc.textContent = '📍 GPSオフ';
      acc.textContent = '';
      hideGeoSuggest();
      toggle.textContent = 'GPSオン';
      toggle.setAttribute('aria-pressed', 'false');
      break;
  }
}

function onGeoUpdate(pos) {
  document.getElementById('geo-location').textContent = '📍 現在地取得済';
  document.getElementById('geo-accuracy').textContent = `±${Math.round(pos.accuracy)}m`;
  refreshNearestSuggestions(pos);

  if (!geoState.initialEntrySet) {
    const nearest = findNearestICs(pos, state.data.ics, { n: 1 });
    if (nearest.length > 0) {
      setEntryIc(nearest[0].ic.id);
      update();
      geoState.initialEntrySet = true;
    }
  }
}

function refreshNearestSuggestions(pos) {
  const wrap = document.getElementById('geo-suggest');
  const buttons = document.getElementById('geo-suggest-buttons');
  buttons.innerHTML = '';
  const nearest = findNearestICs(pos, state.data.ics, { n: NEAREST_SUGGEST_COUNT });
  if (nearest.length === 0) { wrap.hidden = true; return; }
  wrap.hidden = false;
  for (const { ic, distKm } of nearest) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-geo-suggest';
    if (entryGivesCompanyPayDeduction(ic.id, state.data.deduction)) {
      btn.classList.add('glow');
      btn.title = '会社負担 + 控除あり';
    }
    btn.textContent = `${ic.name} ${distKm.toFixed(1)}km`;
    btn.addEventListener('click', () => { setEntryIc(ic.id); update(); });
    buttons.appendChild(btn);
  }
}

function hideGeoSuggest() {
  document.getElementById('geo-suggest').hidden = true;
}

// ---- Session deduction log (localStorage, per-day) ----
function getTodayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function loadTodayLog() {
  const raw = localStorage.getItem(LOG_KEY_PREFIX + getTodayKey());
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function saveTodayLog(entries) {
  localStorage.setItem(LOG_KEY_PREFIX + getTodayKey(), JSON.stringify(entries));
}

function addLogEntry(type) {
  const r = state.lastResult;
  if (!r) return;
  const km = type === 'roundtrip' ? r.totals.deductionKmRoundtrip : r.totals.deductionKmOneway;
  if (!(km > 0)) return;
  const entryIc = state.data.ics.find(x => x.id === state.selected.entryIcId);
  const exitIc  = state.data.ics.find(x => x.id === state.selected.exitIcId);
  const log = loadTodayLog();
  log.push({
    ts: Date.now(),
    type,
    km,
    from: entryIc?.name ?? '',
    to:   exitIc?.name  ?? ''
  });
  saveTodayLog(log);
  renderSessionLog();
}

function removeLogEntry(ts) {
  const log = loadTodayLog().filter(e => e.ts !== ts);
  saveTodayLog(log);
  renderSessionLog();
}

function clearTodayLog() {
  if (!confirm('今日の控除距離ログを全て消去しますか？')) return;
  localStorage.removeItem(LOG_KEY_PREFIX + getTodayKey());
  renderSessionLog();
}

function renderSessionLog() {
  const log = loadTodayLog();
  const d = new Date();
  const wd = ['日','月','火','水','木','金','土'][d.getDay()];
  document.getElementById('session-log-date').textContent =
    `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}(${wd})`;
  const listEl = document.getElementById('session-log-list');
  listEl.innerHTML = '';

  for (const e of log) {
    const li = document.createElement('li');
    const time = new Date(e.ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const typeLabel = e.type === 'roundtrip' ? '往復' : '片道';
    li.innerHTML = `
      <span class="log-time">${time}</span>
      <span class="log-type log-type-${e.type}">${typeLabel}</span>
      <span class="log-route">${e.from}→${e.to}</span>
      <span class="log-km">${e.km.toFixed(1)}km</span>
      <button type="button" class="log-remove" aria-label="削除">×</button>`;
    li.querySelector('.log-remove').addEventListener('click', () => removeLogEntry(e.ts));
    listEl.appendChild(li);
  }

  const total = log.reduce((s, e) => s + e.km, 0);
  document.getElementById('total-deduction').innerHTML =
    `今日の控除合計: <strong>${total.toFixed(1)}</strong>km`;
  document.getElementById('total-drivable').innerHTML =
    `走行可能距離: <strong>${(DAILY_BASE_KM + total).toFixed(1)}</strong>km ` +
    `<span class="formula">(365 + 控除合計)</span>`;
}


const DIRECTION_ORDER = [
  'tomei', 'chuo', 'kanetsu', 'tohoku', 'joban',
  'keiyo', 'tokan', 'aqua', 'tateyama',
  'third_keihin', 'yokoyoko', 'yokohane_route', 'kariba_route', 'wangan_route',
  'hodogaya_route', 'hokuseisen_route', 'kitasen_route',
  'gaikan', 'shutoko_inner'
];

const DIRECTION_EMOJI = {
  'tomei':          '🔵',
  'chuo':           '🟡',
  'kanetsu':        '🟢',
  'tohoku':         '🟣',
  'joban':          '🟠',
  'keiyo':          '🟤',
  'tokan':          '🔴',
  'aqua':           '🟦',
  'tateyama':       '🟧',
  'third_keihin':   '🔶',
  'yokoyoko':       '🔷',
  'yokohane_route': '🟥',
  'kariba_route':   '🟨',
  'wangan_route':   '🟩',
  'hodogaya_route': '🟫',
  'hokuseisen_route':'⬛',
  'kitasen_route':  '🟪',
  'gaikan':         '⚪',
  'shutoko_inner':  '⚫'
};

const DIRECTION_LABELS = {
  'tomei':          '東名',
  'chuo':           '中央道',
  'kanetsu':        '関越道',
  'tohoku':         '東北道',
  'joban':          '常磐道',
  'keiyo':          '京葉道',
  'tokan':          '東関東道',
  'aqua':           'アクアライン',
  'tateyama':       '館山道',
  'third_keihin':   '第三京浜',
  'yokoyoko':       '玉川経由',
  'yokohane_route': '横羽線経由',
  'kariba_route':   '狩場線経由',
  'wangan_route':   '湾岸線経由',
  'hodogaya_route': '保土ヶ谷BP経由',
  'hokuseisen_route':'北西線経由',
  'kitasen_route':  '北線経由',
  'gaikan':         '外環道',
  'shutoko_inner':  '首都高都心側'
};

function buildIcGrouping(data) {
  const { ics, deduction } = data;
  const assignment = new Map();

  for (const dir of deduction.directions) {
    if (!assignment.has(dir.baseline.ic_id)) {
      assignment.set(dir.baseline.ic_id, { groupId: dir.id, sortKey: 0 });
    }
    for (const e of dir.entries) {
      if (!assignment.has(e.ic_id)) {
        assignment.set(e.ic_id, { groupId: dir.id, sortKey: e.km });
      }
    }
  }

  for (const ic of ics) {
    if (assignment.has(ic.id)) continue;
    // 外環道のIC は boundary_tag='gaikan' または gaikan_kp フィールドを持つ
    if (ic.boundary_tag === 'gaikan' || typeof ic.gaikan_kp === 'number') {
      assignment.set(ic.id, { groupId: 'gaikan', sortKey: ic.gaikan_kp ?? 0 });
    } else {
      assignment.set(ic.id, { groupId: 'shutoko_inner', sortKey: 0 });
    }
  }

  const groups = DIRECTION_ORDER.map(gid => ({
    id: gid,
    label: DIRECTION_LABELS[gid] || gid,
    ics: []
  }));
  const groupMap = new Map(groups.map(g => [g.id, g]));

  for (const ic of ics) {
    const a = assignment.get(ic.id);
    const grp = groupMap.get(a.groupId);
    if (grp) grp.ics.push({ ic, sortKey: a.sortKey });
  }

  for (const grp of groups) {
    grp.ics.sort((a, b) => a.sortKey - b.sortKey);
  }

  return groups.filter(g => g.ics.length > 0);
}

// ---- Search support: build datalist and a value→id map ----
function buildSearchIndex() {
  const datalist = document.getElementById('ic-list-all');
  datalist.innerHTML = '';
  const groups = buildIcGrouping(state.data);
  const entries = buildSearchEntries(groups);
  for (const e of entries) {
    const opt = document.createElement('option');
    opt.value = e.value;
    datalist.appendChild(opt);
  }
  return buildValueToIcIdMap(entries);
}

let icValueIndex = new Map();

// ---- Populate both grouped pulldowns (entry + exit-all) ----
function populateAllIcSelects() {
  const entrySel = document.getElementById('sel-entry-ic');
  const exitSel  = document.getElementById('sel-exit-all');
  entrySel.innerHTML = '';
  exitSel.innerHTML = '';

  const groups = buildIcGrouping(state.data);
  for (const grp of groups) {
    const emoji = DIRECTION_EMOJI[grp.id] || '';
    const ogLabel = `${emoji} ${grp.label}`;
    const ogE = document.createElement('optgroup'); ogE.label = ogLabel;
    const ogX = document.createElement('optgroup'); ogX.label = ogLabel;
    for (const { ic } of grp.ics) {
      const txt = `${emoji} ${ic.name}`;
      const e = document.createElement('option'); e.value = ic.id; e.textContent = txt;
      const x = document.createElement('option'); x.value = ic.id; x.textContent = txt;
      ogE.appendChild(e); ogX.appendChild(x);
    }
    entrySel.appendChild(ogE); exitSel.appendChild(ogX);
  }
}

// ---- Favorites pulldown ----
function populateExitFavorites() {
  const sel = document.getElementById('sel-exit-fav');
  sel.innerHTML = '';
  const favorites = state.data.favorites.exit_favorites;
  for (const f of favorites) {
    const ic = state.data.ics.find(x => x.id === f.ic_id);
    if (!ic) continue;
    const opt = document.createElement('option');
    opt.value = f.ic_id;
    opt.textContent = ic.name;
    sel.appendChild(opt);
  }
  sel.value = 'kukou_chuou';
}

function setEntryIc(icId) {
  const ic = state.data.ics.find(x => x.id === icId);
  if (!ic) return;
  state.selected.entryIcId = icId;

  // Determine valid outerRoute options for this entry IC
  updateOuterRouteOptions();  // also sets state.selected.outerRoute if current is invalid

  document.getElementById('sel-entry-ic').value = icId;

  const hint = document.getElementById('entry-ic-hint');
  hint.textContent = ic.route_name || '';
  hint.className = 'hint';

  toggleGaikanCheckbox();
  updateShutokoRouteOptions();
}

function setExitIc(icId) {
  const ic = state.data.ics.find(x => x.id === icId);
  if (!ic) return;
  state.selected.exitIcId = icId;

  const favSel = document.getElementById('sel-exit-fav');
  const allSel = document.getElementById('sel-exit-all');

  const favIds = state.data.favorites.exit_favorites.map(f => f.ic_id);
  favSel.value = favIds.includes(icId) ? icId : '';
  allSel.value = icId;

  const hint = document.getElementById('exit-ic-hint');
  hint.textContent = ic.route_name || '';
  hint.className = 'hint';

  updateShutokoRouteOptions();
}

function getOuterRouteOptions(ic) {
  if (!ic) return ['none'];

  // Baseline ICs (首都高と外側本線の境界) → fix their direction
  const baselineMap = {
    'tokyo_ic':         ['tomei'],
    'takaido':          ['chuo'],
    'nerima':           ['kanetsu'],
    'kawaguchi_jct':    ['tohoku'],
    'misato_jct':       ['joban'],
    'shinozaki':        ['keiyo'],
    'wangan_ichikawa':  ['tokan'],
    'ukishima_jct':     ['aqua'],
    'kisarazu_jct':     ['tateyama'],
    'tamagawa_ic':      ['third_keihin', 'yokoyoko']
  };
  if (baselineMap[ic.id]) return baselineMap[ic.id];

  // Data-driven: check which directions contain this IC as an entry.
  // 複数方面に登録されている場合、湾岸線経由 (tokan/wangan_route/aqua) を
  // 優先デフォルトにする。それ以外は km 昇順で残す（候補は全部表示）。
  const WANGAN_FIRST = new Set(['tokan', 'wangan_route', 'aqua']);
  const matched = [];
  for (const dir of state.data.deduction.directions) {
    const entry = dir.entries.find(e => e.ic_id === ic.id);
    if (entry) matched.push({ id: dir.id, km: entry.km });
  }
  if (matched.length > 0) {
    matched.sort((a, b) => {
      const aw = WANGAN_FIRST.has(a.id), bw = WANGAN_FIRST.has(b.id);
      if (aw !== bw) return aw ? -1 : 1;
      return a.km - b.km;
    });
    return matched.map(m => m.id);
  }

  // Gaikan direct-entry IC
  if (ic.boundary_tag === 'gaikan') return ['gaikan_direct'];

  // 首都高内 IC (都心側 / 8入口) — no external trunk
  return ['none'];
}

function updateOuterRouteOptions() {
  const entryIc = state.data.ics.find(x => x.id === state.selected.entryIcId);
  const options = getOuterRouteOptions(entryIc);
  const sel = document.getElementById('sel-outer-route');
  const labels = state.data.routes.labels;
  sel.innerHTML = '';
  for (const optValue of options) {
    const opt = document.createElement('option');
    opt.value = optValue;
    opt.textContent = labels[optValue] || optValue;
    sel.appendChild(opt);
  }
  if (options.includes(state.selected.outerRoute)) {
    sel.value = state.selected.outerRoute;
  } else {
    sel.value = options[0];
    state.selected.outerRoute = options[0];
  }
}

function updateShutokoRouteOptions() {
  const { ics, deduction, shutokoRoutes } = state.data;
  const entryIc = ics.find(x => x.id === state.selected.entryIcId);
  const exitIc  = ics.find(x => x.id === state.selected.exitIcId);
  if (!entryIc || !exitIc) return;

  // Compute shutoko start IC (same logic as judge.js resolveShutokoStartIcId)
  const dir = deduction.directions.find(d => d.id === state.selected.outerRoute);
  const startIcId = dir ? dir.baseline.ic_id : entryIc.id;

  const pair = shutokoRoutes.pairs.find(p => p.from === startIcId && p.to === exitIc.id);
  const label = document.getElementById('label-shutoko-route');
  const sel   = document.getElementById('sel-shutoko-route');
  sel.innerHTML = '';

  if (!pair || pair.options.length <= 1) {
    label.hidden = true;
    state.selected.shutokoRouteId = null;
    return;
  }

  label.hidden = false;
  for (const opt of pair.options) {
    const o = document.createElement('option');
    o.value = opt.id;
    o.textContent = `${opt.label}（${opt.km}km）`;
    sel.appendChild(o);
  }
  const def = pair.options.find(o => o.default) || pair.options[0];
  sel.value = def.id;
  state.selected.shutokoRouteId = def.id;
}

function wireEvents() {
  // outerRoute / gaikan checkbox / roundtrip
  document.getElementById('sel-outer-route').addEventListener('change', (e) => {
    state.selected.outerRoute = e.target.value;
    toggleGaikanCheckbox();
    updateShutokoRouteOptions();
    update();
  });
  document.getElementById('chk-via-gaikan').addEventListener('change', (e) => {
    state.selected.viaGaikan = e.target.checked; update();
  });
  document.getElementById('btn-geo-refresh').addEventListener('click', () => {
    if (!geoState.watcher) return;
    geoState.watcher.stop();
    geoState.enabled = true;
    geoState.watcher.start();
  });
  document.getElementById('btn-geo-toggle').addEventListener('click', () => {
    if (!geoState.watcher) return;
    if (geoState.enabled) {
      geoState.watcher.stop();
      geoState.enabled = false;
    } else {
      geoState.enabled = true;
      geoState.watcher.start();
    }
  });
  document.getElementById('sel-shutoko-route').addEventListener('change', (e) => {
    state.selected.shutokoRouteId = e.target.value;
    update();
  });

  // ---- Entry IC: search input + pulldown ----
  const entryInput = document.getElementById('inp-entry-ic');
  const entrySel   = document.getElementById('sel-entry-ic');

  function resolveEntryFromSearch() {
    const icId = icValueIndex.get(entryInput.value);
    if (!icId) {
      const hint = document.getElementById('entry-ic-hint');
      hint.textContent = entryInput.value ? '候補から選択してください' : '';
      hint.className = entryInput.value ? 'hint error' : 'hint';
      return;
    }
    setEntryIc(icId); update();
  }
  entryInput.addEventListener('change', resolveEntryFromSearch);
  entryInput.addEventListener('input',  resolveEntryFromSearch);
  entrySel.addEventListener('change', (e) => { setEntryIc(e.target.value); update(); });

  // ---- Exit IC: favorites + "別のIC" search + "別のIC" pulldown ----
  document.getElementById('sel-exit-fav').addEventListener('change', (e) => {
    setExitIc(e.target.value); update();
  });
  document.getElementById('sel-exit-all').addEventListener('change', (e) => {
    setExitIc(e.target.value); update();
  });
  const exitInput = document.getElementById('inp-exit-ic');
  function resolveExitFromSearch() {
    const icId = icValueIndex.get(exitInput.value);
    if (!icId) {
      const hint = document.getElementById('exit-ic-hint');
      hint.textContent = exitInput.value ? '候補から選択してください' : '';
      hint.className = exitInput.value ? 'hint error' : 'hint';
      return;
    }
    setExitIc(icId); update();
  }
  exitInput.addEventListener('change', resolveExitFromSearch);
  exitInput.addEventListener('input',  resolveExitFromSearch);

  // ---- Session log buttons ----
  document.getElementById('btn-save-oneway').addEventListener('click', () => addLogEntry('oneway'));
  document.getElementById('btn-save-roundtrip').addEventListener('click', () => addLogEntry('roundtrip'));
  document.getElementById('btn-clear-log').addEventListener('click', clearTodayLog);
}

function toggleGaikanCheckbox() {
  const conf = state.data.routes.needs_gaikan_transit[state.selected.outerRoute];
  document.getElementById('label-via-gaikan').hidden = (conf !== 'optional');
}

function renderRoutePath(result) {
  const section = document.getElementById('route-path-section');
  const container = document.getElementById('route-path');
  container.innerHTML = '';

  const entryIc = state.data.ics.find(x => x.id === state.selected.entryIcId);
  const exitIc  = state.data.ics.find(x => x.id === state.selected.exitIcId);
  if (!entryIc || !exitIc) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const nodes = [];

  // Entry IC
  nodes.push({ type: 'node', text: entryIc.name });

  // Segments from judgeRoute
  for (const seg of result.segments) {
    nodes.push({ type: 'arrow', text: '→' });
    nodes.push({ type: 'seg', text: seg.name, pay: seg.pay });
  }

  nodes.push({ type: 'arrow', text: '→' });
  nodes.push({ type: 'node', text: exitIc.name });

  for (const n of nodes) {
    const el = document.createElement('span');
    if (n.type === 'node') { el.className = 'route-node'; el.textContent = n.text; }
    else if (n.type === 'arrow') { el.className = 'route-arrow'; el.textContent = n.text; }
    else if (n.type === 'seg') {
      el.className = `route-seg ${n.pay}`;
      el.textContent = n.text;
    }
    container.appendChild(el);
  }

  renderJctDetails(result, entryIc, exitIc);
}

function renderJctDetails(result, entryIc, exitIc) {
  const wrap = document.getElementById('route-jct-details');
  const list = document.getElementById('route-jct-list');
  list.innerHTML = '';
  const shutokoSeg = result.segments.find(s => s.route === 'shutoko');
  const path = shutokoSeg?.path;
  if (!path || path.length < 2) { wrap.hidden = true; return; }

  const ics = state.data.ics;
  const fullPath = path[0] === entryIc.id ? path.slice() : [entryIc.id, ...path];
  if (fullPath[fullPath.length - 1] !== exitIc.id) fullPath.push(exitIc.id);

  for (let i = 0; i < fullPath.length; i++) {
    const id = fullPath[i];
    const ic = ics.find(x => x.id === id);
    const span = document.createElement('span');
    const isJct = id.includes('jct') || (ic?.name || '').includes('JCT');
    span.className = isJct ? 'jct-node jct-is-jct' : 'jct-node jct-is-ic';
    span.textContent = ic ? ic.name : id;
    list.appendChild(span);
    if (i < fullPath.length - 1) {
      const arrow = document.createElement('span');
      arrow.className = 'jct-arrow';
      arrow.textContent = '→';
      list.appendChild(arrow);
    }
  }
  wrap.hidden = false;
}

function update() {
  const icById = (id) => state.data.ics.find(x => x.id === id);
  const entryIc = icById(state.selected.entryIcId);
  const exitIc  = icById(state.selected.exitIcId);
  if (!entryIc || !exitIc) return;

  entryIc._viaGaikan = state.selected.viaGaikan;

  const result = judgeRoute({
    outerRoute: state.selected.outerRoute,
    entryIc, exitIc,
    roundTrip: true,
    shutokoRouteId: state.selected.shutokoRouteId
  }, state.data);

  state.lastResult = result;
  renderVerdict(result);
  renderBreakdown(result);
  renderRoutePath(result);
}

function renderVerdict(result) {
  const main = document.getElementById('badge-main');
  const ded  = document.getElementById('badge-deduction');
  const dist = document.getElementById('badge-distance');

  const { paySummary, deductionKmOneway, deductionKmRoundtrip,
          distanceKmOneway, distanceKmRoundtrip } = result.totals;

  main.className = 'badge-main';
  if (paySummary === 'all_company') { main.classList.add('company'); main.textContent = '🟢 全区間 会社負担'; }
  else if (paySummary === 'all_self') { main.classList.add('self'); main.textContent = '⚫ 全区間 自己負担'; }
  else { main.classList.add('mixed'); main.textContent = '🔵 区間混在（内訳で確認）'; }

  ded.textContent  = `🛣 控除: 片道 ${deductionKmOneway.toFixed(1)}km / 往復 ${deductionKmRoundtrip.toFixed(1)}km`;
  dist.textContent = `📏 総距離: 片道 ${distanceKmOneway.toFixed(1)}km / 往復 ${distanceKmRoundtrip.toFixed(1)}km`;
}

function renderBreakdown(result) {
  const ul = document.getElementById('segment-breakdown');
  ul.innerHTML = '';
  for (const seg of result.segments) {
    const li = document.createElement('li');
    const emoji = seg.pay === 'company' ? '🟢' : '⚫';
    const pay = seg.pay === 'company' ? '会社負担' : '自己負担';
    li.textContent = `${emoji} ${seg.name} — ${pay} / 距離 ${seg.distanceKm.toFixed(1)}km / 控除 ${seg.deductionKm.toFixed(1)}km`;
    ul.appendChild(li);
  }
}

init().catch(err => {
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = `起動エラー:\n${err.message}`;
  document.body.prepend(banner);
  console.error(err);
});
