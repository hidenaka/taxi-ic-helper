import {
  renderForecastMeta, renderForecastTable,
  renderPatternMeta, renderSimilarDays, renderHistoricalCurve,
} from './forecast-render.js';

async function main() {
  const metaEl = document.getElementById('forecast-meta');
  const tableEl = document.getElementById('forecast-table-wrap');
  const patternMetaEl = document.getElementById('pattern-meta');
  const similarDaysEl = document.getElementById('similar-days');
  const curveEl = document.getElementById('historical-curve-wrap');

  // 短期予測 (Phase C-1)
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

  // パターンマッチング (Phase C-2)
  try {
    const res = await fetch('data/stall-pattern-match.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const patternMatch = await res.json();
    renderPatternMeta(patternMetaEl, patternMatch);
    renderSimilarDays(similarDaysEl, patternMatch);
    renderHistoricalCurve(curveEl, patternMatch);
  } catch (e) {
    patternMetaEl.textContent = `パターンマッチングデータの読み込みに失敗: ${e.message}`;
    similarDaysEl.innerHTML = '';
    curveEl.innerHTML = '';
  }
}

main();
