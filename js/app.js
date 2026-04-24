import { loadAllData } from './data-loader.js';
import { judgeRoute } from './judge.js';

const state = {
  data: null,
  selected: {
    outerRoute: 'none',
    entryIcId: null,
    exitIcId: null,
    roundTrip: true,
    viaGaikan: false
  }
};

async function init() {
  state.data = await loadAllData();
  populateOuterRouteSelect();
  icValueIndex = buildSearchIndex();
  populateExitFavorites();
  populateAllIcSelects();
  setEntryIc('maihama');
  setExitIc('kukou_chuou');
  wireEvents();
  update();
}

function populateOuterRouteSelect() {
  const sel = document.getElementById('sel-outer-route');
  const labels = state.data.routes.labels;
  sel.innerHTML = '';
  for (const [value, label] of Object.entries(labels)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === 'none') opt.selected = true;
    sel.appendChild(opt);
  }
}

const DIRECTION_ORDER = [
  'tomei', 'chuo', 'kanetsu', 'tohoku', 'joban',
  'keiyo', 'tokan', 'aqua', 'tateyama',
  'third_keihin', 'yokoyoko', 'yokohane_route', 'kariba_route', 'wangan_route',
  'gaikan', 'shutoko_inner'
];

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
    const ogE = document.createElement('optgroup'); ogE.label = grp.label;
    const ogX = document.createElement('optgroup'); ogX.label = grp.label;
    for (const { ic } of grp.ics) {
      const e = document.createElement('option'); e.value = ic.id; e.textContent = ic.name;
      const x = document.createElement('option'); x.value = ic.id; x.textContent = ic.name;
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
    const noteStr = f.note ? `（${f.note}）` : '';
    opt.textContent = `${ic.name}${noteStr}`;
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
  state.selected.outerRoute = inferOuterRoute(ic);

  document.getElementById('sel-outer-route').value = state.selected.outerRoute;
  document.getElementById('sel-entry-ic').value = icId;
  document.getElementById('inp-entry-ic').value = findSearchValueForId(icId);

  const hint = document.getElementById('entry-ic-hint');
  hint.textContent = ic.route_name || '';
  hint.className = 'hint';

  toggleGaikanCheckbox();
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
}

function inferOuterRoute(ic) {
  if (!ic) return 'none';
  const ROUTE_MAP = {
    'tomei':    'tomei',
    'chuo':     'chuo',
    'kanetsu':  'kanetsu',
    'tohoku':   'tohoku',
    'joban':    'joban',
    'keiyo':    'keiyo',
    'tokan':    'tokan',
    'aqua':     'aqua',
    'tateyama': 'tateyama',
    'third_keihin':   'third_keihin',
    'yokoyoko':       'yokoyoko',
    'yokohane_route': 'yokohane_route',
    'kariba_route':   'kariba_route',
    'wangan_route':   'wangan_route'
  };
  if (ROUTE_MAP[ic.route]) return ROUTE_MAP[ic.route];
  if (ic.boundary_tag === 'gaikan') return 'gaikan_direct';
  return 'none';  // 都心IC / 首都高内
}

function wireEvents() {
  // outerRoute / gaikan checkbox / roundtrip
  document.getElementById('sel-outer-route').addEventListener('change', (e) => {
    state.selected.outerRoute = e.target.value;
    toggleGaikanCheckbox();
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

function update() {
  const icById = (id) => state.data.ics.find(x => x.id === id);
  const entryIc = icById(state.selected.entryIcId);
  const exitIc  = icById(state.selected.exitIcId);
  if (!entryIc || !exitIc) return;

  entryIc._viaGaikan = state.selected.viaGaikan;

  const result = judgeRoute({
    outerRoute: state.selected.outerRoute,
    entryIc, exitIc,
    roundTrip: state.selected.roundTrip
  }, state.data);

  renderVerdict(result);
  renderBreakdown(result);
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

  const rt = state.selected.roundTrip;
  ded.textContent  = `🛣 控除: ${rt ? '往復' : '片道'} ${(rt ? deductionKmRoundtrip : deductionKmOneway).toFixed(1)}km`;
  dist.textContent = `📏 総距離: ${rt ? '往復' : '片道'} ${(rt ? distanceKmRoundtrip : distanceKmOneway).toFixed(1)}km`;
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
