#!/usr/bin/env node
// 羽田プールの「今夜いつまで動くか」予測。
//
// 設計(2026-08-27 本人承認):
//   土台 = 時間帯 × 曜日タイプ(平日/土日/祝日/連休の位置)の平均的な形
//   補正 = 今夜の遅延量(23時以降に押し出された客の数)
//
// 出すもの: その夜の「動きが終わる時刻」と「動きの総量(いつも比)」。
// 出さないもの: 15分単位の回数 / 客数から量を増減させる補正
//   (混むとさばける速さに限界があり、量には効かないため)
//
// 根拠: 92夜の実測で、23時以降に押し出された客の数と「動きの終わり時刻」の相関 r=0.544。
//   遅延が少ない夜=23:40終わり/93回、多い夜=0:20終わり/119回(+40分・+26回)。

import { readFileSync, existsSync } from 'node:fs';

export const NIGHT_START_MIN = 20 * 60;   // 夜の始まり(20:00)
export const NIGHT_END_MIN = 28 * 60;     // 夜の終わり(翌4:00)
const KEYS = ['stall1', 'stall2', 'stall3', 'stall4'];

/** 日付(YYYY-MM-DD)→曜日タイプ。連休の位置まで見る。 */
export function dayType(date, holidays = new Set()) {
  const d = new Date(`${date}T12:00:00+09:00`);
  const wd = d.getUTCDay();
  const off = (x) => {
    const t = new Date(d.getTime() + x * 86400000).toISOString().slice(0, 10);
    const w = new Date(`${t}T12:00:00+09:00`).getUTCDay();
    return w === 0 || w === 6 || holidays.has(t);
  };
  const today = wd === 0 || wd === 6 || holidays.has(date);
  if (!today) return 'weekday';
  // 連休の中での位置。帰ってくる日(最終日)は動きが多い
  const prev = off(-1), next = off(1);
  if (prev && !next) return 'holiday_last';   // 連休最終日=帰る日
  if (!prev && next) return 'holiday_first';  // 連休初日=出る日
  if (prev && next) return 'holiday_mid';
  return 'holiday_single';
}

/** 夜キー: 20:00〜翌4:00 をその日付の「夜」として束ねる */
export function nightKeyOf(ts) {
  const date = ts.slice(0, 10);
  const h = Number(ts.slice(11, 13));
  if (h >= 20) return { key: date, min: h * 60 + Number(ts.slice(14, 16)) };
  if (h < 4) {
    const prev = new Date(Date.parse(`${date}T12:00:00+09:00`) - 86400000).toISOString().slice(0, 10);
    return { key: prev, min: h * 60 + Number(ts.slice(14, 16)) + 1440 };
  }
  return null;
}

/** 実測から夜ごとの {総量, 終わり時刻} を作る。終わり=累積が90%に達した時刻。 */
export function nightsFromCounts(rows) {
  const acc = new Map();
  for (const r of rows) {
    const nk = nightKeyOf(r.ts);
    if (!nk) continue;
    let s = 0;
    for (const k of KEYS) s += Number((r.stalls || {})[k] || 0);
    if (!acc.has(nk.key)) acc.set(nk.key, []);
    acc.get(nk.key).push({ min: nk.min, n: s });
  }
  const out = new Map();
  for (const [key, arr] of acc) {
    arr.sort((a, b) => a.min - b.min);
    const total = arr.reduce((s, x) => s + x.n, 0);
    if (total < 10) continue;
    let cum = 0, endMin = null;
    for (const x of arr) { cum += x.n; if (cum >= total * 0.9) { endMin = x.min; break; } }
    if (endMin === null) continue;
    out.set(key, { total, endMin });
  }
  return out;
}

/** 遅延で23時以降に押し出された客の数。到着便のスナップショット(定刻と実績)から。 */
export function lateShiftFrom(flights, { minDelay = 20, afterMin = 23 * 60 } = {}) {
  const hhmm = (s) => { const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  let pax = 0, count = 0;
  for (const f of flights || []) {
    if (f.status === '欠航') continue;
    const p = Number(f.estimatedPax || 0);
    if (!p) continue;
    const sm = hhmm(f.scheduledTime);
    const am = hhmm(f.actualTime || f.estimatedTime);
    if (sm === null || am === null) continue;
    if (am >= afterMin && am - sm >= minDelay) { pax += p; count += 1; }
  }
  return { pax, count };
}

/** 学習: 曜日タイプごとの基準(終わり時刻・総量)と、遅延の効き方を出す。 */
export function trainNightModel(nights, lateShift, holidays = new Set()) {
  const byType = {};
  const xs = [], ysEnd = [], ysTot = [];
  for (const [date, v] of nights) {
    const t = dayType(date, holidays);
    byType[t] = byType[t] || { end: 0, tot: 0, n: 0 };
    byType[t].end += v.endMin; byType[t].tot += v.total; byType[t].n += 1;
    const ls = lateShift.get(date);
    if (ls !== undefined) { xs.push(ls); ysEnd.push(v.endMin); ysTot.push(v.total); }
  }
  const base = {};
  for (const [t, v] of Object.entries(byType)) {
    base[t] = { endMin: v.end / v.n, total: v.tot / v.n, n: v.n };
  }
  const slope = (x, y) => {
    const n = x.length; if (n < 10) return 0;
    const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
    return sxx > 0 ? sxy / sxx : 0;
  };
  const mx = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  return {
    base,
    delay: { meanShift: mx, endPerPax: slope(xs, ysEnd), totalPerPax: slope(xs, ysTot), n: xs.length },
  };
}

/** 予測: その夜の終わり時刻と総量。 */
export function predictNight(date, lateShiftPax, model, holidays = new Set()) {
  const t = dayType(date, holidays);
  const b = model.base[t] || model.base.weekday;
  if (!b) return null;
  const d = lateShiftPax - model.delay.meanShift;
  const endMin = b.endMin + d * model.delay.endPerPax;
  const total = Math.max(0, b.total + d * model.delay.totalPerPax);
  return { dayType: t, endMin, total, baseEndMin: b.endMin, baseTotal: b.total, samples: b.n };
}

export const fmtMin = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;

/**
 * 羽田の雷は、グランドスタッフが作業できなくなり遅延を生む(乗務員の現場知識・2026-08-27)。
 * 実測(98夜): 雷なし=終わり23:54で1時以降まで動くのは9%。
 * 雷4時間以上の夜は2夜とも02:00超え、総量も196回(通常133回)。
 * 夜の数が少ないので回帰には入れず、警告として出す。
 * 雷は Open-Meteo の天気コードでは取れない(5〜8月で0件)。空港の実際の気象通報(METAR)を使う。
 * @param {number} tsHours 羽田で雷が観測された時間数(12-23時)
 */
export function lightningWarning(tsHours) {
  if (!(tsHours > 0)) return null;
  if (tsHours >= 4) {
    return { level: 'high', text: '羽田で雷が続いています。深夜2時ごろまで動く夜になりやすいです', samples: 2 };
  }
  if (tsHours >= 1) {
    return { level: 'mid', text: '羽田で雷が出ています。いつもより遅く、動きも多めになりがちです', samples: 6 };
  }
  return null;
}

/** METAR(空港の気象通報)から、その日の羽田の雷の時間数を数える(12-23時)。 */
export function hanedaLightningHours(metarRows, day) {
  let n = 0;
  for (const r of metarRows || []) {
    if (!/TS/.test(r.wx || '')) continue;
    if (String(r.t || '').slice(0, 10) !== day) continue;
    const h = Number(String(r.t).slice(11, 13));
    if (h >= 12 && h <= 23) n += 1;
  }
  return n;
}
