import { loadArrivals, filterByTerminals, filterByTimeWindow, aggregateHeatmapClient, summarizeFlights } from './arrivals-data.js';
import { renderHeatmap, renderFlightList, renderUpdatedAt, renderSummary, renderLegend } from './arrivals-render.js';

const TAB_TERMINALS = {
  'T1': ['T1'],
  'T2': ['T2'],
  'T1T2': ['T1', 'T2'],
  'T3': ['T3']
};

const state = { arrivals: null, tab: 'T1T2' };

async function refresh() {
  try {
    state.arrivals = await loadArrivals();
    render();
  } catch (e) {
    document.getElementById('arrivals-error').textContent = `データ取得失敗: ${e.message}`;
    document.getElementById('arrivals-error').hidden = false;
  }
}

function render() {
  const terminals = TAB_TERMINALS[state.tab] ?? ['T1'];
  const all = filterByTerminals(state.arrivals, terminals);
  const visible = filterByTimeWindow(all, new Date(), 30, 180);
  const bins = aggregateHeatmapClient(visible);
  const summary = summarizeFlights(visible);
  renderSummary(document.getElementById('summary'), summary);
  renderHeatmap(document.getElementById('heatmap'), bins);
  renderFlightList(document.getElementById('flight-list'), visible);
  renderUpdatedAt(
    document.getElementById('arrivals-footer'),
    state.arrivals.updatedAt,
    state.arrivals.stats.unknownAircraft
  );
  document.querySelectorAll('.terminal-tab').forEach(el => {
    el.classList.toggle('is-active', el.dataset.terminal === state.tab);
  });
}

function setupTerminalTabs() {
  document.querySelectorAll('.terminal-tab').forEach(el => {
    el.addEventListener('click', () => {
      state.tab = el.dataset.terminal;
      if (state.arrivals) render();
    });
  });
}

function setupReload() {
  const btn = document.getElementById('arrivals-reload');
  if (btn) btn.addEventListener('click', refresh);
}

renderLegend(document.getElementById('legend'));
setupTerminalTabs();
setupReload();
refresh();
setInterval(refresh, 60000);
