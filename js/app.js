import { loadAllData } from './data-loader.js';
import { judgeRoute } from './judge.js';

const state = {
  data: null,
  selected: {
    outerRoute: 'none',
    entryIcId: null,
    exitIcId: null,
    roundTrip: true,
    viaGaikan: false,
    shutokoRouteId: null
  }
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
}


const DIRECTION_ORDER = [
  'tomei', 'chuo', 'kanetsu', 'tohoku', 'joban',
  'keiyo', 'tokan', 'aqua', 'tateyama',
  'third_keihin', 'yokoyoko', 'yokohane_route', 'kariba_route', 'wangan_route',
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
  'yokoyoko':       '横横道路',
  'yokohane_route': '横羽線経由',
  'kariba_route':   '狩場線経由',
  'wangan_route':   '湾岸線経由',
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
    if (ic.boundary_tag === 'gaikan') {
      assignment.set(ic.id, { groupId: 'gaikan', sortKey: 0 });
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
  const valueToIcId = new Map();

  const groups = buildIcGrouping(state.data);
  for (const grp of groups) {
    for (const { ic } of grp.ics) {
      const value = `${ic.name}（${grp.label}）`;
      valueToIcId.set(value, ic.id);
      const opt = document.createElement('option');
      opt.value = value;
      datalist.appendChild(opt);
    }
  }
  return valueToIcId;
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

// ---- State-sync helpers ----
function findSearchValueForId(icId) {
  for (const [val, id] of icValueIndex.entries()) {
    if (id === icId) return val;
  }
  return '';
}

function setEntryIc(icId) {
  const ic = state.data.ics.find(x => x.id === icId);
  if (!ic) return;
  state.selected.entryIcId = icId;

  // Determine valid outerRoute options for this entry IC
  updateOuterRouteOptions();  // also sets state.selected.outerRoute if current is invalid

  document.getElementById('sel-entry-ic').value = icId;
  document.getElementById('inp-entry-ic').value = findSearchValueForId(icId);

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
  const inp    = document.getElementById('inp-exit-ic');

  const favIds = state.data.favorites.exit_favorites.map(f => f.ic_id);
  favSel.value = favIds.includes(icId) ? icId : '';
  allSel.value = icId;
  inp.value = findSearchValueForId(icId);

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
  // If found in >=1 direction, return all of them (enables 同じICが両経路 を使う pattern).
  const matched = [];
  for (const dir of state.data.deduction.directions) {
    if (dir.entries.some(e => e.ic_id === ic.id)) matched.push(dir.id);
  }
  if (matched.length > 0) return matched;

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
  document.getElementById('chk-roundtrip').addEventListener('change', (e) => {
    state.selected.roundTrip = e.target.checked; update();
  });
  document.getElementById('chk-via-gaikan').addEventListener('change', (e) => {
    state.selected.viaGaikan = e.target.checked; update();
  });
  document.getElementById('btn-geo-refresh').addEventListener('click', () => {
    document.getElementById('geo-location').textContent = 'GPS はv0.2で実装予定';
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
    roundTrip: state.selected.roundTrip,
    shutokoRouteId: state.selected.shutokoRouteId
  }, state.data);

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
