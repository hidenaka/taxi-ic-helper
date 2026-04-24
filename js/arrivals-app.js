import { loadArrivals, filterByTerminal, filterByTimeWindow, aggregateHeatmapClient, summarizeFlights } from './arrivals-data.js';
import { renderHeatmap, renderFlightList, renderUpdatedAt, renderSummary } from './arrivals-render.js';

const state = { arrivals: null, terminal: 'T1' };

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
  const all = filterByTerminal(state.arrivals, state.terminal);
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
    el.classList.toggle('is-active', el.dataset.terminal === state.terminal);
  });
}

function setupTerminalTabs() {
  document.querySelectorAll('.terminal-tab').forEach(el => {
    el.addEventListener('click', () => {
      state.terminal = el.dataset.terminal;
      if (state.arrivals) render();
    });
  });
}

function setupReload() {
  const btn = document.getElementById('arrivals-reload');
  if (btn) btn.addEventListener('click', refresh);
}

setupTerminalTabs();
setupReload();
refresh();
setInterval(refresh, 60000);
