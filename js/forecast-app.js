import { renderForecastMeta, renderForecastTable } from './forecast-render.js';

async function main() {
  const metaEl = document.getElementById('forecast-meta');
  const tableEl = document.getElementById('forecast-table-wrap');
  try {
    const res = await fetch('data/stall-forecast.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const forecast = await res.json();
    renderForecastMeta(metaEl, forecast);
    renderForecastTable(tableEl, forecast);
  } catch (e) {
    metaEl.textContent = `予測データの読み込みに失敗: ${e.message}`;
    tableEl.innerHTML = '';
  }
}

main();
