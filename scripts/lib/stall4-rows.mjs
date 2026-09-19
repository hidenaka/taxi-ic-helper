// 乗り場ごとの「列移動イベント」(画像計測の専用 tick が出す jsonl)を、
// 15分ビンの advance-count-history と現況(直近15分)へ載せるための純関数。
//
// 背景(2026-09-18):
//   4号後列: frontDensity(コーンの手前線の小箱)では列移動を数えられない(列1がふだん箱まで来ない)
//            → scripts/stall4-row-shift-tick.py が列1の前縁を追い、2列移動は 2 と数える。
//   3号:     列1(出口側=画面左端)が混雑時は画面外 → scripts/stall3-block-move-tick.py が
//            「帯の大半が同時に変わる」=塊が動いた を 1回(rows=1)として数える。
//   1・2号は従来どおり frontDensity 経路のまま。

/** jsonl テキスト → イベント配列。壊れた行は捨てる。 */
export function parseRowEvents(text) {
  return String(text || '')
    .split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && typeof e.ts === 'string' && Number.isFinite(e.rows));
}

/** ts(ISO, +09:00) の JST 時。 */
function jstHour(ts) {
  const m = /T(\d{2}):/.exec(ts);
  return m ? parseInt(m[1], 10) : NaN;
}

/**
 * [startEpoch, endEpoch) に入るイベントの列数合計(2列移動は 2)。
 * opts.quietHours = [[from,to],...] の JST 時間帯(乗り場停止中)のイベントは数えない
 * (停止中の入庫の並べ替えを列移動に数えないため。advance-forecast の DEFAULT_QUIET_HOURS と同じ考え)。
 */
// 数えるのは「列移動の回数」(本人指示 2026-09-19)。rows(何列ぶん進んだか)はイベントの付帯情報として残すだけで、
// 集計には使わない(opts.unit === 'rows' を明示したときだけ列数を足す)。
export function rowsInWindow(events, startEpoch, endEpoch, opts = {}) {
  const quiet = opts.quietHours || null;
  const useRows = opts.unit === 'rows';
  let sum = 0;
  for (const e of events || []) {
    const t = Math.floor(new Date(e.ts).getTime() / 1000);
    if (!Number.isFinite(t) || t < startEpoch || t >= endEpoch) continue;
    if (quiet) {
      const h = jstHour(e.ts);
      if (quiet.some(([a, b]) => h >= a && h < b)) continue;
    }
    sum += useRows ? Math.max(0, Math.round(e.rows)) : 1;
  }
  return sum;
}

/**
 * 完成した15分ビン行 {ts, stalls} の、指定乗り場を列移動イベント由来の値で置き換える。
 * eventsByStall = { stall4: events|null, stall3: events|null }。null の乗り場は触らない(従来経路)。
 * イベントが無いビンはその乗り場を落とす(=0。「count>0 のみ持つ」流儀に合わせる)。
 */
export function applyRowEvents(binRow, eventsByStall, opts = {}) {
  if (!binRow || !eventsByStall) return binRow;
  const start = Math.floor(new Date(binRow.ts).getTime() / 1000);
  if (!Number.isFinite(start)) return binRow;
  const binSec = opts.binSec ?? 900;
  const quietByStall = opts.quietHours || {};
  const stalls = { ...(binRow.stalls || {}) };
  for (const [stall, events] of Object.entries(eventsByStall)) {
    if (!events) continue;
    const rows = rowsInWindow(events, start, start + binSec, { quietHours: quietByStall[stall] });
    if (rows > 0) stalls[stall] = rows; else delete stalls[stall];
  }
  return { ...binRow, stalls };
}

/** 後方互換: 4号だけ置き換える旧API。 */
export function applyStall4Rows(binRow, events, binSec = 900) {
  return applyRowEvents(binRow, { stall4: events }, { binSec });
}
