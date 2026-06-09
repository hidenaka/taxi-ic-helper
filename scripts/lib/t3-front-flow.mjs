// t3-front-flow — T3 前方プール(Real108)の流れ計測 Phase 1 の純関数群。
// 画像 I/O・ネットワークに依存しない。tick 本体は scripts/t3-front-flow-tick.mjs。
// 設計: docs/superpowers/specs/2026-06-10-t3-front-flow-movement-shift-design.md

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
