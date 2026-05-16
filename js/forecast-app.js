import {
  renderForecastMeta, renderForecastTable,
  renderPatternMeta, renderSimilarDays, renderHistoricalCurve,
  renderAccuracy, renderEnsemble, renderCorrections,
} from './forecast-render.js';

async function main() {
  const ensembleMetaEl = document.getElementById('ensemble-meta');
  const ensembleTableEl = document.getElementById('ensemble-table-wrap');
  const metaEl = document.getElementById('forecast-meta');
  const tableEl = document.getElementById('forecast-table-wrap');
  const patternMetaEl = document.getElementById('pattern-meta');
  const similarDaysEl = document.getElementById('similar-days');
  const curveEl = document.getElementById('historical-curve-wrap');
  const accuracyMetaEl = document.getElementById('accuracy-meta');
  const accuracyTableEl = document.getElementById('accuracy-table-wrap');
  const correctionMetaEl = document.getElementById('correction-meta');
  const correctionLevelEl = document.getElementById('correction-level-wrap');
  const correctionShareEl = document.getElementById('correction-share-wrap');

  // 統合予測 (Phase D-2) — メイン予測、最初に描画
  try {
    const res = await fetch('data/stall-ensemble.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ensemble = await res.json();
    renderEnsemble(ensembleMetaEl, ensembleTableEl, ensemble);
  } catch (e) {
    ensembleMetaEl.textContent = `統合予測データの読み込みに失敗: ${e.message}`;
    ensembleTableEl.innerHTML = '';
  }

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

  // 予測精度 (Phase D-1)
  try {
    const res = await fetch('data/forecast-accuracy.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const accuracy = await res.json();
    renderAccuracy(accuracyMetaEl, accuracyTableEl, accuracy);
  } catch (e) {
    accuracyMetaEl.textContent = `精度データの読み込みに失敗: ${e.message}`;
    accuracyTableEl.innerHTML = '';
  }

  // 係数補正状態 (Phase D-3)
  try {
    const res = await fetch('data/coefficient-corrections.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const corrections = await res.json();
    renderCorrections(correctionMetaEl, correctionLevelEl, correctionShareEl, corrections);
  } catch (e) {
    correctionMetaEl.textContent = `補正データの読み込みに失敗: ${e.message}`;
    correctionLevelEl.innerHTML = '';
    correctionShareEl.innerHTML = '';
  }
}

main();
