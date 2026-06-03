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
import { getDayContext } from './holiday-context.mjs';

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

const STALL_KEYS = {
  stall1: ['stall1'], stall2: ['stall2'], stall3: ['stall3'], stall4: ['stall4', 'stall4_back'],
};

/** 乗り場別（第1〜4）の現在在台数。第4は stall4_back を合算（departures の畳み込みと一致）。 */
export function currentOccupancyByStall(rows, now, windowTicks = 5) {
  const rs = sorted(rows).filter(r => r.tsMs <= now.getTime());
  const tail = rs.slice(-windowTicks);
  const out = {};
  for (const stall of Object.keys(STALL_KEYS)) {
    const vals = tail.map(r => STALL_KEYS[stall].reduce(
      (s, k) => s + (typeof r.stalls?.[k]?.occ === 'number' ? r.stalls[k].occ : 0), 0));
    out[stall] = Math.round(median(vals));
  }
  return out;
}

/** 待ち時間目安（分）。在台×60÷直近1h出庫。出庫0は算出不能で null。 */
export function waitMinFor(occ, recent1hDep) {
  if (!(recent1hDep > 0)) return null;
  return Math.round((occ * 60) / recent1hDep);
}

/** 直近30分 vs その前30分の出庫比で動き方を判定。≥1.25→up / <0.75→down / 他→flat。前30が0は flat。 */
export function stallTrend(recent30, prior30) {
  if (!(prior30 > 0)) return 'flat';
  const ratio = recent30 / prior30;
  if (ratio >= 1.25) return 'up';
  if (ratio < 0.75) return 'down';
  return 'flat';
}

const STALL_NAMES = ['stall1', 'stall2', 'stall3', 'stall4'];
const STALL_LABEL = { stall1: '第1乗り場', stall2: '第2乗り場', stall3: '第3乗り場', stall4: '第4乗り場' };
const STALL_TERMINAL = { stall1: 'T1', stall2: 'T1', stall3: 'T2', stall4: 'T2' };

/** 指定窓（分）の乗り場別出庫合計。computeSlotActuals の stallN を合算。 */
function stallDepartures(rows, now, windowMinutes) {
  const bins = computeSlotActuals(rows, now, windowMinutes);
  const out = { stall1: 0, stall2: 0, stall3: 0, stall4: 0 };
  for (const b of bins) for (const s of STALL_NAMES) out[s] += b[s];
  return out;
}

/** 乗り場間の recent1hDep を比較し、最大に 'most-active' / 最小に 'most-low' / 他 null を付与。
 * 全て0なら全て null。同率は同じヒントが複数の乗り場に付く。 */
export function buildStallRankHint(stalls) {
  const out = { stall1: null, stall2: null, stall3: null, stall4: null };
  if (!stalls) return out;  // stalls=undefined/null ガード
  const deps = Object.keys(out).map(k => ({ k, v: stalls[k]?.recent1hDep ?? 0 }));
  const max = Math.max(...deps.map(d => d.v));
  const min = Math.min(...deps.map(d => d.v));
  if (max === 0) return out; // 全部0
  for (const { k, v } of deps) {
    if (v === max && v > 0) out[k] = 'most-active';
    else if (v === min) out[k] = 'most-low';
  }
  return out;
}

/** 乗り場別ブロック（在台・直近1h出庫・待ち目安・動き方・ターミナル）を組み立てる。
 *  holidays 指定時は各 stall に sameConditionCompare を付与（省略時は null）。 */
export function buildStalls(rows, now, holidays = null) {
  const occ = currentOccupancyByStall(rows, now, 5);
  const dep1h = stallDepartures(rows, now, 60);
  const depRecent30 = stallDepartures(rows, now, 30);
  const depPrior30 = stallDepartures(rows, new Date(now.getTime() - 30 * 60000), 30);
  const out = {};
  for (const s of STALL_NAMES) {
    out[s] = {
      label: STALL_LABEL[s],
      terminal: STALL_TERMINAL[s],
      occ: occ[s],
      recent1hDep: dep1h[s],
      waitMin: waitMinFor(occ[s], dep1h[s]),
      trend: stallTrend(depRecent30[s], depPrior30[s]),
      sameConditionCompare: holidays ? sameConditionCompare(rows, now, holidays, 4, s) : null,
    };
  }
  return out;
}

/** "HH:MM"（24+ は翌日）を now と同じ JST 日付基準の Date に。不正は null。 */
function lobbyExitDate(timeStr, now) {
  const m = String(timeStr ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (h >= 24) { d.setDate(d.getDate() + 1); h -= 24; }
  d.setHours(h, min, 0, 0);
  return d;
}

/** ターミナル別（T1=第1・2乗り場/T2=第3・4乗り場）に、lobbyExitTime が今後30/60分の便の estimatedTaxiPax を合計。 */
export function buildTerminalArrivals(arrivals, now) {
  const out = { T1: { next30: 0, next60: 0 }, T2: { next30: 0, next60: 0 } };
  const flights = arrivals?.flights ?? [];
  const nowMs = now.getTime();
  const ms30 = nowMs + 30 * 60000;
  const ms60 = nowMs + 60 * 60000;
  for (const f of flights) {
    const t = f.terminal;
    if (t !== 'T1' && t !== 'T2') continue;
    const d = lobbyExitDate(f.lobbyExitTime, now);
    if (!d) continue;
    const ms = d.getTime();
    if (ms <= nowMs || ms > ms60) continue;
    const pax = typeof f.estimatedTaxiPax === 'number' ? f.estimatedTaxiPax : 0;
    out[t].next60 += pax;
    if (ms <= ms30) out[t].next30 += pax;
  }
  return out;
}

/** rows から指定 Date の直近1h出庫合計（全体または stall別）を返す。
 *  bins が空（データなし）の場合は null を返す。 */
function recent1hAt(rows, atDate, stallKey = null) {
  const bins = computeSlotActuals(rows, atDate, 60);
  if (!bins.length) return null;
  if (stallKey) return bins.reduce((s, b) => s + (b[stallKey] || 0), 0);
  return bins.reduce((s, b) => s + b.total, 0);
}

/** 過去 weeks 週間の同(weekday, dayKind)の同時間帯サンプルから median を取る。
 *  stallKey=null（既定）で全体、'stall1'..'stall4' で per-stall。 */
export function sameConditionCompare(rows, now, holidays, weeks = 4, stallKey = null) {
  const today = getDayContext(now, holidays);
  const today1h = recent1hAt(rows, now, stallKey) ?? 0;
  const samples = [];
  for (let w = 1; w <= weeks; w++) {
    const past = new Date(now.getTime() - w * 7 * 86400000);
    const ctx = getDayContext(past, holidays);
    if (ctx.weekday !== today.weekday) continue;
    if (ctx.dayKind !== today.dayKind) continue;
    const v = recent1hAt(rows, past, stallKey);
    if (v === null) continue; // データなし → スキップ
    samples.push(v);
  }
  if (samples.length < 3) {
    return { peers_typical: null, percent: null, label: null, dayLabel: today.dayLabel };
  }
  samples.sort((a, b) => a - b);
  const m = Math.floor(samples.length / 2);
  const peers_typical = samples.length % 2 ? samples[m] : Math.round((samples[m - 1] + samples[m]) / 2);
  if (!(peers_typical > 0)) {
    return { peers_typical, percent: null, label: null, dayLabel: today.dayLabel };
  }
  const percent = Math.round((today1h / peers_typical - 1) * 100);
  let label;
  if (percent >= 15) label = 'いつもより活発';
  else if (percent <= -15) label = 'いつもより少なめ';
  else label = 'いつも通り';
  return { peers_typical, percent, label, dayLabel: today.dayLabel };
}

/** 各ターミナル(T1/T2)の今後60分以内に lobbyExit を迎える便を最大5件返す。
 * 過去便・60分超・T3は除外。並び: lobbyExitMinutes 昇順、同値時 flightNumber 順。 */
export function buildTerminalArrivalsList(arrivals, now) {
  const out = { T1: [], T2: [] };
  const flights = arrivals?.flights ?? [];
  const nowMs = now.getTime();
  const ms60 = nowMs + 60 * 60000;
  for (const f of flights) {
    const t = f.terminal;
    if (t !== 'T1' && t !== 'T2') continue;
    const d = lobbyExitDate(f.lobbyExitTime, now);
    if (!d) continue;
    const ms = d.getTime();
    if (ms <= nowMs || ms > ms60) continue;
    const lobbyExitMinutes = Math.round((ms - nowMs) / 60000);
    out[t].push({
      flightNumber: f.flightNumber,
      airline: f.airline,
      fromName: f.fromName,
      seatCount: f.seatCount,
      lobbyExitMinutes,
      lobbyExitTime: f.lobbyExitTime,
    });
  }
  for (const t of ['T1', 'T2']) {
    out[t].sort((a, b) => a.lobbyExitMinutes - b.lobbyExitMinutes || a.flightNumber.localeCompare(b.flightNumber));
    out[t] = out[t].slice(0, 5);
  }
  return out;
}

/** 乗り場号(poolLane 1-4)別の今後60分以内に lobbyExit を迎える便を最大5件返す。
 * 欠航・過去便・60分超・poolLane未確定は除外。号: 1=T1南/2=T1北/3=T2北/4=T2南・国際。
 * 並び: lobbyExitMinutes 昇順、同値時 flightNumber 順。 */
export function buildNoribaArrivalsList(arrivals, now) {
  const out = { 1: [], 2: [], 3: [], 4: [] };
  const flights = arrivals?.flights ?? [];
  const nowMs = now.getTime();
  const ms60 = nowMs + 60 * 60000;
  for (const f of flights) {
    const lane = f.poolLane;
    if (!Number.isInteger(lane) || lane < 1 || lane > 4) continue;
    if (f.status === '欠航') continue;
    const d = lobbyExitDate(f.lobbyExitTime, now);
    if (!d) continue;
    const ms = d.getTime();
    if (ms <= nowMs || ms > ms60) continue;
    out[lane].push({
      flightNumber: f.flightNumber,
      airline: f.airline,
      fromName: f.fromName,
      seatCount: f.seatCount,
      lobbyExitMinutes: Math.round((ms - nowMs) / 60000),
      lobbyExitTime: f.lobbyExitTime,
    });
  }
  for (const n of [1, 2, 3, 4]) {
    out[n].sort((a, b) => a.lobbyExitMinutes - b.lobbyExitMinutes || a.flightNumber.localeCompare(b.flightNumber));
    out[n] = out[n].slice(0, 5);
  }
  return out;
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

/** pool-status.json オブジェクトを組み立てる。
 * arrivals, holidays は optional（省略時は後方互換: terminalArrivals=null, sameConditionCompare=null）。 */
export function buildPoolStatus(rows, now = new Date(), arrivals = null, holidays = null) {
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
  const stallsBase = buildStalls(rows, now, holidays);
  const rankHints = buildStallRankHint(stallsBase);
  const stalls = {};
  for (const k of ['stall1', 'stall2', 'stall3', 'stall4']) {
    stalls[k] = { ...stallsBase[k], rankHint: rankHints[k] };
  }
  const sameCompare = holidays ? sameConditionCompare(rows, now, holidays) : null;
  return {
    generatedAt: jstIso(now),
    cameras,
    total: { occ: totalOcc, level: occLevel(totalOcc, totalRef) },
    activity: {
      recent1hDepartures: recent,
      typical1h: typical,
      ratio: act.ratio,
      level: act.level,
      arrow: act.arrow,
      sameConditionCompare: sameCompare,
    },
    stalls,
    terminalArrivals: arrivals ? buildTerminalArrivals(arrivals, now) : null,
    terminalArrivalsList: buildTerminalArrivalsList(arrivals, now),
    noribaArrivalsList: buildNoribaArrivalsList(arrivals, now),
  };
}
