# baseline 出力の真値化 実装 Plan（B案）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** forecast の出力 JSON（`stall-forecast.json` / `stall-ensemble.json`）の slot outflow を calibration 係数 `k` 倍して書き出し、真の出庫 throughput 単位にする。

**Architecture:** 純関数 `applyThroughputScale(obj, k)` が forecast/ensemble 出力オブジェクトの `slots[].stall1-4/total` を `k` 倍した新オブジェクトを返す。`observe-taxi-pool.mjs` が `stall-forecast.json` / `stall-ensemble.json` 書き出し時にこれを通す。内部（log・accuracy・correction・ensemble 計算）は net-diff のまま据え置き。

**Tech Stack:** Node.js ESM（`node:test`）。新依存なし。`computeForecast`・`computeEnsemble`・accuracy・correction・Python は不変。

**Spec:** `docs/superpowers/specs/2026-05-16-baseline-output-truthification-design.md`

**git 運用:** main 直 push 運用（feature branch なし）。worktree 不要、main workdir で作業。各 Task の最後に commit → `git pull --rebase --autostash origin main` → `git push origin main`。コミットは scripts/tests のみ、観測データ（`data/*`）は混ぜない（`git diff --cached --name-only` で確認、混入時 `git restore --staged data/<file>`）。コミットメッセージ末尾に `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。

**作業ディレクトリ:** `/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係`（以下、全パスはここからの相対）。

**テストコマンド:** `npm test`（node:test）

---

## File Structure

| ファイル | 役割 | Task |
|---|---|---|
| `scripts/lib/throughput-calibration.mjs` | **改修**。純関数 `applyThroughputScale` を追加。 | 1 |
| `tests/throughput-calibration.test.mjs` | **改修**。`applyThroughputScale` の node:test を追加。 | 1 |
| `scripts/observe-taxi-pool.mjs` | **改修**。import 追加、`throughputK` を hoist、2つの書き出しを `applyThroughputScale` 経由に。 | 2 |

---

## Task 1: 純関数 `applyThroughputScale`

forecast/ensemble 出力オブジェクトの slot outflow を `k` 倍する純関数を `throughput-calibration.mjs` に追加する。

**Files:**
- Modify: `scripts/lib/throughput-calibration.mjs`（末尾に関数追加）
- Test: `tests/throughput-calibration.test.mjs`

- [ ] **Step 1: 失敗テストを書く**

`tests/throughput-calibration.test.mjs` の import 文に `applyThroughputScale` を追加する。現在の import 文:

```js
import {
  computeThroughputCalibration,
  WINDOW_MS,
  MIN_WINDOWS_FOR_LEARNING,
  K_MAX,
  sumTrackDepartedInWindow,
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
} from '../scripts/lib/throughput-calibration.mjs';
```

`tests/throughput-calibration.test.mjs` の末尾に以下を追加:

```js
// --- applyThroughputScale (B案) ---

// forecast 形の出力オブジェクトを作る
function makeForecastObj() {
  return {
    schemaVersion: 1,
    trendFactor: 1.5,
    trendWindow: { actual: 9, expected: 7.5, source: 'track', k: 2 },
    slots: [
      { slotStart: '12:05', slotEnd: '12:10', flightFactor: 1.0, stall1: 2, stall2: 3, stall3: 0, stall4: 1, total: 6 },
      { slotStart: '12:10', slotEnd: '12:15', flightFactor: 2.0, stall1: 1, stall2: 1, stall3: 1, stall4: 1, total: 4 },
    ],
  };
}

test('applyThroughputScale: slot の stall1-4 を k 倍し total を再計算', () => {
  const r = applyThroughputScale(makeForecastObj(), 2);
  assert.equal(r.slots[0].stall1, 4);
  assert.equal(r.slots[0].stall2, 6);
  assert.equal(r.slots[0].stall3, 0);
  assert.equal(r.slots[0].stall4, 2);
  assert.equal(r.slots[0].total, 12); // 4+6+0+2
});

test('applyThroughputScale: k=1 は恒等 (数値不変)', () => {
  const r = applyThroughputScale(makeForecastObj(), 1);
  assert.equal(r.slots[0].stall1, 2);
  assert.equal(r.slots[0].total, 6);
  assert.equal(r.throughputScaleK, 1);
});

test('applyThroughputScale: 非 slot フィールド保持、trendWindow はスケールしない', () => {
  const r = applyThroughputScale(makeForecastObj(), 2);
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.trendFactor, 1.5);
  assert.equal(r.trendWindow.actual, 9);    // net-diff 診断値、スケールしない
  assert.equal(r.trendWindow.expected, 7.5);
  assert.equal(r.slots[0].slotStart, '12:05');
  assert.equal(r.slots[0].flightFactor, 1.0);
});

test('applyThroughputScale: 入力を破壊しない', () => {
  const obj = makeForecastObj();
  applyThroughputScale(obj, 2);
  assert.equal(obj.slots[0].stall1, 2);   // 元のまま
  assert.equal(obj.slots[0].total, 6);
  assert.equal(obj.throughputScaleK, undefined);
});

test('applyThroughputScale: throughputScaleK を付与', () => {
  const r = applyThroughputScale(makeForecastObj(), 2.5);
  assert.equal(r.throughputScaleK, 2.5);
});

test('applyThroughputScale: ensemble 形 (slots に leadBucket) でも動く', () => {
  const ens = {
    schemaVersion: 1,
    weights: { lead30: { w_fc: 0.5, w_pm: 0.5 } },
    slots: [{ slotStart: '12:05', leadBucket: 'lead30', stall1: 2, stall2: 2, stall3: 2, stall4: 2, total: 8 }],
  };
  const r = applyThroughputScale(ens, 3);
  assert.equal(r.slots[0].stall1, 6);
  assert.equal(r.slots[0].total, 24);
  assert.equal(r.slots[0].leadBucket, 'lead30');
  assert.deepEqual(r.weights, { lead30: { w_fc: 0.5, w_pm: 0.5 } });
});

test('applyThroughputScale: k が非正・非数値 → 1.0 扱い (恒等)', () => {
  assert.equal(applyThroughputScale(makeForecastObj(), 0).throughputScaleK, 1);
  assert.equal(applyThroughputScale(makeForecastObj(), -2).throughputScaleK, 1);
  assert.equal(applyThroughputScale(makeForecastObj(), NaN).throughputScaleK, 1);
  const r = applyThroughputScale(makeForecastObj(), 0);
  assert.equal(r.slots[0].stall1, 2); // 恒等
});

test('applyThroughputScale: slots が配列でない → throughputScaleK のみ付与', () => {
  const r = applyThroughputScale({ schemaVersion: 1 }, 2);
  assert.equal(r.throughputScaleK, 2);
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.slots, undefined);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm test -- tests/throughput-calibration.test.mjs 2>&1 | tail -15`
Expected: FAIL — `applyThroughputScale is not a function`（export されていない）。

- [ ] **Step 3: `applyThroughputScale` を実装**

`scripts/lib/throughput-calibration.mjs` の末尾（`sumTrackDepartedInWindow` 関数の後）に以下を追加:

```js
/**
 * forecast / ensemble の出力オブジェクトの slot outflow を k 倍した新オブジェクトを返す。
 *
 * 各 slot の stall1-4 を round(値×k)、total はスケール後 stall1-4 の合計で再計算する。
 * slot のその他フィールド (slotStart/slotEnd/flightFactor/leadBucket 等) と
 * トップレベルのその他フィールド (schemaVersion/trendFactor/trendWindow/weights 等) は保持する。
 * 入力は破壊しない。トップレベルに throughputScaleK (適用した k) を付与する。
 *
 * @param {{slots?: Array}} obj forecast または ensemble の出力オブジェクト
 * @param {number} k スケール係数 (非数値・非正なら 1.0 扱い)
 * @returns {object} スケール済みの新オブジェクト
 */
export function applyThroughputScale(obj, k) {
  const scale = (Number.isFinite(k) && k > 0) ? k : 1.0;
  if (!Array.isArray(obj.slots)) {
    return { ...obj, throughputScaleK: scale };
  }
  const slots = obj.slots.map(slot => {
    const out = { ...slot };
    let total = 0;
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      if (typeof slot[name] === 'number') {
        out[name] = Math.round(slot[name] * scale);
        total += out[name];
      }
    }
    out.total = total;
    return out;
  });
  return { ...obj, slots, throughputScaleK: scale };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test -- tests/throughput-calibration.test.mjs 2>&1 | tail -15`
Expected: PASS — 既存 19 + 新規 8 = 27 tests passing。

- [ ] **Step 5: 全体回帰テスト**

Run: `npm test 2>&1 | tail -15`
Expected: PASS — 全件 pass（431 → 439）、fail 0。

- [ ] **Step 6: コミット**

```bash
git add scripts/lib/throughput-calibration.mjs tests/throughput-calibration.test.mjs
git diff --cached --name-only   # この2ファイルのみであることを確認
git commit -m "$(cat <<'EOF'
feat(B案): applyThroughputScale 純関数を追加

forecast/ensemble 出力の slot outflow を k 倍する。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## Task 2: `observe-taxi-pool.mjs` の配線

`stall-forecast.json` と `stall-ensemble.json` の書き出しを `applyThroughputScale` 経由にする。

**Files:**
- Modify: `scripts/observe-taxi-pool.mjs`

> `observe-taxi-pool.mjs` はネットワーク I/O を伴うため単体テストハーネスを持たない。検証は構文/import チェック + `npm test` 回帰で行う。

- [ ] **Step 1: import に `applyThroughputScale` を追加**

`scripts/observe-taxi-pool.mjs` の `./lib/throughput-calibration.mjs` からの import 文:

```js
import {
  computeThroughputCalibration,
  sumTrackDepartedInWindow,
  MIN_TRACK_TICKS_FOR_TREND,
} from './lib/throughput-calibration.mjs';
```

を、以下に置換:

```js
import {
  computeThroughputCalibration,
  sumTrackDepartedInWindow,
  MIN_TRACK_TICKS_FOR_TREND,
  applyThroughputScale,
} from './lib/throughput-calibration.mjs';
```

- [ ] **Step 2: `throughputK` を hoist**

`scripts/observe-taxi-pool.mjs` の現在の:

```js
  // forecast / pattern-match の結果を Phase D-1 ログ記録で参照するため外側で保持
  let forecastResult = null;
  let patternMatchResult = null;
```

を、以下に置換:

```js
  // forecast / pattern-match の結果を Phase D-1 ログ記録で参照するため外側で保持
  let forecastResult = null;
  let patternMatchResult = null;
  // Phase B案: 出力 JSON を真値化するスケール係数 (forecast block で calibration.k をセット)
  let throughputK = 1.0;
```

- [ ] **Step 3: forecast block で `throughputK` をセット**

`scripts/observe-taxi-pool.mjs` の forecast try ブロック内、現在の:

```js
    const calibration = computeThroughputCalibration(allHistory, trackHistory);
    writeFileSync(THROUGHPUT_CALIBRATION_PATH, JSON.stringify({
```

を、以下に置換:

```js
    const calibration = computeThroughputCalibration(allHistory, trackHistory);
    throughputK = calibration.k;
    writeFileSync(THROUGHPUT_CALIBRATION_PATH, JSON.stringify({
```

- [ ] **Step 4: `stall-forecast.json` 書き出しをスケール経由に**

`scripts/observe-taxi-pool.mjs` の現在の:

```js
    forecastResult = computeForecast(baseline, recent, arrivalsJson, now, trackTrend);
    writeFileSync(FORECAST_OUTPUT_PATH, JSON.stringify(forecastResult, null, 2) + '\n', 'utf8');
```

を、以下に置換:

```js
    forecastResult = computeForecast(baseline, recent, arrivalsJson, now, trackTrend);
    writeFileSync(FORECAST_OUTPUT_PATH, JSON.stringify(applyThroughputScale(forecastResult, throughputK), null, 2) + '\n', 'utf8');
```

（`forecastResult` 変数自体は未スケールのまま。後段の `buildLogEntry(forecastResult, ...)` は未スケール net-diff を使う。）

- [ ] **Step 5: `stall-ensemble.json` 書き出しをスケール経由に**

`scripts/observe-taxi-pool.mjs` の現在の:

```js
    writeFileSync(ENSEMBLE_OUTPUT_PATH, JSON.stringify(ensemble, null, 2) + '\n', 'utf8');
```

を、以下に置換:

```js
    writeFileSync(ENSEMBLE_OUTPUT_PATH, JSON.stringify(applyThroughputScale(ensemble, throughputK), null, 2) + '\n', 'utf8');
```

- [ ] **Step 6: 構文・import チェック**

Run: `node --check scripts/observe-taxi-pool.mjs && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 7: 全体回帰テスト**

Run: `npm test 2>&1 | tail -15`
Expected: PASS — 全件 pass（439）、fail 0（observe-taxi-pool.mjs は import 解決のみ確認、テスト数は Task 1 と同じ）。

- [ ] **Step 8: コミット**

```bash
git add scripts/observe-taxi-pool.mjs
git diff --cached --name-only   # scripts/observe-taxi-pool.mjs のみ。data/ が混ざっていないこと
git commit -m "$(cat <<'EOF'
feat(B案): stall-forecast/ensemble 出力を真値化して書き出す

書き出し時に applyThroughputScale で k 倍。log/accuracy は net-diff 据え置き。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git pull --rebase --autostash origin main && git push origin main
```

---

## 完了後

- `npm test` 全 pass（約 439 件）。Python テストは不変（触らない）。
- 次の observe tick（Mac mini）から `stall-forecast.json` / `stall-ensemble.json` が `applyThroughputScale` 経由で書き出される。`k` が `bootstrapping`（=1.0）の間は出力不変、`learning` 到達後に slot outflow が真の出庫台数になり `throughputScaleK` に適用値が出る。
- `forecast-log.jsonl`・`forecast-accuracy.json`・`coefficient-corrections.json`・`computeForecast`・`computeEnsemble` は不変。

**Mac mini デプロイ:** `~/repos/taxi-ic-helper` で `git pull` のみ（observe-tick が自動実行）。新依存なし、launchd 変更なし。

**ロードマップ残（本 plan のスコープ外）:** C 後半（`DIST_THRESHOLD` 値設定）、`stall-pattern-match.json` の真値化、`forecast-accuracy.json` の真値単位移行、検出ベース並行 forecast。
