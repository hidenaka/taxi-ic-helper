import { loadAllData } from './data-loader.js';
import { judgeRoute } from './judge.js';
import { clearHighlights, highlightIc } from './map-svg.js';

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
  await loadSvg();
  populateOuterRouteSelect();
  populateIcSelects();
  wireEvents();
  update();
}

async function loadSvg() {
  const svgText = await (await fetch('./svg/map.svg')).text();
  document.getElementById('svg-mount').innerHTML = svgText;
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

function populateIcSelects() {
  const entrySel = document.getElementById('sel-entry-ic');
  const exitSel = document.getElementById('sel-exit-ic');
  entrySel.innerHTML = '';
  exitSel.innerHTML = '';

  const grouped = groupIcsByRoute(state.data.ics);
  for (const [routeName, list] of Object.entries(grouped)) {
    const ogE = document.createElement('optgroup'); ogE.label = routeName;
    const ogX = document.createElement('optgroup'); ogX.label = routeName;
    for (const ic of list) {
      const e = document.createElement('option'); e.value = ic.id; e.textContent = ic.name;
      const x = document.createElement('option'); x.value = ic.id; x.textContent = ic.name;
      ogE.appendChild(e); ogX.appendChild(x);
    }
    entrySel.appendChild(ogE); exitSel.appendChild(ogX);
  }
  entrySel.value = 'maihama';
  exitSel.value = 'kasumigaseki';
  state.selected.entryIcId = 'maihama';
  state.selected.exitIcId = 'kasumigaseki';
}

function groupIcsByRoute(ics) {
  const map = {};
  for (const ic of ics) {
    const key = ic.route_name || 'その他';
    (map[key] ||= []).push(ic);
  }
  return map;
}

function wireEvents() {
  document.getElementById('sel-outer-route').addEventListener('change', (e) => {
    state.selected.outerRoute = e.target.value;
    toggleGaikanCheckbox();
    update();
  });
  document.getElementById('sel-entry-ic').addEventListener('change', (e) => {
    state.selected.entryIcId = e.target.value; update();
  });
  document.getElementById('sel-exit-ic').addEventListener('change', (e) => {
    state.selected.exitIcId = e.target.value; update();
  });
  document.getElementById('chk-roundtrip').addEventListener('change', (e) => {
    state.selected.roundTrip = e.target.checked; update();
  });
  document.getElementById('chk-via-gaikan').addEventListener('change', (e) => {
    state.selected.viaGaikan = e.target.checked; update();
  });
  document.getElementById('btn-geo-refresh').addEventListener('click', () => {
    // v0.2 で GPS 取得。v0.1 では空のハンドラ
    const span = document.getElementById('geo-location');
    span.textContent = 'GPS はv0.2で実装予定';
  });
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
  renderSvgHighlights(result);
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

function renderSvgHighlights(result) {
  clearHighlights();
  const allCompany = result.totals.paySummary === 'all_company';
  const hasDeduction = result.totals.deductionKmOneway > 0;
  const entryVariant = allCompany ? 'company' : (hasDeduction ? 'self-ded' : 'self-none');
  highlightIc(state.selected.entryIcId, entryVariant);
  highlightIc(state.selected.exitIcId, 'self-none');
}

init().catch(err => {
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.textContent = `起動エラー:\n${err.message}`;
  document.body.prepend(banner);
  console.error(err);
});
