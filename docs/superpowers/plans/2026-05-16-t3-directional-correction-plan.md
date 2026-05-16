# T3需要圧力 方向性補正 実装プラン (Phase E-2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** E-1 が収集中の `t3-pool-history.jsonl` の Real106 `black_ratio` から T3 需要圧力を算出し、D-4 で `unobservable` だった `coefficient-corrections.json` の `share.<bucket>.T3` を方向性補正 (`directional`) に格上げする。

**Architecture:** 純関数 `computeT3DirectionalCorrection` を `correction-engine.mjs` に追加。observe-tick の D-3 ブロックで `computeShareCorrection` 後に T3 を方向性補正で上書き。`computeShareCorrection` / `buildEffectiveTransitShare` (D-4) と E-1 の収集ステップは不変。新規 ROI 校正なし。

**Tech Stack:** ES Modules / `node:test` + `node:assert/strict` / 既存 launchd ジョブ

**設計ドキュメント:** `docs/superpowers/specs/2026-05-16-t3-directional-correction-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/lib/correction-engine.mjs` | Modify | `computeT3DirectionalCorrection` + 定数追加、`CORRECTION_SCHEMA_VERSION` → 3 |
| `tests/correction-engine.test.mjs` | Modify | `computeT3DirectionalCorrection` のテスト 6 件追加 |
| `scripts/observe-taxi-pool.mjs` | Modify | D-3 ブロックで T3 を方向性補正に上書き |
| `js/forecast-render.js` | Modify | `renderCorrections` の T3 セルが `directional` を表示 |

実装順序: **純関数 + テスト先行 (TDD) → observe-tick 統合 → フロント表示 → 最終整合 + push**。

`computeT3DirectionalCorrection` は既存の `ymdOf` / `pickBucket` / `clipFactor` (correction-engine.mjs 内、D-3/D-4 で定義済) を使う。

---

## Task 1: `computeT3DirectionalCorrection` の実装 (TDD)

**Files:**
- Modify: `scripts/lib/correction-engine.mjs`
- Modify: `tests/correction-engine.test.mjs`

- [ ] **Step 1.1: テスト 6 件を追加**

`tests/correction-engine.test.mjs` の末尾に追加:

```javascript

// --- computeT3DirectionalCorrection (Phase E-2) ---

import { computeT3DirectionalCorrection } from '../scripts/lib/correction-engine.mjs';

// transit-share フィクスチャ (noon/peak1/evening バケット)
const T3_TS = {
  buckets: [
    { id: 'noon', fromHHMM: '12:00', toHHMM: '15:00', rates: { T1: 0.035, T2: 0.035, T3: 0.040 } },
    { id: 'peak1', fromHHMM: '17:00', toHHMM: '19:00', rates: { T1: 0.060, T2: 0.060, T3: 0.055 } },
    { id: 'evening', fromHHMM: '19:00', toHHMM: '21:30', rates: { T1: 0.035, T2: 0.035, T3: 0.045 } },
  ],
};
const T3_NOW = new Date('2026-06-03T10:00:00+09:00');

// hhmm (例 '13:00') の完了日 (6/2) tick を n 件、Real106 black_ratio=br で作る
function t3Rows(hhmm, n, br) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      ts: `2026-06-02T${hhmm}:00+09:00`,
      t3_stand: [{ name: 'Real106', black_ratio: br }, { name: 'Real107', black_ratio: 0.1 }],
      pool: [],
    });
  }
  return rows;
}

test('computeT3DirectionalCorrection: 0 件 → 全バケット fallback', () => {
  const r = computeT3DirectionalCorrection([], T3_TS, T3_NOW);
  assert.equal(r.noon.source, 'fallback');
  assert.equal(r.noon.factor, 1.0);
  assert.equal(r.peak1.source, 'fallback');
});

test('computeT3DirectionalCorrection: 当日データのみ → fallback (完了日なし)', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push({ ts: '2026-06-03T13:00:00+09:00', t3_stand: [{ name: 'Real106', black_ratio: 0.1 }], pool: [] });
  }
  const r = computeT3DirectionalCorrection(rows, T3_TS, T3_NOW);
  assert.equal(r.noon.source, 'fallback');
});

test('computeT3DirectionalCorrection: 全バケット均一活性 → factor ≈ 1.0', () => {
  const rows = [...t3Rows('13:00', 25, 0.1), ...t3Rows('18:00', 25, 0.1)];
  const r = computeT3DirectionalCorrection(rows, T3_TS, T3_NOW);
  assert.equal(r.noon.factor, 1.0);
  assert.equal(r.noon.source, 'directional');
  assert.equal(r.peak1.factor, 1.0);
});

test('computeT3DirectionalCorrection: 相対的に活性高→factor<1、低→factor>1', () => {
  // noon black_ratio 0.2、peak1 0.1。overall=0.15。
  // noon relative=1.333 → factor=1-0.2*0.333=0.9333。peak1 relative=0.667 → factor=1.0667。
  const rows = [...t3Rows('13:00', 25, 0.2), ...t3Rows('18:00', 25, 0.1)];
  const r = computeT3DirectionalCorrection(rows, T3_TS, T3_NOW);
  assert.ok(r.noon.factor < 1.0, `noon factor ${r.noon.factor} < 1`);
  assert.ok(r.peak1.factor > 1.0, `peak1 factor ${r.peak1.factor} > 1`);
  assert.equal(r.noon.source, 'directional');
});

test('computeT3DirectionalCorrection: tick 数 < T3_MIN_TICKS → そのバケット fallback', () => {
  const rows = [...t3Rows('13:00', 5, 0.2), ...t3Rows('18:00', 25, 0.1)];
  const r = computeT3DirectionalCorrection(rows, T3_TS, T3_NOW);
  assert.equal(r.noon.source, 'fallback'); // 5 件 < 20
  assert.equal(r.noon.factor, 1.0);
  assert.equal(r.peak1.source, 'directional');
});

test('computeT3DirectionalCorrection: factor は bound [0.8, 1.2] でクリップ', () => {
  // noon 0.9、peak1 0.0、evening 0.0。overall=0.3。noon relative=3.0 → 素 factor=0.6 → クリップ 0.8。
  const rows = [...t3Rows('13:00', 25, 0.9), ...t3Rows('18:00', 25, 0.0), ...t3Rows('20:00', 25, 0.0)];
  const r = computeT3DirectionalCorrection(rows, T3_TS, T3_NOW);
  assert.equal(r.noon.factor, 0.8);
  assert.equal(r.peak1.factor, 1.2);
  assert.equal(r.evening.factor, 1.2);
});
```

- [ ] **Step 1.2: テスト実行 → 失敗確認**

Run: `node --test tests/correction-engine.test.mjs`
Expected: FAIL (`computeT3DirectionalCorrection` が未 export)

- [ ] **Step 1.3: `CORRECTION_SCHEMA_VERSION` を 3 に**

`scripts/lib/correction-engine.mjs` の変更前:

```javascript
export const CORRECTION_SCHEMA_VERSION = 2;
```

変更後:

```javascript
export const CORRECTION_SCHEMA_VERSION = 3;
```

- [ ] **Step 1.4: T3 定数を追加**

`scripts/lib/correction-engine.mjs` の `export const SLOTS_PER_DAY = 288;` の直後に追加:

```javascript
export const T3_MIN_TICKS = 20;
export const T3_DIRECTIONAL_GAIN = 0.2;
export const T3_FACTOR_MIN = 0.8;
export const T3_FACTOR_MAX = 1.2;
```

- [ ] **Step 1.5: `computeT3DirectionalCorrection` を実装**

`scripts/lib/correction-engine.mjs` の末尾 (`computeShareCorrection` の後) に追加:

```javascript

/**
 * t3-pool-history.jsonl の Real106 black_ratio から、T3 のバケット別方向性補正を計算する。
 *
 * curb の 5 分サンプリングでは台数を数えられないため、これは弱い経験則:
 * バケットの先頭活性 (Real106 black_ratio 平均) を全バケット平均で相対化し、
 * 相対的に活性が高い (滞留タクシー多め) バケットは factor < 1、低いバケットは factor > 1。
 *
 * @param {Array} t3PoolRows    t3-pool-history.jsonl の全行
 * @param {Object} transitShare data/transit-share.json (バケット定義)
 * @param {Date} now
 * @returns {Object} {<bucketId>: {factor, source, n, relativeActivity}}
 */
export function computeT3DirectionalCorrection(t3PoolRows, transitShare, now) {
  const buckets = (transitShare && Array.isArray(transitShare.buckets)) ? transitShare.buckets : [];
  const todayStr = ymdOf(now);

  // バケット別に Real106 black_ratio を集計 (完了日のみ)
  const sums = {};
  for (const b of buckets) sums[b.id] = { sum: 0, n: 0 };
  for (const row of t3PoolRows) {
    if (!row || typeof row.ts !== 'string') continue;
    if (row.ts.slice(0, 10) >= todayStr) continue; // 完了日のみ
    if (!Array.isArray(row.t3_stand)) continue;
    const r106 = row.t3_stand.find(e => e && e.name === 'Real106');
    if (!r106 || typeof r106.black_ratio !== 'number') continue;
    const bucket = pickBucket(row.ts.slice(11, 16), transitShare);
    if (!bucket || !sums[bucket.id]) continue;
    sums[bucket.id].sum += r106.black_ratio;
    sums[bucket.id].n += 1;
  }

  // tick 数が閾値以上のバケットの平均活性 → overall
  const activity = {};
  let overallSum = 0;
  let overallCount = 0;
  for (const b of buckets) {
    const s = sums[b.id];
    if (s.n >= T3_MIN_TICKS) {
      activity[b.id] = s.sum / s.n;
      overallSum += activity[b.id];
      overallCount += 1;
    }
  }
  const overall = overallCount > 0 ? overallSum / overallCount : 0;

  const out = {};
  for (const b of buckets) {
    const s = sums[b.id];
    if (s.n < T3_MIN_TICKS || overall <= 0) {
      out[b.id] = { factor: 1.0, source: 'fallback', n: s.n, relativeActivity: null };
    } else {
      const relative = activity[b.id] / overall;
      const factor = clipFactor(
        Number((1 - T3_DIRECTIONAL_GAIN * (relative - 1)).toFixed(4)),
        T3_FACTOR_MIN, T3_FACTOR_MAX
      );
      out[b.id] = {
        factor,
        source: 'directional',
        n: s.n,
        relativeActivity: Number(relative.toFixed(4)),
      };
    }
  }
  return out;
}
```

- [ ] **Step 1.6: テスト実行 → パス**

Run: `node --test tests/correction-engine.test.mjs`
Expected: PASS (23 + 6 = 29 件)

- [ ] **Step 1.7: 全テストスイート (回帰確認)**

Run: `npm test 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 407 件パス (401 + 6)、fail 0

- [ ] **Step 1.8: commit**

```bash
git add scripts/lib/correction-engine.mjs tests/correction-engine.test.mjs
git commit -m "feat(correction): add computeT3DirectionalCorrection (T3 demand-pressure)"
```

---

## Task 2: `observe-taxi-pool.mjs` で T3 を方向性補正に上書き

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`

- [ ] **Step 2.1: import に `computeT3DirectionalCorrection` を追加**

変更前:

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
  computeT3DirectionalCorrection, CORRECTION_SCHEMA_VERSION,
} from './lib/correction-engine.mjs';
```

- [ ] **Step 2.2: D-3 ブロックで T3 を方向性補正に上書き**

D-3 ブロックの `corrections` 構築直後 (`corrections = { ... };` と `writeFileSync(CORRECTIONS_OUTPUT_PATH,` の間) に挿入する。

変更前:

```javascript
    corrections = {
      schemaVersion: CORRECTION_SCHEMA_VERSION,
      generatedAt: ts,
      share: computeShareCorrection(snapshotRows, actualMap, transitShare, new Date()),
      level: computeLevelCorrection(logEntries, actualMap, new Date()),
    };
    writeFileSync(CORRECTIONS_OUTPUT_PATH, JSON.stringify(corrections, null, 2) + '\n', 'utf8');
```

変更後:

```javascript
    corrections = {
      schemaVersion: CORRECTION_SCHEMA_VERSION,
      generatedAt: ts,
      share: computeShareCorrection(snapshotRows, actualMap, transitShare, new Date()),
      level: computeLevelCorrection(logEntries, actualMap, new Date()),
    };
    // Phase E-2: T3 を方向性補正で上書き (t3-pool-history の先頭活性ベース)
    try {
      const t3PoolRows = [];
      if (existsSync(T3_POOL_HISTORY_PATH)) {
        for (const line of readFileSync(T3_POOL_HISTORY_PATH, 'utf8').trim().split('\n')) {
          if (!line.trim()) continue;
          try { t3PoolRows.push(JSON.parse(line)); } catch { /* skip bad line */ }
        }
      }
      const t3dir = computeT3DirectionalCorrection(t3PoolRows, transitShare, new Date());
      for (const bucketId of Object.keys(corrections.share)) {
        if (t3dir[bucketId]) corrections.share[bucketId].T3 = t3dir[bucketId];
      }
    } catch (e) {
      console.error(`[observe] T3 directional correction failed: ${e.message}`);
    }
    writeFileSync(CORRECTIONS_OUTPUT_PATH, JSON.stringify(corrections, null, 2) + '\n', 'utf8');
```

- [ ] **Step 2.3: 構文チェック + 単発実行**

```bash
node --check scripts/observe-taxi-pool.mjs && echo "syntax OK"
node scripts/observe-taxi-pool.mjs 2>&1 | grep -E "\[observe\] (corrections|T3)"
python3 -c "
import json
d = json.load(open('data/coefficient-corrections.json'))
print('schemaVersion:', d['schemaVersion'])
noon = d['share'].get('noon', {})
print('noon.T3:', noon.get('T3'))
"
```

期待: `syntax OK`。`schemaVersion: 3`。`noon.T3` は `source` が `fallback` (データ不足の現状では fallback、factor 1.0) または `directional`。T3 補正失敗時のみ `[observe] T3 directional correction failed` が出る。

- [ ] **Step 2.4: 全テスト (回帰確認)**

```bash
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```

期待: 407 件パス、fail 0。

- [ ] **Step 2.5: commit**

```bash
git add scripts/observe-taxi-pool.mjs data/coefficient-corrections.json
git commit -m "feat(observe): wire T3 directional correction into coefficient-corrections"
```

---

## Task 3: `forecast.html` の T3 セルに方向性 factor を表示

**Files:**
- Modify: `js/forecast-render.js`

- [ ] **Step 3.1: `renderCorrections` の `shareCell` を更新**

`js/forecast-render.js` の変更前:

```javascript
  const shareCell = (entry) => {
    if (!entry) return '—';
    if (entry.source === 'unobservable') return '<span class="src-fallback">観測外</span>';
    return `${Number(entry.factor).toFixed(2)}× ${srcSpan(entry.source)}`;
  };
```

変更後:

```javascript
  const shareCell = (entry) => {
    if (!entry) return '—';
    if (entry.source === 'unobservable') return '<span class="src-fallback">観測外</span>';
    const f = `${Number(entry.factor).toFixed(2)}×`;
    if (entry.source === 'directional') return `${f} <span class="src-learning">方向性</span>`;
    return `${f} ${srcSpan(entry.source)}`;
  };
```

- [ ] **Step 3.2: 構文チェック**

```bash
node --check js/forecast-render.js && echo "syntax OK"
```

期待: `syntax OK`。

- [ ] **Step 3.3: 全テスト (回帰なし確認)**

```bash
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```

期待: 407 件パス、fail 0。

- [ ] **Step 3.4: commit**

```bash
git add js/forecast-render.js
git commit -m "feat(correction): show T3 directional factor in forecast.html"
```

---

## Task 4: 最終整合 + push

- [ ] **Step 4.1: scope check (触ったファイル一覧)**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
git log origin/main..HEAD --name-only --pretty=format:'%h %s'
```

期待: 触ったのは以下のみ:
- `scripts/lib/correction-engine.mjs`
- `tests/correction-engine.test.mjs`
- `scripts/observe-taxi-pool.mjs`
- `js/forecast-render.js`
- `data/coefficient-corrections.json`
- (docs の spec / plan)

`computeShareCorrection` / `buildEffectiveTransitShare` を含む `correction-engine.mjs` の D-4 部分、`forecast-engine.mjs` / `accuracy-evaluator.mjs` / `ensemble-engine.mjs` / `transit-share.json` / `aux-observation.mjs` / `taxi-pool-history.jsonl` / `t3-pool-history.jsonl` は変更されないこと。

- [ ] **Step 4.2: 全テスト最終パス**

```bash
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```

期待: 407 件パス、fail 0。

- [ ] **Step 4.3: git pull --rebase --autostash で観測 push との衝突回避**

```bash
git pull --rebase --autostash origin main 2>&1 | tail -5
```

autostash 適用でコンフリクトが出た場合は **`git reset --hard` を使わないこと**。再生成系 JSON (`data/stall-*.json` / `data/forecast-accuracy.json` / `data/coefficient-corrections.json`) のみ `git checkout HEAD --` で破棄し、append-only の `data/taxi-pool-history.jsonl` と `data/t3-pool-history.jsonl` の未コミット観測行は working tree に残す。解決後、`git stash list` に残った autostash を `git stash drop` する。

- [ ] **Step 4.4: push (3 回までリトライ)**

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

- [ ] **Step 4.5: 本番反映確認 (GitHub Pages 自動デプロイ後 80-90 秒)**

```bash
echo "=== coefficient-corrections.json ==="
curl -sf https://hidenaka.github.io/taxi-ic-helper/data/coefficient-corrections.json | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print(f'schemaVersion: {d[\"schemaVersion\"]}')
print(f'noon.T3: {d[\"share\"].get(\"noon\", {}).get(\"T3\")}')
"
echo "=== forecast-render.js ==="
curl -sf https://hidenaka.github.io/taxi-ic-helper/js/forecast-render.js | grep -oE '方向性' | head -1
```

期待: `schemaVersion: 3`、`noon.T3` が `source` 付きで取得でき、`forecast-render.js` に「方向性」がある。

- [ ] **Step 4.6: 完了報告**

最終状態を要約。Mac mini 側は次 tick で git pull → E-2 ロジック稼働。`t3-pool-history` の完了日が 7 日以上貯まれば T3 が `fallback` → `directional` に切り替わる。

---

## 検証コマンド一覧 (チートシート)

```bash
node --test tests/correction-engine.test.mjs
npm test
node scripts/observe-taxi-pool.mjs
python3 -c "import json; print(json.dumps(json.load(open('data/coefficient-corrections.json'))['share'], indent=2, ensure_ascii=False))"
```

---

## 完了条件 (再掲)

- [ ] `npm test` 全件パス (401 → 407 件)
- [ ] `computeT3DirectionalCorrection` が純関数として実装され、バケット別の `directional` / `fallback` factor を返す
- [ ] `observe-taxi-pool.mjs` が `t3-pool-history.jsonl` から T3 補正を計算し `coefficient-corrections.json` の `share.<bucket>.T3` に反映
- [ ] `CORRECTION_SCHEMA_VERSION` が 3
- [ ] `forecast.html` の係数補正テーブル T3 列が方向性 factor を表示
- [ ] `computeShareCorrection` / `buildEffectiveTransitShare` (D-4) と `aux-observation.mjs` (E-1) は不変
- [ ] データ不足時は T3 factor 1.0 (`fallback`) で現行と同じ挙動
