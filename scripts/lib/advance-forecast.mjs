// advance-forecast — 前進カウント履歴(advance-count-history.jsonl)から
// 「次の15分の前進回数」を時間帯(15分)×乗り場の平均で予測する。
// 履歴が少ない(数週間)ので過学習を避けた素直なベースライン。
// 注: bin行に乗り場キーが無い=その時間帯0回として平均に算入する。

import { detectAdvances } from './advance-counter.mjs';

const DEFAULT_STALLS = ['stall1', 'stall2', 'stall3', 'stall4'];

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * コモンモード除去: 全乗り場が同時に同方向へ動く成分(=照明/夜明け等)を各時点で中央値として
 * 求めて差し引き、乗り場ごとの「固有の動き」だけを残した残差 frontDensity 系列を返す。
 * 実際の列移動は乗り場ごとに独立なので残るが、空全体の明るさ変化は相殺される。
 * 同時に3乗り場未満しか観測が無い時点は補正しない(中央値が不安定なため)。
 * @param {{ts:string, stalls:Record<string,{frontDensity?:number}>}[]} rows
 * @param {string[]} stalls
 * @returns {Record<string, {t:number, v:number}[]>}
 */
export function commonModeResiduals(rows, stalls) {
  const ticks = [];
  for (const r of rows) {
    const t = Math.floor(new Date(r.ts).getTime() / 1000);
    if (!Number.isFinite(t)) continue;
    const vals = {};
    for (const s of stalls) {
      const fd = r?.stalls?.[s]?.frontDensity;
      if (typeof fd === 'number') vals[s] = fd;
    }
    if (Object.keys(vals).length) ticks.push({ t, vals });
  }
  ticks.sort((a, b) => a.t - b.t);
  // 乗り場ごとの基準(窓内中央値)。レベル差を除いて変化成分だけ比較するため。
  const baseline = {};
  for (const s of stalls) baseline[s] = median(ticks.map((x) => x.vals[s]).filter((v) => typeof v === 'number'));
  const out = {};
  for (const s of stalls) out[s] = [];
  for (const { t, vals } of ticks) {
    const centered = [];
    for (const s of stalls) if (typeof vals[s] === 'number') centered.push(vals[s] - baseline[s]);
    const common = centered.length >= 3 ? median(centered) : 0;
    for (const s of stalls) if (typeof vals[s] === 'number') out[s].push({ t, v: vals[s] - common });
  }
  return out;
}

/**
 * 窓内の行から、コモンモード除去後に乗り場別の前進回数を数える。
 * @returns {Record<string, number>} count>0 の乗り場のみ
 */
export function binAdvanceCounts(rows, stalls = DEFAULT_STALLS, opts = {}) {
  const absThreshold = opts.absThreshold ?? 15;
  const debounceSec = opts.debounceSec ?? 120;
  const res = commonModeResiduals(rows, stalls);
  const out = {};
  for (const s of stalls) {
    const arr = res[s] || [];
    if (arr.length < 2) continue;
    const c = detectAdvances(arr.map((p) => p.v), arr.map((p) => p.t), { absThreshold, debounceSec }).count;
    if (c > 0) out[s] = c;
  }
  return out;
}

/**
 * 直近 windowMin 分の frontDensity 変化で乗り場の実測前進回数を数える(コモンモード除去込み)。
 * rows は全乗り場ぶんを渡す(共通成分の推定に必要)。
 * @returns {number}
 */
export function recentActualCount(rows, stall, nowEpoch, opts = {}) {
  const windowMin = opts.windowMin ?? 15;
  const cutoff = nowEpoch - windowMin * 60;
  const stalls = opts.stalls ?? DEFAULT_STALLS;
  const inWin = rows.filter((r) => {
    const t = Math.floor(new Date(r.ts).getTime() / 1000);
    return t >= cutoff && t <= nowEpoch;
  });
  const counts = binAdvanceCounts(inWin, stalls, { absThreshold: opts.absThreshold ?? 8, debounceSec: opts.debounceSec ?? 120 });
  return counts[stall] || 0;
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
  const stalls = opts.stalls ?? DEFAULT_STALLS;
  const lastStart = Math.floor(nowEpoch / BIN) * BIN - BIN; // 直前の完成ビン開始
  let lastHistEpoch = -Infinity;
  for (const r of historyRows) {
    const e = Math.floor(new Date(r.ts).getTime() / 1000);
    if (e > lastHistEpoch) lastHistEpoch = e;
  }
  if (lastHistEpoch >= lastStart) return null; // 既にこのビンを記録済み
  const winEnd = lastStart + BIN;
  const binRows = msRows.filter((r) => {
    const t = Math.floor(new Date(r.ts).getTime() / 1000);
    return t >= lastStart && t < winEnd;
  });
  // 観測判定: いずれかの乗り場で2点以上あればそのビンは観測ありとみなす。
  let observed = false;
  for (const s of stalls) {
    const n = binRows.filter((r) => typeof r?.stalls?.[s]?.frontDensity === 'number').length;
    if (n >= 2) { observed = true; break; }
  }
  if (!observed) return null;
  // コモンモード除去込みで乗り場別カウント。
  const stallsOut = binAdvanceCounts(binRows, stalls, { absThreshold: opts.absThreshold ?? 15, debounceSec: opts.debounceSec ?? 120 });
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

// ---- 段階A: 到着便(乗り場号 poolLane)を予測に効かせる ----

const FF_MIN = 0.5;
const FF_MAX = 2.0;

/**
 * 到着便から「乗り場(号)×15分バケット」の到着需要(estimatedTaxiPax 合計)を作る。
 * poolLane(1-4) → stall1-4 に対応。lobbyExitTime を 15分バケットに割り当て、
 * 段階Bで学習した lag(バケット数シフト) があれば後ろにずらす。
 * @returns {Record<string, number[]>} stall -> 96バケットの需要
 */
export function arrivalDemandByStall(arrivalsJson, opts = {}) {
  const stalls = opts.stalls ?? ['stall1', 'stall2', 'stall3', 'stall4'];
  const lagByStall = opts.lagByStall ?? {};
  const field = opts.field ?? 'estimatedTaxiPax'; // 学習ログは 'estimatedPax'(過去再現と単位を揃える)
  const demand = {};
  for (const s of stalls) demand[s] = new Array(96).fill(0);
  const flights = arrivalsJson && Array.isArray(arrivalsJson.flights) ? arrivalsJson.flights : [];
  for (const f of flights) {
    if (typeof f.poolLane !== 'number') continue;
    const stall = 'stall' + f.poolLane;
    if (!demand[stall]) continue;
    const t = f.lobbyExitTime;
    if (typeof t !== 'string' || t.length < 5) continue;
    const hh = parseInt(t.slice(0, 2), 10);
    const mm = parseInt(t.slice(3, 5), 10);
    if (Number.isNaN(hh) || Number.isNaN(mm)) continue;
    const pax = typeof f[field] === 'number' ? f[field] : 0;
    if (pax <= 0) continue;
    const lag = lagByStall[stall] || 0;
    const b = ((Math.floor((hh * 60 + mm) / 15) + lag) % 96 + 96) % 96;
    demand[stall][b] += pax;
  }
  return demand;
}

/**
 * 到着需要を「乗り場ごとに自己正規化」した係数(0.5〜2.0)に変換する。
 * その乗り場の便がある時間帯の平均需要に対し、多い時間帯は>1・少ない時間帯は<1。
 * 需要0(便なし)の時間帯は 1.0(基線を変えない)。履歴不要・当日内で完結。
 * @returns {Record<string, number[]>} stall -> 96バケットの係数
 */
export function flightFactorByStall(arrivalsJson, opts = {}) {
  const stalls = opts.stalls ?? ['stall1', 'stall2', 'stall3', 'stall4'];
  const ffMin = opts.ffMin ?? FF_MIN;
  const ffMax = opts.ffMax ?? FF_MAX;
  const demand = arrivalDemandByStall(arrivalsJson, opts);
  const factor = {};
  for (const s of stalls) {
    const vals = demand[s];
    const nz = vals.filter((v) => v > 0);
    const avg = nz.length ? nz.reduce((a, b) => a + b, 0) / nz.length : 0;
    factor[s] = vals.map((v) => {
      if (avg <= 0 || v <= 0) return 1.0;
      const r = v / avg;
      return r < ffMin ? ffMin : r > ffMax ? ffMax : r;
    });
  }
  return factor;
}

/**
 * predictAdvance に到着係数を掛けた値。factorByStall が無ければ素の予測。
 */
export function predictAdvanceWithFlights(model, ts, stall, factorByStall) {
  const base = predictAdvance(model, ts, stall);
  if (!factorByStall || !factorByStall[stall]) return base;
  const f = factorByStall[stall][bucketOfDay(ts)];
  return typeof f === 'number' ? base * f : base;
}

// ---- 段階B: 到着→列移動の「ラグ」を履歴から学習 ----

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; syy += ys[i] * ys[i]; sxy += xs[i] * ys[i];
  }
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  if (vx <= 0 || vy <= 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

/** jsonl行(ts, stalls:{stall:number})を 乗り場ごとの Map(binEpoch -> 値) に。 */
function toBinMap(rows, stall) {
  const m = new Map();
  for (const r of rows) {
    const v = r?.stalls?.[stall];
    if (typeof v !== 'number') continue;
    const e = Math.floor(new Date(r.ts).getTime() / 1000);
    const bin = Math.floor(e / 900) * 900;
    m.set(bin, (m.get(bin) || 0) + v);
  }
  return m;
}

/**
 * 到着需要履歴(demandRows) と 実測列移動履歴(advanceRows) から、
 * 乗り場ごとに「到着の何バケット後に列移動が最も相関するか(lag)」を学習。
 * @param {{ts,stalls}[]} demandRows arrival-demand-history.jsonl
 * @param {{ts,stalls}[]} advanceRows advance-count-history.jsonl
 * @param {{stalls?:string[], maxLag?:number, minSamples?:number, minCorr?:number}} opts
 * @returns {{schema_version:number, coeffs:Record<string,{lag:number,corr:number,n:number,applied:boolean}>}}
 */
export function learnArrivalLag(demandRows, advanceRows, opts = {}) {
  const stalls = opts.stalls ?? ['stall1', 'stall2', 'stall3', 'stall4'];
  const maxLag = opts.maxLag ?? 6;          // 0〜90分
  const minSamples = opts.minSamples ?? 24; // 採用に必要な最小ペア数(~1日分の日中)
  const minCorr = opts.minCorr ?? 0.2;      // 相関が弱ければ採用しない
  const corrFloor = opts.corrFloor ?? 8;    // これ未満のペア数は相関を見ない(進捗表示も0)
  const result = {};
  for (const s of stalls) {
    const dm = toBinMap(demandRows, s);
    const am = toBinMap(advanceRows, s);
    // bestは「最もペア数の取れた相関」を進捗として記録(採用は下のゲートで判定)
    let best = { lag: 0, corr: 0, n: 0, applied: false };
    for (let lag = 0; lag <= maxLag; lag++) {
      const xs = [], ys = [];
      for (const [bin, dv] of dm) {
        const av = am.get(bin + lag * 900);
        if (typeof av === 'number') { xs.push(dv); ys.push(av); }
      }
      if (xs.length < corrFloor) continue;
      const c = pearson(xs, ys);
      // 相関が高いものを採用候補に(同程度ならペア数が多い方)
      if (c > best.corr || (Math.abs(c - best.corr) < 1e-9 && xs.length > best.n)) {
        best = { lag, corr: Number(c.toFixed(3)), n: xs.length, applied: false };
      }
    }
    best.applied = best.n >= minSamples && best.corr >= minCorr;
    if (!best.applied) best.lag = 0; // 未採用は lag0(従来動作)
    result[s] = best;
  }
  return { schema_version: 1, coeffs: result };
}
