// T3 第5乗り場 slot-occupancy 固有純関数。
// 既存共通関数 (slotOccupied / computeSlotActuals 等) は流用し、ここには
// T3 にしか出ないロジック (9レーン×2列のサマリ・total 1値の actuals 集計) だけを置く。
import { departuresBetween } from './slot-occupancy.mjs';

const SLOT_MS = 15 * 60 * 1000;

function fmtJst(ms) {
  const jst = new Date(ms + 9 * 3600 * 1000);
  return `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * T3 占有履歴から 15分スロット × total を集計する純関数。
 * 既存 computeSlotActuals (T1/T2 4-stall 用) の T3 単一スロット版。
 *
 * T3 では smoothing (medianOf3) は使わない。 T3 は列移動 (row1→row2 でも occ
 * 不変、 row2→出庫で -1) があり、 1tick の急変動も「実際の出庫/列移動」を
 * 反映しているため、 平滑すると本当の departures を取り逃がす。
 * 窓判定は前後両 row が窓内であることを要求 (窓境界をまたぐ巨大な diff を防ぐ)。
 *
 * @param {Array} occHistory t3-slot-occupancy-history.jsonl の行配列
 * @param {Date} now 現在時刻
 * @param {number} [windowMinutes] 遡る分数（既定120）
 * @returns {Array<{slotStart:string, slotEnd:string, total:number}>}
 */
export function computeT3SlotActuals(occHistory, now, windowMinutes = 120) {
  const rows = (occHistory || [])
    .map(r => ({
      tsMs: new Date(r.ts).getTime(),
      occ: (r.stalls && r.stalls.t3_stand && typeof r.stalls.t3_stand.occ === 'number') ? r.stalls.t3_stand.occ : 0,
      mode: r.mode || null,
    }))
    .filter(r => !Number.isNaN(r.tsMs))
    .sort((a, b) => a.tsMs - b.tsMs);
  if (rows.length < 2) return [];
  const endMs = now.getTime();
  const startMs = endMs - windowMinutes * 60 * 1000;
  const bins = new Map();
  for (let i = 1; i < rows.length; i++) {
    // 前後 row 両方が窓内であることを要求（窓境界をまたぐ巨大 diff を排除）
    if (rows[i - 1].tsMs < startMs || rows[i - 1].tsMs > endMs) continue;
    if (rows[i].tsMs < startMs || rows[i].tsMs > endMs) continue;
    // 昼/夜モード切替 tick は差分0扱い（既存 computeSlotActuals と同じ理由）
    const prevMode = rows[i - 1].mode;
    const curMode = rows[i].mode;
    if (prevMode !== null && curMode !== null && prevMode !== curMode) continue;
    const binStart = Math.floor(rows[i].tsMs / SLOT_MS) * SLOT_MS;
    let bin = bins.get(binStart);
    if (!bin) { bin = { total: 0 }; bins.set(binStart, bin); }
    bin.total += departuresBetween(rows[i - 1].occ, rows[i].occ);
  }
  return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([ms, bin]) => ({
    slotStart: fmtJst(ms), slotEnd: fmtJst(ms + SLOT_MS), total: bin.total,
  }));
}

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
