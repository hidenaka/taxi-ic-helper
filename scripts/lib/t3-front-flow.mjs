// t3-front-flow — T3 前方プール(Real108)の流れ計測 Phase 1 の純関数群。
// 画像 I/O・ネットワークに依存しない。tick 本体は scripts/t3-front-flow-tick.mjs。
// 設計: docs/superpowers/specs/2026-06-10-t3-front-flow-movement-shift-design.md

import { detectReplenishments, binCountsByWindow } from './advance-counter.mjs';

export const T3_FRONT_FLOW_SCHEMA_VERSION = 1;

const DEFAULT_PARAMS = { nightLum: 60, lanternK: 4, lanternT: 50 };

/**
 * data/t3-front-flow-rois.json のバリデーションと抽出。
 * gate の width/height が 0 のときは「未校正」(calibrated=false) を返し、tick 側で skip させる。
 * @returns {{camera:string, gate:{x,y,width,height}, params:{nightLum,lanternK,lanternT}, calibrated:boolean}}
 */
export function parseT3FrontFlowRois(json) {
  if (!json || json.schema_version !== T3_FRONT_FLOW_SCHEMA_VERSION) {
    throw new Error(`t3-front-flow-rois: schema_version=${T3_FRONT_FLOW_SCHEMA_VERSION} が必要`);
  }
  const g = json.gate;
  if (!g || typeof g.x !== 'number' || typeof g.y !== 'number' ||
      typeof g.width !== 'number' || typeof g.height !== 'number') {
    throw new Error('t3-front-flow-rois: gate {x,y,width,height} が必要');
  }
  const params = { ...DEFAULT_PARAMS, ...(json.params ?? {}) };
  const calibrated = g.width > 0 && g.height > 0;
  return { camera: json.camera ?? 'Real108', gate: { ...g }, params, calibrated };
}

/**
 * gate ROI ({x,y,width,height} 正規化) を advance-counter の box 形式 ({x0,x1,y0,y1}) へ。
 * 1.0 を超える端はクランプ。
 */
export function gateToBox(gate) {
  return {
    x0: gate.x,
    x1: Math.min(1.0, gate.x + gate.width),
    y0: gate.y,
    y1: Math.min(1.0, gate.y + gate.height),
  };
}

/**
 * 前回 state と今回の取得結果が「同じフレーム」かを判定する (R4: 同一フレーム連打防止)。
 * Last-Modified が両方あればそれで比較、どちらか欠けたら画像バイト列の md5 で比較。
 * @param {{last_modified?:string|null, frame_hash?:string}|null} prevState
 * @param {{lastModified:string|null, hash:string}} current
 * @returns {boolean}
 */
export function isSameFrame(prevState, current) {
  if (!prevState) return false;
  if (prevState.last_modified && current.lastModified) {
    return prevState.last_modified === current.lastModified;
  }
  return prevState.frame_hash === current.hash;
}

/**
 * Date → JST ISO 文字列 (+09:00)。movement-shift-tick.mjs の jstTimestamp と同じ表現。
 */
export function toJstIso(d) {
  const z = (n) => String(n).padStart(2, '0');
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  return `${j.getUTCFullYear()}-${z(j.getUTCMonth() + 1)}-${z(j.getUTCDate())}T` +
    `${z(j.getUTCHours())}:${z(j.getUTCMinutes())}:${z(j.getUTCSeconds())}+09:00`;
}

/**
 * t3-front-flow-history.jsonl の1行を組み立てる。frame_ts はフレームの実時刻
 * (Last-Modified 由来)で、後段の計数の時刻軸に使う。front_density は小数2桁。
 */
export function buildFlowRow({ frameTs, tickTs, camera, isNight, frontDensity, frameHash }) {
  return {
    schema_version: T3_FRONT_FLOW_SCHEMA_VERSION,
    frame_ts: frameTs,
    tick_ts: tickTs,
    camera,
    is_night: isNight,
    front_density: Math.round(frontDensity * 100) / 100,
    frame_hash: frameHash,
  };
}

/**
 * 上昇エッジ(補充=詰め)と下降エッジ(枯渇=出庫)の両方を 15分窓などで集計する。
 * 極性は Phase 2 の実データ検証で確定するため、ここでは両方を併記する (R3)。
 * 下降は値の符号反転で detectReplenishments に対称に通す。
 * @param {number[]} values front_density 列(時系列順)
 * @param {number[]} times  epoch 秒(昇順, frame_ts 由来)
 * @param {{absThreshold:number, persistSec?:number, debounceSec?:number, smoothK?:number, windowSec?:number}} opts
 * @returns {{rising:Record<number,number>, falling:Record<number,number>}}
 */
export function summarizeBothPolarities(values, times, opts) {
  const windowSec = opts.windowSec ?? 900;
  const detectOpts = {
    absThreshold: opts.absThreshold,
    persistSec: opts.persistSec ?? 120,
    debounceSec: opts.debounceSec ?? 120,
    smoothK: opts.smoothK ?? 3,
  };
  const rising = detectReplenishments(values, times, detectOpts);
  const falling = detectReplenishments(values.map((v) => -v), times, detectOpts);
  return {
    rising: binCountsByWindow(rising.eventTimes, windowSec),
    falling: binCountsByWindow(falling.eventTimes, windowSec),
  };
}
