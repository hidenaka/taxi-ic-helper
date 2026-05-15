/**
 * data/stall-forecast.json を受け取り、テーブルとメタ情報を描画する。
 */

const TIER_HIGH_THRESHOLD = 8;
const TIER_VERY_HIGH_THRESHOLD = 12;

export function renderForecastMeta(container, forecast) {
  if (!container || !forecast) return;
  const ts = forecast.generatedAt ? forecast.generatedAt.slice(0, 16).replace('T', ' ') : 'n/a';
  const trend = (forecast.trendFactor ?? 1).toFixed(2);
  const samples = forecast.baselineSampleCount ?? 0;
  container.innerHTML =
    `予測時刻 <strong>${ts} JST</strong> / 直近トレンド × <strong>${trend}</strong> / baseline サンプル ${samples} 行`;
}

export function renderForecastTable(container, forecast) {
  if (!container || !forecast) return;
  const rows = forecast.slots.map(s => {
    let tierClass = '';
    let mark = '';
    if (s.total >= TIER_VERY_HIGH_THRESHOLD) {
      tierClass = 'tier-very-high';
      mark = ' <span class="star">★★</span>';
    } else if (s.total >= TIER_HIGH_THRESHOLD) {
      tierClass = 'tier-high';
      mark = ' <span class="star">★</span>';
    }
    return `<tr class="${tierClass}">
      <td class="time">${s.slotStart}</td>
      <td>${s.stall1}</td>
      <td>${s.stall2}</td>
      <td>${s.stall3}</td>
      <td>${s.stall4}</td>
      <td class="total-cell">${s.total}${mark}</td>
      <td class="factor-cell">${s.flightFactor.toFixed(2)}</td>
    </tr>`;
  }).join('');
  container.innerHTML = `<table class="forecast-table">
    <thead><tr>
      <th>時刻</th>
      <th>stall1</th>
      <th>stall2</th>
      <th>stall3</th>
      <th>stall4</th>
      <th>合計</th>
      <th>便量×</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
