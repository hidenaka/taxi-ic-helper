# 予測 throughput スケール単位整合 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** トラッカー実測ベース予測への `k` 二重適用を解消し、予測パイプラインの全出力を実台数単位に統一する。

**Architecture:** 純関数 `forecastOutputK` で「forecast に適用すべき k」を一元決定（track-anchored→1.0 / netdiff→k）。`observe-taxi-pool.mjs` の forecast 書き出しと ensemble 組み立てを、混合前に各要素を実台数化する順序へ組み替える。

**Tech Stack:** Node.js ESM（`.mjs`、`node:test`）。

設計書: `docs/superpowers/specs/2026-05-19-forecast-throughput-scale-units-design.md`

## 前提知識

- リポジトリ: taxi-ic-helper（`乗務地図関係/`、main直push、`npm test`）。
- commit メッセージ末尾に `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。commit 前に `git diff --cached --name-only` で観測データ混入なし確認。
- `throughput-calibration.mjs`: `applyThroughputScale(obj, k, slotsKey='slots')` は `obj[slotsKey]` の各 slot の stall1-4 を `round(値×k)`、total を再計算、`throughputScaleK` を付与した新オブジェクトを返す（入力非破壊）。`k=1.0` なら丸めのみ。
- `forecast-engine.mjs`: `computeForecast` の戻り値は `trendWindow.levelSource` を持つ（`'track-anchored'` or `'netdiff-fallback'`）。
- `observe-taxi-pool.mjs`: forecast ブロック（`forecastResult = computeForecast(...)`、`FORECAST_OUTPUT_PATH` 書き出し、行 325-326 付近）、ensemble ブロック（`applyLevelCorrection` → `computeEnsemble` → `ENSEMBLE_OUTPUT_PATH` 書き出し、行 445-458 付近）。`throughputK` は forecast ブロックで `calibration.k` をセット。
- `computeEnsemble(forecast, patternMatch, accuracyResult, now)`: `forecast.slots` と `patternMatch.historicalCurve` を MAE 重みで混合する。`applyLevelCorrection(forecastResult, corrections)` は forecast slot を level 補正係数で乗算（乗算なので throughput スケールと可換）。

## ファイル構成

| ファイル | 変更 |
|---|---|
| `scripts/lib/throughput-calibration.mjs` | `forecastOutputK` 追加 |
| `tests/throughput-calibration.test.mjs` | `forecastOutputK` テスト追加 |
| `scripts/observe-taxi-pool.mjs` | forecast 書き出し条件化（Fix 1）・ensemble 組み替え（Fix 2） |

---

## Task 1: throughput-calibration.mjs — forecastOutputK 純関数

**作業ディレクトリ:** `乗務地図関係/`

**Files:**
- Modify: `scripts/lib/throughput-calibration.mjs`
- Test: `tests/throughput-calibration.test.mjs`

- [ ] **Step 1: 失敗するテストを書く**

`tests/throughput-calibration.test.mjs` の import 行に `forecastOutputK` を追加する。末尾に追加:

```javascript

test('forecastOutputK: track-anchored 予測は 1.0（k を掛けない）', () => {
  const fc = { trendWindow: { levelSource: 'track-anchored' } };
  assert.equal(forecastOutputK(fc, 5), 1.0);
});

test('forecastOutputK: netdiff-fallback 予測は k', () => {
  const fc = { trendWindow: { levelSource: 'netdiff-fallback' } };
  assert.equal(forecastOutputK(fc, 5), 5);
});

test('forecastOutputK: forecastResult が null なら k（安全側）', () => {
  assert.equal(forecastOutputK(null, 5), 5);
});

test('forecastOutputK: trendWindow 欠落なら k（安全側）', () => {
  assert.equal(forecastOutputK({}, 3), 3);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/throughput-calibration.test.mjs`
Expected: FAIL — `forecastOutputK` 未定義。

- [ ] **Step 3: 実装**

`scripts/lib/throughput-calibration.mjs` の `applyThroughputScale` 関数の直前（または直後）に追加:

```javascript
/**
 * forecast 結果に適用すべき throughput スケール係数を返す。
 * トラッカーアンカー経路の予測はすでに実台数単位なので 1.0（k を掛けない）。
 * net-diff フォールバック経路はネット差分単位なので k。
 * @param {object|null} forecastResult computeForecast の戻り値
 * @param {number} calibrationK throughput 校正の k
 * @returns {number}
 */
export function forecastOutputK(forecastResult, calibrationK) {
  const tw = forecastResult && forecastResult.trendWindow;
  return (tw && tw.levelSource === 'track-anchored') ? 1.0 : calibrationK;
}
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test tests/throughput-calibration.test.mjs`
Expected: PASS — 新規4件を含め全件パス。

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/throughput-calibration.mjs tests/throughput-calibration.test.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
feat(throughput): forecastOutputK 追加（track-anchored は k を掛けない）

トラッカーアンカー経路の予測はすでに実台数単位。それに throughput 校正の
k を掛けると二重適用になる。forecast 結果の levelSource を見て適用すべき
スケール係数（track-anchored→1.0 / netdiff→k）を返す純関数を追加。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: observe-taxi-pool.mjs — forecast 書き出し条件化・ensemble 組み替え

**作業ディレクトリ:** `乗務地図関係/`

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`

このタスクは `observe-taxi-pool.mjs`（ファイル I/O を伴う統合スクリプト・単体テスト対象外）の
配線変更。`node --check` ＋ `npm test` 全件回帰 ＋ 実データドライランで検証する。

- [ ] **Step 1: import に forecastOutputK を追加**

`scripts/observe-taxi-pool.mjs` の `throughput-calibration.mjs` からの import に `forecastOutputK` を追加する。現在 `applyThroughputScale, applyThroughputScaleToAccuracy` 等を import している import 文に `forecastOutputK` を加える。

- [ ] **Step 2: forecast 書き出しを条件付きスケールに（Fix 1）**

forecast ブロックの `FORECAST_OUTPUT_PATH` 書き出し行（`applyThroughputScale(forecastResult, throughputK)` を使っている行）を変更する。

変更前:
```javascript
    writeFileSync(FORECAST_OUTPUT_PATH, JSON.stringify(applyThroughputScale(forecastResult, throughputK), null, 2) + '\n', 'utf8');
```

変更後:
```javascript
    writeFileSync(FORECAST_OUTPUT_PATH, JSON.stringify(applyThroughputScale(forecastResult, forecastOutputK(forecastResult, throughputK)), null, 2) + '\n', 'utf8');
```

- [ ] **Step 3: ensemble ブロックを「混ぜる前に実台数化」へ組み替え（Fix 2）**

ensemble ブロック（`applyLevelCorrection` → `computeEnsemble` → `ENSEMBLE_OUTPUT_PATH` 書き出し）を変更する。

変更前:
```javascript
    const correctedForecast = applyLevelCorrection(forecastResult, corrections);
    const ensemble = computeEnsemble(
      correctedForecast,
      patternMatchResult ? { historicalCurve: patternMatchResult.historicalCurve } : null,
      accuracyResult,
      new Date()
    );
    writeFileSync(ENSEMBLE_OUTPUT_PATH, JSON.stringify(applyThroughputScale(ensemble, throughputK), null, 2) + '\n', 'utf8');
```

変更後:
```javascript
    // 混ぜる前に各要素を実台数単位へ揃える（k はネット差分単位のものにだけ適用）。
    // forecast: track-anchored は実台数なので forecastOutputK が 1.0 を返す。level 補正は乗算で k と可換。
    const correctedForecast = applyLevelCorrection(forecastResult, corrections);
    const realForecast = applyThroughputScale(correctedForecast, forecastOutputK(forecastResult, throughputK));
    // historicalCurve は常にネット差分単位なので ×k。
    const realPatternMatch = patternMatchResult
      ? applyThroughputScale({ historicalCurve: patternMatchResult.historicalCurve }, throughputK, 'historicalCurve')
      : null;
    const ensemble = computeEnsemble(
      realForecast,
      realPatternMatch ? { historicalCurve: realPatternMatch.historicalCurve } : null,
      accuracyResult,
      new Date()
    );
    // 混合済みは既に実台数単位。丸めのみ（k=1.0、追加スケールなし）。
    writeFileSync(ENSEMBLE_OUTPUT_PATH, JSON.stringify(applyThroughputScale(ensemble, 1.0), null, 2) + '\n', 'utf8');
```

注意:
- `forecastResult` が null の場合、`applyLevelCorrection(null, ...)` 以降は従来どおり ensemble の try/catch が握る。`forecastOutputK(null, throughputK)` は `throughputK` を返すので安全。
- `computeEnsemble` の呼び出し引数の形（第2引数が `{historicalCurve}` か null）は従来と同一。中身が実台数化された点だけが違う。

- [ ] **Step 4: 構文チェック**

Run: `node --check scripts/observe-taxi-pool.mjs`
Expected: エラーなし。

- [ ] **Step 5: 全回帰**

Run: `npm test`
Expected: PASS — 全件（Task 1 の変更含む）。失敗したら停止して報告。

- [ ] **Step 6: 実データドライラン検証**

実 history で computeForecast → forecastOutputK の判定が効くことを確認する。Run:

```bash
node --input-type=module -e "
import {readFileSync,existsSync} from 'node:fs';
import {computeBaseline,computeForecast} from './scripts/lib/forecast-engine.mjs';
import {computeThroughputCalibration,applyThroughputScale,forecastOutputK} from './scripts/lib/throughput-calibration.mjs';
import {computeTrackActuals} from './scripts/lib/track-actuals.mjs';
const hist=readFileSync('data/taxi-pool-history.jsonl','utf8').trim().split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));
const th=existsSync('data/vehicle-track-history.jsonl')?readFileSync('data/vehicle-track-history.jsonl','utf8').trim().split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l)):[];
const baseline=computeBaseline(hist);
const recent=hist.slice(-12).map(r=>({ts:r.ts,total_outflow:0}));
const cal=computeThroughputCalibration(hist,th);
const now=new Date();
let tt=null;
if(cal.state==='learning'&&recent.length>=12){const w=computeTrackActuals(th,now,60);if(w.length>0){const ps={stall1:0,stall2:0,stall3:0,stall4:0};for(const s of w)for(const n of Object.keys(ps))ps[n]+=s[n];tt={perStall:ps};}}
const fc=computeForecast(baseline,recent,null,now,tt);
const k=forecastOutputK(fc,cal.k);
const scaled=applyThroughputScale(fc,k);
console.log('calibration.k=',cal.k,'levelSource=',fc.trendWindow.levelSource,'forecastOutputK=',k,'throughputScaleK=',scaled.throughputScaleK);
console.log('raw slot0=',JSON.stringify(fc.slots[0]));
console.log('scaled slot0=',JSON.stringify(scaled.slots[0]));
"
```

Expected: `levelSource` が `track-anchored` のとき `forecastOutputK` が `1`、`scaled slot0` の stall 値が `raw slot0` の四捨五入と一致（k 倍されていない）。`netdiff-fallback` のときは `forecastOutputK` が `calibration.k`。出力を報告する。

- [ ] **Step 7: コミットして push**

```bash
git add scripts/observe-taxi-pool.mjs
git diff --cached --name-only
git commit -m "$(cat <<'EOF'
fix(observe): 予測パイプラインの throughput スケール二重適用を解消

トラッカー実測ベース予測(track-anchored)はすでに実台数単位なのに、
forecast 書き出し・ensemble 全体に k を掛けて最大5倍に膨張させていた。
- forecast 書き出し: forecastOutputK で track-anchored 時は k を掛けない
- ensemble: 混ぜる前に forecast と historicalCurve を各々実台数化し、
  混合済みは丸めのみ(k=1.0)。二重スケールを除去。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main
git push origin main
```

---

## 完了条件

- `forecastOutputK` が track-anchored で 1.0、netdiff で k を返す（テスト済み）。
- `observe-taxi-pool.mjs` の forecast 書き出しと ensemble が単位整合・k 1回適用。
- `npm test` 全件回帰パス。
- 実データドライランで track-anchored 予測が k 倍されないことを確認。
- taxi-ic-helper main 反映。

## Self-Review

- **Spec coverage:** 設計§1（forecastOutputK）→Task 1。§2（forecast 書き出し Fix 1）→Task 2 Step 2。§3（ensemble Fix 2）→Task 2 Step 3。テスト方針→Task 1 TDD ＋ Task 2 回帰/ドライラン。
- **Placeholder scan:** TBD/TODO なし。各ステップに実コード・実コマンド。
- **Type consistency:** `forecastOutputK(forecastResult, k)` は Task 1 定義・Task 2 が forecast 書き出しと ensemble 入力の2箇所で使用。`applyThroughputScale(obj, 1.0)` は丸めのみ（既存仕様）。`computeEnsemble` の引数形は不変、中身のみ実台数化。
