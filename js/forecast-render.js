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
  post_holiday: '連休明け平日',
  saturday: '土曜',
  sunday_holiday: '日曜/祝日',
  pre_holiday: '連休前平日',
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
  let consecText = '';
  if (typeof t.relevantConsec === 'number' && t.relevantConsec >= 2) {
    if (t.dayType === 'post_holiday') consecText = ` / ${t.relevantConsec}連休明け`;
    else if (t.dayType === 'pre_holiday') consecText = ` / ${t.relevantConsec}連休前`;
    else consecText = ` / ${t.relevantConsec}連休中`;
  }
  container.innerHTML =
    `今日: <strong>${t.date}</strong> / ${dayLabel}${consecText} / ${t.month}月 / フィルタ <strong>${tierLabel}</strong> / 候補 ${patternMatch.candidateCount} 日`;
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

// --- Phase D-1: 予測精度描画 ---

const LEAD_LABEL = { lead30: '30 分先', lead60: '60 分先', lead120: '120 分先' };

export function renderAccuracy(metaEl, tableEl, accuracy) {
  if (!metaEl || !tableEl || !accuracy) return;
  const r24 = accuracy.recent24h;
  metaEl.innerHTML = `予測時刻 ${(accuracy.generatedAt || '').slice(0, 16).replace('T', ' ')} JST / ログ ${accuracy.logEntryCount} 件`;

  if (!r24) {
    tableEl.innerHTML = '<p class="accuracy-meta">精度データなし</p>';
    return;
  }
  const fmt = (v) => (v === null || v === undefined) ? '—' : `${v.toFixed(2)} 台`;
  const rows = ['lead30', 'lead60', 'lead120'].map(k => {
    const fc = r24.forecast[k] || { mae_total: null, n: 0 };
    const pm = r24.patternMatch[k] || { mae_total: null, n: 0 };
    const w = r24.winner[k];
    let winLabel = '—';
    if (w === 'forecast') winLabel = '<span class="winner-fc">forecast</span>';
    else if (w === 'patternMatch') winLabel = '<span class="winner-pm">pattern</span>';
    return `<tr>
      <td class="lead">${LEAD_LABEL[k]}</td>
      <td>${fmt(fc.mae_total)}</td>
      <td>${fmt(pm.mae_total)}</td>
      <td>${winLabel}</td>
      <td>${fc.n}</td>
    </tr>`;
  }).join('');
  tableEl.innerHTML = `<table class="accuracy-table">
    <thead><tr>
      <th>lead time</th><th>forecast MAE</th><th>pattern MAE</th><th>優勢</th><th>n</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// --- Phase D-2: 統合予測描画 ---

const ENSEMBLE_TIER_HIGH = 8;
const ENSEMBLE_TIER_VERY_HIGH = 12;

export function renderEnsemble(metaEl, tableEl, ensemble) {
  if (!metaEl || !tableEl || !ensemble) return;
  const w = ensemble.weights || {};
  const wText = ['lead30', 'lead60', 'lead120'].map(k => {
    const e = w[k];
    if (!e) return '';
    const label = { lead30: '30分先', lead60: '60分先', lead120: '120分先' }[k];
    const pct = `fc${Math.round(e.w_fc * 100)}%/pm${Math.round(e.w_pm * 100)}%`;
    const note = e.source === 'fallback' ? ' (様子見)' : '';
    return `${label} ${pct}${note}`;
  }).filter(Boolean).join(' / ');
  const ts = (ensemble.generatedAt || '').slice(0, 16).replace('T', ' ');
  metaEl.innerHTML = `予測時刻 <strong>${ts} JST</strong><br>重み: ${wText}`;

  const slots = ensemble.slots || [];
  if (slots.length === 0) {
    tableEl.innerHTML = '<p class="ensemble-meta">統合予測なし</p>';
    return;
  }
  const rows = slots.map(s => {
    let tierClass = '';
    let mark = '';
    if (s.total >= ENSEMBLE_TIER_VERY_HIGH) { tierClass = 'tier-very-high'; mark = ' <span class="star">★★</span>'; }
    else if (s.total >= ENSEMBLE_TIER_HIGH) { tierClass = 'tier-high'; mark = ' <span class="star">★</span>'; }
    return `<tr class="${tierClass}">
      <td class="time">${s.slotStart}</td>
      <td>${s.stall1}</td>
      <td>${s.stall2}</td>
      <td>${s.stall3}</td>
      <td>${s.stall4}</td>
      <td class="total-cell">${s.total}${mark}</td>
    </tr>`;
  }).join('');
  tableEl.innerHTML = `<table class="ensemble-table">
    <thead><tr>
      <th>時刻</th><th>stall1</th><th>stall2</th><th>stall3</th><th>stall4</th><th>合計</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// --- Phase D-3: 係数補正状態描画 ---

const SHARE_BUCKET_LABELS = {
  early: '7-9時', morning: '9-12時', noon: '12-15時', afternoon: '15-17時',
  peak1: '17-19時', evening: '19-21:30', peak2: '21:30-24時', midnight: '24時以降',
};
const LEVEL_LABELS = { lead30: '30分先', lead60: '60分先', lead120: '120分先' };

function srcSpan(source) {
  const cls = source === 'learning' ? 'src-learning' : 'src-fallback';
  const label = source === 'learning' ? '学習中' : '様子見';
  return `<span class="${cls}">${label}</span>`;
}

export function renderCorrections(metaEl, levelEl, shareEl, corrections) {
  if (!metaEl || !levelEl || !shareEl || !corrections) return;
  const ts = (corrections.generatedAt || '').slice(0, 16).replace('T', ' ');
  metaEl.innerHTML = `生成時刻 <strong>${ts} JST</strong><br>forecast レベル補正 ＝ ensemble に適用 / transit-share 補正 ＝ 便台数推定に適用`;

  const level = corrections.level || {};
  const levelRows = ['lead30', 'lead60', 'lead120'].map(k => {
    const e = level[k] || { factor: 1.0, source: 'fallback', n: 0 };
    return `<tr>
      <td class="label">${LEVEL_LABELS[k]}</td>
      <td>${Number(e.factor).toFixed(2)}×</td>
      <td>${srcSpan(e.source)}</td>
      <td>${e.n}</td>
    </tr>`;
  }).join('');
  levelEl.innerHTML = `<h3>forecast レベル補正</h3>
    <table class="correction-table">
      <thead><tr><th>lead time</th><th>補正係数</th><th>状態</th><th>n</th></tr></thead>
      <tbody>${levelRows}</tbody>
    </table>`;

  const share = corrections.share || {};
  const shareCell = (entry) => {
    if (!entry) return '—';
    if (entry.source === 'unobservable') return '<span class="src-fallback">観測外</span>';
    const f = `${Number(entry.factor).toFixed(2)}×`;
    if (entry.source === 'directional') return `${f} <span class="src-learning">方向性</span>`;
    return `${f} ${srcSpan(entry.source)}`;
  };
  const shareRows = ['early', 'morning', 'noon', 'afternoon', 'peak1', 'evening', 'peak2', 'midnight']
    .filter(k => share[k])
    .map(k => {
      const e = share[k];
      return `<tr>
        <td class="label">${SHARE_BUCKET_LABELS[k]}</td>
        <td>${shareCell(e.T1)}</td>
        <td>${shareCell(e.T2)}</td>
        <td>${shareCell(e.T3)}</td>
      </tr>`;
    }).join('');
  shareEl.innerHTML = `<h3>transit-share バケット補正 (端末別)</h3>
    <table class="correction-table">
      <thead><tr><th>時間帯</th><th>T1</th><th>T2</th><th>T3</th></tr></thead>
      <tbody>${shareRows}</tbody>
    </table>`;
}

// --- G-9: スループット校正バナー描画 ---

/**
 * 出力 JSON の throughputScaleK を読み、予測台数が車両追跡実測で
 * 校正済みかどうかを示す1行バナーを描画する。
 * @param {HTMLElement} el - バナー要素 (#throughput-banner)
 * @param {object} obj - throughputScaleK を持つ出力 JSON (ensemble など)
 */
export function renderThroughputBanner(el, obj) {
  if (!el || !obj) return;
  const k = Number(obj.throughputScaleK);
  if (Number.isFinite(k) && k > 1) {
    el.className = 'throughput-banner calibrated';
    el.textContent = `🚕 予測台数は車両追跡の実測で校正済み（校正係数 ×${k.toFixed(2)}）`;
  } else {
    el.className = 'throughput-banner pending';
    el.textContent = '予測台数は占有差分ベース（車両追跡の校正データ蓄積中）';
  }
}
