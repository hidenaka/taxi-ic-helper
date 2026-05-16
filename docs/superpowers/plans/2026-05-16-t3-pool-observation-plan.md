# T3乗り場・待機所プール観測 実装プラン (Phase E-1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 既存観測と並行して、毎 tick で T3乗り場 (Real106/107) と待機所プール (Real03/04/108/109) の6画像メトリクスを収集し、独立した新ファイル `data/t3-pool-history.jsonl` に蓄積する。

**Architecture:** 純関数モジュール `aux-observation.mjs` (画像エントリ整形・前tick参照・行組み立て) を新設。`observe-taxi-pool.mjs` の末尾に収集ステップを追加 (try/catch で fail-safe)。既存の `analyzePoolImage` を全画面 ROI で再利用。`taxi-pool-history.jsonl` (schema v3) と forecast/accuracy/ensemble/correction は一切変更しない。

**Tech Stack:** ES Modules / `node:test` + `node:assert/strict` / Jimp / 既存 launchd ジョブ

**設計ドキュメント:** `docs/superpowers/specs/2026-05-16-t3-pool-observation-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/lib/aux-observation.mjs` | Create | 純関数: `buildAuxImageEntry` / `findPrevAuxImage` / `buildAuxRow` + 定数 |
| `tests/aux-observation.test.mjs` | Create | 単体テスト 7 件 |
| `data/t3-pool-history.jsonl` | Create (生成物) | T3乗り場・プール観測の append-only ログ |
| `scripts/observe-taxi-pool.mjs` | Modify | 末尾に E-1 収集ステップを追加 |
| `scripts/observe-tick-local.sh` | Modify | `git add` 対象に `t3-pool-history.jsonl` 追加 |
| `.gitattributes` | Modify | `t3-pool-history.jsonl merge=union` 追加 |

実装順序: **純関数 + テスト先行 (TDD) → observe-tick 統合 + 配線 → 単発実行確認 + push**。

既存 API の前提 (確認済み):
- `fetchImage(url)` (observe-taxi-pool.mjs 内) → `Buffer` を返す。
- `analyzePoolImage(buffer, prev, roi)` (image-pool-analyzer.mjs) → `{sha256, size_bytes, black_ratio, diff_from_prev, roi?:{edge_density, roi_black_ratio, luminance_mean, luminance_std, diff_edge_from_prev}}`。`roi` を渡すと `.roi` を追加。`clipRoi` が ROI を実画像サイズにクリップするため、巨大 ROI を渡せば全画面解析になる。`diff_from_prev` は `prev.black_ratio` から算出。
- `observe-taxi-pool.mjs` 内に tick 変数 `ts` (JST ISO) と `tickSeq` (連番) が既にある。

---

## Task 1: `aux-observation.mjs` 純関数モジュール (TDD)

**Files:**
- Create: `scripts/lib/aux-observation.mjs`
- Create: `tests/aux-observation.test.mjs`

- [ ] **Step 1.1: 失敗テスト 7 件を作成**

`tests/aux-observation.test.mjs` の内容:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  buildAuxImageEntry, findPrevAuxImage, buildAuxRow,
  AUX_SCHEMA_VERSION, T3_STAND_IMAGES, POOL_IMAGES,
} from '../scripts/lib/aux-observation.mjs';

test('定数: 観測対象画像とスキーマ版', () => {
  assert.deepEqual(T3_STAND_IMAGES, ['Real106', 'Real107']);
  assert.deepEqual(POOL_IMAGES, ['Real03', 'Real04', 'Real108', 'Real109']);
  assert.equal(AUX_SCHEMA_VERSION, 1);
});

test('buildAuxImageEntry: 完全な結果 → フラットなエントリ', () => {
  const analyzeResult = {
    sha256: 'abc', size_bytes: 13961, black_ratio: 0.05, diff_from_prev: 0.03,
    roi: { edge_density: 0.12, roi_black_ratio: 0.05, luminance_mean: 180.2, luminance_std: 40.1, diff_edge_from_prev: null },
  };
  const e = buildAuxImageEntry('Real106', analyzeResult);
  assert.equal(e.name, 'Real106');
  assert.equal(e.sha256, 'abc');
  assert.equal(e.size_bytes, 13961);
  assert.equal(e.black_ratio, 0.05);
  assert.equal(e.edge_density, 0.12);
  assert.equal(e.luminance_mean, 180.2);
  assert.equal(e.luminance_std, 40.1);
  assert.equal(e.diff_from_prev, 0.03);
});

test('buildAuxImageEntry: roi 欠損 → edge_density 等は null', () => {
  const analyzeResult = { sha256: 'x', size_bytes: 100, black_ratio: 0.1, diff_from_prev: null };
  const e = buildAuxImageEntry('Real107', analyzeResult);
  assert.equal(e.edge_density, null);
  assert.equal(e.luminance_mean, null);
  assert.equal(e.luminance_std, null);
  assert.equal(e.diff_from_prev, null);
  assert.equal(e.black_ratio, 0.1);
});

test('findPrevAuxImage: prevRow null → null', () => {
  assert.equal(findPrevAuxImage(null, 't3_stand', 'Real106'), null);
});

test('findPrevAuxImage: 該当グループ・画像 → エントリ', () => {
  const prevRow = {
    t3_stand: [{ name: 'Real106', black_ratio: 0.04 }, { name: 'Real107', black_ratio: 0.08 }],
    pool: [{ name: 'Real03', black_ratio: 0.11 }],
  };
  assert.equal(findPrevAuxImage(prevRow, 't3_stand', 'Real107').black_ratio, 0.08);
  assert.equal(findPrevAuxImage(prevRow, 'pool', 'Real03').black_ratio, 0.11);
});

test('findPrevAuxImage: 該当なし → null', () => {
  const prevRow = { t3_stand: [{ name: 'Real106' }], pool: [] };
  assert.equal(findPrevAuxImage(prevRow, 't3_stand', 'Real999'), null);
  assert.equal(findPrevAuxImage(prevRow, 'pool', 'Real03'), null);
});

test('buildAuxRow: 行を組み立てる', () => {
  const row = buildAuxRow('2026-05-16T11:14:27+09:00', 1162, [{ name: 'Real106' }], [{ name: 'Real03' }]);
  assert.equal(row.schema_version, 1);
  assert.equal(row.ts, '2026-05-16T11:14:27+09:00');
  assert.equal(row.tick_seq, 1162);
  assert.equal(row.t3_stand.length, 1);
  assert.equal(row.pool.length, 1);
});
```

- [ ] **Step 1.2: テスト実行 → 失敗確認**

Run: `node --test tests/aux-observation.test.mjs`
Expected: FAIL (`Cannot find module '../scripts/lib/aux-observation.mjs'`)

- [ ] **Step 1.3: `aux-observation.mjs` を実装**

`scripts/lib/aux-observation.mjs` の内容:

```javascript
/**
 * T3乗り場・待機所プール観測 (Phase E-1)。
 *
 * 設計: docs/superpowers/specs/2026-05-16-t3-pool-observation-design.md
 *
 * ttc.taxi-inf.jp の T3乗り場 (No5TaxiStand) と待機所プール (no23) の
 * 画像メトリクスを t3-pool-history.jsonl の行に整形する純関数群 (副作用なし)。
 */

export const AUX_SCHEMA_VERSION = 1;
export const T3_STAND_IMAGES = ['Real106', 'Real107'];
export const POOL_IMAGES = ['Real03', 'Real04', 'Real108', 'Real109'];
// analyzePoolImage に渡す全画面 ROI (clipRoi が実画像サイズにクリップする)。
export const FULL_FRAME_ROI = { x: 0, y: 0, width: 100000, height: 100000 };

function numOrNull(v) {
  return typeof v === 'number' ? v : null;
}

/**
 * analyzePoolImage の結果を t3-pool-history の画像エントリ (フラット) に整形する。
 *
 * @param {string} name           画像名 (例 'Real106')
 * @param {Object} analyzeResult  analyzePoolImage(buffer, prev, FULL_FRAME_ROI) の戻り値
 * @returns {Object} {name, sha256, size_bytes, black_ratio, edge_density, luminance_mean, luminance_std, diff_from_prev}
 */
export function buildAuxImageEntry(name, analyzeResult) {
  const r = analyzeResult || {};
  const roi = r.roi || {};
  return {
    name,
    sha256: r.sha256 ?? null,
    size_bytes: numOrNull(r.size_bytes),
    black_ratio: numOrNull(r.black_ratio),
    edge_density: numOrNull(roi.edge_density),
    luminance_mean: numOrNull(roi.luminance_mean),
    luminance_std: numOrNull(roi.luminance_std),
    diff_from_prev: numOrNull(r.diff_from_prev),
  };
}

/**
 * 前 tick の aux 行から、あるグループのある画像名のエントリを返す。
 * analyzePoolImage の prev 引数 (diff_from_prev 算出に prev.black_ratio を使う) に渡す。
 *
 * @param {Object|null} prevRow  t3-pool-history.jsonl の最終行
 * @param {string} group         't3_stand' または 'pool'
 * @param {string} name          画像名
 * @returns {Object|null}
 */
export function findPrevAuxImage(prevRow, group, name) {
  if (!prevRow || !Array.isArray(prevRow[group])) return null;
  return prevRow[group].find(e => e && e.name === name) || null;
}

/**
 * t3-pool-history.jsonl の 1 行を組み立てる。
 *
 * @param {string} ts             tick タイムスタンプ (JST ISO)
 * @param {number} tickSeq        tick 連番
 * @param {Array} t3StandEntries  T3乗り場画像エントリ配列
 * @param {Array} poolEntries     待機所プール画像エントリ配列
 * @returns {Object}
 */
export function buildAuxRow(ts, tickSeq, t3StandEntries, poolEntries) {
  return {
    schema_version: AUX_SCHEMA_VERSION,
    ts,
    tick_seq: tickSeq,
    t3_stand: t3StandEntries,
    pool: poolEntries,
  };
}
```

- [ ] **Step 1.4: テスト実行 → パス**

Run: `node --test tests/aux-observation.test.mjs`
Expected: PASS (7 件)

- [ ] **Step 1.5: 全テストスイート (回帰確認)**

Run: `npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 401 件パス (394 + 7)、fail 0

- [ ] **Step 1.6: commit**

```bash
git add scripts/lib/aux-observation.mjs tests/aux-observation.test.mjs
git commit -m "feat(observe): add aux-observation pure functions (T3 stand + pool)"
```

---

## Task 2: `observe-taxi-pool.mjs` 統合 + 配線

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`
- Modify: `scripts/observe-tick-local.sh`
- Modify: `.gitattributes`

- [ ] **Step 2.1: import 追加**

`scripts/observe-taxi-pool.mjs` の変更前:

```javascript
import {
  computeShareCorrection, computeLevelCorrection, applyLevelCorrection,
  CORRECTION_SCHEMA_VERSION,
} from './lib/correction-engine.mjs';
```

変更後:

```javascript
import {
  computeShareCorrection, computeLevelCorrection, applyLevelCorrection,
  CORRECTION_SCHEMA_VERSION,
} from './lib/correction-engine.mjs';
import {
  T3_STAND_IMAGES, POOL_IMAGES, FULL_FRAME_ROI,
  buildAuxImageEntry, findPrevAuxImage, buildAuxRow,
} from './lib/aux-observation.mjs';
```

- [ ] **Step 2.2: 定数追加**

変更前:

```javascript
const CORRECTIONS_OUTPUT_PATH = './data/coefficient-corrections.json';
const TRANSIT_SHARE_PATH = './data/transit-share.json';
```

変更後:

```javascript
const CORRECTIONS_OUTPUT_PATH = './data/coefficient-corrections.json';
const TRANSIT_SHARE_PATH = './data/transit-share.json';
const T3_POOL_HISTORY_PATH = './data/t3-pool-history.jsonl';
```

- [ ] **Step 2.3: E-1 収集ステップを追加**

D-2 ブロックの閉じ (`console.error(\`[observe] ensemble generation failed: ${e.message}\`);` を含む catch の後) と `  console.log(\`[observe] img1 edge=...` の間に挿入:

```javascript

  // Phase E-1: T3乗り場・待機所プール観測 (収集のみ、独立ファイル t3-pool-history.jsonl)
  try {
    let prevAuxRow = null;
    if (existsSync(T3_POOL_HISTORY_PATH)) {
      const auxLines = readFileSync(T3_POOL_HISTORY_PATH, 'utf8').trim().split('\n');
      for (let i = auxLines.length - 1; i >= 0; i--) {
        if (!auxLines[i].trim()) continue;
        try { prevAuxRow = JSON.parse(auxLines[i]); break; } catch { /* skip bad line */ }
      }
    }
    const observeAux = async (name, group) => {
      const buffer = await fetchImage(`https://ttc.taxi-inf.jp/${name}.jpg`);
      const prev = findPrevAuxImage(prevAuxRow, group, name);
      const analyzed = await analyzePoolImage(buffer, prev, FULL_FRAME_ROI);
      return buildAuxImageEntry(name, analyzed);
    };
    const t3StandEntries = [];
    for (const name of T3_STAND_IMAGES) {
      try { t3StandEntries.push(await observeAux(name, 't3_stand')); }
      catch (e) { console.error(`[observe] aux ${name} failed: ${e.message}`); }
    }
    const poolEntries = [];
    for (const name of POOL_IMAGES) {
      try { poolEntries.push(await observeAux(name, 'pool')); }
      catch (e) { console.error(`[observe] aux ${name} failed: ${e.message}`); }
    }
    if (t3StandEntries.length > 0 || poolEntries.length > 0) {
      const auxRow = buildAuxRow(ts, tickSeq, t3StandEntries, poolEntries);
      appendFileSync(T3_POOL_HISTORY_PATH, JSON.stringify(auxRow) + '\n', 'utf8');
      console.log(`[observe] aux ok: t3_stand=${t3StandEntries.length} pool=${poolEntries.length}`);
    } else {
      console.error('[observe] aux: all images failed, skip append');
    }
  } catch (e) {
    console.error(`[observe] aux observation failed: ${e.message}`);
  }
```

- [ ] **Step 2.4: 構文チェック**

```bash
node --check scripts/observe-taxi-pool.mjs && echo "syntax OK"
```

期待: `syntax OK`

- [ ] **Step 2.5: `observe-tick-local.sh` の git add に追加**

変更前:

```bash
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json 2>/dev/null || true
```

変更後:

```bash
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json data/t3-pool-history.jsonl 2>/dev/null || true
```

注: `t3-pool-history.jsonl` は append-only なので、pull 前 `git checkout HEAD --` の対象には**追加しない** (観測行を捨てないため)。`taxi-pool-history.jsonl` と同じ扱い。

- [ ] **Step 2.6: `.gitattributes` に merge=union を追加**

`.gitattributes` の末尾 (`data/taxi-pool-history.jsonl merge=union` の行の後) に追加:

```
data/t3-pool-history.jsonl merge=union
```

- [ ] **Step 2.7: 構文チェック (シェル)**

```bash
bash -n scripts/observe-tick-local.sh && echo "syntax OK"
```

期待: `syntax OK`

- [ ] **Step 2.8: 単発実行 → t3-pool-history.jsonl 生成確認**

```bash
node scripts/observe-taxi-pool.mjs 2>&1 | grep -E "\[observe\] (aux|ensemble)"
python3 -c "
import json
with open('data/t3-pool-history.jsonl') as f:
    row = json.loads(f.readlines()[-1])
print('schema_version:', row['schema_version'])
print('t3_stand:', [e['name'] for e in row['t3_stand']])
print('pool:', [e['name'] for e in row['pool']])
print('sample entry:', json.dumps(row['t3_stand'][0] if row['t3_stand'] else row['pool'][0], ensure_ascii=False))
"
```

期待: `[observe] aux ok: t3_stand=2 pool=4` (ネットワーク次第で件数は前後しうる)。`schema_version: 1`、`t3_stand` に Real106/107、`pool` に Real03/04/108/109。サンプルエントリに `name`/`sha256`/`size_bytes`/`black_ratio`/`edge_density`/`luminance_mean`/`luminance_std`/`diff_from_prev` がある。

- [ ] **Step 2.9: 全テスト (回帰確認)**

```bash
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```

期待: 401 件パス、fail 0。

- [ ] **Step 2.10: commit**

```bash
git add scripts/observe-taxi-pool.mjs scripts/observe-tick-local.sh .gitattributes data/t3-pool-history.jsonl
git commit -m "feat(observe): collect T3 stand + pool images into t3-pool-history.jsonl"
```

---

## Task 3: 最終整合 + push

- [ ] **Step 3.1: scope check (触ったファイル一覧)**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
git log origin/main..HEAD --name-only --pretty=format:'%h %s'
```

期待: 触ったのは以下のみ:
- `scripts/lib/aux-observation.mjs`
- `tests/aux-observation.test.mjs`
- `data/t3-pool-history.jsonl`
- `scripts/observe-taxi-pool.mjs`
- `scripts/observe-tick-local.sh`
- `.gitattributes`
- (docs の spec / plan)

`taxi-pool-history.jsonl` / `forecast-engine.mjs` / `accuracy-evaluator.mjs` / `ensemble-engine.mjs` / `correction-engine.mjs` / `transit-share.json` は含まれないこと。

- [ ] **Step 3.2: 全テスト最終パス**

```bash
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```

期待: 401 件パス、fail 0。

- [ ] **Step 3.3: git pull --rebase --autostash で観測 push との衝突回避**

```bash
git pull --rebase --autostash origin main 2>&1 | tail -5
```

autostash 適用でコンフリクトが出た場合は **`git reset --hard` を使わないこと**。再生成系 JSON (`data/stall-*.json` / `data/forecast-accuracy.json` / `data/coefficient-corrections.json`) のみ `git checkout HEAD --` で破棄し、append-only の `data/taxi-pool-history.jsonl` と `data/t3-pool-history.jsonl` の未コミット観測行は working tree に残す (次の observe-tick がコミットする)。解決後、`git stash list` に残った autostash を `git stash drop` する。

- [ ] **Step 3.4: push (3 回までリトライ)**

```bash
for i in 1 2 3; do
  if git push origin main; then
    echo "[push ok attempt $i]"
    break
  fi
  echo "[retry $i]"
  git pull --rebase --autostash origin main
  sleep 2
done
```

- [ ] **Step 3.5: 完了報告**

最終状態を要約。Mac mini 側は次 tick で git pull → E-1 収集ステップが稼働し、毎 tick で `t3-pool-history.jsonl` に追記が始まる。

---

## 検証コマンド一覧 (チートシート)

```bash
# 個別テスト
node --test tests/aux-observation.test.mjs

# 全テスト
npm test

# observe-tick 単発実行
node scripts/observe-taxi-pool.mjs

# 生成ログの最終行
python3 -c "import json; print(json.dumps(json.loads(open('data/t3-pool-history.jsonl').readlines()[-1]), indent=2, ensure_ascii=False))"
```

---

## 完了条件 (再掲)

- [ ] `npm test` 全件パス (394 → 401 件)
- [ ] `scripts/lib/aux-observation.mjs` が純関数として実装 (`buildAuxImageEntry` / `findPrevAuxImage` / `buildAuxRow`)
- [ ] `observe-taxi-pool.mjs` が毎 tick で6画像を取得し `data/t3-pool-history.jsonl` に schema v1 の行を追記
- [ ] 行に `t3_stand` (Real106/107) と `pool` (Real03/04/108/109)、各エントリに8キーがある
- [ ] E-1 ステップ失敗時も `taxi-pool-history.jsonl` 追記と既存処理が継続 (try/catch)
- [ ] `observe-tick-local.sh` の git add に `t3-pool-history.jsonl` 追加、`.gitattributes` に merge=union 追加
- [ ] `taxi-pool-history.jsonl` (schema v3) と forecast/accuracy/ensemble/correction 系は不変
