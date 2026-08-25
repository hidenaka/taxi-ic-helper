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

/** YOLO占有履歴(yolo-occupancy-history)の直近windowTicks件のmedianをstall1/2について返す。
 *  遠景fillが満車/空を分離不可のため、昼の最奥占有はこの値で上書きする。30分より古い/無→null。 */
function percentileVal(arr, p) {
  if (!arr.length) return 0;
  const b = [...arr].sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(p * (b.length - 1) + 0.5))];
}
export function slotTexOccByStall(texRows, now, windowTicks = 5) {
  if (!Array.isArray(texRows) || texRows.length === 0) return null;
  const rs = texRows.map(r => ({ ...r, tsMs: new Date(r.ts).getTime() }))
    .filter(r => Number.isFinite(r.tsMs) && r.tsMs <= now.getTime()).sort((a, b) => a.tsMs - b.tsMs);
  const fresh = rs.filter(r => r.tsMs >= now.getTime() - 25 * 60000).slice(-windowTicks);
  if (fresh.length < 1) return null;
  // 最新行が暗所(dark=stall値なし)なら、古い昼値を出し続けずfillへ退避(夕暮れ移行対策)。
  const latest = fresh[fresh.length - 1];
  if (!latest || (typeof latest.stall1 !== "number" && typeof latest.stall2 !== "number")) return null;
  const out = {};
  // 学習版占有は安定。直近25分の中央値で「今の埋まり」を出す(現状追従)。
  for (const k of ["stall1", "stall2"]) {
    const vals = fresh.map(r => (typeof r[k] === "number" ? r[k] : null)).filter(v => v != null);
    if (vals.length) out[k] = Math.round(median(vals));
  }
  return Object.keys(out).length ? out : null;
}

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

/** 夜明けの薄明かりで昼モデルが全号一斉に〜100%を出す誤爆(2026-06〜08で明け方に実測)を落とす。
 * 直前の採用行から12分以内に、4号中3号以上が同時に +0.4 超ジャンプした行は物理的に
 * 不可能(プールは5分で満車にならない)なので破棄する。号別の緩やかな増減はそのまま通す。 */
export function filterFillGlareRows(rows, { jumpThreshold = 0.4, minStalls = 3, maxGapMs = 12 * 60 * 1000 } = {}) {
  const out = [];
  let prev = null;
  for (const r of rows) {
    if (prev && Number.isFinite(r.tsMs) && Number.isFinite(prev.tsMs) && r.tsMs - prev.tsMs <= maxGapMs) {
      let jumps = 0;
      for (const go of ['1', '2', '3', '4']) {
        const a = prev.fill?.[go];
        const b = r.fill?.[go];
        if (typeof a === 'number' && typeof b === 'number' && b - a > jumpThreshold) jumps += 1;
      }
      if (jumps >= minStalls) continue; // 誤爆行は捨てる(prevは据え置き=次行も同じ基準で比較)
    }
    out.push(r);
    prev = r;
  }
  return out;
}

/** 号別(1〜4)全レーン埋まり率(noriba-fill-history)の直近windowTicks件 median を
 * {stall1..stall4} の比率(0-1)で返す。データ無は null。昼=学習モデル/夜=行灯の統合値。 */
export function noribaFillByStall(fillRows, now, windowTicks = 5) {
  if (!Array.isArray(fillRows) || fillRows.length === 0) return null;
  const rs = filterFillGlareRows(
    fillRows.map(r => ({ ...r, tsMs: new Date(r.ts).getTime() }))
      .filter(r => Number.isFinite(r.tsMs) && r.tsMs <= now.getTime())
      .sort((a, b) => a.tsMs - b.tsMs)
  ).slice(-windowTicks);
  if (rs.length === 0) return null;
  const map = { stall1: '1', stall2: '2', stall3: '3', stall4: '4' };
  const out = {};
  for (const [stall, go] of Object.entries(map)) {
    const vals = rs.map(r => r.fill?.[go]).filter(v => typeof v === 'number').sort((a, b) => a - b);
    out[stall] = vals.length ? vals[Math.floor((vals.length - 1) / 2)] : null;
  }
  return out;
}

/** 号別×時間帯(2時間括り)×昼夜の「普段の埋まり率」中央値を返す。
 * 待機車両バーの「通常」目盛り用 — 同じ4段でも 2号は普段より少なめ・4号は普段より多め、
 * と号ごとに意味が真逆になる問題への対策 (2026-08-09 ユーザー指摘)。
 * 直近 days 日の履歴から、今と同じ時間帯・同じ昼夜モードの値だけを集める。
 * サンプルが minSamples 未満の枠は null (目盛りを出さない)。
 * @param {{ts:string, mode:string, fill:Record<string,number>}[]} fillRows
 * @returns {Record<string, number|null>|null}
 */
export function typicalFillByStall(fillRows, now, opts = {}) {
  if (!Array.isArray(fillRows) || fillRows.length === 0) return null;
  const days = opts.days ?? 28;
  const minSamples = opts.minSamples ?? 20;
  const nowMs = now.getTime();
  const sinceMs = nowMs - days * 86400000;
  const bandOf = (ts) => Math.floor(parseInt(String(ts).slice(11, 13), 10) / 2) * 2;
  // 今の時間帯・今のモードを最新行から決める(モードは計測側の昼夜判定が正)
  const latest = fillRows[fillRows.length - 1];
  const nowBand = Math.floor(now.getHours() / 2) * 2;
  const nowMode = latest && latest.mode ? latest.mode : null;
  if (!nowMode) return null;
  const per = {};
  for (const s of STALL_NAMES) per[s] = [];
  const goOf = { stall1: '1', stall2: '2', stall3: '3', stall4: '4' };
  for (const r of fillRows) {
    if (!r || r.mode !== nowMode || !r.fill) continue;
    const t = new Date(r.ts).getTime();
    if (!Number.isFinite(t) || t < sinceMs || t > nowMs) continue;
    if (bandOf(r.ts) !== nowBand) continue;
    for (const s of STALL_NAMES) {
      const v = r.fill[goOf[s]];
      if (typeof v === 'number' && v >= 0) per[s].push(v);
    }
  }
  const out = {};
  let any = false;
  for (const s of STALL_NAMES) {
    const a = per[s];
    if (a.length >= minSamples) {
      a.sort((x, y) => x - y);
      out[s] = Number(a[Math.floor((a.length - 1) / 2)].toFixed(3));
      any = true;
    } else {
      out[s] = null;
    }
  }
  return any ? out : null;
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
export function buildStalls(rows, now, holidays = null, yoloOcc = null, noribaFill = null, typicalFill = null) {
  const occ = currentOccupancyByStall(rows, now, 5);
  if (yoloOcc) {
    if (typeof yoloOcc.stall1 === "number") occ.stall1 = yoloOcc.stall1;
    if (typeof yoloOcc.stall2 === "number") occ.stall2 = yoloOcc.stall2;
  }
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
      fillRate: (noribaFill && typeof noribaFill[s] === 'number') ? noribaFill[s] : null,
      // その号・その時間帯の「普段の埋まり率」(0-1)。アプリの待機車両バーの通常目盛り。
      typicalFillRate: (typicalFill && typeof typicalFill[s] === 'number') ? typicalFill[s] : null,
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
export function buildPoolStatus(rows, now = new Date(), arrivals = null, holidays = null, texRows = null, fillRows = null) {
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
  // 昼は最奥 stall1/2 の占有を YOLO 計測で上書き(fillは遠景で満車/空を分離不可)。夜/データ無は fill のまま。
  const _latest = sorted(rows).filter(r => r.tsMs <= now.getTime()).slice(-1)[0];
  const _isDay = _latest ? _latest.mode === "day" : false;
  // 独立検証(サブエージェント+codex)でテクスチャ占有は固定閾値std>28が脆く、昼でも16->3->16と振動・暗い車で大量偽陰性=出荷不可と判明。占有上書きを一旦停止しfillへ戻す(2026-06-20)。texRows/slotTexOccByStallはシャドウ温存。
  const _texOcc = null; void texRows; void slotTexOccByStall;
  const noribaFill = noribaFillByStall(fillRows, now);
  const typicalFill = typicalFillByStall(fillRows, now);
  const stallsBase = buildStalls(rows, now, holidays, _texOcc, noribaFill, typicalFill);
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

// 配信データの鮮度判定。写真(アーカイブ更新)と台数計測(vehicle-count)の両方が
// 新しいときだけ「最新」とする。
// 2026-08-24〜26: 配信元の解像度変更で台数計測だけ2日止まったが、写真の鮮度しか
// 見ていなかったため、凍結した旧系統の数値を最新として配信していた。
// 戻り値 { stale, since } — since は「どこまでは正しかったか」の時刻(ISO)。
export function poolFreshness(imageAtMs, countAtMs, nowMs,
  { imageMaxAgeMin = 10, countMaxAgeMin = 20 } = {}) {
  const okImage = Number.isFinite(imageAtMs) && (nowMs - imageAtMs) < imageMaxAgeMin * 60 * 1000;
  const okCount = Number.isFinite(countAtMs) && (nowMs - countAtMs) < countMaxAgeMin * 60 * 1000;
  if (okImage && okCount) return { stale: false, since: null };
  // 止まっている側の最終時刻を出す(両方止まっていれば古いほう)
  const candidates = [];
  if (!okImage && Number.isFinite(imageAtMs)) candidates.push(imageAtMs);
  if (!okCount && Number.isFinite(countAtMs)) candidates.push(countAtMs);
  const since = candidates.length ? new Date(Math.min(...candidates)).toISOString() : null;
  return { stale: true, since };
}
