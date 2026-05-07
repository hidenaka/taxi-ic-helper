import { loadArrivals, filterByTerminals, filterByTimeWindow, aggregateHeatmapClient, summarizeFlights, detectTopics, classifyStaleness, sortFlightsByTime } from './arrivals-data.js';
import { renderHeatmap, renderFlightList, renderUpdatedAt, renderSummary, renderLegend, renderTopics, renderWeatherBanner, renderStaleBanner } from './arrivals-render.js';

const TAB_TERMINALS = {
  'T1': ['T1'],
  'T2': ['T2'],
  'T1T2': ['T1', 'T2'],
  'T3': ['T3']
};

const state = { arrivals: null, tab: 'T1T2', detailMode: false, heatmapMode: 'pax' };

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
  const visible = state.detailMode ? all : filterByTimeWindow(all, new Date(), 30, 180);
  const bins = aggregateHeatmapClient(visible);
  const summaryOpts = state.detailMode
    ? { windowHours: 19, windowLabel: '今日全体' }
    : { windowHours: 3.5, windowLabel: '直近3時間' };
  const summary = summarizeFlights(visible, summaryOpts);
  const topics = detectTopics(all);
  renderWeatherBanner(document.getElementById('weather-banner'), state.arrivals.weather ?? null);
  renderStaleBanner(
    document.getElementById('stale-banner'),
    classifyStaleness(state.arrivals.updatedAt, new Date())
  );
  renderTopics(document.getElementById('topics'), topics);
  renderSummary(document.getElementById('summary'), summary);
  const heatmapEl = document.getElementById('heatmap');
  heatmapEl.classList.toggle('is-taxi-mode', state.heatmapMode === 'taxi');
  renderHeatmap(heatmapEl, bins, state.heatmapMode);
  const title = document.getElementById('heatmap-title');
  if (title) title.textContent = state.heatmapMode === 'taxi'
    ? '時間帯別 タクシー候補数（30分単位）'
    : '時間帯別 推定降客数（30分単位）';
  renderFlightList(document.getElementById('flight-list'), sortFlightsByTime(visible));
  renderUpdatedAt(
    document.getElementById('arrivals-footer'),
    state.arrivals.updatedAt,
    state.arrivals.stats.unknownAircraft
  );
  document.querySelectorAll('.terminal-tab').forEach(el => {
    el.classList.toggle('is-active', el.dataset.terminal === state.tab);
  });
  updateDetailButton();
}

function updateDetailButton() {
  const btn = document.getElementById('detail-toggle');
  if (!btn) return;
  btn.textContent = state.detailMode ? '▲ 直近3時間に戻す' : '▼ 今日の全便を表示';
  btn.classList.toggle('is-active', state.detailMode);
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

function setupDetailToggle() {
  const btn = document.getElementById('detail-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    state.detailMode = !state.detailMode;
    if (state.arrivals) render();
  });
}

function setupHeatmapModeToggle() {
  document.querySelectorAll('.heatmap-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.heatmapMode = btn.dataset.mode;
      document.querySelectorAll('.heatmap-mode-btn').forEach(b => {
        b.classList.toggle('is-active', b.dataset.mode === state.heatmapMode);
      });
      if (state.arrivals) render();
    });
  });
}

renderLegend(document.getElementById('legend'));
setupTerminalTabs();
setupReload();
setupDetailToggle();
setupHeatmapModeToggle();
refresh();
setInterval(refresh, 60000);
