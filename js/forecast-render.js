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

// --- Phase C-2: パターンマッチング描画 ---

const SIM_HIGH_THRESHOLD = 0.7;
const SIM_MID_THRESHOLD = 0.4;

function similarityIcon(sim) {
  if (sim >= SIM_HIGH_THRESHOLD) return '🟢';
  if (sim >= SIM_MID_THRESHOLD) return '🟡';
  return '⚪';
}

const DAY_TYPE_LABEL = {
  weekday: '平日',
  saturday: '土曜',
  sunday_holiday: '日曜/祝日',
  pre_holiday: '連休前',
  in_consec_holiday: '連休中',
  last_consec_holiday: '連休最終日',
};

const FILTER_TIER_LABEL = {
  strict: '厳密 (同曜日カテゴリ・同月)',
  medium: '中 (同曜日カテゴリ・近月)',
  loose: '緩 (平日/休日)',
  all: '全候補',
};

export function renderPatternMeta(container, patternMatch) {
  if (!container || !patternMatch) return;
  const t = patternMatch.today || {};
  const dayLabel = DAY_TYPE_LABEL[t.dayType] || t.dayType || '?';
  const tierLabel = FILTER_TIER_LABEL[t.filterTier] || t.filterTier || '?';
  container.innerHTML =
    `今日: <strong>${t.date}</strong> / ${dayLabel} / ${t.month}月 / フィルタ <strong>${tierLabel}</strong> / 候補 ${patternMatch.candidateCount} 日`;
}

export function renderSimilarDays(container, patternMatch) {
  if (!container || !patternMatch) return;
  const items = patternMatch.similarDays || [];
  if (items.length === 0) {
    container.innerHTML = '<li class="similar-day-item">類似日なし (サンプル不足)</li>';
    return;
  }
  container.innerHTML = items.map(s => `
    <li class="similar-day-item">
      <span class="similar-day-icon">${similarityIcon(s.similarity)}</span>
      <span class="similar-day-label">${s.label}</span>
      <span class="similar-day-score">cos ${s.similarity.toFixed(3)}</span>
    </li>
  `).join('');
}

export function renderHistoricalCurve(container, patternMatch) {
  if (!container || !patternMatch) return;
  const slots = patternMatch.historicalCurve || [];
  if (slots.length === 0) {
    container.innerHTML = '<p class="pattern-meta">ヒストリカル予測なし (類似日なし)</p>';
    return;
  }
  const rows = slots.map(s => `<tr>
    <td class="time">${s.slotStart}</td>
    <td>${s.stall1}</td>
    <td>${s.stall2}</td>
    <td>${s.stall3}</td>
    <td>${s.stall4}</td>
    <td class="total-cell">${s.total}</td>
  </tr>`).join('');
  container.innerHTML = `<table class="forecast-table">
    <thead><tr>
      <th>時刻</th><th>stall1</th><th>stall2</th><th>stall3</th><th>stall4</th><th>合計</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
