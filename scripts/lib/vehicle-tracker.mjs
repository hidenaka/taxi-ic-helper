import { iou } from './iou.mjs';

const IOU_THRESHOLD = 0.3;
const LOST_THRESHOLD = 2; // 2 tick 連続で消えたら lost 確定

export function createEmptyState() {
  return { vehicles: {}, nextId: 1, tick: 0 };
}

export function updateTracker(state, newBboxes) {
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
