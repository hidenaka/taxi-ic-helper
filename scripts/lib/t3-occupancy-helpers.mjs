// T3 第5乗り場 slot-occupancy 固有純関数。
// 既存共通関数 (slotOccupied / computeSlotActuals 等) は流用し、ここには
// T3 にしか出ないロジック (9レーン×2列のサマリ・total 1値の actuals 集計) だけを置く。

/**
 * t3-stall-slots.json の JSON 構造を検証して必要部分を抽出する純関数。
 * @param {object} json
 * @returns {{source:string, slots:Array, meta:object}}
 */
export function parseT3SlotConfig(json) {
  if (!json || json.schema_version !== 1) {
    throw new Error(`parseT3SlotConfig: unsupported schema_version: ${json && json.schema_version}`);
  }
  const stand = json.stalls && json.stalls.t3_stand;
  if (!stand || !Array.isArray(stand.slots)) {
    throw new Error('parseT3SlotConfig: t3_stand not found in stalls');
  }
  return {
    source: stand.source,
    slots: stand.slots,
    meta: json._meta || {},
  };
}

/**
 * 18マスの occupied dict から T3 全体の集計を返す純関数。
 * @param {Array<{id:string, lane:number, row:number}>} slots スロット定義配列
 * @param {Object<string, boolean>} occupiedById {slotId: occupied}
 * @returns {{total:number, row1:number, row2:number}}
 */
export function summarizeT3Occupancy(slots, occupiedById) {
  let total = 0, row1 = 0, row2 = 0;
  for (const s of slots) {
    if (!occupiedById[s.id]) continue;
    total += 1;
    if (s.row === 1) row1 += 1;
    else if (s.row === 2) row2 += 1;
  }
  return { total, row1, row2 };
}
