# T3 待機所 埋まり具合観測 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 羽田T3 第3待機所の前方(Real108)/後方(Real109)の埋まり具合(0〜100%)を計測して `data/t3-pool-fill.json` を生成し、日報アプリへ配信する。旧 slot-occupancy コードは撤去する。

**Architecture:** 既存 Phase E-1 観測(observe-taxi-pool.mjs)が5分tickで Real108/109 を取得しているので、そのbufferから駐車エリア ROI の占有度メトリクスを `analyzePoolImage` で計測し、空/満 baseline で正規化(`computeFillRatio`)して fillRatio にする。台数は数えず占有度ベース。新規カメラ解析ゼロ、既存 `analyzePoolImage`/`analyzeROI` を流用。

**Tech Stack:** Node.js 22 (.mjs) / node:test / Jimp / 既存 image-pool-analyzer.mjs / TDD 純関数中心

**Branch:** `feat/front-slot-occupancy`（origin/main 同期済み・main直push運用）
**Worktree:** `乗務地図関係-wt-perspective/`（T1/T2 と共有）

---

## ファイル構造

### 新規ファイル

| パス | 責務 |
|---|---|
| `scripts/lib/t3-pool-fill.mjs` | 純関数: computeFillRatio / fillLevel / approxCount / parseT3PoolRois / buildT3PoolFillPayload |
| `data/t3-pool-rois.json` | Real108/109 の駐車エリア ROI + 空/満 baseline + max_capacity（校正後確定、初期プレースホルダー）|
| `tests/t3-pool-fill.test.js` | 上記純関数のテスト |

### 修正ファイル

| パス | 修正 |
|---|---|
| `scripts/observe-taxi-pool.mjs` | 旧 T3 actuals ブロック撤去 + Phase E-1 に fill 計測追加 + t3-pool-fill.json 書き出し |
| `scripts/snapshot-t3-cameras.mjs` | TARGETS に Real108/Real109 追加 |
| `scripts/observe-tick-local.sh` | 旧 t3-slot配線撤去 + t3-pool-fill.json 追加 |
| `.gitattributes` | 旧 t3-slot-occupancy-history.jsonl 行撤去 |
| `.github/workflows/relay-taxi-data.yml` | FILES に t3-pool-fill.json 追加 + paths トリガー追加 |

### 削除ファイル（Task 1）

`scripts/t3-slot-occupancy-tick.mjs`, `scripts/lib/t3-occupancy-helpers.mjs`, `scripts/lib/t3-stall-slots.json`, `scripts/calibrate-t3-slots.mjs`, `tests/t3-stall-slots-parse.test.js`, `tests/t3-occupancy-helpers.test.js`, `tests/observe-t3-actuals.test.js`, `data/t3-slot-occupancy-history.jsonl`, `data/t3-stall-actuals.json`

---

## Task 0: ベースライン確認

**Files:** なし

- [ ] **Step 1: テスト数とブランチ確認**

Run:
```bash
cd 乗務地図関係-wt-perspective
git branch --show-current
git fetch origin main && git log --oneline HEAD..origin/main | head -3
npm test 2>&1 | tail -5
```

Expected: ブランチ `feat/front-slot-occupancy`。origin/main に未取得コミットがあれば `git pull --rebase --autostash origin main`（Mac mini の observe-tick が進んでいる）。テスト総数を記録（旧コード撤去で減る基準）。

---

## Task 1: 旧 slot-occupancy コード撤去

**Files:**
- Delete: 上記「削除ファイル」9点
- Modify: `scripts/observe-taxi-pool.mjs`, `scripts/observe-tick-local.sh`, `.gitattributes`

旧 Phase 1（9レーン slot-occupancy）は新設計で不要。撤去する。TDD ではなく「削除 → 回帰確認 → commit」。

- [ ] **Step 1: コード/テスト/データファイルを git rm**

```bash
git rm scripts/t3-slot-occupancy-tick.mjs scripts/lib/t3-occupancy-helpers.mjs scripts/lib/t3-stall-slots.json scripts/calibrate-t3-slots.mjs tests/t3-stall-slots-parse.test.js tests/t3-occupancy-helpers.test.js tests/observe-t3-actuals.test.js
git rm --cached data/t3-slot-occupancy-history.jsonl data/t3-stall-actuals.json 2>/dev/null || true
rm -f data/t3-slot-occupancy-history.jsonl data/t3-stall-actuals.json
```

`data/*` は `git rm --cached` + `rm`（観測データなので working tree からも消す。Mac mini 側は launchd 停止後に消える）。

- [ ] **Step 2: observe-taxi-pool.mjs から旧 T3 actuals を撤去**

`scripts/observe-taxi-pool.mjs` で以下3箇所を削除:

(a) import 行（26行目付近）:
```javascript
import { computeT3SlotActuals } from './lib/t3-occupancy-helpers.mjs';
```
→ 行ごと削除

(b) path 定数（53-54行目付近）:
```javascript
const T3_HISTORY_PATH = './data/t3-slot-occupancy-history.jsonl';
const T3_ACTUALS_OUTPUT_PATH = './data/t3-stall-actuals.json';
```
→ 2行とも削除

(c) T3 actuals 集計ブロック（365-385行目付近、`// T3 第5乗り場 actuals` コメントから始まる try/catch 全体）:
```javascript
    // T3 第5乗り場 actuals (15分スロット × total) を書き出す。
    // ... (computeT3SlotActuals を使う try/catch ブロック全体)
    } catch (e) {
      console.warn(`[observe] t3-stall-actuals write skipped: ${e.message}`);
    }
```
→ try/catch ブロックごと削除

- [ ] **Step 3: observe-tick-local.sh から旧 t3-slot 配線を撤去**

44行目・52行目の `git checkout HEAD --` から ` data/t3-stall-actuals.json` を削除。
77行目の `git add` から ` data/t3-slot-occupancy-history.jsonl data/t3-stall-actuals.json` を削除。

- [ ] **Step 4: .gitattributes から旧行を撤去**

`data/t3-slot-occupancy-history.jsonl merge=union` の行を削除。

- [ ] **Step 5: 構文チェック + テスト回帰**

Run:
```bash
node --check scripts/observe-taxi-pool.mjs
bash -n scripts/observe-tick-local.sh
npm test 2>&1 | tail -5
```

Expected: 構文OK。テストは Task 0 の数から **21件減**（削除した3テストファイル分: slots-parse 6 + occupancy-helpers 12 + observe-t3-actuals 3）。fail 0。

- [ ] **Step 6: Commit**

```bash
git add scripts/observe-taxi-pool.mjs scripts/observe-tick-local.sh .gitattributes
git commit -m "$(cat <<'EOF'
refactor(t3): 旧 slot-occupancy コード撤去（埋まり具合観測へ置き換え）

実画像確認で 9レーン slot-occupancy の前提（カメラに9レーンが映る）が
崩れたため、旧 Phase 1 一式を撤去。新「埋まり具合観測」は別コミットで
追加する。撤去対象: t3-slot-occupancy-tick.mjs / t3-occupancy-helpers.mjs
/ t3-stall-slots.json / calibrate-t3-slots.mjs / テスト3本 /
observe-taxi-pool.mjs の T3 actuals ブロック / observe-tick-local.sh と
.gitattributes の旧配線 / data の旧観測ファイル。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: t3-pool-fill.mjs 純関数

**Files:**
- Create: `scripts/lib/t3-pool-fill.mjs`
- Test: `tests/t3-pool-fill.test.js`

埋まり具合の正規化・ラベル・概算台数・ROIパース・payload整形の純関数群。

- [ ] **Step 1: 失敗するテストを書く**

Create `tests/t3-pool-fill.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFillRatio, fillLevel, approxCount, parseT3PoolRois, buildT3PoolFillPayload,
} from '../scripts/lib/t3-pool-fill.mjs';

test('computeFillRatio: empty baseline → 0', () => {
  assert.equal(computeFillRatio(0.10, 0.10, 0.50), 0);
});

test('computeFillRatio: full baseline → 1', () => {
  assert.equal(computeFillRatio(0.50, 0.10, 0.50), 1);
});

test('computeFillRatio: midpoint → 0.5', () => {
  assert.equal(computeFillRatio(0.30, 0.10, 0.50), 0.5);
});

test('computeFillRatio: below empty clamps to 0', () => {
  assert.equal(computeFillRatio(0.05, 0.10, 0.50), 0);
});

test('computeFillRatio: above full clamps to 1', () => {
  assert.equal(computeFillRatio(0.80, 0.10, 0.50), 1);
});

test('computeFillRatio: full==empty (degenerate) → 0', () => {
  assert.equal(computeFillRatio(0.30, 0.40, 0.40), 0);
});

test('fillLevel: thresholds 0.33 / 0.66', () => {
  assert.equal(fillLevel(0.0), '空き');
  assert.equal(fillLevel(0.32), '空き');
  assert.equal(fillLevel(0.33), '半分');
  assert.equal(fillLevel(0.65), '半分');
  assert.equal(fillLevel(0.66), '混雑');
  assert.equal(fillLevel(1.0), '混雑');
});

test('approxCount: ratio × capacity rounded', () => {
  assert.equal(approxCount(0.0, 50), 0);
  assert.equal(approxCount(0.5, 50), 25);
  assert.equal(approxCount(1.0, 50), 50);
  assert.equal(approxCount(0.87, 50), 44); // 43.5 → 44
});

test('parseT3PoolRois: extracts front/rear', () => {
  const cfg = parseT3PoolRois({
    schema_version: 1,
    areas: {
      front: { camera: 'Real108', roi: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, metric: 'edge_density', empty_baseline: 0.1, full_baseline: 0.5, max_capacity: 20 },
      rear: { camera: 'Real109', roi: { x: 0.0, y: 0.3, width: 0.9, height: 0.6 }, metric: 'edge_density', empty_baseline: 0.2, full_baseline: 0.6, max_capacity: 50 },
    },
  });
  assert.equal(cfg.front.camera, 'Real108');
  assert.equal(cfg.rear.max_capacity, 50);
  assert.equal(cfg.front.metric, 'edge_density');
});

test('parseT3PoolRois: throws on schema mismatch', () => {
  assert.throws(() => parseT3PoolRois({ schema_version: 2, areas: {} }), /schema_version/);
});

test('parseT3PoolRois: throws on missing areas', () => {
  assert.throws(() => parseT3PoolRois({ schema_version: 1 }), /areas/);
});

test('buildT3PoolFillPayload: both areas present', () => {
  const front = { camera: 'Real108', fillRatio: 0.15, level: '空き', approxCount: 3 };
  const rear = { camera: 'Real109', fillRatio: 0.88, level: '混雑', approxCount: 44 };
  const payload = buildT3PoolFillPayload(front, rear, new Date('2026-05-21T12:30:00+09:00'));
  assert.equal(payload.schemaVersion, 1);
  assert.equal(typeof payload.generatedAt, 'string');
  assert.deepEqual(payload.areas.front, front);
  assert.deepEqual(payload.areas.rear, rear);
});

test('buildT3PoolFillPayload: missing camera omitted', () => {
  const rear = { camera: 'Real109', fillRatio: 0.5, level: '半分', approxCount: 25 };
  const payload = buildT3PoolFillPayload(null, rear, new Date('2026-05-21T12:30:00+09:00'));
  assert.equal(payload.areas.front, undefined);
  assert.deepEqual(payload.areas.rear, rear);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test tests/t3-pool-fill.test.js`
Expected: FAIL — `Cannot find module '../scripts/lib/t3-pool-fill.mjs'`

- [ ] **Step 3: 純関数を実装**

Create `scripts/lib/t3-pool-fill.mjs`:

```javascript
// T3 第3待機所 埋まり具合（占有度）の純関数群。
// 駐車エリア ROI の占有度メトリクスを空/満 baseline で 0〜1 に正規化し、
// レベルラベルと概算台数を出す。台数は数えず占有度ベース。

export const LEVEL_HALF_THRESHOLD = 0.33;
export const LEVEL_BUSY_THRESHOLD = 0.66;

/**
 * 占有度メトリクスを空/満 baseline で 0〜1 に正規化する純関数。
 * @param {number} metric 計測値（edge_density か black_ratio）
 * @param {number} emptyBaseline 空っぽの時の metric 値
 * @param {number} fullBaseline 満杯の時の metric 値
 * @returns {number} 0〜1（範囲外はクランプ、full<=empty の異常時は 0）
 */
export function computeFillRatio(metric, emptyBaseline, fullBaseline) {
  const span = fullBaseline - emptyBaseline;
  if (!(span > 0)) return 0;
  const ratio = (metric - emptyBaseline) / span;
  if (ratio < 0) return 0;
  if (ratio > 1) return 1;
  return ratio;
}

/**
 * fillRatio を 3段階ラベルに変換する純関数。
 * @param {number} ratio 0〜1
 * @returns {string} '空き' | '半分' | '混雑'
 */
export function fillLevel(ratio) {
  if (ratio < LEVEL_HALF_THRESHOLD) return '空き';
  if (ratio < LEVEL_BUSY_THRESHOLD) return '半分';
  return '混雑';
}

/**
 * 概算台数 = fillRatio × エリア最大収容数（四捨五入）。
 * @param {number} ratio 0〜1
 * @param {number} maxCapacity エリア最大収容台数
 * @returns {number}
 */
export function approxCount(ratio, maxCapacity) {
  return Math.round(ratio * maxCapacity);
}

/**
 * t3-pool-rois.json を検証して front/rear を抽出する純関数。
 * @param {object} json
 * @returns {{front:object, rear:object}}
 */
export function parseT3PoolRois(json) {
  if (!json || json.schema_version !== 1) {
    throw new Error(`parseT3PoolRois: unsupported schema_version: ${json && json.schema_version}`);
  }
  if (!json.areas || !json.areas.front || !json.areas.rear) {
    throw new Error('parseT3PoolRois: areas.front/rear not found');
  }
  return { front: json.areas.front, rear: json.areas.rear };
}

/**
 * 表示用 payload を整形する純関数。null のエリアは省略。
 * @param {object|null} frontResult {camera, fillRatio, level, approxCount} or null
 * @param {object|null} rearResult 同上
 * @param {Date} now
 * @returns {object}
 */
export function buildT3PoolFillPayload(frontResult, rearResult, now) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const generatedAt = jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
  const areas = {};
  if (frontResult) areas.front = frontResult;
  if (rearResult) areas.rear = rearResult;
  return { schemaVersion: 1, generatedAt, areas };
}
```

- [ ] **Step 4: テスト通過確認**

Run: `node --test tests/t3-pool-fill.test.js`
Expected: PASS（13 tests）

- [ ] **Step 5: 全体テスト回帰**

Run: `npm test 2>&1 | tail -5`
Expected: PASS（Task 1 後の数 + 13）

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/t3-pool-fill.mjs tests/t3-pool-fill.test.js
git commit -m "$(cat <<'EOF'
feat(t3-fill): 埋まり具合 純関数（computeFillRatio ほか）

T3 第3待機所の占有度を空/満 baseline で 0〜1 に正規化する純関数群。
computeFillRatio / fillLevel(空き/半分/混雑) / approxCount /
parseT3PoolRois / buildT3PoolFillPayload。台数は数えず占有度ベース。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: t3-pool-rois.json テンプレート

**Files:**
- Create: `data/t3-pool-rois.json`
- Test: `tests/t3-pool-fill.test.js`（パーステストは Task 2 で実装済み。ここでは実ファイルの読み込み確認を追加）

座標・baseline・max_capacity は校正後確定するためプレースホルダー（0）。

- [ ] **Step 1: 実ファイル読み込みテストを追加**

Append to `tests/t3-pool-fill.test.js`:

```javascript
import { readFileSync } from 'node:fs';

test('t3-pool-rois.json: file parses with parseT3PoolRois', () => {
  const json = JSON.parse(readFileSync('./data/t3-pool-rois.json', 'utf8'));
  const cfg = parseT3PoolRois(json);
  assert.equal(cfg.front.camera, 'Real108');
  assert.equal(cfg.rear.camera, 'Real109');
  // metric は black_ratio か edge_density のいずれか
  assert.ok(['black_ratio', 'edge_density'].includes(cfg.front.metric));
  assert.ok(['black_ratio', 'edge_density'].includes(cfg.rear.metric));
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node --test tests/t3-pool-fill.test.js`
Expected: FAIL — `ENOENT: ... data/t3-pool-rois.json`

- [ ] **Step 3: テンプレート作成**

Create `data/t3-pool-rois.json`:

```json
{
  "_meta": {
    "image_size": [1024, 576],
    "note": "T3 第3待機所 前方(Real108)/後方(Real109) 駐車エリア占有度 ROI。roi/baseline/max_capacity は校正で確定。metric は校正で black_ratio か edge_density を選ぶ。"
  },
  "schema_version": 1,
  "areas": {
    "front": {
      "camera": "Real108",
      "roi": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0 },
      "metric": "edge_density",
      "empty_baseline": 0.0,
      "full_baseline": 0.0,
      "max_capacity": 0
    },
    "rear": {
      "camera": "Real109",
      "roi": { "x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0 },
      "metric": "edge_density",
      "empty_baseline": 0.0,
      "full_baseline": 0.0,
      "max_capacity": 0
    }
  }
}
```

- [ ] **Step 4: テスト通過確認**

Run: `node --test tests/t3-pool-fill.test.js`
Expected: PASS（14 tests = 13 + 1）

- [ ] **Step 5: Commit**

```bash
git add data/t3-pool-rois.json tests/t3-pool-fill.test.js
git commit -m "$(cat <<'EOF'
feat(t3-fill): t3-pool-rois.json テンプレート

Real108(前方)/Real109(後方) の駐車エリア ROI 定義。座標・baseline・
max_capacity はプレースホルダー(0)で、校正フェーズで実値確定する。
metric 既定 edge_density（校正で black_ratio と弁別力比較）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: snapshot-t3-cameras.mjs を Real108/109 取得対応に拡張

**Files:**
- Modify: `scripts/snapshot-t3-cameras.mjs`

校正サンプルに前方/後方プールも含める。

- [ ] **Step 1: TARGETS を拡張**

`scripts/snapshot-t3-cameras.mjs` の TARGETS 定数を変更:

```javascript
const TARGETS = ['Real106', 'Real107', 'Real108', 'Real109'];
```

（変更は1行のみ。他は不変。コメントも `Real106 / Real107 / Real108 / Real109 を取得` のように更新してよい）

- [ ] **Step 2: 構文チェック + 試走**

Run:
```bash
node --check scripts/snapshot-t3-cameras.mjs
node scripts/snapshot-t3-cameras.mjs
ls -la data/calibration/t3/$(ls -t data/calibration/t3/ | head -1)
```

Expected: 4枚（Real106/107/108/109）が保存される。ネットワーク不可なら DONE_WITH_CONCERNS で報告（構文チェックが通れば実装は完了）。

- [ ] **Step 3: Commit**

```bash
git add scripts/snapshot-t3-cameras.mjs
git commit -m "$(cat <<'EOF'
feat(t3-fill): snapshot-t3-cameras.mjs に Real108/109 追加

埋まり具合校正用に前方(Real108)/後方(Real109)プールのサンプルも
取得対象に追加。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: observe-taxi-pool.mjs に fill 計測を統合

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`

既存 Phase E-1 ステップ（Real108/109 を取得して t3-pool-history.jsonl 記録）に、駐車エリア ROI の占有度計測 → fillRatio → t3-pool-fill.json 書き出しを追加する。

参照: `analyzePoolImage(buffer, prev, roi)` は `roi` 指定時に `result.roi.edge_density` と `result.roi.roi_black_ratio`（どちらも ROI 内）を返す。

- [ ] **Step 1: import と path 定数を追加**

`scripts/observe-taxi-pool.mjs` の import 群に追加:
```javascript
import { computeFillRatio, fillLevel, approxCount, parseT3PoolRois, buildT3PoolFillPayload } from './lib/t3-pool-fill.mjs';
```

path 定数群に追加:
```javascript
const T3_POOL_ROIS_PATH = './data/t3-pool-rois.json';
const T3_POOL_FILL_OUTPUT_PATH = './data/t3-pool-fill.json';
```

注意: ROI ファイルは Task 3 で `data/t3-pool-rois.json` に作成済み。`./data/t3-pool-rois.json` を参照する。

- [ ] **Step 2: Phase E-1 ブロックに fill 計測を追加**

`scripts/observe-taxi-pool.mjs` の Phase E-1 ブロック（`// Phase E-1: T3乗り場・待機所プール観測` から始まる try、515行目付近）の中、`poolEntries` を集めるループの後・`buildAuxRow` で append する前に、以下を挿入:

```javascript
    // 埋まり具合: Real108(前方)/Real109(後方) の駐車エリア ROI 占有度を計測し
    // t3-pool-fill.json を書き出す。t3-pool-rois.json 未校正(baseline=0)なら skip。
    // poolEntries に roi_fill_ratio を後付けする。
    let fillFront = null, fillRear = null;
    try {
      if (existsSync(T3_POOL_ROIS_PATH)) {
        const roisCfg = parseT3PoolRois(JSON.parse(readFileSync(T3_POOL_ROIS_PATH, 'utf8')));
        for (const [areaKey, area] of [['front', roisCfg.front], ['rear', roisCfg.rear]]) {
          // baseline 未校正(full<=empty)なら skip
          if (!(area.full_baseline > area.empty_baseline)) continue;
          const buffer = await fetchImage(`https://ttc.taxi-inf.jp/${area.camera}.jpg`);
          const analyzed = await analyzePoolImage(buffer, null, area.roi);
          const metricVal = area.metric === 'black_ratio'
            ? (analyzed.roi?.roi_black_ratio ?? 0)
            : (analyzed.roi?.edge_density ?? 0);
          const ratio = computeFillRatio(metricVal, area.empty_baseline, area.full_baseline);
          const result = {
            camera: area.camera,
            fillRatio: Number(ratio.toFixed(3)),
            level: fillLevel(ratio),
            approxCount: approxCount(ratio, area.max_capacity),
          };
          if (areaKey === 'front') fillFront = result; else fillRear = result;
          // poolEntries の該当カメラに roi_fill_ratio を後付け
          const entry = poolEntries.find(e => e && e.name === area.camera);
          if (entry) entry.roi_fill_ratio = result.fillRatio;
        }
        if (fillFront || fillRear) {
          writeFileSync(T3_POOL_FILL_OUTPUT_PATH,
            JSON.stringify(buildT3PoolFillPayload(fillFront, fillRear, new Date()), null, 2) + '\n', 'utf8');
        }
      }
    } catch (e) {
      console.error(`[observe] t3-pool-fill failed: ${e.message}`);
    }
```

注意: `fetchImage` は既存（observe-taxi-pool.mjs 内で使用済み）。`analyzePoolImage` は既に import 済み（行16付近 `analyzePoolImage, analyzeStalls`）。`writeFileSync`/`readFileSync`/`existsSync` も import 済み。

- [ ] **Step 3: 構文チェック**

Run: `node --check scripts/observe-taxi-pool.mjs`
Expected: 出力なし

- [ ] **Step 4: 全テスト回帰**

Run: `npm test 2>&1 | tail -5`
Expected: PASS（テスト追加なし、Task 3 と同数）

- [ ] **Step 5: 単発実行で動作確認（ネットワーク必要・任意）**

Run: `node scripts/observe-taxi-pool.mjs 2>&1 | grep -i "t3-pool-fill\|aux ok" | head -5`
Expected: t3-pool-rois.json が未校正(baseline=0)なら fill 計測は skip され、エラーも出ない（`aux ok` は出る）。校正後は t3-pool-fill.json が生成される。観測データが生成されたら commit に含めないこと（次 Step で確認）。

- [ ] **Step 6: 観測データを除外して Commit**

```bash
git checkout HEAD -- data/taxi-pool-history.jsonl data/t3-pool-history.jsonl 2>/dev/null || true
git status --porcelain data/  # data/t3-pool-fill.json 等が残っていないか確認、あれば rm
rm -f data/t3-pool-fill.json
git add scripts/observe-taxi-pool.mjs
git commit -m "$(cat <<'EOF'
feat(t3-fill): observe-taxi-pool.mjs に埋まり具合計測を統合

Phase E-1 で Real108/109 の駐車エリア ROI 占有度を analyzePoolImage で
計測し、computeFillRatio で正規化して t3-pool-fill.json を書き出す。
poolEntries に roi_fill_ratio を後付け。t3-pool-rois.json 未校正
(baseline=0)時は skip。独立 try/catch で既存 Phase E-1/forecast を
巻き込まない。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 配線（observe-tick-local.sh + relay-taxi-data.yml）

**Files:**
- Modify: `scripts/observe-tick-local.sh`, `.github/workflows/relay-taxi-data.yml`

- [ ] **Step 1: observe-tick-local.sh に t3-pool-fill.json を追加**

44行目・52行目の `git checkout HEAD --`（再生成系破棄）の末尾に ` data/t3-pool-fill.json` を追加（再生成系のため）。
77行目の `git add` の末尾に ` data/t3-pool-fill.json` を追加。
（`data/t3-pool-history.jsonl` は既存で git add 済み、`roi_fill_ratio` 追加は append-only の既存ファイルに乗るので追加配線不要）

- [ ] **Step 2: relay-taxi-data.yml に t3-pool-fill.json を追加**

`.github/workflows/relay-taxi-data.yml`:
- `paths` トリガー（17-18行目付近の `- 'data/arrivals.json'` 群）に追加:
  ```yaml
      - 'data/t3-pool-fill.json'
  ```
- `FILES` 行（56行目付近）を変更:
  ```bash
          FILES="arrivals.json stall-ensemble.json stall-actuals.json t3-pool-fill.json"
  ```

- [ ] **Step 3: 構文チェック**

Run: `bash -n scripts/observe-tick-local.sh`
Expected: 出力なし。（yml は構文チェックツールがあれば `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/relay-taxi-data.yml'))"`、なければ目視）

- [ ] **Step 4: Commit**

```bash
git add scripts/observe-tick-local.sh .github/workflows/relay-taxi-data.yml
git commit -m "$(cat <<'EOF'
feat(t3-fill): t3-pool-fill.json の配線（観測commit + relay配信）

observe-tick-local.sh の git add と再生成系破棄に t3-pool-fill.json を
追加。relay-taxi-data.yml の FILES と paths トリガーに t3-pool-fill.json
を追加し、日報アプリ dev/prod へ配信する。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: 校正（手動・実画像）

**Files:**
- Modify: `data/t3-pool-rois.json`（プレースホルダー → 実値）

plan 内のコード作業ではなく実画像を見ながらの校正。完了の最終条件として明示。

- [ ] **Step 1: サンプル取得**

```bash
node scripts/snapshot-t3-cameras.mjs
```
→ `data/calibration/t3/<ts>/Real108.jpg` `Real109.jpg` が生成される。

- [ ] **Step 2: 駐車エリア ROI を記入**

`data/t3-pool-rois.json` の front(Real108)/rear(Real109) の `roi`（x/y/width/height 正規化 0〜1）を、画像で駐車スペースを囲む矩形に設定。空(前方)・建物/芝生(後方の上部)を避けて駐車エリアだけを囲む。

- [ ] **Step 3: 空/満 baseline と max_capacity を確定**

- `empty_baseline`: 空っぽに近い時間帯（前方は日中よく空く）の metric 値
- `full_baseline`: 満杯時（後方の混雑時）の metric 値
- `max_capacity`: 各エリアの目測最大収容台数
- `metric`: edge_density と black_ratio の両方を空/満サンプルで比較し、差が大きい（弁別力が高い）方を選ぶ

確認用に単発計測:
```bash
node -e "import('./scripts/lib/image-pool-analyzer.mjs').then(async m => { const fs=await import('node:fs'); const buf=fs.readFileSync('data/calibration/t3/<ts>/Real109.jpg'); const r=await m.analyzePoolImage(buf, null, {x:0.0,y:0.3,width:0.9,height:0.6}); console.log('edge', r.roi.edge_density, 'black', r.roi.roi_black_ratio); })"
```

- [ ] **Step 4: 確定後コミット**

```bash
git add data/t3-pool-rois.json
git commit -m "$(cat <<'EOF'
chore(t3-fill): t3-pool-rois.json を校正後の実値に更新

Real108/109 の駐車エリア ROI 矩形・空/満 baseline・max_capacity を
実画像から確定。metric は弁別力比較で選定。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin feat/front-slot-occupancy:main
```

---

## Task 8: Mac mini の旧 launchd 停止（手動）

**Files:** Mac mini 側のみ

旧 slot-occupancy の launchd ジョブを停止する。新観測は observe 本体に統合済みなので**新 launchd は不要**。

- [ ] **Step 1: 旧ジョブ停止・アンロード**

Mac mini で:
```bash
launchctl unload ~/Library/LaunchAgents/jp.taxi-ic-helper.t3-slot.plist
rm ~/Library/LaunchAgents/jp.taxi-ic-helper.t3-slot.plist
launchctl list | grep t3-slot   # 消えていることを確認（出力なしが正常）
```

- [ ] **Step 2: 最新コードを取り込み**

```bash
cd ~/repos/taxi-ic-helper
git pull --rebase --autostash origin main
```
→ 旧ファイル削除 + 新 fill 計測が反映される。次の observe-tick（5分毎）から t3-pool-fill.json が生成される（校正済みなら）。

- [ ] **Step 3: 動作確認（校正後・数tick待ち）**

```bash
cat data/t3-pool-fill.json
```
Expected: front/rear の fillRatio/level/approxCount が出る。時間帯と整合（深夜＝空きがち、混雑時＝後方満杯）。

---

## 完了条件チェックリスト

spec の成功基準と対応:

- [ ] **コード**: Task 1〜6 のコミットが push されている
- [ ] **テスト**: t3-pool-fill のテスト14件が pass、旧テスト21件削除後も既存テスト回帰なし
- [ ] **旧コード撤去**: 旧 slot-occupancy ファイル・テスト・配線が削除、launchd 停止手順を本人に渡す
- [ ] **観測の隔離**: fill 計測ブロックが独立 try/catch で Phase E-1/forecast を巻き込まない
- [ ] **校正**: Real108/109 の ROI が駐車スペースを覆い、空/満で fillRatio が 0付近/1付近
- [ ] **実データ検証**: t3-pool-fill.json の前方/後方 fillRatio が時間帯と整合

---

## 注意事項

- **commit に観測データを混ぜない**: 各 commit 前に `git diff --cached --name-only` で確認。`data/*.jsonl` / `data/t3-pool-fill.json` / `data/taxi-pool-history.jsonl` が混入したら `git restore --staged` か `git checkout HEAD --`
- **push 前に `git pull --rebase --autostash origin main`**: Mac mini observe-tick が並行で main を進める
- **既存 T1/T2 ファイルに触れない**: slot-occupancy.mjs / slot-actuals.mjs / stall-slots.json / stall-rois.json は不変
- **computeT3DirectionalCorrection は不変**: Real106 black_ratio を読む既存処理。本作業は別データ出力なので触らない
- **Mac mini 配備（Task 8）は本人操作**: launchctl は本人実行
