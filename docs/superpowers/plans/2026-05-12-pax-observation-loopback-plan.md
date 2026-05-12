# タクシー乗り場観測ループバック — 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** YOLOv8n + ByteTrack(簡略版)で4乗り場の出庫イベントを観測し、日次バッチで `transit-share.json` の T1/T2 rates を EMA で自動キャリブレーションする。

**Architecture:** 既存 `observe-taxi-pool.mjs` を schema v3 に拡張し、`vehicle-detector → vehicle-tracker → lane-roi → departure-detector` の4段パイプラインを追加。出庫イベントを `taxi-pool-history.jsonl` に蓄積し、日次バッチ `calibrate-transit-share.mjs` が14日分の観測を集計して `transit-share.json` を α=0.2 の EMA で更新する。launchd cron を 15分→1分に変更。

**Tech Stack:** Node.js 20, `onnxruntime-node` (新規依存), `jimp` (既存), YOLOv8n COCO 事前学習モデル (`.onnx`), `node --test`, launchd

**設計仕様書:** `docs/superpowers/specs/2026-05-12-pax-observation-loopback-design.md`

**実画像の事実（spec の数値と実態の差分メモ）:**
- 実画像サイズは **800×600** (spec の 1920×1080 はサンプル例。実装時は `scripts/lib/roi-config.json` の `image_size: [800, 600]` を真とする)
- 既存 launchd cron は **15分間隔**（spec の「5分→1分」は誤記、実態は「15分→1分」）

**実装の5段階構成:**
- **Phase 1A** (Task 1〜5): 純関数モジュール群（テスト主導、ML不要、安全）
- **Phase 1B** (Task 6〜7): YOLOv8n 推論モジュール + 動作確認
- **Phase 1C** (Task 8): `data/lane-roi.json` の手動定義（実画像確認）
- **Phase 1D** (Task 9〜11): observe-taxi-pool 拡張 + launchd cron変更 + 1週間稼働
- **Phase 1E** (Task 12〜14): 日次キャリブレーション実装 + 14日蓄積後の本番反映

---

## ファイル構造

### 新規

| ファイル | 責務 |
|---|---|
| `scripts/lib/vehicle-detector.mjs` | YOLOv8n 推論。`detect(buffer) → bbox配列` |
| `scripts/lib/vehicle-tracker.mjs` | ByteTrack 簡略版（IoUベース）。前tick状態 + 新bbox → 追跡IDつき配列 |
| `scripts/lib/lane-roi.mjs` | Point-in-polygon + lane_id 割当 |
| `scripts/lib/departure-detector.mjs` | 前/今tick から出庫イベント検出 |
| `scripts/lib/iou.mjs` | IoU 計算 (vehicle-tracker の依存) |
| `scripts/calibrate-transit-share.mjs` | 日次キャリブレーション バッチ |
| `scripts/download-yolo-model.sh` | YOLOv8n.onnx 取得スクリプト |
| `data/lane-roi.json` | 4乗り場×レーン polygon 座標（手動定義） |
| `models/README.md` | モデル取得手順 |
| `tests/lib/vehicle-detector.test.mjs` | YOLO 推論テスト |
| `tests/lib/vehicle-tracker.test.mjs` | ID マッチングテスト |
| `tests/lib/lane-roi.test.mjs` | polygon 判定 + lane_id 割当テスト |
| `tests/lib/departure-detector.test.mjs` | 出庫イベント検出テスト |
| `tests/lib/iou.test.mjs` | IoU 計算テスト |
| `tests/calibrate-transit-share.test.mjs` | EMA + ガード検証 |
| `tests/observe-taxi-pool-integration.test.mjs` | schema v3 出力検証 |
| `tests/fixtures/observation/sample-real01.jpg` | テスト用 fixture 画像 |
| `tests/fixtures/observation/sample-real02.jpg` | テスト用 fixture 画像 |
| `tests/fixtures/observation/history-14days.jsonl` | calibration 入力 fixture |

### 修正

| ファイル | 修正内容 |
|---|---|
| `scripts/observe-taxi-pool.mjs` | SCHEMA_VERSION 2→3、YOLO/Tracker/ROI/Departure 呼び出し追加 |
| `package.json` | `onnxruntime-node@^1.16.0` を依存追加 |
| `.gitignore` | `models/*.onnx` を追加 |
| `scripts/install-observe-launchd.sh` | StartInterval を 15分→1分 (900s→60s) に変更 |

---

# Phase 1A: 純関数モジュール群（ML不要、TDDで安全実装）

## Task 1: 依存追加とディレクトリ準備

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `models/README.md`
- Create: `scripts/download-yolo-model.sh`

- [ ] **Step 1: `onnxruntime-node` を依存追加**

Run（`乗務地図関係/` で）:
```bash
npm install onnxruntime-node@^1.16.0
```

- [ ] **Step 2: `models/` ディレクトリと README を作成**

`models/README.md`:
```markdown
# YOLOv8n ONNX モデル

このディレクトリには `yolov8n.onnx` (約 12MB) を配置する。
git には commit せず、初回セットアップ時に以下を実行:

```bash
./scripts/download-yolo-model.sh
```

モデル取得元: https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.pt
.pt → .onnx 変換は ultralytics CLI で実行 (`yolo export model=yolov8n.pt format=onnx`)。
本リポジトリの README には変換済み .onnx の DLリンクを記載する。
```

- [ ] **Step 3: ダウンロードスクリプトを作成**

`scripts/download-yolo-model.sh`:
```bash
#!/bin/bash
set -e
MODEL_URL="https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.pt"
MODEL_DIR="$(cd "$(dirname "$0")/../models" && pwd)"
mkdir -p "$MODEL_DIR"

# .pt → .onnx 変換は Python の ultralytics CLI で行う必要があるため、
# 既に変換済みの .onnx ファイルがある場合は URL を変えること
ONNX_URL="${YOLOV8N_ONNX_URL:-https://huggingface.co/Ultralytics/YOLOv8/resolve/main/yolov8n.onnx}"
echo "Downloading YOLOv8n ONNX from $ONNX_URL ..."
curl -L -o "$MODEL_DIR/yolov8n.onnx" "$ONNX_URL"
echo "Downloaded $(ls -la "$MODEL_DIR/yolov8n.onnx" | awk '{print $5}') bytes to $MODEL_DIR/yolov8n.onnx"
```

`chmod +x scripts/download-yolo-model.sh`

- [ ] **Step 4: `.gitignore` に追加**

```
# YOLOv8n ONNX model (downloaded separately)
models/*.onnx
```

- [ ] **Step 5: コミット**

```bash
chmod +x scripts/download-yolo-model.sh
git add package.json package-lock.json .gitignore models/README.md scripts/download-yolo-model.sh
git commit -m "chore: add onnxruntime-node and yolo model scaffold"
```

---

## Task 2: IoU 計算モジュール（純関数）

**Files:**
- Create: `scripts/lib/iou.mjs`
- Test: `tests/lib/iou.test.mjs`

- [ ] **Step 1: テスト作成**

`tests/lib/iou.test.mjs`:
```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { iou } from '../../scripts/lib/iou.mjs';

// bbox は [x, y, w, h] 形式

test('完全一致は 1.0', () => {
  assert.equal(iou([10, 10, 100, 100], [10, 10, 100, 100]), 1.0);
});

test('完全非交差は 0.0', () => {
  assert.equal(iou([0, 0, 50, 50], [100, 100, 50, 50]), 0);
});

test('半分重なる場合は 1/3', () => {
  // 100x100 と 100x100、横方向に50ずれ
  // 交差面積 50*100=5000, 結合面積 100*100 + 50*100 = 15000
  const r = iou([0, 0, 100, 100], [50, 0, 100, 100]);
  assert.ok(Math.abs(r - 5000/15000) < 1e-6);
});

test('片方が他方に内包される場合', () => {
  // 100x100 の中に 50x50
  // 交差 2500, 結合 10000
  const r = iou([0, 0, 100, 100], [25, 25, 50, 50]);
  assert.ok(Math.abs(r - 2500/10000) < 1e-6);
});

test('境界接触は 0.0', () => {
  // 100x100 と 100x100、x=100で接する
  assert.equal(iou([0, 0, 100, 100], [100, 0, 100, 100]), 0);
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
node --test tests/lib/iou.test.mjs
```
Expected: FAIL (Cannot find module)

- [ ] **Step 3: 実装**

`scripts/lib/iou.mjs`:
```javascript
export function iou(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = aw * ah + bw * bh - inter;
  return inter / union;
}
```

- [ ] **Step 4: テスト通過確認**

```bash
node --test tests/lib/iou.test.mjs
```
Expected: PASS (5 tests)

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/iou.mjs tests/lib/iou.test.mjs
git commit -m "feat(observation): add IoU calculation utility"
```

---

## Task 3: 車両追跡モジュール（ByteTrack 簡略版）

**Files:**
- Create: `scripts/lib/vehicle-tracker.mjs`
- Test: `tests/lib/vehicle-tracker.test.mjs`

- [ ] **Step 1: テスト作成**

`tests/lib/vehicle-tracker.test.mjs`:
```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { updateTracker, createEmptyState } from '../../scripts/lib/vehicle-tracker.mjs';

test('createEmptyState: 空のstateを返す', () => {
  const s = createEmptyState();
  assert.deepEqual(s.vehicles, {});
  assert.equal(s.nextId, 1);
  assert.equal(s.tick, 0);
});

test('updateTracker: 初回検出は全部新ID', () => {
  const state = createEmptyState();
  const bboxes = [[10, 10, 50, 50], [200, 200, 50, 50]];
  const { state: newState, tracked } = updateTracker(state, bboxes);
  assert.equal(tracked.length, 2);
  assert.equal(tracked[0].id, 1);
  assert.equal(tracked[1].id, 2);
  assert.equal(newState.nextId, 3);
  assert.equal(newState.tick, 1);
});

test('updateTracker: 同位置の車両は同一IDで継続', () => {
  let state = createEmptyState();
  ({ state } = updateTracker(state, [[10, 10, 50, 50]]));
  const { tracked } = updateTracker(state, [[12, 11, 49, 51]]); // 軽微なズレ
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].id, 1); // 同じID継続
  assert.equal(tracked[0].age, 2);
});

test('updateTracker: 大きく動いたbboxは新ID', () => {
  let state = createEmptyState();
  ({ state } = updateTracker(state, [[10, 10, 50, 50]]));
  const { state: state2, tracked } = updateTracker(state, [[500, 500, 50, 50]]);
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].id, 2); // 別の車両として扱われる
});

test('updateTracker: 消えた車両は lost で報告', () => {
  let state = createEmptyState();
  ({ state } = updateTracker(state, [[10, 10, 50, 50]]));
  // LOST_THRESHOLD (2) 超えるまで lost にならない
  ({ state } = updateTracker(state, []));
  ({ state } = updateTracker(state, []));
  const { lost } = updateTracker(state, []);
  assert.deepEqual(lost.map(v => v.id), [1]);
});

test('updateTracker: 1tick だけ消えても LOST_THRESHOLD 内なら維持', () => {
  let state = createEmptyState();
  ({ state } = updateTracker(state, [[10, 10, 50, 50]]));
  ({ state } = updateTracker(state, [])); // 1 tick 消失
  const { tracked } = updateTracker(state, [[12, 11, 49, 51]]); // 再出現
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].id, 1); // 同じIDで継続
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
node --test tests/lib/vehicle-tracker.test.mjs
```

- [ ] **Step 3: 実装**

`scripts/lib/vehicle-tracker.mjs`:
```javascript
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
```

- [ ] **Step 4: テスト通過確認**

```bash
node --test tests/lib/vehicle-tracker.test.mjs
```
Expected: PASS (6 tests)

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/vehicle-tracker.mjs tests/lib/vehicle-tracker.test.mjs
git commit -m "feat(observation): add simplified ByteTrack vehicle tracker"
```

---

## Task 4: Lane ROI モジュール（Point-in-polygon + lane割当）

**Files:**
- Create: `scripts/lib/lane-roi.mjs`
- Test: `tests/lib/lane-roi.test.mjs`

- [ ] **Step 1: テスト作成**

`tests/lib/lane-roi.test.mjs`:
```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { pointInPolygon, assignLane, terminalForLane } from '../../scripts/lib/lane-roi.mjs';

const LANE_CONFIG = {
  lanes: [
    {
      id: '第一-一般', terminal: 'T1', camera: 'real01_line',
      polygon: [[100, 300], [200, 300], [200, 500], [100, 500]],
      front_row_polygon: [[100, 480], [200, 480], [200, 500], [100, 500]]
    },
    {
      id: '第二-一般', terminal: 'T1', camera: 'real01_line',
      polygon: [[210, 300], [310, 300], [310, 500], [210, 500]],
      front_row_polygon: [[210, 480], [310, 480], [310, 500], [210, 500]]
    },
    {
      id: '第三-一般', terminal: 'T2', camera: 'real01_line',
      polygon: [[400, 300], [500, 300], [500, 500], [400, 500]],
      front_row_polygon: [[400, 480], [500, 480], [500, 500], [400, 500]]
    }
  ]
};

test('pointInPolygon: 内側はtrue', () => {
  const poly = [[100, 100], [200, 100], [200, 200], [100, 200]];
  assert.equal(pointInPolygon([150, 150], poly), true);
});

test('pointInPolygon: 外側はfalse', () => {
  const poly = [[100, 100], [200, 100], [200, 200], [100, 200]];
  assert.equal(pointInPolygon([50, 50], poly), false);
});

test('pointInPolygon: 三角形の内外', () => {
  const poly = [[0, 0], [100, 0], [50, 100]];
  assert.equal(pointInPolygon([50, 30], poly), true);
  assert.equal(pointInPolygon([10, 90], poly), false);
});

test('assignLane: bbox中心が第一-一般の polygon に入る', () => {
  const bbox = [120, 350, 50, 50]; // 中心(145, 375) → 第一-一般
  const r = assignLane(bbox, 'real01_line', LANE_CONFIG);
  assert.equal(r.lane, '第一-一般');
  assert.equal(r.front_row, false);
});

test('assignLane: bbox中心が第二-一般の front_row に入る', () => {
  const bbox = [240, 480, 30, 30]; // 中心(255, 495) → 第二-一般 front_row
  const r = assignLane(bbox, 'real01_line', LANE_CONFIG);
  assert.equal(r.lane, '第二-一般');
  assert.equal(r.front_row, true);
});

test('assignLane: どのlaneにも入らない', () => {
  const bbox = [700, 350, 30, 30]; // 範囲外
  const r = assignLane(bbox, 'real01_line', LANE_CONFIG);
  assert.equal(r.lane, null);
});

test('terminalForLane: 第一/第二は T1', () => {
  assert.equal(terminalForLane('第一-一般', LANE_CONFIG), 'T1');
  assert.equal(terminalForLane('第二-一般', LANE_CONFIG), 'T1');
});

test('terminalForLane: 第三/第四は T2', () => {
  assert.equal(terminalForLane('第三-一般', LANE_CONFIG), 'T2');
});

test('terminalForLane: 存在しない lane は null', () => {
  assert.equal(terminalForLane('存在しない', LANE_CONFIG), null);
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
node --test tests/lib/lane-roi.test.mjs
```

- [ ] **Step 3: 実装**

`scripts/lib/lane-roi.mjs`:
```javascript
// Ray casting algorithm
export function pointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function assignLane(bbox, camera, config) {
  const [x, y, w, h] = bbox;
  const center = [x + w / 2, y + h / 2];
  for (const lane of config.lanes) {
    if (lane.camera !== camera) continue;
    if (!pointInPolygon(center, lane.polygon)) continue;
    const front_row = pointInPolygon(center, lane.front_row_polygon);
    return { lane: lane.id, front_row };
  }
  return { lane: null, front_row: false };
}

export function terminalForLane(laneId, config) {
  const lane = config.lanes.find(l => l.id === laneId);
  return lane ? lane.terminal : null;
}
```

- [ ] **Step 4: テスト通過確認**

```bash
node --test tests/lib/lane-roi.test.mjs
```
Expected: PASS (9 tests)

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/lane-roi.mjs tests/lib/lane-roi.test.mjs
git commit -m "feat(observation): add lane ROI point-in-polygon assignment"
```

---

## Task 5: 出庫イベント検出モジュール

**Files:**
- Create: `scripts/lib/departure-detector.mjs`
- Test: `tests/lib/departure-detector.test.mjs`

- [ ] **Step 1: テスト作成**

`tests/lib/departure-detector.test.mjs`:
```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectDepartures } from '../../scripts/lib/departure-detector.mjs';

test('detectDepartures: 前tickでfront_rowにいた車両が今tickで消えた → 出庫', () => {
  const prev = [
    { id: 100, bbox: [120, 480, 50, 50], lane: '第一-一般', front_row: true },
    { id: 101, bbox: [240, 350, 50, 50], lane: '第二-一般', front_row: false }
  ];
  const current = [
    { id: 101, bbox: [240, 350, 50, 50], lane: '第二-一般', front_row: false }
  ];
  const lost = [{ id: 100 }];
  const ts = '2026-05-12T15:30:00+09:00';
  const events = detectDepartures(prev, current, lost, ts);
  assert.equal(events.length, 1);
  assert.equal(events[0].lane, '第一-一般');
  assert.equal(events[0].vehicle_id, 100);
  assert.equal(events[0].ts, ts);
});

test('detectDepartures: front_row以外で消えた車両は出庫扱いしない', () => {
  const prev = [
    { id: 100, bbox: [240, 350, 50, 50], lane: '第二-一般', front_row: false }
  ];
  const current = [];
  const lost = [{ id: 100 }];
  const events = detectDepartures(prev, current, lost, '2026-05-12T15:30:00+09:00');
  assert.equal(events.length, 0);
});

test('detectDepartures: front_rowから後ろに動いた車両は出庫扱いしない（同laneに残る）', () => {
  const prev = [{ id: 100, bbox: [120, 480, 50, 50], lane: '第一-一般', front_row: true }];
  const current = [{ id: 100, bbox: [120, 400, 50, 50], lane: '第一-一般', front_row: false }];
  const lost = [];
  const events = detectDepartures(prev, current, lost, '2026-05-12T15:30:00+09:00');
  assert.equal(events.length, 0); // 後退は通常起きないがガード
});

test('detectDepartures: 複数同時出庫', () => {
  const prev = [
    { id: 100, bbox: [120, 480, 50, 50], lane: '第一-一般', front_row: true },
    { id: 200, bbox: [420, 480, 50, 50], lane: '第三-一般', front_row: true }
  ];
  const current = [];
  const lost = [{ id: 100 }, { id: 200 }];
  const events = detectDepartures(prev, current, lost, '2026-05-12T15:30:00+09:00');
  assert.equal(events.length, 2);
});

test('detectDepartures: lane=null の車両は無視', () => {
  const prev = [{ id: 100, bbox: [700, 100, 50, 50], lane: null, front_row: false }];
  const current = [];
  const lost = [{ id: 100 }];
  const events = detectDepartures(prev, current, lost, '2026-05-12T15:30:00+09:00');
  assert.equal(events.length, 0);
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
node --test tests/lib/departure-detector.test.mjs
```

- [ ] **Step 3: 実装**

`scripts/lib/departure-detector.mjs`:
```javascript
export function detectDepartures(previousTracks, currentTracks, lost, ts) {
  const lostIds = new Set(lost.map(v => v.id));
  const events = [];
  for (const prev of previousTracks) {
    if (!prev.front_row) continue;
    if (prev.lane == null) continue;
    if (!lostIds.has(prev.id)) continue;
    events.push({
      lane: prev.lane,
      vehicle_id: prev.id,
      ts
    });
  }
  return events;
}
```

- [ ] **Step 4: テスト通過確認**

```bash
node --test tests/lib/departure-detector.test.mjs
```
Expected: PASS (5 tests)

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/departure-detector.mjs tests/lib/departure-detector.test.mjs
git commit -m "feat(observation): add departure event detector"
```

---

# Phase 1B: YOLOv8n 推論モジュール

## Task 6: vehicle-detector.mjs（YOLOv8n + onnxruntime-node）

**Files:**
- Create: `scripts/lib/vehicle-detector.mjs`
- Test: `tests/lib/vehicle-detector.test.mjs`
- Create: `tests/fixtures/observation/sample-real01.jpg` (実画像、curl で取得)

YOLOv8n のONNX出力形式: shape `[1, 84, 8400]`。84 = 4(bbox: cx, cy, w, h) + 80(クラス確信度)。8400 はアンカー数。
COCOクラス: `car` = class_id 2、`truck` = class_id 7。

- [ ] **Step 1: YOLOv8n .onnx モデルを取得**

```bash
./scripts/download-yolo-model.sh
ls -la models/yolov8n.onnx
```
Expected: 約12MB のファイルがあること。失敗したら `models/README.md` の手順で別URL試行。

- [ ] **Step 2: テスト用 fixture 画像を取得**

```bash
mkdir -p tests/fixtures/observation
curl -sS -A 'taxi-pax-estimator test fixture' \
  -o tests/fixtures/observation/sample-real01.jpg \
  'https://ttc.taxi-inf.jp/Real01_line.jpg'
curl -sS -A 'taxi-pax-estimator test fixture' \
  -o tests/fixtures/observation/sample-real02.jpg \
  'https://ttc.taxi-inf.jp/Real02.jpg'
ls -la tests/fixtures/observation/
```
Expected: 各 50-100KB の JPEG ファイル。

- [ ] **Step 3: テスト作成（緩い基準で動作確認のみ）**

`tests/lib/vehicle-detector.test.mjs`:
```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectVehicles, loadModel } from '../../scripts/lib/vehicle-detector.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '../fixtures/observation/sample-real01.jpg');
const MODEL = join(__dirname, '../../models/yolov8n.onnx');

// モデルが無い環境ではスキップ
const skipUnlessModelExists = existsSync(MODEL) ? false : true;

test('loadModel: ONNXモデルをロードできる', { skip: skipUnlessModelExists }, async () => {
  const model = await loadModel(MODEL);
  assert.ok(model);
});

test('detectVehicles: fixture画像から最低1台の車両を検出', { skip: skipUnlessModelExists || !existsSync(FIXTURE) }, async () => {
  const model = await loadModel(MODEL);
  const buf = readFileSync(FIXTURE);
  const detections = await detectVehicles(buf, model, { confidenceThreshold: 0.3 });
  assert.ok(Array.isArray(detections));
  assert.ok(detections.length >= 1, `Expected at least 1 vehicle, got ${detections.length}`);
  // 各bboxの構造を検証
  for (const d of detections) {
    assert.equal(d.bbox.length, 4);
    assert.ok(d.confidence >= 0.3);
    assert.ok(['car', 'truck'].includes(d.class));
  }
});

test('detectVehicles: confidenceで絞り込み', { skip: skipUnlessModelExists || !existsSync(FIXTURE) }, async () => {
  const model = await loadModel(MODEL);
  const buf = readFileSync(FIXTURE);
  const high = await detectVehicles(buf, model, { confidenceThreshold: 0.9 });
  const low = await detectVehicles(buf, model, { confidenceThreshold: 0.1 });
  assert.ok(low.length >= high.length);
});
```

- [ ] **Step 4: テスト失敗確認**

```bash
node --test tests/lib/vehicle-detector.test.mjs
```

- [ ] **Step 5: 実装**

`scripts/lib/vehicle-detector.mjs`:
```javascript
import * as ort from 'onnxruntime-node';
import { Jimp } from 'jimp';

const INPUT_SIZE = 640;
const COCO_CAR_CLASS = 2;
const COCO_TRUCK_CLASS = 7;
const TARGET_CLASSES = { 2: 'car', 7: 'truck' };

export async function loadModel(modelPath) {
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu']
  });
  return session;
}

// 画像を 640x640 にリサイズ + パディング (letterbox)
async function preprocess(buffer) {
  const img = await Jimp.read(buffer);
  const { width, height } = img.bitmap;
  const scale = Math.min(INPUT_SIZE / width, INPUT_SIZE / height);
  const newW = Math.round(width * scale);
  const newH = Math.round(height * scale);
  img.resize({ w: newW, h: newH });

  // 640x640 のキャンバスに中央配置
  const canvas = new Jimp({ width: INPUT_SIZE, height: INPUT_SIZE, color: 0x727272ff });
  const padX = Math.floor((INPUT_SIZE - newW) / 2);
  const padY = Math.floor((INPUT_SIZE - newH) / 2);
  canvas.composite(img, padX, padY);

  // RGB float32 [0, 1] に正規化、CHW 順
  const data = canvas.bitmap.data;
  const float32 = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  for (let y = 0; y < INPUT_SIZE; y++) {
    for (let x = 0; x < INPUT_SIZE; x++) {
      const srcIdx = (y * INPUT_SIZE + x) * 4;
      const r = data[srcIdx] / 255;
      const g = data[srcIdx + 1] / 255;
      const b = data[srcIdx + 2] / 255;
      float32[0 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = r;
      float32[1 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = g;
      float32[2 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = b;
    }
  }
  return { tensor: float32, origWidth: width, origHeight: height, scale, padX, padY };
}

function nms(boxes, iouThreshold = 0.5) {
  // boxes: [{ bbox, confidence, class }, ...]
  // 降順ソート
  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  while (sorted.length > 0) {
    const top = sorted.shift();
    kept.push(top);
    for (let i = sorted.length - 1; i >= 0; i--) {
      // IoU 計算
      const [ax, ay, aw, ah] = top.bbox;
      const [bx, by, bw, bh] = sorted[i].bbox;
      const x1 = Math.max(ax, bx);
      const y1 = Math.max(ay, by);
      const x2 = Math.min(ax + aw, bx + bw);
      const y2 = Math.min(ay + ah, by + bh);
      if (x2 > x1 && y2 > y1) {
        const inter = (x2 - x1) * (y2 - y1);
        const u = aw * ah + bw * bh - inter;
        if (inter / u >= iouThreshold) sorted.splice(i, 1);
      }
    }
  }
  return kept;
}

export async function detectVehicles(buffer, model, opts = {}) {
  const confidenceThreshold = opts.confidenceThreshold ?? 0.4;
  const { tensor, origWidth, origHeight, scale, padX, padY } = await preprocess(buffer);
  const inputTensor = new ort.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const inputName = model.inputNames[0];
  const outputs = await model.run({ [inputName]: inputTensor });
  const outputName = model.outputNames[0];
  const output = outputs[outputName]; // shape [1, 84, 8400]
  const data = output.data; // Float32Array length = 84 * 8400
  const numAnchors = 8400;

  const candidates = [];
  for (let i = 0; i < numAnchors; i++) {
    // bbox: data[0*numAnchors + i] .. data[3*numAnchors + i]
    const cx = data[0 * numAnchors + i];
    const cy = data[1 * numAnchors + i];
    const w = data[2 * numAnchors + i];
    const h = data[3 * numAnchors + i];
    // 各クラスの確信度を確認 (car=2, truck=7)
    for (const classId of [COCO_CAR_CLASS, COCO_TRUCK_CLASS]) {
      const conf = data[(4 + classId) * numAnchors + i];
      if (conf < confidenceThreshold) continue;
      // 元画像座標に変換
      const x = (cx - w / 2 - padX) / scale;
      const y = (cy - h / 2 - padY) / scale;
      const bw = w / scale;
      const bh = h / scale;
      // 範囲外は除外
      if (x < 0 || y < 0 || x + bw > origWidth || y + bh > origHeight) continue;
      candidates.push({
        bbox: [Math.round(x), Math.round(y), Math.round(bw), Math.round(bh)],
        confidence: conf,
        class: TARGET_CLASSES[classId]
      });
    }
  }

  return nms(candidates, 0.5);
}
```

- [ ] **Step 6: テスト通過確認**

```bash
node --test tests/lib/vehicle-detector.test.mjs
```
Expected: PASS (3 tests, or all skip if model未取得)

- [ ] **Step 7: コミット**

```bash
git add scripts/lib/vehicle-detector.mjs tests/lib/vehicle-detector.test.mjs tests/fixtures/observation/sample-real01.jpg tests/fixtures/observation/sample-real02.jpg
git commit -m "feat(observation): add YOLOv8n vehicle detector"
```

---

## Task 7: 検出デバッグツール（実画像にbbox描画して目視確認）

**Files:**
- Create: `scripts/debug-detect-overlay.mjs`

このツールはROI定義 (Task 8) で使う。実画像を YOLOで処理し、bboxを描画したPNGを出力する。

- [ ] **Step 1: デバッグスクリプト作成**

`scripts/debug-detect-overlay.mjs`:
```javascript
#!/usr/bin/env node
/**
 * 使い方: node scripts/debug-detect-overlay.mjs <input.jpg> <output.png>
 * 例: node scripts/debug-detect-overlay.mjs tests/fixtures/observation/sample-real01.jpg /tmp/real01-bbox.png
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Jimp, JimpMime } from 'jimp';
import { detectVehicles, loadModel } from './lib/vehicle-detector.mjs';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/debug-detect-overlay.mjs <input.jpg> <output.png>');
  process.exit(1);
}

const model = await loadModel('./models/yolov8n.onnx');
const buf = readFileSync(inputPath);
const detections = await detectVehicles(buf, model, { confidenceThreshold: 0.3 });
console.log(`Detected ${detections.length} vehicles:`);
for (const d of detections) {
  console.log(`  ${d.class} conf=${d.confidence.toFixed(2)} bbox=[${d.bbox.join(', ')}]`);
}

const img = await Jimp.read(buf);
// 各bboxを赤線で描画
for (const d of detections) {
  const [x, y, w, h] = d.bbox;
  for (let i = 0; i < w; i++) {
    img.setPixelColor(0xff0000ff, x + i, y);
    img.setPixelColor(0xff0000ff, x + i, y + h - 1);
  }
  for (let j = 0; j < h; j++) {
    img.setPixelColor(0xff0000ff, x, y + j);
    img.setPixelColor(0xff0000ff, x + w - 1, y + j);
  }
}
const outBuf = await img.getBuffer(JimpMime.png);
writeFileSync(outputPath, outBuf);
console.log(`Wrote ${outputPath}`);
```

- [ ] **Step 2: 動作確認**

```bash
node scripts/debug-detect-overlay.mjs tests/fixtures/observation/sample-real01.jpg /tmp/real01-bbox.png
open /tmp/real01-bbox.png
```

画像が開き、検出された車両に赤枠が表示されることを確認。

- [ ] **Step 3: コミット**

```bash
git add scripts/debug-detect-overlay.mjs
git commit -m "tools(observation): add detection overlay debug script"
```

---

# Phase 1C: ROI 手動定義

## Task 8: data/lane-roi.json を手動定義

**Files:**
- Create: `data/lane-roi.json`
- Create: `scripts/debug-lane-overlay.mjs`

これは**手動作業**。Real01/Real02 の画像を見ながら、4乗り場×レーンの polygon を定義する。

- [ ] **Step 1: lane overlay デバッグスクリプト作成**

`scripts/debug-lane-overlay.mjs`:
```javascript
#!/usr/bin/env node
/**
 * 使い方: node scripts/debug-lane-overlay.mjs <input.jpg> <lane-roi.json> <camera> <output.png>
 * 例: node scripts/debug-lane-overlay.mjs tests/fixtures/observation/sample-real01.jpg data/lane-roi.json real01_line /tmp/real01-lanes.png
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Jimp, JimpMime } from 'jimp';

const [, , imgPath, configPath, camera, outputPath] = process.argv;
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const img = await Jimp.read(imgPath);

function drawPolygon(image, polygon, color) {
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
    for (let t = 0; t <= steps; t++) {
      const x = Math.round(x1 + (x2 - x1) * t / steps);
      const y = Math.round(y1 + (y2 - y1) * t / steps);
      if (x >= 0 && y >= 0 && x < image.bitmap.width && y < image.bitmap.height) {
        image.setPixelColor(color, x, y);
      }
    }
  }
}

for (const lane of config.lanes) {
  if (lane.camera !== camera) continue;
  drawPolygon(img, lane.polygon, 0x00ff00ff); // 緑 = polygon
  drawPolygon(img, lane.front_row_polygon, 0x0000ffff); // 青 = front_row
}
const out = await img.getBuffer(JimpMime.png);
writeFileSync(outputPath, out);
console.log(`Wrote ${outputPath}`);
```

- [ ] **Step 2: lane-roi.json の初期テンプレートを作成**

`data/lane-roi.json` (初期版、座標は後で手動修正):
```json
{
  "_meta": {
    "image_size": { "real01_line": [800, 600], "real02": [800, 600] },
    "updated": "2026-05-12",
    "note": "polygon は画像座標系。Real01_line で第一〜第四先頭、Real02 で第四続き。神奈川レーンは除外。"
  },
  "lanes": [
    {
      "id": "第一-一般",
      "terminal": "T1",
      "camera": "real01_line",
      "polygon": [[50, 300], [180, 300], [200, 560], [40, 560]],
      "front_row_polygon": [[50, 530], [200, 530], [200, 560], [40, 560]]
    },
    {
      "id": "第一-おもてなし",
      "terminal": "T1",
      "camera": "real01_line",
      "polygon": [[190, 300], [280, 300], [300, 560], [200, 560]],
      "front_row_polygon": [[190, 530], [300, 530], [300, 560], [200, 560]]
    },
    {
      "id": "第二-一般",
      "terminal": "T1",
      "camera": "real01_line",
      "polygon": [[290, 300], [380, 300], [400, 560], [300, 560]],
      "front_row_polygon": [[290, 530], [400, 530], [400, 560], [300, 560]]
    },
    {
      "id": "第二-おもてなし",
      "terminal": "T1",
      "camera": "real01_line",
      "polygon": [[390, 300], [470, 300], [490, 560], [400, 560]],
      "front_row_polygon": [[390, 530], [490, 530], [490, 560], [400, 560]]
    },
    {
      "id": "第三-一般",
      "terminal": "T2",
      "camera": "real01_line",
      "polygon": [[480, 300], [580, 300], [600, 560], [490, 560]],
      "front_row_polygon": [[480, 530], [600, 530], [600, 560], [490, 560]]
    },
    {
      "id": "第三-おもてなし",
      "terminal": "T2",
      "camera": "real01_line",
      "polygon": [[590, 300], [690, 300], [710, 560], [600, 560]],
      "front_row_polygon": [[590, 530], [710, 530], [710, 560], [600, 560]]
    },
    {
      "id": "第四-一般-先頭",
      "terminal": "T2",
      "camera": "real01_line",
      "polygon": [[700, 300], [790, 300], [799, 560], [710, 560]],
      "front_row_polygon": [[700, 530], [799, 530], [799, 560], [710, 560]]
    },
    {
      "id": "第四-一般-続き",
      "terminal": "T2",
      "camera": "real02",
      "polygon": [[0, 200], [200, 200], [200, 500], [0, 500]],
      "front_row_polygon": [[0, 470], [200, 470], [200, 500], [0, 500]]
    },
    {
      "id": "第四-おもてなし",
      "terminal": "T2",
      "camera": "real02",
      "polygon": [[210, 200], [410, 200], [410, 500], [210, 500]],
      "front_row_polygon": [[210, 470], [410, 470], [410, 500], [210, 500]]
    }
  ]
}
```

- [ ] **Step 3: 初期版 lane-overlay を生成してユーザー確認**

```bash
node scripts/debug-lane-overlay.mjs tests/fixtures/observation/sample-real01.jpg data/lane-roi.json real01_line /tmp/real01-lanes.png
node scripts/debug-lane-overlay.mjs tests/fixtures/observation/sample-real02.jpg data/lane-roi.json real02 /tmp/real02-lanes.png
open /tmp/real01-lanes.png /tmp/real02-lanes.png
```

ユーザーに表示画像を見せ、各 polygon が正しく乗り場領域を囲っているか確認。ずれていれば `data/lane-roi.json` を手動修正して Step 3 を再実行（反復）。

- [ ] **Step 4: 検出 + lane assign 統合テストでROI妥当性確認**

短いインラインスクリプトで確認:
```bash
node -e "
import('./scripts/lib/vehicle-detector.mjs').then(async ({detectVehicles, loadModel}) => {
  const {assignLane} = await import('./scripts/lib/lane-roi.mjs');
  const fs = await import('node:fs');
  const config = JSON.parse(fs.readFileSync('data/lane-roi.json'));
  const model = await loadModel('models/yolov8n.onnx');
  const buf = fs.readFileSync('tests/fixtures/observation/sample-real01.jpg');
  const detections = await detectVehicles(buf, model, {confidenceThreshold: 0.3});
  for (const d of detections) {
    const r = assignLane(d.bbox, 'real01_line', config);
    console.log(\`bbox=[\${d.bbox.join(',')}] → lane=\${r.lane} front_row=\${r.front_row}\`);
  }
});
"
```

各 detection の lane が `null` でなく合理的に分布していること（多数の車両が `第一-一般`〜`第四-` のいずれかに入る）を目視確認。

- [ ] **Step 5: 確定版をコミット**

```bash
git add data/lane-roi.json scripts/debug-lane-overlay.mjs
git commit -m "feat(observation): define lane ROI polygons for 4 taxi stops"
```

---

# Phase 1D: observe-taxi-pool 拡張 + launchd

## Task 9: observe-taxi-pool.mjs を schema v3 に拡張

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`
- Create: `tests/observe-taxi-pool-integration.test.mjs`

- [ ] **Step 1: 統合テスト作成（モック画像 + モックYOLO）**

`tests/observe-taxi-pool-integration.test.mjs`:
```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { processTick } from '../scripts/observe-taxi-pool.mjs';

test('processTick: schema v3 のフィールドを全て含む', async () => {
  const mockFetch = async () => Buffer.from('mock');
  const mockAnalyze = async () => ({ sha256: 'x', size_bytes: 1, black_ratio: 0.1, diff_from_prev: null, roi: { edge_density: 0.5, luminance_mean: 100, luminance_std: 10, roi_black_ratio: 0.2 } });
  const mockDetect = async () => [{ bbox: [120, 480, 50, 50], confidence: 0.9, class: 'car' }];
  const mockTrackerState = { vehicles: {}, nextId: 1, tick: 0 };

  const laneConfig = {
    lanes: [
      { id: '第一-一般', terminal: 'T1', camera: 'real01_line',
        polygon: [[100, 470], [200, 470], [200, 540], [100, 540]],
        front_row_polygon: [[100, 470], [200, 470], [200, 540], [100, 540]] }
    ]
  };

  const result = await processTick({
    ts: '2026-05-12T15:30:00+09:00',
    tickSeq: 1,
    fetchImage: mockFetch,
    analyzeImage: mockAnalyze,
    detectVehicles: mockDetect,
    laneConfig,
    trackerState: mockTrackerState,
    previousTracks: [],
    arrivalsState: null,
    arrivalsWindow: null,
    weather: null,
    prev1: null, prev2: null,
    roi1: null, roi2: null
  });

  assert.equal(result.row.schema_version, 3);
  assert.equal(result.row.tick_seq, 1);
  assert.ok(result.row.img1);
  assert.ok(result.row.img2);
  assert.ok(result.row.vehicles);
  assert.ok(Array.isArray(result.row.departures));
  assert.ok(result.row.lane_state);
});

test('processTick: 出庫イベントを正しく検出', async () => {
  // 前tickで第一-一般 front_row にいた車両が今tickで消える → 出庫
  const previousTracks = [
    { id: 100, bbox: [120, 480, 50, 50], lane: '第一-一般', front_row: true }
  ];
  const mockFetch = async () => Buffer.from('mock');
  const mockAnalyze = async () => ({ sha256: 'x', size_bytes: 1, black_ratio: 0, diff_from_prev: null, roi: null });
  // 今tick で車両ゼロ
  const mockDetect = async () => [];
  const trackerState = { vehicles: { 100: { bbox: [120, 480, 50, 50], age: 5, last_seen_tick: 0 } }, nextId: 101, tick: 0 };

  const laneConfig = {
    lanes: [{ id: '第一-一般', terminal: 'T1', camera: 'real01_line',
      polygon: [[100, 470], [200, 470], [200, 540], [100, 540]],
      front_row_polygon: [[100, 470], [200, 470], [200, 540], [100, 540]] }]
  };

  // tick を進めて lost が確定するまで 2回呼ぶ必要があるが、簡易テストとして1回で
  // 確実にlostになるよう trackerStateを操作 (last_seen_tick を古くする)
  trackerState.vehicles[100].last_seen_tick = -5;

  const result = await processTick({
    ts: '2026-05-12T15:30:00+09:00',
    tickSeq: 1,
    fetchImage: mockFetch,
    analyzeImage: mockAnalyze,
    detectVehicles: mockDetect,
    laneConfig,
    trackerState,
    previousTracks,
    arrivalsState: null, arrivalsWindow: null, weather: null,
    prev1: null, prev2: null, roi1: null, roi2: null
  });

  assert.equal(result.row.departures.length, 1);
  assert.equal(result.row.departures[0].lane, '第一-一般');
  assert.equal(result.row.departures[0].vehicle_id, 100);
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
node --test tests/observe-taxi-pool-integration.test.mjs
```

- [ ] **Step 3: observe-taxi-pool.mjs を リファクタリング (processTick を export)**

既存ロジックを `processTick` という純関数として export し、副作用（fetch / readFile / writeFile）を opts で注入できる構造に。

`scripts/observe-taxi-pool.mjs` を以下に書き換え:
```javascript
#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { analyzePoolImage } from './lib/image-pool-analyzer.mjs';
import { summarizeArrivalsWindow } from './lib/arrivals-window-summary.mjs';
import { detectVehicles, loadModel } from './lib/vehicle-detector.mjs';
import { updateTracker, createEmptyState } from './lib/vehicle-tracker.mjs';
import { assignLane } from './lib/lane-roi.mjs';
import { detectDepartures } from './lib/departure-detector.mjs';

const REAL01_URL = 'https://ttc.taxi-inf.jp/Real01_line.jpg';
const REAL02_URL = 'https://ttc.taxi-inf.jp/Real02.jpg';
const USER_AGENT = 'taxi-ic-helper observation bot (https://github.com/hidenaka/taxi-ic-helper)';
const HISTORY_PATH = './data/taxi-pool-history.jsonl';
const TRACKER_STATE_PATH = './data/.tracker-state.json';
const ROI_CONFIG_PATH = './scripts/lib/roi-config.json';
const LANE_CONFIG_PATH = './data/lane-roi.json';
const MODEL_PATH = './models/yolov8n.onnx';
const TIMEOUT_MS = 15000;
const SCHEMA_VERSION = 3;

function jstNowIso() {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

async function fetchImage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function readLastRow() {
  if (!existsSync(HISTORY_PATH)) return null;
  const txt = readFileSync(HISTORY_PATH, 'utf8').trim();
  if (!txt) return null;
  const lines = txt.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    try { return JSON.parse(lines[i]); } catch { continue; }
  }
  return null;
}

function readTrackerState() {
  if (!existsSync(TRACKER_STATE_PATH)) return null;
  try { return JSON.parse(readFileSync(TRACKER_STATE_PATH, 'utf8')); }
  catch { return null; }
}

function writeTrackerState(state) {
  writeFileSync(TRACKER_STATE_PATH, JSON.stringify(state));
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// 純関数: tick処理ロジック (テスト可能)
export async function processTick(opts) {
  const {
    ts, tickSeq,
    fetchImage, analyzeImage, detectVehicles,
    laneConfig,
    trackerState1, trackerState2,
    previousTracks1, previousTracks2,
    arrivalsState, arrivalsWindow, weather,
    prev1, prev2, roi1, roi2,
    model
  } = opts;

  // 既存 schema v2 互換: 画像取得 + analyzePoolImage
  let buf1, buf2;
  try {
    [buf1, buf2] = await Promise.all([fetchImage(REAL01_URL), fetchImage(REAL02_URL)]);
  } catch (e) {
    throw new Error(`image fetch failed: ${e.message}`);
  }

  const img1 = await analyzeImage(buf1, prev1, roi1);
  const img2 = await analyzeImage(buf2, prev2, roi2);

  // 新規 schema v3: YOLO + Tracker + Lane + Departure
  let vehicles1 = [], vehicles2 = [], departures = [];
  let newTrackerState1 = trackerState1, newTrackerState2 = trackerState2;
  let trackedWithLane1 = [], trackedWithLane2 = [];
  try {
    const detections1 = await detectVehicles(buf1, model, { confidenceThreshold: 0.4 });
    const detections2 = await detectVehicles(buf2, model, { confidenceThreshold: 0.4 });
    const trackUpdate1 = updateTracker(trackerState1, detections1.map(d => d.bbox));
    const trackUpdate2 = updateTracker(trackerState2, detections2.map(d => d.bbox));
    newTrackerState1 = trackUpdate1.state;
    newTrackerState2 = trackUpdate2.state;
    trackedWithLane1 = trackUpdate1.tracked.map(t => ({
      ...t, ...assignLane(t.bbox, 'real01_line', laneConfig)
    }));
    trackedWithLane2 = trackUpdate2.tracked.map(t => ({
      ...t, ...assignLane(t.bbox, 'real02', laneConfig)
    }));
    vehicles1 = trackedWithLane1;
    vehicles2 = trackedWithLane2;
    const dep1 = detectDepartures(previousTracks1, trackedWithLane1, trackUpdate1.lost, ts);
    const dep2 = detectDepartures(previousTracks2, trackedWithLane2, trackUpdate2.lost, ts);
    departures = [
      ...dep1.map(e => ({ ...e, terminal: laneConfig.lanes.find(l => l.id === e.lane)?.terminal })),
      ...dep2.map(e => ({ ...e, terminal: laneConfig.lanes.find(l => l.id === e.lane)?.terminal }))
    ];
  } catch (e) {
    console.error(`[observe] YOLO/track failed: ${e.message}`);
  }

  // lane_state を計算
  const laneState = {};
  for (const lane of laneConfig.lanes) {
    const cameraVehicles = lane.camera === 'real01_line' ? vehicles1 : vehicles2;
    const inLane = cameraVehicles.filter(v => v.lane === lane.id);
    const frontRow = inLane.some(v => v.front_row);
    laneState[lane.id] = { queue_count: inLane.length, front_row_occupied: frontRow };
  }

  return {
    row: {
      schema_version: SCHEMA_VERSION,
      ts,
      tick_seq: tickSeq,
      img1: { name: 'Real01_line', ...img1 },
      img2: { name: 'Real02', ...img2 },
      arrivals_state: arrivalsState,
      arrivals_window: arrivalsWindow,
      weather,
      vehicles: { real01_line: vehicles1, real02: vehicles2 },
      departures,
      lane_state: laneState
    },
    newTrackerState1,
    newTrackerState2,
    trackedWithLane1,
    trackedWithLane2
  };
}

// CLI エントリ
async function main() {
  const ts = jstNowIso();
  const lastRow = readLastRow();
  const tickSeq = (lastRow?.tick_seq ?? 0) + 1;
  const roiConfig = readJson(ROI_CONFIG_PATH);
  const laneConfig = readJson(LANE_CONFIG_PATH);
  if (!laneConfig) { console.error('[observe] lane-roi.json missing'); process.exit(1); }

  // モデルロード（プロセス起動ごとに1回）
  let model;
  try {
    model = await loadModel(MODEL_PATH);
  } catch (e) {
    console.error(`[observe] YOLO model load failed: ${e.message}. Continuing with schema v2 fields only.`);
    model = null;
  }

  // トラッカー状態を読み込み
  const trackerStateSaved = readTrackerState();
  const trackerState1 = trackerStateSaved?.real01_line ?? createEmptyState();
  const trackerState2 = trackerStateSaved?.real02 ?? createEmptyState();
  const previousTracks1 = lastRow?.vehicles?.real01_line ?? [];
  const previousTracks2 = lastRow?.vehicles?.real02 ?? [];

  // arrivals/weather
  const arrivalsJson = readJson('./data/arrivals.json');
  const arrivalsState = arrivalsJson ? {
    updated_at: arrivalsJson.updatedAt ?? null,
    total_estimated_taxi_pax: arrivalsJson.stats?.totalEstimatedTaxiPax ?? null,
    lag_seconds: arrivalsJson.updatedAt ? Math.floor((Date.now() - new Date(arrivalsJson.updatedAt).getTime()) / 1000) : null
  } : null;
  const arrivalsWindow = arrivalsJson ? summarizeArrivalsWindow(arrivalsJson, new Date()) : null;
  const weatherJson = readJson('./data/weather.json');
  const weather = weatherJson ? {
    code: weatherJson.current?.weatherCode ?? null,
    lightning_active: !!weatherJson.current?.lightningActive
  } : null;

  try {
    const { row, newTrackerState1, newTrackerState2 } = await processTick({
      ts, tickSeq,
      fetchImage,
      analyzeImage: analyzePoolImage,
      detectVehicles: model ? detectVehicles : async () => [],
      laneConfig,
      trackerState1, trackerState2,
      previousTracks1, previousTracks2,
      arrivalsState, arrivalsWindow, weather,
      prev1: lastRow?.img1 ?? null, prev2: lastRow?.img2 ?? null,
      roi1: roiConfig?.real01_line ?? null, roi2: roiConfig?.real02 ?? null,
      model
    });

    appendFileSync(HISTORY_PATH, JSON.stringify(row) + '\n', 'utf8');
    writeTrackerState({ real01_line: newTrackerState1, real02: newTrackerState2 });
    console.log(`[observe] appended tick_seq=${tickSeq} ts=${ts} (schema_version=${SCHEMA_VERSION}) vehicles=${row.vehicles.real01_line.length + row.vehicles.real02.length} departures=${row.departures.length}`);
  } catch (e) {
    console.error(`[observe] ${e.message}`);
    process.exit(0); // skip
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: テスト通過確認**

```bash
node --test tests/observe-taxi-pool-integration.test.mjs
```
Expected: PASS (2 tests)

- [ ] **Step 5: 全テスト通過確認**

```bash
node --test
```
Expected: 全PASS、既存テストも壊れていないこと

- [ ] **Step 6: ローカルで実行**

```bash
node scripts/observe-taxi-pool.mjs
tail -1 data/taxi-pool-history.jsonl | jq .
```
Expected: `schema_version: 3`, `vehicles`, `departures`, `lane_state` フィールドが存在すること

- [ ] **Step 7: コミット**

```bash
git add scripts/observe-taxi-pool.mjs tests/observe-taxi-pool-integration.test.mjs
git commit -m "feat(observation): extend observe-taxi-pool to schema v3 with YOLO+ByteTrack"
```

---

## Task 10: launchd cron を 15分→1分に変更

**Files:**
- Modify: `scripts/install-observe-launchd.sh`

- [ ] **Step 1: 既存 install-observe-launchd.sh の StartInterval を確認**

```bash
grep -A2 'StartInterval' scripts/install-observe-launchd.sh
```
Expected: 既存値が `900`（15分）であることを確認

- [ ] **Step 2: StartInterval を 60 に変更**

`scripts/install-observe-launchd.sh` の plist テンプレート部分を編集（既存ファイル内で `900` を `60` に置換）:
```bash
sed -i.bak 's/<integer>900<\/integer>/<integer>60<\/integer>/' scripts/install-observe-launchd.sh
rm scripts/install-observe-launchd.sh.bak
grep -A2 'StartInterval' scripts/install-observe-launchd.sh
```
Expected: `<integer>60</integer>` に変わったこと

- [ ] **Step 3: 既存ジョブを再インストール**

```bash
./scripts/install-observe-launchd.sh uninstall
./scripts/install-observe-launchd.sh install
./scripts/install-observe-launchd.sh status
```

- [ ] **Step 4: 数分待って実行ログ確認**

```bash
ls -la data/taxi-pool-history.jsonl
tail -3 data/taxi-pool-history.jsonl | jq '.tick_seq, .ts'
```
Expected: 1分間隔で tick が追記されていること

- [ ] **Step 5: コミット**

```bash
git add scripts/install-observe-launchd.sh
git commit -m "chore(observation): change observe-taxi-pool interval from 15min to 1min"
```

---

## Task 11: 1週間連続稼働 + 健全性チェック

**Files:** なし（観測 + 検証のみ）

- [ ] **Step 1: 観測開始日時を記録**

```bash
date '+%Y-%m-%dT%H:%M:%S%z' > /tmp/observation-start.txt
cat /tmp/observation-start.txt
```

- [ ] **Step 2: 24時間後にカバレッジ確認**

```bash
COUNT=$(grep -c '"schema_version":3' data/taxi-pool-history.jsonl)
echo "schema v3 ticks accumulated: $COUNT (expected ~1440 per 24h)"
```
Expected: 約1000以上のtick（多少欠損あっても許容）

- [ ] **Step 3: ttc.taxi-inf.jp 遮断有無を確認**

```bash
grep -c 'image fetch failed' .local/observe.log 2>/dev/null || echo "no log file"
# fetch失敗が連続100回以上なら遮断の可能性
```

- [ ] **Step 4: 出庫イベント発生レートを確認**

```bash
node -e "
const lines = require('fs').readFileSync('data/taxi-pool-history.jsonl', 'utf8').trim().split('\n');
const v3 = lines.map(JSON.parse).filter(r => r.schema_version === 3);
const totalDep = v3.reduce((s, r) => s + (r.departures?.length ?? 0), 0);
console.log('Total ticks:', v3.length);
console.log('Total departures:', totalDep);
console.log('Avg departures/tick:', (totalDep / v3.length).toFixed(2));
"
```
Expected: 平均 0.5〜3 departures/tick 程度（時間帯次第で大きく変動）

- [ ] **Step 5: 1週間後の最終確認**

```bash
# 7日後に実行
COUNT=$(grep -c '"schema_version":3' data/taxi-pool-history.jsonl)
echo "Total v3 ticks over 7 days: $COUNT (expected ~10080)"
```

- [ ] **Step 6: 検証完了マーカーをコミット**

```bash
echo "Phase 1D verified at $(date '+%Y-%m-%dT%H:%M:%S%z')" >> docs/superpowers/plans/2026-05-12-pax-observation-loopback-plan.md
git add docs/superpowers/plans/2026-05-12-pax-observation-loopback-plan.md
git commit -m "chore(observation): mark Phase 1D as verified after 7 days"
```

---

# Phase 1E: 日次キャリブレーション

## Task 12: calibrate-transit-share.mjs 純関数ロジック

**Files:**
- Create: `scripts/lib/calibration-math.mjs`
- Test: `tests/calibration-math.test.mjs`

- [ ] **Step 1: テスト作成**

`tests/calibration-math.test.mjs`:
```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { aggregateDepartures, computeUpdatedRate } from '../scripts/lib/calibration-math.mjs';

const BUCKETS = [
  { id: 'early',   fromHHMM: '07:00', toHHMM: '09:00' },
  { id: 'morning', fromHHMM: '09:00', toHHMM: '12:00' }
];

test('aggregateDepartures: 時間帯×ターミナル別に集計', () => {
  const ticks = [
    { ts: '2026-05-12T08:00:00+09:00', departures: [
      { lane: '第一-一般', terminal: 'T1' },
      { lane: '第三-一般', terminal: 'T2' }
    ]},
    { ts: '2026-05-12T08:30:00+09:00', departures: [
      { lane: '第一-一般', terminal: 'T1' }
    ]},
    { ts: '2026-05-12T10:00:00+09:00', departures: [
      { lane: '第二-一般', terminal: 'T1' }
    ]}
  ];
  const agg = aggregateDepartures(ticks, BUCKETS);
  assert.equal(agg.early.T1, 2);
  assert.equal(agg.early.T2, 1);
  assert.equal(agg.morning.T1, 1);
  assert.equal(agg.morning.T2, 0);
});

test('computeUpdatedRate: 通常更新（EMA α=0.2）', () => {
  const result = computeUpdatedRate({
    observedDepartures: 80,
    estimatedPaxTerminal: 400,
    previousRate: 0.20,
    alpha: 0.2,
    sampleCount: 100
  });
  // observed_rate = 80/400 = 0.20、previousと同じ → 変化なし
  assert.ok(Math.abs(result.newRate - 0.20) < 1e-6);
  assert.equal(result.skipped, false);
});

test('computeUpdatedRate: サンプル<50 はスキップ', () => {
  const result = computeUpdatedRate({
    observedDepartures: 5, estimatedPaxTerminal: 50,
    previousRate: 0.20, alpha: 0.2, sampleCount: 30
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'insufficient_samples');
  assert.equal(result.newRate, 0.20); // 変更なし
});

test('computeUpdatedRate: ±50%超は半分のみ反映', () => {
  const result = computeUpdatedRate({
    observedDepartures: 200, estimatedPaxTerminal: 400, // observed_rate = 0.5
    previousRate: 0.20, alpha: 0.2, sampleCount: 100
  });
  // (0.5 - 0.2) / 0.2 = 1.5 → 50%超
  // adjusted_observed = 0.2 + (0.5 - 0.2) * 0.5 = 0.35
  // new = 0.2 * 0.35 + 0.8 * 0.20 = 0.07 + 0.16 = 0.23
  assert.ok(Math.abs(result.newRate - 0.23) < 1e-6);
  assert.equal(result.warning, 'large_drift_clamped');
});

test('computeUpdatedRate: clamp [0.01, 0.95]', () => {
  // observed_rate = 100, EMA で 0.2*100 + 0.8*0.2 = 20.16 → clamp 0.95
  const result = computeUpdatedRate({
    observedDepartures: 1000, estimatedPaxTerminal: 10,
    previousRate: 0.2, alpha: 0.2, sampleCount: 100
  });
  assert.equal(result.newRate, 0.95);
});
```

- [ ] **Step 2: テスト失敗確認**

```bash
node --test tests/calibration-math.test.mjs
```

- [ ] **Step 3: 実装**

`scripts/lib/calibration-math.mjs`:
```javascript
function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function tsToBucketId(ts, buckets) {
  const d = new Date(ts);
  const jst = new Date(d.getTime() + (9 * 60 - d.getTimezoneOffset()) * 60 * 1000);
  const minutes = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  for (const b of buckets) {
    const from = hhmmToMinutes(b.fromHHMM);
    const to = b.toHHMM === '24:00' ? 1440 : hhmmToMinutes(b.toHHMM);
    if (minutes >= from && minutes < to) return b.id;
  }
  return null;
}

export function aggregateDepartures(ticks, buckets) {
  const result = {};
  for (const b of buckets) result[b.id] = { T1: 0, T2: 0 };
  for (const tick of ticks) {
    const bucketId = tsToBucketId(tick.ts, buckets);
    if (!bucketId) continue;
    for (const dep of tick.departures ?? []) {
      if (dep.terminal === 'T1') result[bucketId].T1++;
      else if (dep.terminal === 'T2') result[bucketId].T2++;
    }
  }
  return result;
}

const MIN_SAMPLES = 50;
const DRIFT_THRESHOLD = 0.5;
const RATE_MIN = 0.01;
const RATE_MAX = 0.95;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function computeUpdatedRate({ observedDepartures, estimatedPaxTerminal, previousRate, alpha, sampleCount }) {
  if (sampleCount < MIN_SAMPLES) {
    return { newRate: previousRate, skipped: true, reason: 'insufficient_samples' };
  }
  if (estimatedPaxTerminal === 0) {
    return { newRate: previousRate, skipped: true, reason: 'zero_denominator' };
  }
  let observedRate = observedDepartures / estimatedPaxTerminal;
  let warning = null;
  const drift = Math.abs(observedRate - previousRate) / previousRate;
  if (drift > DRIFT_THRESHOLD) {
    observedRate = previousRate + (observedRate - previousRate) * 0.5;
    warning = 'large_drift_clamped';
  }
  const newRate = clamp(alpha * observedRate + (1 - alpha) * previousRate, RATE_MIN, RATE_MAX);
  return { newRate, skipped: false, warning };
}
```

- [ ] **Step 4: テスト通過確認**

```bash
node --test tests/calibration-math.test.mjs
```
Expected: PASS (5 tests)

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/calibration-math.mjs tests/calibration-math.test.mjs
git commit -m "feat(calibration): add aggregation and EMA update math"
```

---

## Task 13: calibrate-transit-share.mjs エントリポイント

**Files:**
- Create: `scripts/calibrate-transit-share.mjs`
- Test: `tests/calibrate-transit-share.test.mjs`
- Create: `tests/fixtures/observation/history-14days.jsonl`

- [ ] **Step 1: fixture jsonl を生成**

```bash
node -e "
const fs = require('fs');
const lines = [];
const start = new Date('2026-04-28T07:00:00+09:00');
for (let day = 0; day < 14; day++) {
  for (let h = 7; h < 22; h++) {
    for (let m = 0; m < 60; m++) {
      const ts = new Date(start.getTime() + (day*24 + (h-7))*3600*1000 + m*60*1000).toISOString();
      const tickSeq = day * 900 + (h-7)*60 + m;
      const departures = [];
      // T1: 平均0.5/tick, T2: 平均0.4/tick
      if (Math.random() < 0.5) departures.push({lane:'第一-一般', terminal:'T1'});
      if (Math.random() < 0.4) departures.push({lane:'第三-一般', terminal:'T2'});
      const taxi_pax_sum = 30 + Math.floor(Math.random() * 60);
      lines.push(JSON.stringify({
        schema_version: 3,
        ts,
        tick_seq: tickSeq,
        departures,
        arrivals_window: { flight_count: 5, estimated_taxi_pax_sum: taxi_pax_sum }
      }));
    }
  }
}
fs.writeFileSync('tests/fixtures/observation/history-14days.jsonl', lines.join('\n') + '\n');
console.log('Wrote', lines.length, 'lines');
"
```

- [ ] **Step 2: テスト作成**

`tests/calibrate-transit-share.test.mjs`:
```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { calibrate } from '../scripts/calibrate-transit-share.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures/observation/history-14days.jsonl');

const TRANSIT_SHARE = {
  _meta: { source: 'test' },
  buckets: [
    { id: 'early', fromHHMM: '07:00', toHHMM: '09:00', rates: { T1: 0.08, T2: 0.08, T3: 0.10 } },
    { id: 'morning', fromHHMM: '09:00', toHHMM: '12:00', rates: { T1: 0.11, T2: 0.11, T3: 0.12 } },
    { id: 'noon', fromHHMM: '12:00', toHHMM: '15:00', rates: { T1: 0.14, T2: 0.14, T3: 0.16 } },
    { id: 'afternoon', fromHHMM: '15:00', toHHMM: '17:00', rates: { T1: 0.18, T2: 0.18, T3: 0.20 } },
    { id: 'peak1', fromHHMM: '17:00', toHHMM: '19:00', rates: { T1: 0.24, T2: 0.24, T3: 0.22 } },
    { id: 'evening', fromHHMM: '19:00', toHHMM: '21:30', rates: { T1: 0.14, T2: 0.14, T3: 0.18 } },
    { id: 'peak2', fromHHMM: '21:30', toHHMM: '24:00', rates: { T1: 0.32, T2: 0.32, T3: 0.32 } },
    { id: 'midnight', fromHHMM: '24:00', toHHMM: '27:00', rates: { T1: 0.30, T2: 0.30, T3: 0.30 } }
  ]
};

test('calibrate: T3は変更されない', () => {
  const ticks = readFileSync(FIXTURE, 'utf8').trim().split('\n').map(JSON.parse);
  const result = calibrate(ticks, TRANSIT_SHARE, { alpha: 0.2 });
  for (const b of result.buckets) {
    const orig = TRANSIT_SHARE.buckets.find(x => x.id === b.id);
    assert.equal(b.rates.T3, orig.rates.T3);
  }
});

test('calibrate: 出庫イベントのある時間帯は rates が更新される', () => {
  const ticks = readFileSync(FIXTURE, 'utf8').trim().split('\n').map(JSON.parse);
  const result = calibrate(ticks, TRANSIT_SHARE, { alpha: 0.2 });
  // morning bucket (9-12時) は fixture 内で十分サンプル → 更新されているはず
  const morning = result.buckets.find(b => b.id === 'morning');
  const origMorning = TRANSIT_SHARE.buckets.find(b => b.id === 'morning');
  // T1かT2の少なくとも片方が変化していること
  const changed = morning.rates.T1 !== origMorning.rates.T1 || morning.rates.T2 !== origMorning.rates.T2;
  assert.ok(changed, `morning.rates should change. T1: ${origMorning.rates.T1}→${morning.rates.T1}, T2: ${origMorning.rates.T2}→${morning.rates.T2}`);
});

test('calibrate: _meta.calibratedAt が追加される', () => {
  const ticks = readFileSync(FIXTURE, 'utf8').trim().split('\n').map(JSON.parse);
  const result = calibrate(ticks, TRANSIT_SHARE, { alpha: 0.2 });
  assert.ok(result._meta.calibratedAt);
});
```

- [ ] **Step 3: テスト失敗確認**

```bash
node --test tests/calibrate-transit-share.test.mjs
```

- [ ] **Step 4: 実装**

`scripts/calibrate-transit-share.mjs`:
```javascript
#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { aggregateDepartures, computeUpdatedRate } from './lib/calibration-math.mjs';

const HISTORY_PATH = './data/taxi-pool-history.jsonl';
const TRANSIT_SHARE_PATH = './data/transit-share.json';
const DEFAULT_ALPHA = 0.2;
const PAST_DAYS = 14;

function jstIsoNow() {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

function aggregateEstimatedPax(ticks, buckets) {
  // arrivals_window.estimated_taxi_pax_sum を bucket 別に集計
  // この値は既存 transit-share で計算済みの「タクシー客見積もり合計」なので、
  // 既存 transit-share の平均rateで割り戻して全降客 estimatedPax を逆算する
  const result = {};
  for (const b of buckets) result[b.id] = { taxiPaxSum: 0, sampleCount: 0 };
  for (const tick of ticks) {
    const d = new Date(tick.ts);
    const jst = new Date(d.getTime() + (9 * 60 - d.getTimezoneOffset()) * 60 * 1000);
    const minutes = jst.getUTCHours() * 60 + jst.getUTCMinutes();
    let bucketId = null;
    for (const b of buckets) {
      const [fh, fm] = b.fromHHMM.split(':').map(Number);
      const [th, tm] = b.toHHMM.split(':').map(Number);
      const from = fh * 60 + fm;
      const to = b.toHHMM === '24:00' ? 1440 : th * 60 + tm;
      if (minutes >= from && minutes < to) { bucketId = b.id; break; }
    }
    if (!bucketId) continue;
    if (tick.arrivals_window?.estimated_taxi_pax_sum != null) {
      result[bucketId].taxiPaxSum += tick.arrivals_window.estimated_taxi_pax_sum;
      result[bucketId].sampleCount += 1;
    }
  }
  return result;
}

export function calibrate(ticks, transitShare, opts = {}) {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const v3Ticks = ticks.filter(t => t.schema_version === 3);
  const departureAgg = aggregateDepartures(v3Ticks, transitShare.buckets);
  const paxAgg = aggregateEstimatedPax(v3Ticks, transitShare.buckets);

  const newBuckets = transitShare.buckets.map(b => {
    const t1Dep = departureAgg[b.id]?.T1 ?? 0;
    const t2Dep = departureAgg[b.id]?.T2 ?? 0;
    const taxiPaxSum = paxAgg[b.id]?.taxiPaxSum ?? 0;
    const sampleCount = paxAgg[b.id]?.sampleCount ?? 0;
    // taxiPaxSum を T1/T2 ratesで按分 (T3を除外)
    const prevT1 = b.rates.T1;
    const prevT2 = b.rates.T2;
    const t1Share = prevT1 / (prevT1 + prevT2);
    const t2Share = prevT2 / (prevT1 + prevT2);
    const t1EstimatedPax = taxiPaxSum * t1Share;
    const t2EstimatedPax = taxiPaxSum * t2Share;

    const t1Update = computeUpdatedRate({
      observedDepartures: t1Dep,
      estimatedPaxTerminal: t1EstimatedPax,
      previousRate: prevT1,
      alpha,
      sampleCount
    });
    const t2Update = computeUpdatedRate({
      observedDepartures: t2Dep,
      estimatedPaxTerminal: t2EstimatedPax,
      previousRate: prevT2,
      alpha,
      sampleCount
    });

    return {
      ...b,
      rates: { T1: t1Update.newRate, T2: t2Update.newRate, T3: b.rates.T3 }
    };
  });

  return {
    ...transitShare,
    _meta: {
      ...transitShare._meta,
      calibratedAt: jstIsoNow(),
      calibrationSampleDays: PAST_DAYS
    },
    buckets: newBuckets
  };
}

// CLI
async function main() {
  const transitShare = JSON.parse(readFileSync(TRANSIT_SHARE_PATH, 'utf8'));
  const historyTxt = readFileSync(HISTORY_PATH, 'utf8');
  const lines = historyTxt.trim().split('\n').filter(l => l.trim());
  const ticks = lines.map(l => JSON.parse(l));

  // 過去14日分にフィルタ
  const cutoff = Date.now() - PAST_DAYS * 24 * 3600 * 1000;
  const recent = ticks.filter(t => new Date(t.ts).getTime() >= cutoff);
  console.log(`[calibrate] processing ${recent.length} ticks from past ${PAST_DAYS} days`);

  const updated = calibrate(recent, transitShare);
  writeFileSync(TRANSIT_SHARE_PATH, JSON.stringify(updated, null, 2));
  console.log(`[calibrate] transit-share.json updated. calibratedAt=${updated._meta.calibratedAt}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 5: テスト通過確認**

```bash
node --test tests/calibrate-transit-share.test.mjs
```
Expected: PASS (3 tests)

- [ ] **Step 6: コミット**

```bash
git add scripts/calibrate-transit-share.mjs tests/calibrate-transit-share.test.mjs tests/fixtures/observation/history-14days.jsonl
git commit -m "feat(calibration): add transit-share daily EMA calibration job"
```

---

## Task 14: 本番反映 + arrivals.json 変化確認

**Files:** なし（検証 + launchd登録）

- [ ] **Step 1: 14日分の本物 observation を蓄積する間、何もしない**

Task 11 で観測スタートしてから14日経過するまで待つ。
14日に満たない場合、 Step 2 を実行してドライランで検証する。

- [ ] **Step 2: dry-run calibration（既存transit-share.jsonをバックアップしてから）**

```bash
cp data/transit-share.json /tmp/transit-share.before.json
node scripts/calibrate-transit-share.mjs
diff /tmp/transit-share.before.json data/transit-share.json | head -40
```
Expected: T1/T2 のいくつかの rate に小さな変化（α=0.2 なので大幅変化はないはず）

- [ ] **Step 3: ユーザーが補正後 rates を目視確認**

ユーザーにdiffを見せて「経験則に矛盾しないか」を確認。
ピーク帯（peak1 17-19時、peak2 21:30-24時）の T1/T2 が0.10〜0.40 の範囲か等。

矛盾している場合: alpha を下げる（0.1）、サンプル要件を上げる（100）、ガード閾値を下げる（30%）等のチューニングを Task 12 のロジックに反映。

- [ ] **Step 4: launchd 日次ジョブとして登録**

`scripts/install-calibrate-launchd.sh` を新規作成（observe-taxi-pool の install スクリプトを参考に）:
```bash
#!/bin/bash
set -e
LABEL="jp.taxi-ic-helper.calibrate-transit-share"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO/.local"

case "${1:-help}" in
  install)
    mkdir -p "$PLIST_DIR" "$LOG_DIR"
    cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>$REPO/scripts/calibrate-transit-share.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>2</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/calibrate.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/calibrate.err</string>
</dict>
</plist>
EOF
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"
    echo "Installed $LABEL (runs daily at JST 02:00)"
    ;;
  uninstall)
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "Uninstalled $LABEL"
    ;;
  status)
    launchctl list | grep "$LABEL" || echo "$LABEL: not loaded"
    ;;
  *)
    echo "Usage: $0 {install|uninstall|status}"
    ;;
esac
```

```bash
chmod +x scripts/install-calibrate-launchd.sh
./scripts/install-calibrate-launchd.sh install
./scripts/install-calibrate-launchd.sh status
```

- [ ] **Step 5: arrivals.json への反映を確認**

既存 update-arrivals.yml GitHub Actions または手動実行で fetch-arrivals.mjs を起動し、補正後の transit-share.json が反映されているか確認:
```bash
node scripts/fetch-arrivals.mjs
cat data/arrivals.json | jq '.flights[0:3] | .[] | {flightNumber, terminal, estimatedTaxiPax, taxiBaseRate}'
```
Expected: `taxiBaseRate` が補正後の値になっていること

- [ ] **Step 6: コミット + Phase 1 完了マーク**

```bash
git add scripts/install-calibrate-launchd.sh
git commit -m "chore(calibration): install daily transit-share calibration launchd job"

# README.md にPhase1完了を追記
cat >> README.md << 'EOF'

## 観測ループバック (Phase 1) — 2026-05-XX 完了

- `observe-taxi-pool.mjs` が 1分tick で動作、`taxi-pool-history.jsonl` に schema v3 で記録
- `calibrate-transit-share.mjs` が毎日 JST 02:00 に過去14日分から EMA 補正
- `transit-share.json` の T1/T2 rates は自動更新（T3は手動メンテ維持）
EOF
git add README.md
git commit -m "docs(observation): mark Phase 1 complete"
```

---

# 自己レビュー時メモ

- Phase 1A-E の各タスクは独立した自己完結ファイルを生む
- 各タスクは TDD (テスト → 失敗確認 → 実装 → 通過 → コミット) の5ステップ
- ML推論 (Task 6) はテストで `existsSync(MODEL)` でスキップ可能、CI環境ではモデルなしでも他のテスト動作
- 完全な動作確認は Task 11 (1週間) と Task 14 (14日) の蓄積時間が必要
- Phase 2 (loadFactor 補正) はこの plan のスコープ外、別 brainstorming で開始

# 既知の不確実性

- **Task 6 (YOLOv8n): ttc.taxi-inf.jp の俯瞰角度でCOCO pretrained の検出精度が出ない可能性**。実HTMLサンプル取得後、debug overlay で確認。検出率<50%なら fine-tuning が必要だが Phase 1 スコープ外（要 brainstorming）
- **Task 8 (ROI 手動定義): 初期 polygon は推測値**。実画像を見ながらの反復作業必須
- **Task 11 (1週間稼働): ttc.taxi-inf.jp 側の遮断やサーバー変更**で観測停止する可能性。fetch失敗を継続監視
