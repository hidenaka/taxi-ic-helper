// advance-forecast — 前進カウント履歴(advance-count-history.jsonl)から
// 「次の15分の前進回数」を時間帯(15分)×乗り場の平均で予測する。
// 履歴が少ない(数週間)ので過学習を避けた素直なベースライン。
// 注: bin行に乗り場キーが無い=その時間帯0回として平均に算入する。

import { detectAdvances } from './advance-counter.mjs';

/**
 * movement-shift-history 風の行から、直近 windowMin 分の frontDensity 変化で
 * 乗り場の実測前進回数を数える。
 * @param {{ts:string, stalls:Record<string,{frontDensity?:number}>}[]} rows
 * @param {string} stall
 * @param {number} nowEpoch 現在 epoch 秒
 * @param {{windowMin?:number, absThreshold?:number, debounceSec?:number}} opts
 * @returns {number}
 */
export function recentActualCount(rows, stall, nowEpoch, opts = {}) {
  const windowMin = opts.windowMin ?? 15;
  const cutoff = nowEpoch - windowMin * 60;
  const pts = [];
  for (const r of rows) {
    const fd = r.stalls?.[stall]?.frontDensity;
    if (typeof fd !== 'number') continue;
    const t = Math.floor(new Date(r.ts).getTime() / 1000);
    if (t < cutoff || t > nowEpoch) continue;
    pts.push({ t, v: fd });
  }
  if (pts.length < 2) return 0;
  pts.sort((a, b) => a.t - b.t);
  return detectAdvances(
    pts.map((p) => p.v),
    pts.map((p) => p.t),
    { absThreshold: opts.absThreshold ?? 8, debounceSec: opts.debounceSec ?? 120 },
  ).count;
}

function epochToJstIso(ep) {
  const z = (n) => String(n).padStart(2, '0');
  const j = new Date((ep + 9 * 3600) * 1000);
  return `${j.getUTCFullYear()}-${z(j.getUTCMonth() + 1)}-${z(j.getUTCDate())}T${z(j.getUTCHours())}:${z(j.getUTCMinutes())}:00+09:00`;
}

/**
 * 直前に完成した15分ビンの行を frontDensity 履歴から作る(学習データを育てる用)。
 * 既に履歴にそのビン(以降)があれば null。観測が無ければ null。
 * @returns {{ts:string, stalls:Record<string,number>}|null}
 */
export function lastCompletedBinRow(historyRows, msRows, nowEpoch, opts = {}) {
  const BIN = 900;
  const stalls = opts.stalls ?? ['stall1', 'stall2', 'stall3', 'stall4'];
  const lastStart = Math.floor(nowEpoch / BIN) * BIN - BIN; // 直前の完成ビン開始
  let lastHistEpoch = -Infinity;
  for (const r of historyRows) {
    const e = Math.floor(new Date(r.ts).getTime() / 1000);
    if (e > lastHistEpoch) lastHistEpoch = e;
  }
  if (lastHistEpoch >= lastStart) return null; // 既にこのビンを記録済み
  const winEnd = lastStart + BIN;
  const stallsOut = {};
  let observed = false;
  for (const s of stalls) {
    const pts = [];
    for (const r of msRows) {
      const fd = r.stalls?.[s]?.frontDensity;
      if (typeof fd !== 'number') continue;
      const t = Math.floor(new Date(r.ts).getTime() / 1000);
      if (t < lastStart || t >= winEnd) continue;
      pts.push({ t, v: fd });
    }
    if (pts.length < 2) continue;
    observed = true;
    pts.sort((a, b) => a.t - b.t);
    const c = detectAdvances(pts.map((p) => p.v), pts.map((p) => p.t),
      { absThreshold: opts.absThreshold ?? 15, debounceSec: opts.debounceSec ?? 120 }).count;
    if (c > 0) stallsOut[s] = c;
  }
  if (!observed) return null;
  return { ts: epochToJstIso(lastStart), stalls: stallsOut };
}

/** JST の ts ("...THH:MM:..+09:00") を 15分インデックス 0..95 に。 */
export function bucketOfDay(ts) {
  const hh = parseInt(ts.slice(11, 13), 10);
  const mm = parseInt(ts.slice(14, 16), 10);
  return Math.floor((hh * 60 + mm) / 15);
}

/**
 * 履歴行から時間帯×乗り場のモデルを作る。
 * @param {{ts:string, stalls:Record<string,number>}[]} rows
 * @returns {{buckets:Record<number,{rows:number, sums:Record<string,number>}>, stalls:string[]}}
 */
export function buildAdvanceModel(rows) {
  const buckets = {};
  const stallSet = new Set();
  for (const r of rows) {
    for (const k of Object.keys(r.stalls || {})) stallSet.add(k);
  }
  const stalls = [...stallSet];
  for (const r of rows) {
    const b = bucketOfDay(r.ts);
    const bucket = (buckets[b] = buckets[b] || { rows: 0, sums: {} });
    bucket.rows += 1;
    for (const s of stalls) {
      bucket.sums[s] = (bucket.sums[s] || 0) + (r.stalls?.[s] || 0); // 欠損=0回
    }
  }
  return { buckets, stalls };
}

/**
 * 予測: 対象 ts の時間帯バケットにおける乗り場の平均前進回数。
 * 学習データの無い時間帯/乗り場は 0。
 * @returns {number}
 */
export function predictAdvance(model, ts, stall) {
  const b = bucketOfDay(ts);
  const bucket = model.buckets?.[b];
  if (!bucket || bucket.rows === 0) return 0;
  const sum = bucket.sums?.[stall];
  if (typeof sum !== 'number') return 0;
  return sum / bucket.rows;
}
