// タクシープール現況 (混み具合・今日の流れ) の純関数群。

/** occ/fullRef を 空き/普通/混雑/満車 に写像。fullRef<=0 は empty。 */
export function occLevel(occ, fullRef) {
  if (!(fullRef > 0)) return 'empty';
  const r = occ / fullRef;
  if (r < 0.30) return 'empty';
  if (r < 0.65) return 'normal';
  if (r < 0.90) return 'crowded';
  return 'full';
}

/** 直近1h出庫 recent と平常 typical の比から活発さを判定。 */
export function activityLevel(recent, typical) {
  if (!(typical > 0)) return { ratio: 0, level: 'normal', arrow: 'flat' };
  const ratio = Math.round((recent / typical) * 100) / 100;
  if (ratio >= 1.25) return { ratio, level: 'active', arrow: 'up' };
  if (ratio < 0.75) return { ratio, level: 'low', arrow: 'down' };
  return { ratio, level: 'normal', arrow: 'flat' };
}

import { computeSlotActuals } from './slot-actuals.mjs';

const GROUPS = {
  real01: ['stall1', 'stall2', 'stall3', 'stall4'],
  real02: ['stall4_back'],
};
const FULLREF_MIN = { real01: 20, real02: 4 };

function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function groupOcc(row, group) {
  return GROUPS[group].reduce((s, k) => s + (typeof row.stalls?.[k]?.occ === 'number' ? row.stalls[k].occ : 0), 0);
}
function sorted(rows) {
  return (rows || []).map(r => ({ ...r, tsMs: new Date(r.ts).getTime() }))
    .filter(r => !Number.isNaN(r.tsMs)).sort((a, b) => a.tsMs - b.tsMs);
}

/** 直近 windowTicks 件の group occ 中央値（現在の在台数）。 */
export function currentOccupancy(rows, now, windowTicks = 5) {
  const rs = sorted(rows).filter(r => r.tsMs <= now.getTime());
  const tail = rs.slice(-windowTicks);
  const out = {};
  for (const g of Object.keys(GROUPS)) out[g] = Math.round(median(tail.map(r => groupOcc(r, g))));
  return out;
}

/** group occ の直近 days 日 pct パーセンタイル（満車基準）。min でクランプ。 */
export function fullRefFor(rows, group, { days = 7, pct = 0.92, min = 0, now = new Date() } = {}) {
  const cutoff = now.getTime() - days * 86400000;
  const vals = sorted(rows).filter(r => r.tsMs >= cutoff && r.tsMs <= now.getTime()).map(r => groupOcc(r, group));
  if (!vals.length) return min;
  vals.sort((a, b) => a - b);
  const idx = Math.min(vals.length - 1, Math.max(0, Math.round(pct * (vals.length - 1))));
  return Math.max(min, vals[idx]);
}

/** 直近1h出庫合計（computeSlotActuals total の合算）。 */
function recent1hDepartures(rows, now) {
  return computeSlotActuals(rows, now, 60).reduce((s, b) => s + b.total, 0);
}
/** 直近 days 日の「同じ1時間枠」出庫合計の中央値（平常）。 */
function typical1hDepartures(rows, now, days = 7) {
  const sums = [];
  for (let d = 1; d <= days; d++) {
    const past = new Date(now.getTime() - d * 86400000);
    sums.push(computeSlotActuals(rows, past, 60).reduce((s, b) => s + b.total, 0));
  }
  return Math.round(median(sums));
}

/** Date を JST ISO 文字列 (例 2026-05-25T13:10:00+09:00) に。他データ(stall-actuals等)と表記を揃え、
 *  UI が slice(11,16) で JST の HH:MM を出せるようにする (toISOString の UTC ずれ防止)。 */
function jstIso(d) {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

/** pool-status.json オブジェクトを組み立てる。 */
export function buildPoolStatus(rows, now = new Date()) {
  const cur = currentOccupancy(rows, now, 5);
  const cameras = {};
  for (const g of Object.keys(GROUPS)) {
    const fullRef = fullRefFor(rows, g, { min: FULLREF_MIN[g], now });
    cameras[g] = { occ: cur[g], fullRef, level: occLevel(cur[g], fullRef) };
  }
  const totalOcc = cur.real01 + cur.real02;
  const totalRef = cameras.real01.fullRef + cameras.real02.fullRef;
  const recent = recent1hDepartures(rows, now);
  const typical = typical1hDepartures(rows, now, 7);
  const act = activityLevel(recent, typical);
  return {
    generatedAt: jstIso(now),
    cameras,
    total: { occ: totalOcc, level: occLevel(totalOcc, totalRef) },
    activity: { recent1hDepartures: recent, typical1h: typical, ratio: act.ratio, level: act.level, arrow: act.arrow },
  };
}
