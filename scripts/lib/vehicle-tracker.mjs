import { iou } from './iou.mjs';

const IOU_THRESHOLD = 0.3;
// 1tick 見えなかったら即 lost 扱い。1分tick + 出庫検出ユースケースでは「短期消失耐性」より
// 「出庫イベントを取り漏らさない」方が優先。元は 2 だった。
const LOST_THRESHOLD = 1;

export function createEmptyState() {
  return { vehicles: {}, nextId: 1, tick: 0 };
}

export function updateTracker(state, newBboxes) {
  // Note: greedy oldest-id-first matching. In dense scenes with multiple
  // vehicles of similar IoU score, ID swaps can occur. This is acceptable for
  // Phase 1 because departure-detector.mjs (Task 5) only checks "did a
  // front_row vehicle disappear" — swap誤判定があっても合計出庫数は不変。
  // Phase 2 で score-sorted greedy / Hungarian アルゴリズムに置換する。
  const currentTick = state.tick + 1;
  const tracked = [];
  const usedBboxIndices = new Set();
  const matchedIds = new Set();

  // 既存vehiclesと新bboxesをIoUでマッチング
  const existingIds = Object.keys(state.vehicles).map(Number);
  for (const id of existingIds) {
    const existing = state.vehicles[id];
    let bestIdx = -1;
    let bestIoU = IOU_THRESHOLD;
    for (let i = 0; i < newBboxes.length; i++) {
      if (usedBboxIndices.has(i)) continue;
      const score = iou(existing.bbox, newBboxes[i]);
      if (score > bestIoU) {
        bestIoU = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      usedBboxIndices.add(bestIdx);
      matchedIds.add(id);
      tracked.push({
        id,
        bbox: newBboxes[bestIdx],
        age: existing.age + 1,
        last_seen_tick: currentTick
      });
    }
  }

  // マッチしなかった新bboxes → 新ID
  let nextId = state.nextId;
  for (let i = 0; i < newBboxes.length; i++) {
    if (usedBboxIndices.has(i)) continue;
    tracked.push({
      id: nextId,
      bbox: newBboxes[i],
      age: 1,
      last_seen_tick: currentTick
    });
    nextId++;
  }

  // マッチしなかった既存ID → lost候補
  const newVehicles = {};
  for (const v of tracked) {
    newVehicles[v.id] = { bbox: v.bbox, age: v.age, last_seen_tick: v.last_seen_tick };
  }
  const lost = [];
  for (const id of existingIds) {
    if (matchedIds.has(id)) continue;
    const existing = state.vehicles[id];
    const ticksSinceSeen = currentTick - existing.last_seen_tick;
    if (ticksSinceSeen > LOST_THRESHOLD) {
      lost.push({ id, bbox: existing.bbox, age: existing.age });
    } else {
      // 維持
      newVehicles[id] = existing;
    }
  }

  return {
    state: { vehicles: newVehicles, nextId, tick: currentTick },
    tracked,
    lost
  };
}
