# forecast-accuracy.json の真値単位移行 実装 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `forecast-accuracy.json` の MAE を書き出し時に calibration 係数 `k` 倍し、真の出庫 throughput 単位にする（G-5 で真値化した forecast と単位を揃える）。

**Architecture:** 純関数 `applyThroughputScaleToAccuracy(accObj, k)` が accuracy オブジェクトの全 MAE（`mae_total`/`mae_per_stall`）を `k` 倍した新オブジェクトを返す。`observe-taxi-pool.mjs` が `forecast-accuracy.json` 書き出し時にこれを通す。in-memory の `accuracyResult`（`computeEnsemble` 入力）と内部評価ロジックは net-diff のまま据え置き。MAE は正の同次関数なので真値 MAE = net-diff MAE × k。

**Tech Stack:** Node.js ESM（`node:test`）。新依存なし。`evaluateAccuracy`・`computeEnsemble`・Python は不変。

**Spec:** `docs/superpowers/specs/2026-05-17-accuracy-truthification-design.md`

**git 運用:** main 直 push 運用（feature branch なし）。worktree 不要、main workdir で作業。各 Task の最後に commit → `git pull --rebase --autostash origin main` → `git push origin main`。コミットは scripts/tests のみ、観測データ（`data/*`）は混ぜない（`git diff --cached --name-only` で確認、混入時 `git restore --staged data/<file>`）。コミットメッセージ末尾に `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。

**作業ディレクトリ:** `/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係`（以下、全パスはここからの相対）。

**テストコマンド:** `npm test`（node:test）

---

## File Structure

| ファイル | 役割 | Task |
|---|---|---|
| `scripts/lib/throughput-calibration.mjs` | **改修**。純関数 `applyThroughputScaleToAccuracy` を追加。 | 1 |
| `tests/throughput-calibration.test.mjs` | **改修**。`applyThroughputScaleToAccuracy` の node:test を追加。 | 1 |
| `scripts/observe-taxi-pool.mjs` | **改修**。import 追加、`forecast-accuracy.json` 書き出しを `applyThroughputScaleToAccuracy` 経由に。 | 2 |

---

## Task 1: 純関数 `applyThroughputScaleToAccuracy`

accuracy オブジェクトの全 MAE を `k` 倍する純関数を `throughput-calibration.mjs` に追加する。

**Files:**
- Modify: `scripts/lib/throughput-calibration.mjs`（末尾に関数追加）
- Test: `tests/throughput-calibration.test.mjs`

- [ ] **Step 1: 失敗テストを書く**

`tests/throughput-calibration.test.mjs` の import 文に `applyThroughputScaleToAccuracy` を追加する。現在の import 文（G-5 で `applyThroughputScale` まで追加済み）:

```js
import {
  computeThroughputCalibration,
  WINDOW_MS,
  MIN_WINDOWS_FOR_LEARNING,
  K_MAX,
  sumTrackDepartedInWindow,
  applyThroughputScale,
} from '../scripts/lib/throughput-calibration.mjs';
```

を、以下に置換:

```js
import {
  computeThroughputCalibration,
  WINDOW_MS,
  MIN_WINDOWS_FOR_LEARNING,
  K_MAX,
  sumTrackDepartedInWindow,
  applyThroughputScale,
  applyThroughputScaleToAccuracy,
} from '../scripts/lib/throughput-calibration.mjs';
```

`tests/throughput-calibration.test.mjs` の末尾に以下を追加:

```js
// --- applyThroughputScaleToAccuracy ---

// accuracy 形のオブジェクトを作る
function makeAccuracyObj() {
  const bucket = (total, perStall, n) => ({ mae_total: total, mae_per_stall: perStall, n });
  const method = () => ({
    lead30: bucket(1.0, [0.5, 0.4, 0.3, 0.2], 100),
    lead60: bucket(2.0, [1.0, 0.5, 0.3, 0.2], 80),
    lead120: bucket(null, [null, null, null, null], 0),
  });
  const period = () => ({
    forecast: method(),
    patternMatch: method(),
    winner: { lead30: 'forecast', lead60: 'patternMatch', lead120: 'n/a' },
  });
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-17T10:00:00+09:00',
    logEntryCount: 86,
    recent24h: period(),
    allPeriod: period(),
  };
}

test('applyThroughputScaleToAccuracy: MAE を k 倍する (recent24h/allPeriod, forecast/patternMatch)', () => {
  const r = applyThroughputScaleToAccuracy(makeAccuracyObj(), 2);
  assert.equal(r.recent24h.forecast.lead30.mae_total, 2.0);
  assert.deepEqual(r.recent24h.forecast.lead30.mae_per_stall, [1.0, 0.8, 0.6, 0.4]);
  assert.equal(r.recent24h.forecast.lead60.mae_total, 4.0);
  assert.equal(r.recent24h.patternMatch.lead30.mae_total, 2.0);
  assert.equal(r.allPeriod.forecast.lead30.mae_total, 2.0);
  assert.equal(r.allPeriod.patternMatch.lead60.mae_total, 4.0);
});

test('applyThroughputScaleToAccuracy: null の MAE は null のまま', () => {
  const r = applyThroughputScaleToAccuracy(makeAccuracyObj(), 2);
  assert.equal(r.recent24h.forecast.lead120.mae_total, null);
  assert.deepEqual(r.recent24h.forecast.lead120.mae_per_stall, [null, null, null, null]);
});

test('applyThroughputScaleToAccuracy: n / winner / metadata を保持', () => {
  const r = applyThroughputScaleToAccuracy(makeAccuracyObj(), 2);
  assert.equal(r.recent24h.forecast.lead30.n, 100);
  assert.equal(r.recent24h.winner.lead30, 'forecast');
  assert.equal(r.recent24h.winner.lead60, 'patternMatch');
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.generatedAt, '2026-05-17T10:00:00+09:00');
  assert.equal(r.logEntryCount, 86);
});

test('applyThroughputScaleToAccuracy: 入力を破壊しない', () => {
  const obj = makeAccuracyObj();
  applyThroughputScaleToAccuracy(obj, 2);
  assert.equal(obj.recent24h.forecast.lead30.mae_total, 1.0);
  assert.deepEqual(obj.recent24h.forecast.lead30.mae_per_stall, [0.5, 0.4, 0.3, 0.2]);
  assert.equal(obj.throughputScaleK, undefined);
});

test('applyThroughputScaleToAccuracy: throughputScaleK を付与', () => {
  const r = applyThroughputScaleToAccuracy(makeAccuracyObj(), 2.5);
  assert.equal(r.throughputScaleK, 2.5);
});

test('applyThroughputScaleToAccuracy: k=1 は恒等', () => {
  const r = applyThroughputScaleToAccuracy(makeAccuracyObj(), 1);
  assert.equal(r.recent24h.forecast.lead30.mae_total, 1.0);
  assert.deepEqual(r.recent24h.forecast.lead30.mae_per_stall, [0.5, 0.4, 0.3, 0.2]);
  assert.equal(r.throughputScaleK, 1);
});

test('applyThroughputScaleToAccuracy: k が非正・非数値 → 1.0 扱い', () => {
  assert.equal(applyThroughputScaleToAccuracy(makeAccuracyObj(), 0).throughputScaleK, 1);
  assert.equal(applyThroughputScaleToAccuracy(makeAccuracyObj(), -3).throughputScaleK, 1);
  assert.equal(applyThroughputScaleToAccuracy(makeAccuracyObj(), NaN).throughputScaleK, 1);
  const r = applyThroughputScaleToAccuracy(makeAccuracyObj(), 0);
  assert.equal(r.recent24h.forecast.lead30.mae_total, 1.0); // 恒等
});

test('applyThroughputScaleToAccuracy: 構造が欠けても例外を投げない', () => {
  const r = applyThroughputScaleToAccuracy({ schemaVersion: 1 }, 2);
  assert.equal(r.throughputScaleK, 2);
  assert.equal(r.schemaVersion, 1);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test -- tests/throughput-calibration.test.mjs 2>&1 | tail -15`
Expected: FAIL — `applyThroughputScaleToAccuracy is not a function`（export されていない）。

- [ ] **Step 3: `applyThroughputScaleToAccuracy` を実装**

`scripts/lib/throughput-calibration.mjs` の末尾（`applyThroughputScale` 関数の後）に以下を追加:

```js
/**
 * accuracy オブジェクトの全 MAE 値を k 倍した新オブジェクトを返す。
 *
 * recent24h / allPeriod の forecast・patternMatch の各 lead bucket の
 * mae_total と mae_per_stall[] を round(値×k, 小数3桁) でスケールする。
 * null (や非数値) の MAE はそのまま。n / winner / metadata は保持。
 * 入力は破壊しない。トップレベルに throughputScaleK (適用した k) を付与する。
 * recent24h / allPeriod / forecast / patternMatch / bucket が欠けていても例外を投げない。
 *
 * @param {object} accObj evaluateAccuracy の戻り値相当
 * @param {number} k スケール係数 (非数値・非正なら 1.0 扱い)
 * @returns {object} スケール済みの新オブジェクト
 */
export function applyThroughputScaleToAccuracy(accObj, k) {
  const scale = (Number.isFinite(k) && k > 0) ? k : 1.0;
  const scaleMae = (v) => (typeof v === 'number' ? Number((v * scale).toFixed(3)) : v);
  const scaleBucket = (bucket) => {
    if (!bucket || typeof bucket !== 'object') return bucket;
    const out = { ...bucket };
    if ('mae_total' in bucket) out.mae_total = scaleMae(bucket.mae_total);
    if (Array.isArray(bucket.mae_per_stall)) {
      out.mae_per_stall = bucket.mae_per_stall.map(scaleMae);
    }
    return out;
  };
  const scaleMethod = (method) => {
    if (!method || typeof method !== 'object') return method;
    const out = {};
    for (const [key, bucket] of Object.entries(method)) {
      out[key] = scaleBucket(bucket);
    }
    return out;
  };
  const scalePeriod = (period) => {
    if (!period || typeof period !== 'object') return period;
    const out = { ...period };
    if (period.forecast) out.forecast = scaleMethod(period.forecast);
    if (period.patternMatch) out.patternMatch = scaleMethod(period.patternMatch);
    return out;
  };
  const result = { ...accObj, throughputScaleK: scale };
  if (accObj.recent24h) result.recent24h = scalePeriod(accObj.recent24h);
  if (accObj.allPeriod) result.allPeriod = scalePeriod(accObj.allPeriod);
  return result;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -- tests/throughput-calibration.test.mjs 2>&1 | tail -15`
Expected: PASS — 既存 27 + 新規 8 = 35 tests passing。

- [ ] **Step 5: 全体回帰テスト**

Run: `npm test 2>&1 | tail -15`
Expected: PASS — 全件 pass（439 → 447）、fail 0。

- [ ] **Step 6: コミット**

```bash
git add scripts/lib/throughput-calibration.mjs tests/throughput-calibration.test.mjs
git diff --cached --name-only   # この2ファイルのみであることを確認
git commit -m "$(cat <<'EOF'
feat: applyThroughputScaleToAccuracy 純関数を追加

accuracy オブジェクトの MAE を k 倍する (真値単位移行)。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## Task 2: `observe-taxi-pool.mjs` の配線

`forecast-accuracy.json` の書き出しを `applyThroughputScaleToAccuracy` 経由にする。

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`

> `observe-taxi-pool.mjs` はネットワーク I/O を伴うため単体テストハーネスを持たない。検証は構文/import チェック + `npm test` 回帰で行う。

- [ ] **Step 1: import に `applyThroughputScaleToAccuracy` を追加**

`scripts/observe-taxi-pool.mjs` の `./lib/throughput-calibration.mjs` からの import 文:

```js
import {
  computeThroughputCalibration,
  sumTrackDepartedInWindow,
  MIN_TRACK_TICKS_FOR_TREND,
  applyThroughputScale,
} from './lib/throughput-calibration.mjs';
```

を、以下に置換:

```js
import {
  computeThroughputCalibration,
  sumTrackDepartedInWindow,
  MIN_TRACK_TICKS_FOR_TREND,
  applyThroughputScale,
  applyThroughputScaleToAccuracy,
} from './lib/throughput-calibration.mjs';
```

- [ ] **Step 2: `forecast-accuracy.json` 書き出しをスケール経由に**

`scripts/observe-taxi-pool.mjs` の現在の:

```js
    accuracyResult = evaluateAccuracy(logEntries, actualMap, new Date());
    writeFileSync(FORECAST_ACCURACY_PATH, JSON.stringify(accuracyResult, null, 2) + '\n', 'utf8');
```

を、以下に置換:

```js
    accuracyResult = evaluateAccuracy(logEntries, actualMap, new Date());
    writeFileSync(FORECAST_ACCURACY_PATH, JSON.stringify(applyThroughputScaleToAccuracy(accuracyResult, throughputK), null, 2) + '\n', 'utf8');
```

（`accuracyResult` 変数自体は未スケールのまま。後段で `computeEnsemble` に渡る `accuracyResult` は net-diff → `computeWeights` は不変。`throughputK` は G-5 で hoist 済みの変数を再利用。）

- [ ] **Step 3: 構文・import チェック**

Run: `node --check scripts/observe-taxi-pool.mjs && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 4: 全体回帰テスト**

Run: `npm test 2>&1 | tail -15`
Expected: PASS — 全件 pass（447）、fail 0。

- [ ] **Step 5: コミット**

```bash
git add scripts/observe-taxi-pool.mjs
git diff --cached --name-only   # scripts/observe-taxi-pool.mjs のみ。data/ が混ざっていないこと
git commit -m "$(cat <<'EOF'
feat: forecast-accuracy.json を真値化して書き出す

書き出し時に applyThroughputScaleToAccuracy で MAE を k 倍。
in-memory accuracyResult は net-diff 据え置き (computeWeights 不変)。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## 完了後

- `npm test` 全 pass（約 447 件）。Python テストは不変。
- 次の observe tick（Mac mini）から `forecast-accuracy.json` が `applyThroughputScaleToAccuracy` 経由で書き出される。`k=bootstrapping`（=1.0）の間は MAE 不変、`learning` 到達後に MAE が真値単位になり `stall-forecast.json` の真値化された forecast と単位が揃う。`throughputScaleK` に適用値が出る。
- `evaluateAccuracy`・`accuracy-evaluator.mjs`・`buildActualMap`・`forecast-log.jsonl`・`computeEnsemble`・`computeWeights` は不変。

**Mac mini デプロイ:** `~/repos/taxi-ic-helper` で `git pull` のみ（observe-tick が自動実行）。新依存なし、launchd 変更なし。

**ロードマップ残（本 plan のスコープ外）:** C 後半（`DIST_THRESHOLD` 値設定）、`stall-pattern-match.json` の真値化、検出ベース並行 forecast。
