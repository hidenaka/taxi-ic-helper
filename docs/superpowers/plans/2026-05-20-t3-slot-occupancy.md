# T3 乗り場 slot-occupancy 観測 実装計画（Phase 1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 羽田 T3 第5乗り場 (Real106/107) から 1tick あたりの出庫数 (9レーン合計1値) を計測する観測パイプラインを新設し、`data/t3-slot-occupancy-history.jsonl` と `data/t3-stall-actuals.json` を出力する。

**Architecture:** T1/T2 の slot-occupancy 方式 (`slot-occupancy-tick.mjs` + `computeSlotActuals`) を水平展開する。T3 用ファイルはすべて `t3-` プレフィックスで新設し、既存 T1/T2 ファイルには触れない。観測 tick は新規 CLI スクリプト `scripts/t3-slot-occupancy-tick.mjs` として独立し、後で Mac mini に新 launchd ジョブを配備する。actuals 集計は `observe-taxi-pool.mjs` (5分tick) に T3 用ブロックを try/catch で隔離追加する。

**Tech Stack:** Node.js 22 (`.mjs`) / `node:test` / `Jimp` 画像処理 / 既存共通純関数 `slotOccupied` / `analyzeROI` / `expandRoiVertical` / TDD で純関数中心

**Branch:** `feat/front-slot-occupancy` (T1/T2 と同居・main 直 push 運用維持)

**Worktree:** `乗務地図関係-wt-perspective/`（T1/T2 と共有）

---

## ファイル構造

### 新規ファイル

| パス | 責務 |
|---|---|
| `scripts/lib/t3-stall-slots.json` | T3 マス目格子定義（座標プレースホルダー、校正後確定）|
| `scripts/lib/t3-occupancy-helpers.mjs` | T3 固有純関数: `parseT3SlotConfig`, `summarizeT3Occupancy`, `computeT3SlotActuals` |
| `scripts/t3-slot-occupancy-tick.mjs` | T3 観測 tick CLI スクリプト。`export runT3SlotOccupancyTick(options)` + main |
| `scripts/snapshot-t3-cameras.mjs` | 校正素材取得: Real106/107 を `data/calibration/t3/<timestamp>/` に保存 |
| `scripts/calibrate-t3-slots.mjs` | 校正支援: 取得画像にマス目をオーバーレイした注釈画像を出力 |
| `tests/t3-occupancy-helpers.test.js` | T3 純関数のテスト |
| `tests/t3-stall-slots-parse.test.js` | t3-stall-slots.json パース・スキーマ検証 |
| `tests/observe-t3-actuals.test.js` | `observe-taxi-pool.mjs` の T3 actuals ブロックが既存処理を巻き込まないモックテスト |

### 修正ファイル

| パス | 修正内容 |
|---|---|
| `scripts/observe-taxi-pool.mjs` | 既存 `stall-actuals.json` 書き出しブロック直後に T3 actuals 書き出しブロックを try/catch で追加（1箇所） |
| `scripts/observe-tick-local.sh` | 77行目 `git add` 対象に `data/t3-slot-occupancy-history.jsonl` と `data/t3-stall-actuals.json` を追加 |
| `.gitattributes` | `data/t3-slot-occupancy-history.jsonl merge=union` を1行追加 |

### 校正後の手動更新

| パス | 更新内容 |
|---|---|
| `scripts/lib/t3-stall-slots.json` | 18マスの `cx, cy, r` 座標を校正画像から確定して上書き |

---

## Task 0: ベースライン確認

**Files:** なし

- [ ] **Step 1: 既存テスト数を確認**

Run:
```bash
cd 乗務地図関係-wt-perspective
npm test 2>&1 | tail -5
```

Expected: 直近 HANDOFF.md では `469 passed` だが現状は本日コミットで増減している可能性あり。出力された **テスト総数を記録する**（plan 完了時に「既存 N テスト + T3 追加 M テスト」と検証する基準）。

- [ ] **Step 2: 現ブランチ確認**

Run: `git branch --show-current`

Expected: `feat/front-slot-occupancy`

---

## Task 1: t3-stall-slots.json テンプレート作成

**Files:**
- Create: `scripts/lib/t3-stall-slots.json`
- Test: `tests/t3-stall-slots-parse.test.js`

T1/T2 の `scripts/lib/stall-slots.json` と同形のスキーマで、T3 用テンプレートを作る。9レーン × 2列 = 18マス。座標 `cx, cy, r` は校正後確定するため **プレースホルダー 0.0** で初期化。

- [ ] **Step 1: スキーマ検証テストを書く**

Create `tests/t3-stall-slots-parse.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('t3-stall-slots.json: schema_version=1', () => {
  const cfg = JSON.parse(readFileSync('./scripts/lib/t3-stall-slots.json', 'utf8'));
  assert.equal(cfg.schema_version, 1);
});

test('t3-stall-slots.json: _meta thresholds present', () => {
  const cfg = JSON.parse(readFileSync('./scripts/lib/t3-stall-slots.json', 'utf8'));
  assert.equal(cfg._meta.night_brightness_threshold, 50);
  assert.equal(cfg._meta.edge_threshold, 0.08);
  assert.equal(cfg._meta.night_lantern_ratio, 0.005);
  assert.deepEqual(cfg._meta.image_size, [800, 600]);
});

test('t3-stall-slots.json: t3_stand has 18 slots (9 lanes × 2 rows)', () => {
  const cfg = JSON.parse(readFileSync('./scripts/lib/t3-stall-slots.json', 'utf8'));
  const stand = cfg.stalls.t3_stand;
  assert.equal(stand.source, 'real106');
  assert.equal(stand.capacity, 18);
  assert.equal(stand.slots.length, 18);
});

test('t3-stall-slots.json: each slot has lane/category/row tags', () => {
  const cfg = JSON.parse(readFileSync('./scripts/lib/t3-stall-slots.json', 'utf8'));
  const slots = cfg.stalls.t3_stand.slots;
  for (const s of slots) {
    assert.ok(typeof s.id === 'string', `id missing: ${JSON.stringify(s)}`);
    assert.ok(Number.isInteger(s.lane) && s.lane >= 1 && s.lane <= 9);
    assert.ok(['kanagawa', 'general', 'wagon', 'ecd', 'hire'].includes(s.category));
    assert.ok(s.row === 1 || s.row === 2);
    assert.equal(typeof s.cx, 'number');
    assert.equal(typeof s.cy, 'number');
    assert.equal(typeof s.r, 'number');
  }
});

test('t3-stall-slots.json: 9 unique lanes covered', () => {
  const cfg = JSON.parse(readFileSync('./scripts/lib/t3-stall-slots.json', 'utf8'));
  const lanes = new Set(cfg.stalls.t3_stand.slots.map(s => s.lane));
  assert.equal(lanes.size, 9);
});

test('t3-stall-slots.json: each lane has row1 and row2', () => {
  const cfg = JSON.parse(readFileSync('./scripts/lib/t3-stall-slots.json', 'utf8'));
  const byLane = {};
  for (const s of cfg.stalls.t3_stand.slots) {
    byLane[s.lane] = byLane[s.lane] || new Set();
    byLane[s.lane].add(s.row);
  }
  for (let lane = 1; lane <= 9; lane++) {
    assert.deepEqual([...byLane[lane]].sort(), [1, 2], `lane ${lane} missing rows`);
  }
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test tests/t3-stall-slots-parse.test.js`

Expected: FAIL — `ENOENT: no such file or directory, open './scripts/lib/t3-stall-slots.json'`

- [ ] **Step 3: t3-stall-slots.json を作成（プレースホルダー座標）**

Create `scripts/lib/t3-stall-slots.json`:

```json
{
  "_meta": {
    "image_size": [800, 600],
    "edge_threshold": 0.08,
    "night_brightness_threshold": 50,
    "night_lantern_ratio": 0.005,
    "note": "T3 第5乗り場 9レーン × 先頭2列の格子。座標 cx/cy/r は校正フェーズで確定。スロット中心は0-1正規化座標。"
  },
  "schema_version": 1,
  "stalls": {
    "t3_stand": {
      "source": "real106",
      "label": "T3 第5乗り場（9レーン合計）",
      "capacity": 18,
      "slots": [
        {"id": "lane1-row1", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 1, "category": "kanagawa", "row": 1},
        {"id": "lane1-row2", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 1, "category": "kanagawa", "row": 2},
        {"id": "lane2-row1", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 2, "category": "general", "row": 1},
        {"id": "lane2-row2", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 2, "category": "general", "row": 2},
        {"id": "lane3-row1", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 3, "category": "general", "row": 1},
        {"id": "lane3-row2", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 3, "category": "general", "row": 2},
        {"id": "lane4-row1", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 4, "category": "general", "row": 1},
        {"id": "lane4-row2", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 4, "category": "general", "row": 2},
        {"id": "lane5-row1", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 5, "category": "wagon", "row": 1},
        {"id": "lane5-row2", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 5, "category": "wagon", "row": 2},
        {"id": "lane6-row1", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 6, "category": "wagon", "row": 1},
        {"id": "lane6-row2", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 6, "category": "wagon", "row": 2},
        {"id": "lane7-row1", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 7, "category": "ecd", "row": 1},
        {"id": "lane7-row2", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 7, "category": "ecd", "row": 2},
        {"id": "lane8-row1", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 8, "category": "ecd", "row": 1},
        {"id": "lane8-row2", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 8, "category": "ecd", "row": 2},
        {"id": "lane9-row1", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 9, "category": "hire", "row": 1},
        {"id": "lane9-row2", "cx": 0.0, "cy": 0.0, "r": 0.0, "lane": 9, "category": "hire", "row": 2}
      ]
    }
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test tests/t3-stall-slots-parse.test.js`

Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/t3-stall-slots.json tests/t3-stall-slots-parse.test.js
git commit -m "$(cat <<'EOF'
feat(t3-slot): t3-stall-slots.json テンプレート + スキーマテスト

9レーン × 2列 = 18マスのプレースホルダー。座標 cx/cy/r は 0.0 で
初期化、校正フェーズで実画像から確定する。schema_version=1、
T1/T2 の stall-slots.json と同形。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: parseT3SlotConfig + summarizeT3Occupancy 純関数

**Files:**
- Create: `scripts/lib/t3-occupancy-helpers.mjs`
- Test: `tests/t3-occupancy-helpers.test.js`

T3 用の集計純関数を新ファイルにまとめる。`parseT3SlotConfig` は JSON パースと最低限の検証、`summarizeT3Occupancy` は 18マスの occupied dict から `{total, row1, row2}` を作る。

- [ ] **Step 1: 失敗するテストを書く（parseT3SlotConfig + summarizeT3Occupancy）**

Create `tests/t3-occupancy-helpers.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseT3SlotConfig, summarizeT3Occupancy } from '../scripts/lib/t3-occupancy-helpers.mjs';

test('parseT3SlotConfig: returns slots and meta', () => {
  const cfg = parseT3SlotConfig({
    schema_version: 1,
    _meta: { image_size: [800, 600], edge_threshold: 0.08 },
    stalls: {
      t3_stand: {
        source: 'real106',
        capacity: 18,
        slots: [{ id: 's1', cx: 0.5, cy: 0.5, r: 0.01, lane: 1, category: 'general', row: 1 }],
      },
    },
  });
  assert.equal(cfg.source, 'real106');
  assert.equal(cfg.slots.length, 1);
  assert.equal(cfg.meta.edge_threshold, 0.08);
});

test('parseT3SlotConfig: throws on missing t3_stand', () => {
  assert.throws(() => parseT3SlotConfig({ schema_version: 1, stalls: {} }),
    /t3_stand not found/);
});

test('parseT3SlotConfig: throws on schema_version mismatch', () => {
  assert.throws(() => parseT3SlotConfig({ schema_version: 2, stalls: { t3_stand: { slots: [] } } }),
    /schema_version/);
});

test('summarizeT3Occupancy: counts total, row1, row2', () => {
  const slots = [
    { id: 'lane1-row1', lane: 1, row: 1 },
    { id: 'lane1-row2', lane: 1, row: 2 },
    { id: 'lane2-row1', lane: 2, row: 1 },
    { id: 'lane2-row2', lane: 2, row: 2 },
  ];
  const occupiedById = {
    'lane1-row1': true,
    'lane1-row2': false,
    'lane2-row1': true,
    'lane2-row2': true,
  };
  const result = summarizeT3Occupancy(slots, occupiedById);
  assert.deepEqual(result, { total: 3, row1: 2, row2: 1 });
});

test('summarizeT3Occupancy: empty slots → all zero', () => {
  assert.deepEqual(summarizeT3Occupancy([], {}), { total: 0, row1: 0, row2: 0 });
});

test('summarizeT3Occupancy: missing occupied entries → false', () => {
  const slots = [{ id: 'a', lane: 1, row: 1 }, { id: 'b', lane: 1, row: 2 }];
  const result = summarizeT3Occupancy(slots, { a: true });
  assert.deepEqual(result, { total: 1, row1: 1, row2: 0 });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test tests/t3-occupancy-helpers.test.js`

Expected: FAIL — `Cannot find module '../scripts/lib/t3-occupancy-helpers.mjs'`

- [ ] **Step 3: 純関数を実装**

Create `scripts/lib/t3-occupancy-helpers.mjs`:

```javascript
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
```

- [ ] **Step 4: テスト通過確認**

Run: `node --test tests/t3-occupancy-helpers.test.js`

Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/t3-occupancy-helpers.mjs tests/t3-occupancy-helpers.test.js
git commit -m "$(cat <<'EOF'
feat(t3-slot): parseT3SlotConfig + summarizeT3Occupancy 純関数

T3 観測スクリプト用の純関数2つを新規 helpers モジュールに追加。
parseT3SlotConfig は schema_version=1 と t3_stand の存在を検証。
summarizeT3Occupancy は 18マスの occupied dict から
{total, row1, row2} を作る。既存共通関数 (slotOccupied など) は
流用するためテスト追加なし。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: computeT3SlotActuals 純関数

**Files:**
- Modify: `scripts/lib/t3-occupancy-helpers.mjs`
- Modify: `tests/t3-occupancy-helpers.test.js`

`t3-slot-occupancy-history.jsonl` の行配列を読んで、15分スロット × `total` の actuals を作る純関数。既存 `computeSlotActuals` (T1/T2 用) のシグネチャを踏襲しつつ、出力は `total` 1列のみ。

T3 履歴行の想定スキーマ:
```json
{ "schema_version": 1, "ts": "2026-05-20T...", "mode": "day"|"night", "stalls": { "t3_stand": { "occ": 14, "row1": 7, "row2": 7, "slots": { "lane1-row1": true, ... } } } }
```

- [ ] **Step 1: 失敗するテストを追加**

Append to `tests/t3-occupancy-helpers.test.js`:

```javascript
import { computeT3SlotActuals } from '../scripts/lib/t3-occupancy-helpers.mjs';

test('computeT3SlotActuals: empty history → empty array', () => {
  assert.deepEqual(computeT3SlotActuals([], new Date('2026-05-20T20:00:00+09:00')), []);
});

test('computeT3SlotActuals: single row → empty (no diff possible)', () => {
  const history = [
    { ts: '2026-05-20T19:00:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } },
  ];
  assert.deepEqual(computeT3SlotActuals(history, new Date('2026-05-20T20:00:00+09:00')), []);
});

test('computeT3SlotActuals: decrease counted as departure, increase ignored', () => {
  const history = [
    { ts: '2026-05-20T19:00:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } },
    { ts: '2026-05-20T19:05:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 16 } } }, // -2
    { ts: '2026-05-20T19:10:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 14 } } }, // -2
    { ts: '2026-05-20T19:12:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } }, // +4 → ignore (列移動)
  ];
  const result = computeT3SlotActuals(history, new Date('2026-05-20T19:15:00+09:00'), 120);
  // 全行 19:00-19:15 の 1 binに集約され total = 2+2+0 = 4
  assert.equal(result.length, 1);
  assert.equal(result[0].total, 4);
});

test('computeT3SlotActuals: day/night mode change → diff ignored', () => {
  const history = [
    { ts: '2026-05-20T18:55:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } },
    { ts: '2026-05-20T19:00:00+09:00', mode: 'night', stalls: { t3_stand: { occ: 5 } } }, // mode 切替 → 0扱い
    { ts: '2026-05-20T19:05:00+09:00', mode: 'night', stalls: { t3_stand: { occ: 3 } } }, // -2
  ];
  const result = computeT3SlotActuals(history, new Date('2026-05-20T19:30:00+09:00'), 120);
  const totals = result.reduce((sum, s) => sum + s.total, 0);
  assert.equal(totals, 2); // 18→5 の差分は無視、5→3 のみカウント
});

test('computeT3SlotActuals: outside window excluded', () => {
  const history = [
    { ts: '2026-05-20T10:00:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } },
    { ts: '2026-05-20T10:05:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 16 } } }, // 10時台は窓外
    { ts: '2026-05-20T19:55:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 10 } } },
    { ts: '2026-05-20T20:00:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 8 } } }, // -2
  ];
  const result = computeT3SlotActuals(history, new Date('2026-05-20T20:30:00+09:00'), 120);
  const totals = result.reduce((sum, s) => sum + s.total, 0);
  assert.equal(totals, 2);
});

test('computeT3SlotActuals: output rows have slotStart/slotEnd/total only', () => {
  const history = [
    { ts: '2026-05-20T19:00:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } },
    { ts: '2026-05-20T19:05:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 16 } } },
  ];
  const result = computeT3SlotActuals(history, new Date('2026-05-20T19:30:00+09:00'), 120);
  assert.equal(result.length, 1);
  assert.equal(typeof result[0].slotStart, 'string');
  assert.equal(typeof result[0].slotEnd, 'string');
  assert.equal(typeof result[0].total, 'number');
  // stall1..4 は出さない（T3 は合計1値）
  assert.equal(result[0].stall1, undefined);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test tests/t3-occupancy-helpers.test.js`

Expected: FAIL — `computeT3SlotActuals is not exported`

- [ ] **Step 3: 純関数を追加**

Append to `scripts/lib/t3-occupancy-helpers.mjs`:

```javascript
import { departuresBetween, medianOf3 } from './slot-occupancy.mjs';

const SLOT_MS = 15 * 60 * 1000;

function fmtJst(ms) {
  const jst = new Date(ms + 9 * 3600 * 1000);
  return `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * T3 占有履歴から 15分スロット × total を集計する純関数。
 * 既存 computeSlotActuals (T1/T2 4-stall 用) の T3 単一スロット版。
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
  // 1tickフリッカ平滑（端点はそのまま）
  const smooth = rows.map((r, i) =>
    (i === 0 || i === rows.length - 1) ? r.occ : medianOf3(rows[i - 1].occ, r.occ, rows[i + 1].occ));
  const bins = new Map();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].tsMs < startMs || rows[i].tsMs > endMs) continue;
    // 昼/夜モード切替 tick は差分0扱い（既存 computeSlotActuals と同じ理由）
    const prevMode = rows[i - 1].mode;
    const curMode = rows[i].mode;
    if (prevMode !== null && curMode !== null && prevMode !== curMode) continue;
    const binStart = Math.floor(rows[i].tsMs / SLOT_MS) * SLOT_MS;
    let bin = bins.get(binStart);
    if (!bin) { bin = { total: 0 }; bins.set(binStart, bin); }
    bin.total += departuresBetween(smooth[i - 1], smooth[i]);
  }
  return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([ms, bin]) => ({
    slotStart: fmtJst(ms), slotEnd: fmtJst(ms + SLOT_MS), total: bin.total,
  }));
}
```

- [ ] **Step 4: テスト通過確認**

Run: `node --test tests/t3-occupancy-helpers.test.js`

Expected: PASS (12 tests = 6 + 6)

- [ ] **Step 5: 全体テスト回帰確認**

Run: `npm test 2>&1 | tail -5`

Expected: PASS — Task 0 で記録したテスト数 + 12 件

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/t3-occupancy-helpers.mjs tests/t3-occupancy-helpers.test.js
git commit -m "$(cat <<'EOF'
feat(t3-slot): computeT3SlotActuals 純関数

T3 履歴 → 15分スロット × total の集計関数。既存 computeSlotActuals
(T1/T2 4-stall 用) を total 1列に簡略化した T3 版。
departuresBetween / medianOf3 / mode 切替判定は既存共通関数を流用。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: t3-slot-occupancy-tick.mjs スクリプト本体

**Files:**
- Create: `scripts/t3-slot-occupancy-tick.mjs`

既存 `scripts/slot-occupancy-tick.mjs` をベースに、T3 用カメラ（Real106/107）と T3 用ファイルパスで動くスクリプトを新規作成。`export runT3SlotOccupancyTick()` と CLI main の両方を提供する（CLI は将来 launchd ジョブから直接呼ばれる、`observe-taxi-pool.mjs` からは export 関数を import する）。

座標プレースホルダー（0.0）の状態でも crash しないことを担保する: `slotRoi` が width=0, height=0 を返しても analyzeROI が NaN を出さなければ「全マス空き＝occ=0」が記録され、観測は走る。

- [ ] **Step 1: スクリプト本体を作成**

Create `scripts/t3-slot-occupancy-tick.mjs`:

```javascript
#!/usr/bin/env node
// T3 第5乗り場 slot-occupancy tick: Real106/107 を取得し、18マスの在/不在を
// 画像解析で判定、 t3-slot-occupancy-history.jsonl に 1 行追記する。
//
// CLI: `node scripts/t3-slot-occupancy-tick.mjs`
// import: `import { runT3SlotOccupancyTick } from './t3-slot-occupancy-tick.mjs'`
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { Jimp } from 'jimp';
import { analyzeROI } from './lib/image-pool-analyzer.mjs';
import {
  slotOccupied, DEFAULT_EDGE_THRESHOLD, DEFAULT_NIGHT_LANTERN_RATIO,
  NIGHT_BRIGHTNESS_THRESHOLD, isFrameAbnormal, expandRoiVertical,
} from './lib/slot-occupancy.mjs';
import { parseT3SlotConfig, summarizeT3Occupancy } from './lib/t3-occupancy-helpers.mjs';

const TTC_BASE = 'https://ttc.taxi-inf.jp';
const DEFAULT_SLOTS_PATH = './scripts/lib/t3-stall-slots.json';
const DEFAULT_HISTORY_PATH = './data/t3-slot-occupancy-history.jsonl';

function jstNowIso() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

async function fetchBuffer(name) {
  const res = await fetch(`${TTC_BASE}/${name}.jpg`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function avgBrightness(img) {
  const { data } = img.bitmap;
  let sum = 0, count = 0;
  for (let i = 0; i < data.length; i += 4 * 50) {
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

// 'real106' → 'Real106' のような画像名変換（slot-occupancy-tick.mjs と同形）
function cameraToImageName(cam) {
  return cam.split('_').map((p, i) =>
    i === 0 ? p[0].toUpperCase() + p.slice(1) : p).join('_');
}

function slotRoi(slot, w, h) {
  return {
    x: Math.round((slot.cx - slot.r) * w),
    y: Math.round((slot.cy - slot.r) * h),
    width: Math.round(slot.r * 2 * w),
    height: Math.round(slot.r * 2 * h),
  };
}

/**
 * T3 slot-occupancy tick の本体。CLI からも observe-taxi-pool.mjs からも呼べる。
 * @param {object} [options]
 * @param {string} [options.cfgPath]
 * @param {string} [options.historyPath]
 * @returns {Promise<{ok:boolean, reason?:string, occ?:number}>}
 */
export async function runT3SlotOccupancyTick(options = {}) {
  const cfgPath = options.cfgPath || DEFAULT_SLOTS_PATH;
  const historyPath = options.historyPath || DEFAULT_HISTORY_PATH;
  if (!existsSync(cfgPath)) {
    return { ok: false, reason: 't3-stall-slots.json missing' };
  }
  const cfg = parseT3SlotConfig(JSON.parse(readFileSync(cfgPath, 'utf8')));
  const camName = cfg.source; // 'real106'
  // 画像取得
  let img;
  try {
    const buf = await fetchBuffer(cameraToImageName(camName));
    img = await Jimp.read(buf);
  } catch (e) {
    return { ok: false, reason: `fetch failed: ${e.message}` };
  }
  // 異常フレーム検出
  const avg = avgBrightness(img);
  if (isFrameAbnormal(avg)) {
    return { ok: false, reason: `abnormal frame (avg=${avg.toFixed(1)})` };
  }
  const isNight = avg < (cfg.meta.night_brightness_threshold ?? NIGHT_BRIGHTNESS_THRESHOLD);
  const mode = isNight ? 'night' : 'day';
  const edgeThreshold = cfg.meta.edge_threshold ?? DEFAULT_EDGE_THRESHOLD;
  const nightLanternRatio = cfg.meta.night_lantern_ratio ?? DEFAULT_NIGHT_LANTERN_RATIO;
  const { width, height } = img.bitmap;
  const occupiedById = {};
  for (const slot of cfg.slots) {
    const baseRoi = slotRoi(slot, width, height);
    // 座標プレースホルダー (r=0) の場合 width/height=0 → analyzeROI が undefined を返す可能性
    // その場合 slotOccupied は features を見て false を返す（既存挙動）
    if (baseRoi.width <= 0 || baseRoi.height <= 0) {
      occupiedById[slot.id] = false;
      continue;
    }
    const roi = isNight ? expandRoiVertical(baseRoi, 2, width, height) : baseRoi;
    const feat = await analyzeROI(img, roi);
    occupiedById[slot.id] = slotOccupied(feat, {
      edgeThreshold, isNight, nightLanternRatio,
    });
  }
  const summary = summarizeT3Occupancy(cfg.slots, occupiedById);
  const row = {
    schema_version: 1,
    ts: jstNowIso(),
    mode,
    stalls: {
      t3_stand: {
        occ: summary.total,
        row1: summary.row1,
        row2: summary.row2,
        slots: occupiedById,
      },
    },
  };
  appendFileSync(historyPath, JSON.stringify(row) + '\n', 'utf8');
  return { ok: true, occ: summary.total, row1: summary.row1, row2: summary.row2, mode };
}

// CLI 単独実行用 main
if (import.meta.url === `file://${process.argv[1]}`) {
  runT3SlotOccupancyTick().then(result => {
    if (result.ok) {
      console.log(`[t3-slot] ok: total=${result.occ} row1=${result.row1} row2=${result.row2} mode=${result.mode}`);
    } else {
      console.error(`[t3-slot] skip: ${result.reason}`);
      process.exit(0); // skip は exit 0（launchd ジョブの retry を待たない）
    }
  }).catch(e => {
    console.error(`[t3-slot] fatal: ${e.message}`);
    process.exit(0);
  });
}
```

- [ ] **Step 2: 構文チェック**

Run: `node --check scripts/t3-slot-occupancy-tick.mjs`

Expected: 何も出力されない（pass）。エラーが出たらシンタックス修正

- [ ] **Step 3: CLI 実行で実画像 fetch を試す（ネットワーク必要）**

Run: `node scripts/t3-slot-occupancy-tick.mjs`

Expected: `[t3-slot] ok: total=0 row1=0 row2=0 mode=day` のような出力（座標プレースホルダーなので全マス空き → total=0 が想定）。`data/t3-slot-occupancy-history.jsonl` に1行追記されることを確認:

```bash
tail -1 data/t3-slot-occupancy-history.jsonl
```

Expected: `{"schema_version":1,"ts":"...","mode":"day","stalls":{"t3_stand":{"occ":0,"row1":0,"row2":0,"slots":{"lane1-row1":false,...}}}}`

- [ ] **Step 4: 全テスト回帰確認**

Run: `npm test 2>&1 | tail -5`

Expected: PASS（テスト追加なしなので Task 3 と同じ件数）

- [ ] **Step 5: Commit（観測データファイルを混ぜないこと）**

```bash
git status --porcelain data/  # 観測データが残っていないか確認
git checkout HEAD -- data/t3-slot-occupancy-history.jsonl  # 試走で生成されたファイルがあれば破棄
git add scripts/t3-slot-occupancy-tick.mjs
git commit -m "$(cat <<'EOF'
feat(t3-slot): t3-slot-occupancy-tick.mjs スクリプト本体

T3 第5乗り場の観測 tick スクリプト。Real106 を fetch、18マスの
在/不在を画像解析で判定、t3-slot-occupancy-history.jsonl に 1行
追記する。 export runT3SlotOccupancyTick() で observe-taxi-pool.mjs
からの呼び出しを可能にし、 CLI 単独実行も両立。
座標プレースホルダー (r=0) の状態でも crash せず total=0 を記録する
defensive 実装 (校正前から観測パイプラインを通せる)。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: observe-taxi-pool.mjs に T3 actuals 集計を追加

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`
- Create: `tests/observe-t3-actuals.test.js`

`observe-taxi-pool.mjs` の既存 `stall-actuals.json` 書き出しブロック (340-349行) の直後に、T3 用 actuals 書き出しブロックを try/catch で隔離追加する。T3 観測 tick 自体（fetch+occ計算）は `t3-slot-occupancy-tick.mjs` が別 launchd ジョブで動く前提なので、ここでは history を読んで集計だけする。

- [ ] **Step 1: テストを書く（モック: T3 ブロックが例外を投げても既存処理を巻き込まない）**

Create `tests/observe-t3-actuals.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeT3SlotActuals } from '../scripts/lib/t3-occupancy-helpers.mjs';

// observe-taxi-pool.mjs の T3 ブロックは以下の純粋な流れを持つ:
//   1. data/t3-slot-occupancy-history.jsonl を1行ずつ JSON.parse
//   2. computeT3SlotActuals(history, new Date(), 720) で集計
//   3. data/t3-stall-actuals.json に { schemaVersion, generatedAt, slots } を書き出し
// このTaskでは、組み込みコードを抜き出して同じ流れで動くことを純関数として検証する。
// 実ファイル I/O はスタブし、computeT3SlotActuals の使い方が既存と整合することを確認。

test('T3 actuals payload shape matches existing stall-actuals.json convention', () => {
  const history = [
    { ts: '2026-05-20T19:00:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } },
    { ts: '2026-05-20T19:05:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 16 } } },
  ];
  const slots = computeT3SlotActuals(history, new Date('2026-05-20T19:30:00+09:00'), 720);
  const payload = {
    schemaVersion: 1,
    generatedAt: '2026-05-20T19:30:00+09:00',
    slots,
  };
  assert.equal(payload.schemaVersion, 1);
  assert.equal(typeof payload.generatedAt, 'string');
  assert.ok(Array.isArray(payload.slots));
  assert.ok(payload.slots.length > 0);
  // 各 slot は slotStart/slotEnd/total を持つ (T3 は total 1列のみ)
  for (const s of payload.slots) {
    assert.equal(typeof s.slotStart, 'string');
    assert.equal(typeof s.slotEnd, 'string');
    assert.equal(typeof s.total, 'number');
    assert.equal(s.stall1, undefined, 'T3 actuals must not have stall1..4 keys');
  }
});

test('T3 actuals: empty history → empty slots array (no crash)', () => {
  // history が空 (まだ Mac mini で 1回も観測してない初期状態) のとき crash しない
  const slots = computeT3SlotActuals([], new Date(), 720);
  assert.deepEqual(slots, []);
});

test('T3 actuals: malformed line robustness (純関数は壊れ行を含まない前提だが、組込み側で skip する)', () => {
  // observe-taxi-pool.mjs 内では `try { JSON.parse(line) } catch { skip }` で防御するため、
  // computeT3SlotActuals に渡る時点で壊れ行は除外されている前提。
  // 純関数の責務はあくまで「正しい行配列を受け取って集計する」こと。
  const history = [
    { ts: '2026-05-20T19:00:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } },
    { ts: 'invalid-date', mode: 'day', stalls: { t3_stand: { occ: 10 } } }, // 内部で除外される
    { ts: '2026-05-20T19:05:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 16 } } },
  ];
  const slots = computeT3SlotActuals(history, new Date('2026-05-20T19:30:00+09:00'), 720);
  // 不正な ts 行は filter で落ちる → 残り 2行 で 1diff = total 2
  const totals = slots.reduce((s, x) => s + x.total, 0);
  assert.equal(totals, 2);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test tests/observe-t3-actuals.test.js`

Expected: PASS — このテストは Task 2-3 で実装済みの純関数を呼ぶだけなので、すでに通る想定。**通らない場合は computeT3SlotActuals の filter 挙動を見直す**

- [ ] **Step 3: observe-taxi-pool.mjs に T3 ブロックを追加**

`scripts/observe-taxi-pool.mjs` の頭の import 群に1行追加:

```javascript
import { computeT3SlotActuals } from './lib/t3-occupancy-helpers.mjs';
```

定数定義群（既存パス定数の近く）に T3 用パスを追加:

```javascript
const T3_HISTORY_PATH = './data/t3-slot-occupancy-history.jsonl';
const T3_ACTUALS_OUTPUT_PATH = './data/t3-stall-actuals.json';
```

`scripts/observe-taxi-pool.mjs` の340-349行（既存の `stall-actuals.json` 書き出し `try { ... } catch { ... }` ブロック）の **直後に** 以下を挿入:

```javascript
    // T3 第5乗り場 actuals (15分スロット × total) を書き出す。
    // T3 観測 tick は別 launchd ジョブ (t3-slot-occupancy-tick.mjs) が
    // t3-slot-occupancy-history.jsonl に追記する。ここでは history を読んで集計のみ。
    // 既存 T1/T2 処理を巻き込まないよう独立 try/catch で隔離。
    try {
      if (existsSync(T3_HISTORY_PATH)) {
        const t3Lines = readFileSync(T3_HISTORY_PATH, 'utf8').trim().split('\n');
        const t3History = [];
        for (const line of t3Lines) {
          if (!line.trim()) continue;
          try { t3History.push(JSON.parse(line)); } catch { /* skip bad line */ }
        }
        const t3ActualsSlots = computeT3SlotActuals(t3History, new Date(), 720);
        writeFileSync(T3_ACTUALS_OUTPUT_PATH, JSON.stringify({
          schemaVersion: 1,
          generatedAt: jstNowIso(),
          slots: t3ActualsSlots,
        }, null, 2) + '\n', 'utf8');
      }
    } catch (e) {
      console.warn(`[observe] t3-stall-actuals write skipped: ${e.message}`);
    }
```

注意: `existsSync` は既に頭でimportされている。`readFileSync`/`writeFileSync`/`jstNowIso` も同様。

- [ ] **Step 4: observe-taxi-pool.mjs の構文チェック**

Run: `node --check scripts/observe-taxi-pool.mjs`

Expected: 出力なし

- [ ] **Step 5: 全テスト回帰確認**

Run: `npm test 2>&1 | tail -5`

Expected: PASS — Task 3 のテスト数 + 3件（observe-t3-actuals.test.js）

- [ ] **Step 6: Commit**

```bash
git add scripts/observe-taxi-pool.mjs tests/observe-t3-actuals.test.js
git commit -m "$(cat <<'EOF'
feat(t3-slot): observe-taxi-pool.mjs に T3 actuals 集計ブロック追加

5分tick の最後で t3-slot-occupancy-history.jsonl を読んで
computeT3SlotActuals で集計、t3-stall-actuals.json に書き出す。
既存 T1/T2 処理を巻き込まないよう独立 try/catch で隔離。
T3 観測 tick 自体は別ジョブ (t3-slot-occupancy-tick.mjs) なので
ここでは集計のみ。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 配線 (observe-tick-local.sh + .gitattributes)

**Files:**
- Modify: `scripts/observe-tick-local.sh`
- Modify: `.gitattributes`

Mac mini が観測データを commit/push する時に T3 ファイルも含めるよう配線。append-only の jsonl は merge=union で衝突回避。

- [ ] **Step 1: observe-tick-local.sh の git add 行に T3 ファイル2個を追加**

`scripts/observe-tick-local.sh` の77行目（既存の長い `git add` 行）を次に変更:

```bash
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/stall-actuals.json data/coefficient-corrections.json data/t3-pool-history.jsonl data/vehicle-detection-history.jsonl data/vehicle-track-history.jsonl data/throughput-calibration.json data/slot-occupancy-history.jsonl data/t3-slot-occupancy-history.jsonl data/t3-stall-actuals.json 2>/dev/null || true
```

末尾2つ（`data/t3-slot-occupancy-history.jsonl data/t3-stall-actuals.json`）が追加分。

同じく44行目と52行目の「再生成系を pull 前に破棄」する `git checkout HEAD --` 行に、`data/t3-stall-actuals.json` を追加する（再生成系のため）。`data/t3-slot-occupancy-history.jsonl` は **append-only なので含めない**（次 tick が観測行を回収する）。

44行目を変更:
```bash
  git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/stall-actuals.json data/coefficient-corrections.json data/throughput-calibration.json data/t3-stall-actuals.json 2>/dev/null || true
```

52行目も同様に末尾 `data/t3-stall-actuals.json` を追加:
```bash
git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/stall-actuals.json data/coefficient-corrections.json data/throughput-calibration.json data/t3-stall-actuals.json 2>/dev/null || true
```

- [ ] **Step 2: .gitattributes に1行追加**

`.gitattributes` に追加（既存 `data/slot-occupancy-history.jsonl merge=union` の直下が見やすい）:

```
data/t3-slot-occupancy-history.jsonl merge=union
```

- [ ] **Step 3: bash 構文チェック**

Run: `bash -n scripts/observe-tick-local.sh`

Expected: 出力なし（pass）

- [ ] **Step 4: Commit**

```bash
git add scripts/observe-tick-local.sh .gitattributes
git commit -m "$(cat <<'EOF'
feat(t3-slot): observe-tick-local.sh と .gitattributes に T3 ファイル配線

Mac mini の 5分tick で T3 観測データも git add → commit → push する
よう配線。t3-slot-occupancy-history.jsonl は append-only で
merge=union 衝突回避、t3-stall-actuals.json は再生成系で pull 前
checkout HEAD -- の対象に追加。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: 校正素材取得スクリプト snapshot-t3-cameras.mjs

**Files:**
- Create: `scripts/snapshot-t3-cameras.mjs`

Mac mini で「今の Real106/107 をサンプルとして保存する」一発実行スクリプト。校正用にユーザーが見られる場所（`data/calibration/t3/<timestamp>/`）に保存。

- [ ] **Step 1: スクリプトを作成**

Create `scripts/snapshot-t3-cameras.mjs`:

```javascript
#!/usr/bin/env node
// T3 校正用サンプル画像取得スクリプト。
// Real106 / Real107 を取得して data/calibration/t3/<YYYY-MM-DDTHH-MM-SS>/<name>.jpg に保存。
// CLI: `node scripts/snapshot-t3-cameras.mjs`
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TTC_BASE = 'https://ttc.taxi-inf.jp';
const TARGETS = ['Real106', 'Real107'];
const OUTPUT_ROOT = './data/calibration/t3';

function tsForPath() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '').replace(/[:T]/g, '-').replace(/\..+/, '');
}

async function fetchBuffer(name) {
  const res = await fetch(`${TTC_BASE}/${name}.jpg`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const ts = tsForPath();
  const outDir = join(OUTPUT_ROOT, ts);
  mkdirSync(outDir, { recursive: true });
  for (const name of TARGETS) {
    try {
      const buf = await fetchBuffer(name);
      const out = join(outDir, `${name}.jpg`);
      writeFileSync(out, buf);
      console.log(`[snapshot] saved: ${out} (${buf.length} bytes)`);
    } catch (e) {
      console.error(`[snapshot] failed ${name}: ${e.message}`);
    }
  }
  console.log(`[snapshot] done: ${outDir}`);
}

main().catch(e => { console.error(`[snapshot] fatal: ${e.message}`); process.exit(1); });
```

- [ ] **Step 2: 構文チェック + 実行**

Run:
```bash
node --check scripts/snapshot-t3-cameras.mjs
node scripts/snapshot-t3-cameras.mjs
```

Expected: `[snapshot] saved: data/calibration/t3/2026-05-20-21-XX-XX/Real106.jpg (XXXX bytes)` のような出力。実画像2枚が保存されることを確認:

```bash
ls -la data/calibration/t3/*/
```

- [ ] **Step 3: data/calibration/ を `.gitignore` 確認**

校正サンプルは生画像で sizeが大きいため commit したくない。`.gitignore` を確認:

```bash
grep -n "calibration" .gitignore
```

含まれていなければ追加:
```bash
echo "data/calibration/" >> .gitignore
```

- [ ] **Step 4: Commit**

```bash
git status  # data/calibration/ が untracked になっていることを確認
git add scripts/snapshot-t3-cameras.mjs .gitignore  # .gitignore に変更があれば
git commit -m "$(cat <<'EOF'
feat(t3-slot): snapshot-t3-cameras.mjs 校正サンプル取得スクリプト

Real106 / Real107 を data/calibration/t3/<timestamp>/ に保存する
一発実行スクリプト。校正フェーズの最初のステップで Mac mini で
実行して 18マスの座標確定の素材を作る。 data/calibration/ は
gitignore でリポジトリ管理外。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: 校正支援スクリプト calibrate-t3-slots.mjs

**Files:**
- Create: `scripts/calibrate-t3-slots.mjs`

サンプル画像にマス目をオーバーレイして注釈画像を出力する。校正者は注釈画像を見て `t3-stall-slots.json` の座標を調整する反復作業を行う。

既存 `calibrate-slots.mjs` がT1/T2 用にあり構造を参考にできるため、本タスクは「既存スクリプトを読んで T3 対応薄ラッパーを作る」という流れ。

- [ ] **Step 1: 既存 calibrate-slots.mjs の構造を確認**

Run: `head -80 scripts/calibrate-slots.mjs`

実装パターンを把握する（Jimp で画像読み・slot ごとに矩形描画・PNG 出力など）。本 plan では具体的なコードは書き起こさず、「同じパターンで T3 用に書く」とする。実装者は head 出力を見てから次の Step に進む。

- [ ] **Step 2: スクリプトを作成（T3 専用）**

Create `scripts/calibrate-t3-slots.mjs`:

```javascript
#!/usr/bin/env node
// T3 校正支援: data/calibration/t3/<timestamp>/Real106.jpg にマス目をオーバーレイし、
// data/calibration/t3/<timestamp>/Real106_annotated.png として出力する。
// 18マスの位置調整を t3-stall-slots.json で繰り返しながら見比べる用途。
//
// CLI:
//   node scripts/calibrate-t3-slots.mjs <calibration-dir>
//   例: node scripts/calibrate-t3-slots.mjs data/calibration/t3/2026-05-20-21-30-00
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { parseT3SlotConfig } from './lib/t3-occupancy-helpers.mjs';

const SLOTS_PATH = './scripts/lib/t3-stall-slots.json';

const LANE_COLORS = {
  kanagawa: 0xff0000ff, // 赤
  general:  0x00ff00ff, // 緑
  wagon:    0x0000ffff, // 青
  ecd:      0xffff00ff, // 黄
  hire:     0xff00ffff, // 紫
};

async function annotateImage(srcPath, cfg) {
  const img = await Jimp.read(srcPath);
  const { width, height } = img.bitmap;
  for (const slot of cfg.slots) {
    const color = LANE_COLORS[slot.category] || 0xffffffff;
    const x = Math.round((slot.cx - slot.r) * width);
    const y = Math.round((slot.cy - slot.r) * height);
    const w = Math.round(slot.r * 2 * width);
    const h = Math.round(slot.r * 2 * height);
    // 矩形を線描画 (上下左右の辺)
    for (let i = 0; i < w; i++) {
      if (x + i >= 0 && x + i < width) {
        if (y >= 0 && y < height) img.setPixelColor(color, x + i, y);
        if (y + h - 1 >= 0 && y + h - 1 < height) img.setPixelColor(color, x + i, y + h - 1);
      }
    }
    for (let i = 0; i < h; i++) {
      if (y + i >= 0 && y + i < height) {
        if (x >= 0 && x < width) img.setPixelColor(color, x, y + i);
        if (x + w - 1 >= 0 && x + w - 1 < width) img.setPixelColor(color, x + w - 1, y + i);
      }
    }
  }
  return img;
}

async function main() {
  const calDir = process.argv[2];
  if (!calDir) {
    console.error('Usage: node scripts/calibrate-t3-slots.mjs <calibration-dir>');
    process.exit(1);
  }
  const cfg = parseT3SlotConfig(JSON.parse(readFileSync(SLOTS_PATH, 'utf8')));
  const camName = cfg.source; // 'real106' → ファイル名 'Real106.jpg'
  const imageName = camName.split('_').map((p, i) =>
    i === 0 ? p[0].toUpperCase() + p.slice(1) : p).join('_');
  const srcPath = join(calDir, `${imageName}.jpg`);
  if (!existsSync(srcPath)) {
    console.error(`source image not found: ${srcPath}`);
    process.exit(1);
  }
  const annotated = await annotateImage(srcPath, cfg);
  const outPath = join(calDir, `${imageName}_annotated.png`);
  await annotated.write(outPath);
  console.log(`[calibrate-t3] annotated: ${outPath}`);
  console.log(`  → このファイルを開いて 18マスが 9レーン × 2列 の先頭領域に重なるか確認`);
  console.log(`  → ズレがあれば ${SLOTS_PATH} の cx/cy/r を調整して再実行`);
}

main().catch(e => { console.error(`[calibrate-t3] fatal: ${e.message}`); process.exit(1); });
```

- [ ] **Step 3: 構文チェック**

Run: `node --check scripts/calibrate-t3-slots.mjs`

Expected: 出力なし

- [ ] **Step 4: 試走（Task 7 で取得したサンプルがある前提）**

Run:
```bash
ls data/calibration/t3/  # サンプルディレクトリ確認
node scripts/calibrate-t3-slots.mjs data/calibration/t3/$(ls -t data/calibration/t3/ | head -1)
```

Expected: `[calibrate-t3] annotated: data/calibration/t3/<ts>/Real106_annotated.png` のような出力。座標プレースホルダー (cx=cy=r=0) のため、すべてのマスは画像左上の点に集中して表示される（校正前の正常な状態）。

- [ ] **Step 5: Commit**

```bash
git add scripts/calibrate-t3-slots.mjs
git commit -m "$(cat <<'EOF'
feat(t3-slot): calibrate-t3-slots.mjs 校正支援スクリプト

snapshot-t3-cameras.mjs で取得した Real106.jpg に t3-stall-slots.json
の 18マスをオーバーレイした注釈 PNG を出力する。校正者は注釈画像を
見て cx/cy/r を調整→再実行のサイクルで 9レーン × 2列 の位置を確定する。
車種カテゴリで色分け (神奈川=赤・一般=緑・ワゴン=青・ECD=黄・ハイヤー=紫)。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: 校正実施（手動・実画像）

**Files:**
- Modify: `scripts/lib/t3-stall-slots.json` (18マスの座標を 0.0 から実値へ)

これは plan 内のコード作業ではなく、Mac mini と本人の協業作業。plan 完了の最終条件として明示しておく。

- [ ] **Step 1: Mac mini で snapshot-t3-cameras.mjs を実行**

Mac mini にログインして:
```bash
cd ~/repos/taxi-ic-helper
git pull --rebase origin main
node scripts/snapshot-t3-cameras.mjs
```

→ `data/calibration/t3/<timestamp>/Real106.jpg` と `Real107.jpg` が生成される

- [ ] **Step 2: 画像を iCloud Drive 経由でクライアントへ転送（または scp / Mac mini 共有経由）**

開発機の `乗務地図関係-wt-perspective/data/calibration/t3/` に同じ画像を配置する。

- [ ] **Step 3: source 選定**

Real106 と Real107 を両方開いて、9レーンが全部見えるカメラを選ぶ。デフォルト `real106` から変更が必要なら `t3-stall-slots.json` の `source` フィールドを更新。

- [ ] **Step 4: 座標反復調整**

`scripts/lib/t3-stall-slots.json` の 18マスの `cx, cy, r` を画像を見ながら手入力で更新 →
`node scripts/calibrate-t3-slots.mjs data/calibration/t3/<ts>` で注釈画像を再生成 → 画像を開いて確認 → 調整 → 再生成 を繰り返す。

各マスの目安:
- `cx, cy`: 1台分の駐車枠中心の正規化座標 (0-1)
- `r`: マスの半幅 (1台ぶん)、目安 0.015〜0.03 程度（実画像のスケール依存）

9レーン × 2列を「先頭2列」が covered になるよう配置。

- [ ] **Step 5: 確定後コミット**

```bash
git add scripts/lib/t3-stall-slots.json
git commit -m "$(cat <<'EOF'
chore(t3-slot): t3-stall-slots.json マス目座標を校正後の実値に更新

Mac mini で取得した Real106.jpg のサンプル画像を元に、18マスの
cx/cy/r を実画像から確定。calibrate-t3-slots.mjs の注釈画像で
9レーン × 2列が先頭領域に重なることを目視確認済み。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Mac mini への launchd ジョブ配備（手動・最終ステップ）

**Files:** Mac mini 側のみ（リポジトリには含めない）

`t3-slot-occupancy-tick.mjs` を Mac mini で定期実行するための launchd plist を作成・install する。これは plan のコード成果物ではなく**運用手順書**。

- [ ] **Step 1: Mac mini で 既存 launchd ジョブを確認**

```bash
launchctl list | grep taxi-ic-helper
```

期待: `jp.taxi-ic-helper.observe`（5分tick）と `jp.taxi-ic-helper.track`（60秒tick）が見える。

- [ ] **Step 2: 新規 launchd plist を作成**

Mac mini の `~/Library/LaunchAgents/jp.taxi-ic-helper.t3-slot.plist` を以下の内容で作成:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>jp.taxi-ic-helper.t3-slot</string>
  <key>WorkingDirectory</key>
  <string>/Users/<USER>/repos/taxi-ic-helper</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>scripts/t3-slot-occupancy-tick.mjs</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>/tmp/jp.taxi-ic-helper.t3-slot.out</string>
  <key>StandardErrorPath</key>
  <string>/tmp/jp.taxi-ic-helper.t3-slot.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

`<USER>` は Mac mini のユーザー名に置換。

- [ ] **Step 3: ジョブをロード**

```bash
launchctl load ~/Library/LaunchAgents/jp.taxi-ic-helper.t3-slot.plist
launchctl list | grep t3-slot   # ロードされたか確認
```

- [ ] **Step 4: 1分待って動作確認**

```bash
sleep 70
tail /tmp/jp.taxi-ic-helper.t3-slot.out
tail data/t3-slot-occupancy-history.jsonl
```

Expected: `[t3-slot] ok: total=N row1=N row2=N mode=day` がログに出る、history jsonl に行が追記される

- [ ] **Step 5: 翌日まで観測 → 実データ検証**

24時間後、開発機で:
```bash
cd 乗務地図関係-wt-perspective
git pull
cat data/t3-stall-actuals.json | head -20
```

Expected: `slots[].total` が時間帯ごとに数十〜数百のオーダーで変化、深夜（2-5時）は少なく、朝〜夕は多い（観測時間帯の総出庫数の感覚値と整合）。

---

## 完了条件チェックリスト

spec の「成功基準」と対応:

- [ ] **コード**: Task 1〜8 のコミットが `feat/front-slot-occupancy` に積まれ push されている
- [ ] **テスト**: Task 0 で記録したテスト数 + 21件（slots-parse 6 + occupancy-helpers 12 + observe-t3-actuals 3）が pass、既存テストが回帰なし
- [ ] **観測の隔離**: Task 5 のテストで T3 ブロックの隔離が確認済み
- [ ] **校正**: Task 9 完了、18マスが目視で 9レーン × 2列の先頭領域に重なる
- [ ] **実データ検証**: Task 10 Step 5 完了、24時間データで `total` が観測実態と整合

---

## 注意事項

- **commit に観測データファイルを混ぜない**: 各 Task の commit 前に `git diff --cached --name-only` で確認。混入したら `git restore --staged data/<file>`
- **push 前に `git pull --rebase --autostash origin main`**: HANDOFF.md の git運用鉄則
- **iCloud Drive 配下の worktree**: ファイル操作が稀にハングする報告あり（`タクシー日報-wt-prod-deploy` 事例）。本作業の `乗務地図関係-wt-perspective` も iCloud 配下だが実績で動いている。ハング検出時は `~/work/` 等 iCloud 外へ移すか別worktree新設
- **既存 T1/T2 ファイルには触れない**: spec の絶対要件。`scripts/slot-occupancy-tick.mjs`・`scripts/lib/stall-slots.json`・`scripts/lib/stall-rois.json` の編集は禁止
- **Mac mini 配備（Task 10）は本人が操作**: SSH 経由でも本人の直接操作でもOKだが、`launchctl load` は本人実行
