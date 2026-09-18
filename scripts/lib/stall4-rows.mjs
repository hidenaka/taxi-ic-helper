// 4号後列の列移動(scripts/stall4-row-shift-tick.py が出す data/stall4-row-events.jsonl)を、
// 15分ビンの advance-count-history と現況(直近15分)へ載せるための純関数。
//
// 背景(2026-09-18): 4号だけは frontDensity(コーンの手前線の小箱)では列移動を数えられない
// (列1がふだん箱まで来ない)。列1の前縁を追う専用計測に置き換え、2列移動は 2 と数える。
// 他の乗り場(1〜3号)は従来どおり frontDensity 経路のまま。

/** jsonl テキスト → イベント配列。壊れた行は捨てる。 */
export function parseRowEvents(text) {
  return String(text || '')
    .split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && typeof e.ts === 'string' && Number.isFinite(e.rows));
}

/** [startEpoch, endEpoch) に入るイベントの列数合計(2列移動は 2)。 */
export function rowsInWindow(events, startEpoch, endEpoch) {
  let sum = 0;
  for (const e of events || []) {
    const t = Math.floor(new Date(e.ts).getTime() / 1000);
    if (!Number.isFinite(t) || t < startEpoch || t >= endEpoch) continue;
    sum += Math.max(0, Math.round(e.rows));
  }
  return sum;
}

/**
 * 完成した15分ビン行 {ts, stalls} の stall4 を、列移動イベント由来の値で置き換える。
 * イベントが無いビンは stall4 を落とす(=0。他乗り場の「count>0 のみ持つ」流儀に合わせる)。
 * events が null(計測未稼働)なら行をそのまま返す(従来経路を維持)。
 */
export function applyStall4Rows(binRow, events, binSec = 900) {
  if (!binRow || !events) return binRow;
  const start = Math.floor(new Date(binRow.ts).getTime() / 1000);
  if (!Number.isFinite(start)) return binRow;
  const rows = rowsInWindow(events, start, start + binSec);
  const stalls = { ...(binRow.stalls || {}) };
  if (rows > 0) stalls.stall4 = rows; else delete stalls.stall4;
  return { ...binRow, stalls };
}
