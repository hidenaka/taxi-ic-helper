// lane-actuals — 「その便が実際にどの乗り場(号)に着いたか」の実績を貯め、
// パターンを学習するための純関数群。
//
// 背景 (2026-08-14 本人要望):
//   遅延便は通常と違う号に着くことがある。「このパターンだとこの場所に着く」を明確にしたい。
//   静的推定 (羽田公式APIの出口番号→北/南→号) は平常時は当たるが、深夜の遅延便では
//   航空会社都合で出口が変わり、現地掲示だけが正となる。
//   掲示は毎晩そのとき限りで消えるので、実績として蓄積しないと学習できない。
//
// 学習は2系統を並行で持つ (どちらが効くかはデータが決める):
//   A. 便別実績   … 「NH84 は直近5回中4回が4号」— 同じ便が繰り返し同じ号に着く場合に効く
//   B. パターン別 … 「深夜1時以降・札幌方面・T2 → 4号が7割」— 便でなく状況で決まる場合に効く
//
// 実績の出所は現地掲示 (pool-notice の lateFlights)。掲示に便番号と号が両方あるものだけを採る。

const CARRIER_TO_IATA = {
  JAL: 'JL', 日本航空: 'JL',
  ANA: 'NH', 全日空: 'NH',
  SKY: 'BC', スカイマーク: 'BC',
  ADO: 'HD', エアドゥ: 'HD', 'エア・ドゥ': 'HD',
  SFJ: '7G', スターフライヤー: '7G',
  ソラシド: '6J', SNA: '6J',
};

/** 掲示の便名 ("ANA84 札幌便") → IATA便名 ("NH84")。便番号が無ければ null。 */
export function noticeNameToFlightNumber(name) {
  const m = String(name ?? '').match(
    /(JAL|日本航空|ANA|全日空|SKY|スカイマーク|ADO|エアドゥ|エア・ドゥ|SFJ|スターフライヤー|ソラシド|SNA)\s*(\d{1,4})/,
  );
  if (!m) return null;
  const iata = CARRIER_TO_IATA[m[1]];
  return iata ? iata + String(parseInt(m[2], 10)) : null;
}

/** "NH0084" / "nh 84" → "NH84"。取れなければ null。 */
export function normalizeFlightNumber(fn) {
  const m = String(fn ?? '').replace(/\s/g, '').toUpperCase().match(/^([A-Z0-9]{2})0*(\d+)$/);
  return m ? m[1] + m[2] : null;
}

/** "0:48"/"23:05" → 0時起点の分。深夜(12時未満)は翌日として +1440 する。 */
export function etaToMinutes(text, { wrapLateNight = true } = {}) {
  const m = String(text ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (h > 29 || mm > 59) return null;
  const min = h * 60 + mm;
  // 翌日側に送るのは 0:00-4:59 のみ。h<12 だと朝の便まで深夜バンドに落ち、
  // 深夜便の実績が朝の便に適用されてしまう(2026-08-14 本人指摘)。
  return (wrapLateNight && h < 5) ? min + 1440 : min;
}

/** 時間帯の粗いラベル。深夜帯を細かく、それ以外はまとめる(サンプルを薄めないため)。 */
export function timeBand(etaText) {
  const min = etaToMinutes(etaText);
  if (min == null) return 'unknown';
  if (min < 22 * 60) return 'day';          // 〜21:59
  if (min < 23 * 60) return 'late22';       // 22時台
  if (min < 24 * 60) return 'late23';       // 23時台
  if (min < 25 * 60) return 'mid00';        // 0時台
  return 'mid01+';                          // 1時以降
}

/**
 * 現地掲示の1レコード(pool-notice 履歴の1行)から実績行を作る。
 * 便番号と号が両方あるものだけを返す(号だけ・便名だけの掲示は学習に使えない)。
 * @param {{ts:string, lateFlights?:{flights:Array}}} noticeRow
 * @returns {{date:string, flightNumber:string, stall:number, eta:string|null, pax:number|null, band:string, source:'notice'}[]}
 */
export function extractLaneActuals(noticeRow, parsed = null) {
  const flights = parsed?.flights ?? noticeRow?.lateFlights?.flights ?? [];
  if (!Array.isArray(flights)) return [];
  const date = String(noticeRow?.ts ?? '').slice(0, 10);
  if (!date) return [];
  const out = [];
  for (const f of flights) {
    if (!Number.isInteger(f?.stall) || f.stall < 1 || f.stall > 4) continue;
    const fno = noticeNameToFlightNumber(f.name);
    if (!fno) continue;
    const eta = f.eta?.text ?? null;
    out.push({
      date,
      flightNumber: fno,
      stall: f.stall,
      eta,
      pax: typeof f.pax === 'number' ? f.pax : null,
      band: timeBand(eta),
      source: 'notice',
    });
  }
  return out;
}

/** 同じ(日付,便)は最後の掲示を採る(掲示は更新されるため)。 */
export function dedupeActuals(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (!r?.date || !r?.flightNumber) continue;
    map.set(r.date + '|' + r.flightNumber, r);
  }
  return [...map.values()].sort((a, b) => (a.date + a.flightNumber).localeCompare(b.date + b.flightNumber));
}

const MIN_SAMPLES_FLIGHT = 2;   // 便別: 2回以上見ていれば傾向として出す
const MIN_SAMPLES_PATTERN = 3;  // パターン別: 3回以上

const RECENT_WINDOW = 3;

function summarizeStalls(list) {
  const count = {};
  for (const r of list) count[r.stall] = (count[r.stall] || 0) + 1;
  const entries = Object.entries(count).map(([k, v]) => [parseInt(k, 10), v]).sort((a, b) => b[1] - a[1]);
  const [topStall, topCount] = entries[0];
  // 直近ぶんの最多号。乗り場運用が変わると古い実績が足を引っ張るため
  // (実測: JL528 は 6月=1号 → 7月以降=2号 と切り替わっている)。
  const sorted = [...list].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const recent = sorted.slice(-RECENT_WINDOW);
  const rc = {};
  for (const r of recent) rc[r.stall] = (rc[r.stall] || 0) + 1;
  const recentTop = Object.entries(rc).map(([k, v]) => [parseInt(k, 10), v]).sort((a, b) => b[1] - a[1])[0];
  return {
    n: list.length,
    stall: topStall,
    share: Number((topCount / list.length).toFixed(2)),
    dist: Object.fromEntries(entries),
    lastDate: sorted[sorted.length - 1]?.date ?? null,
    recentStall: recentTop[0],
    recentN: recent.length,
  };
}

/**
 * A': 便×時間帯の実績。同じ便でも到着が日をまたぐと号が変わるため、これが最も効く。
 * (実測: NH84 は 23:59着なら3号(2/2)・0:48着なら4号(2/2) と時間帯で完全に分かれる)
 * @returns {Record<string, {n, stall, share, dist, lastDate, recentStall}>} キーは `便名|時間帯`
 */
export function learnByFlightBand(actuals, { minSamples = 2 } = {}) {
  const by = new Map();
  for (const r of dedupeActuals(actuals)) {
    const key = `${r.flightNumber}|${r.band}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  const out = {};
  for (const [key, list] of by) {
    if (list.length < minSamples) continue;
    out[key] = summarizeStalls(list);
  }
  return out;
}

/**
 * A: 便別実績。「この便は実際どの号に着いているか」。
 * @returns {Record<string, {n, stall, share, dist, lastDate}>}
 */
export function learnByFlight(actuals, { minSamples = MIN_SAMPLES_FLIGHT } = {}) {
  const by = new Map();
  for (const r of dedupeActuals(actuals)) {
    if (!by.has(r.flightNumber)) by.set(r.flightNumber, []);
    by.get(r.flightNumber).push(r);
  }
  const out = {};
  for (const [fno, list] of by) {
    if (list.length < minSamples) continue;
    out[fno] = summarizeStalls(list);
  }
  return out;
}

/**
 * B: パターン別実績。便でなく「状況」で決まる号を拾う。
 * キーは `${band}|${airline}` (時間帯×航空会社)。方面を足すと薄くなるため、まずこの粒度。
 * @returns {Record<string, {n, stall, share, dist, lastDate}>}
 */
export function learnByPattern(actuals, { minSamples = MIN_SAMPLES_PATTERN } = {}) {
  const by = new Map();
  for (const r of dedupeActuals(actuals)) {
    const airline = String(r.flightNumber).slice(0, 2);
    const key = `${r.band}|${airline}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  const out = {};
  for (const [key, list] of by) {
    if (list.length < minSamples) continue;
    out[key] = summarizeStalls(list);
  }
  return out;
}

/**
 * 学習結果を1便に当てる。便別(A)を優先し、無ければパターン別(B)。
 * 推定号(estLane)と違うときだけ意味があるので、呼び出し側で比較して使う。
 * @returns {{stall:number, share:number, n:number, basis:'flight'|'pattern', key:string}|null}
 */
// 実績が割れているときは直近を採る(運用変更に追従)。share がこの値未満なら recentStall。
const DECISIVE_SHARE = 0.7;

function pick(entry, basis, key) {
  const decisive = entry.share >= DECISIVE_SHARE;
  return {
    stall: decisive ? entry.stall : (entry.recentStall ?? entry.stall),
    share: entry.share,
    n: entry.n,
    basis: decisive ? basis : basis + '-recent',
    key,
    dist: entry.dist,
    lastDate: entry.lastDate,
  };
}

export function predictLane(flight, model) {
  if (!flight || !model) return null;
  const fno = normalizeFlightNumber(flight.flightNumber);
  const band = timeBand(flight.estimatedTime ?? flight.scheduledTime ?? null);
  // 1) 便×時間帯 — 同じ便でも到着が日をまたぐと号が変わるので最優先
  const byFlightBand = model.byFlightBand || {};
  if (fno && byFlightBand[`${fno}|${band}`]) {
    return pick(byFlightBand[`${fno}|${band}`], 'flight-band', `${fno}|${band}`);
  }
  // 2) 便別
  const byFlight = model.byFlight || {};
  if (fno && byFlight[fno]) return pick(byFlight[fno], 'flight', fno);
  // 3) 時間帯×航空会社
  const airline = fno ? fno.slice(0, 2) : null;
  if (!airline) return null;
  const key = `${band}|${airline}`;
  const byPattern = model.byPattern || {};
  if (byPattern[key]) return pick(byPattern[key], 'pattern', key);
  return null;
}
