# 予測の早すぎる四捨五入バグ修正 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 予測パイプライン3か所の早すぎる `Math.round` を除去し、小数の出庫レートが整数化で0に潰れる不具合を解消する。

**Architecture:** `computeForecast` / `computePatternMatch`（historicalCurve）/ `computeEnsemble` の3関数で行っている中間の `Math.round` を外し、小数のままパイプラインを流す。整数化は書き出し時の `applyThroughputScale`（`round(値×k)`、変更なし）1回に集約する。出力 JSON スキーマは整数のまま不変。

**Tech Stack:** Node.js ESM（`.mjs`）、`node:test`、既存テストランナー `npm test`。

設計書: `docs/superpowers/specs/2026-05-18-forecast-rounding-bug-fix-design.md`
診断書: `docs/research/2026-05-18-forecast-rounding-bug-diagnosis.md`

## 前提知識（このプロジェクト固有）

- 既存の3エンジンのユニットテストは整数入力（baseline 値 1.0 / 2.0 等）で書かれているため、`Math.round` を外しても**既存テストは破壊されない**（`2.0 === 2` は true）。よって各タスクで「小数入力を丸めず保持する」**新規回帰テスト**を追加し、それが現行コードで失敗することを確認してから修正する。
- `computePatternMatch(historyAll, holidaysSet, now)` は生の観測履歴行（`schema_version: 3`）を受け取り、内部で `aggregateByDate` して類似日を集約する。テストは `tests/pattern-matcher.test.mjs` の既存ヘルパ `makeRow` を再利用する。
- git 運用: main 直 push。commit メッセージ末尾に `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。**commit 前に `git diff --cached --name-only` で観測データファイル（`data/*.jsonl`・再生成系 JSON）が混入していないことを確認**し、混入していたら `git restore --staged data/<file>`。

## ファイル構成

| ファイル | 変更 | 責務 |
|---|---|---|
| `scripts/lib/forecast-engine.mjs` | Modify: `computeForecast`（170行付近） | ルールベース予測。slot 値の中間丸めを除去 |
| `tests/forecast-engine.test.mjs` | Modify: 末尾に回帰テスト追加 | computeForecast のテスト |
| `scripts/lib/pattern-matcher.mjs` | Modify: `historicalCurve` 構築（244-247行付近） | 類似日マッチ。平均の中間丸めを除去 |
| `tests/pattern-matcher.test.mjs` | Modify: 末尾に回帰テスト追加 | computePatternMatch のテスト |
| `scripts/lib/ensemble-engine.mjs` | Modify: `computeEnsemble`（100行付近） | アンサンブル統合。加重平均の中間丸めを除去 |
| `tests/ensemble-engine.test.mjs` | Modify: 末尾に回帰テスト追加 | computeEnsemble のテスト |
| `scripts/tmp-verify-rounding-fix.mjs` | Create（一時・コミットしない） | 実データ検証スクリプト |

---

## Task 1: forecast-engine.mjs の中間丸めを除去

**Files:**
- Modify: `scripts/lib/forecast-engine.mjs`（`computeForecast` 内、170行付近）
- Test: `tests/forecast-engine.test.mjs`（末尾に追加）

- [ ] **Step 1: 失敗する回帰テストを書く**

`tests/forecast-engine.test.mjs` の末尾（最終行 227 の後）に追加する。ファイル冒頭で `computeForecast` と `makeArrivals` は既にインポート/定義済みなので追加 import は不要。

```javascript

test('computeForecast: baseline 小数値を丸めず保持する (早すぎる四捨五入バグ回帰)', () => {
  // baseline stall1 = 0.3、recent なし → trendFactor=1.0、便なし → flightFactor=1.0
  // 予測値 = 0.3 * 1 * 1 = 0.3。Math.round で 0 に潰れてはいけない。
  const slots = Array.from({ length: 288 }, () => ({ stall1: 0.3, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const r = computeForecast(baseline, [], makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'));
  assert.equal(r.slots[0].stall1, 0.3);
  assert.equal(r.slots[0].total, 0.3);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/forecast-engine.test.mjs`
Expected: FAIL — 新規テストで `r.slots[0].stall1` が `0`（`Math.round(0.3)`）になり `0.3` と一致しない。

- [ ] **Step 3: 中間丸めを除去**

`scripts/lib/forecast-engine.mjs` の `computeForecast` 内、170行付近。

変更前:
```javascript
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      const b = base[name];
      const val = (b === null || b === undefined) ? 0 : Math.round(b * trendFactor * f);
      slotOut[name] = val;
      total += val;
    }
```

変更後:
```javascript
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      const b = base[name];
      // 小数のまま保持する。整数化は書き出し時の applyThroughputScale (round(値×k)) で1回だけ行う。
      const val = (b === null || b === undefined) ? 0 : b * trendFactor * f;
      slotOut[name] = val;
      total += val;
    }
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test tests/forecast-engine.test.mjs`
Expected: PASS — 新規テストを含む forecast-engine の全テストがパス。

- [ ] **Step 5: コミット**

```bash
cd 乗務地図関係
git add scripts/lib/forecast-engine.mjs tests/forecast-engine.test.mjs
git diff --cached --name-only   # data/ が含まれないことを確認
git commit -m "$(cat <<'EOF'
fix(forecast-engine): computeForecast の早すぎる四捨五入を除去

slot 値を Math.round で整数化してから throughputScaleK を掛けるため、
小数の出庫レート (中央値 0.333) が 0 に潰れていた。中間丸めを外し、
整数化は applyThroughputScale の round(値×k) 1回に集約する。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: pattern-matcher.mjs の historicalCurve 中間丸めを除去

**Files:**
- Modify: `scripts/lib/pattern-matcher.mjs`（`computePatternMatch` 内、244-247行付近）
- Test: `tests/pattern-matcher.test.mjs`（末尾に追加）

- [ ] **Step 1: 失敗する回帰テストを書く**

`tests/pattern-matcher.test.mjs` の末尾（最終行 184 の後）に追加する。`computePatternMatch`・`loadHolidaysSet`・`makeRow` は既にインポート/定義済みなので追加 import は不要。

```javascript

test('computePatternMatch: historicalCurve は類似日平均を丸めず小数で保持する (早すぎる四捨五入バグ回帰)', () => {
  // 2026-05 の平日 3 日に 17:35 の信頼行 (luminance 100) を 1 本ずつ。
  // stall1 の出庫 (= -diff_occupied_from_prev) は [1, 0, 0] → 3 日平均 = 1/3。
  // Math.round で 0 に潰れてはいけない。
  const holidays = loadHolidaysSet({ holidays: [] });
  const history = [
    makeRow('2026-05-11T17:35:00+09:00', 100, -1, 0, 0, 0),
    makeRow('2026-05-12T17:35:00+09:00', 100, 0, 0, 0, 0),
    makeRow('2026-05-13T17:35:00+09:00', 100, 0, 0, 0, 0),
  ];
  // 現在 17:30 → forecast slot 0 = 17:35
  const r = computePatternMatch(history, holidays, new Date('2026-05-15T17:30:00+09:00'));
  assert.equal(r.historicalCurve.length, 24);
  assert.equal(r.historicalCurve[0].slotStart, '17:35');
  assert.equal(r.historicalCurve[0].stall1, 1 / 3);
  assert.equal(r.historicalCurve[0].total, 1 / 3);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/pattern-matcher.test.mjs`
Expected: FAIL — `r.historicalCurve[0].stall1` が `0`（`Math.round(1/3)`）になり `1/3` と一致しない。

- [ ] **Step 3: 中間丸めを除去**

`scripts/lib/pattern-matcher.mjs` の `computePatternMatch` 内、244-247行付近。

変更前:
```javascript
    const stall1 = count > 0 ? Math.round(stallSums[0] / count) : 0;
    const stall2 = count > 0 ? Math.round(stallSums[1] / count) : 0;
    const stall3 = count > 0 ? Math.round(stallSums[2] / count) : 0;
    const stall4 = count > 0 ? Math.round(stallSums[3] / count) : 0;
```

変更後:
```javascript
    // 小数のまま保持する。整数化は書き出し時の applyThroughputScale (round(値×k)) で1回だけ行う。
    const stall1 = count > 0 ? stallSums[0] / count : 0;
    const stall2 = count > 0 ? stallSums[1] / count : 0;
    const stall3 = count > 0 ? stallSums[2] / count : 0;
    const stall4 = count > 0 ? stallSums[3] / count : 0;
```

（`total: stall1 + stall2 + stall3 + stall4` は変更不要。小数和になる。）

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test tests/pattern-matcher.test.mjs`
Expected: PASS — 新規テストを含む pattern-matcher の全テストがパス。

- [ ] **Step 5: コミット**

```bash
cd 乗務地図関係
git add scripts/lib/pattern-matcher.mjs tests/pattern-matcher.test.mjs
git diff --cached --name-only   # data/ が含まれないことを確認
git commit -m "$(cat <<'EOF'
fix(pattern-matcher): historicalCurve の早すぎる四捨五入を除去

類似日マッチの historicalCurve で平均を Math.round してから
throughputScaleK を掛けるため小数が 0 に潰れていた。中間丸めを外す。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: ensemble-engine.mjs の加重平均中間丸めを除去

**Files:**
- Modify: `scripts/lib/ensemble-engine.mjs`（`computeEnsemble` 内、100行付近）
- Test: `tests/ensemble-engine.test.mjs`（末尾に追加）

- [ ] **Step 1: 失敗する回帰テストを書く**

`tests/ensemble-engine.test.mjs` の末尾（最終行 110 の後）に追加する。`computeEnsemble`・`makeForecast`・`makePatternMatch` は既にインポート/定義済みなので追加 import は不要。

```javascript

test('computeEnsemble: 加重平均の小数値を丸めず保持する (早すぎる四捨五入バグ回帰)', () => {
  // forecast stall1 = 1、pattern-match stall1 = 0、mae 同値 → 重み w_fc=w_pm=0.5。
  // 加重平均 = 1*0.5 + 0*0.5 = 0.5。Math.round(0.5)=1 で潰してはいけない。
  const fc = makeForecast([[1, 0, 0, 0]]);
  const pm = makePatternMatch([[0, 0, 0, 0]]);
  const accuracy = {
    recent24h: {
      forecast:     { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
      patternMatch: { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
    },
  };
  const r = computeEnsemble(fc, pm, accuracy, new Date('2026-06-01T17:00:00+09:00'));
  assert.equal(r.slots[0].stall1, 0.5);
  assert.equal(r.slots[0].total, 0.5);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/ensemble-engine.test.mjs`
Expected: FAIL — `r.slots[0].stall1` が `1`（`Math.round(0.5)`）になり `0.5` と一致しない。

- [ ] **Step 3: 中間丸めを除去**

`scripts/lib/ensemble-engine.mjs` の `computeEnsemble` 内、95-104行付近。

変更前:
```javascript
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      let val;
      if (pm === null) {
        val = fc[name];
      } else {
        val = Math.round(fc[name] * w_fc + pm[name] * w_pm);
      }
      out[name] = val;
      total += val;
    }
```

変更後:
```javascript
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      let val;
      if (pm === null) {
        val = fc[name];
      } else {
        // 小数のまま保持する。整数化は書き出し時の applyThroughputScale (round(値×k)) で1回だけ行う。
        val = fc[name] * w_fc + pm[name] * w_pm;
      }
      out[name] = val;
      total += val;
    }
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test tests/ensemble-engine.test.mjs`
Expected: PASS — 新規テストを含む ensemble-engine の全テストがパス。

- [ ] **Step 5: コミット**

```bash
cd 乗務地図関係
git add scripts/lib/ensemble-engine.mjs tests/ensemble-engine.test.mjs
git diff --cached --name-only   # data/ が含まれないことを確認
git commit -m "$(cat <<'EOF'
fix(ensemble-engine): computeEnsemble の早すぎる四捨五入を除去

加重平均を Math.round してから throughputScaleK を掛けるため小数が
0 に潰れていた。中間丸めを外す。これで予測パイプライン3か所すべてが
小数を保持し、整数化は applyThroughputScale の round(値×k) に一本化。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 全回帰テスト

**Files:** なし（検証のみ）

- [ ] **Step 1: Node テスト全件を実行**

Run: `cd 乗務地図関係 && npm test`
Expected: PASS — 全 451 件（＋本計画で追加した3件 = 454 件）がパス。失敗が出た場合は、その原因が「整数出力を前提にしていた別テスト」かを確認する。設計書の波及分析どおり `applyThroughputScale` は小数入力でも `round(×k)` が機能するため `throughput-calibration` 系は影響しないはずだが、もし失敗したら停止してユーザーに報告する（勝手にアサーションを書き換えない）。

- [ ] **Step 2: Python テストを実行**

Run: `cd 乗務地図関係 && .venv.nosync/bin/python3 -m unittest tests.test_detect_vehicles tests.test_track_vehicles`
Expected: PASS — detect 13 + track 29 = 42 件。`.venv.nosync` が無い場合は `.venv` を試す。本修正は `.mjs` のみで Python に影響しないため回帰確認の位置づけ。

- [ ] **Step 3: コミット不要**

このタスクはコミットを生成しない。テストが全てパスしたことを確認して次へ進む。

---

## Task 5: 実データ検証

**Files:**
- Create: `scripts/tmp-verify-rounding-fix.mjs`（一時ファイル。**コミットしない**。検証後に削除）

- [ ] **Step 1: 検証スクリプトを作成**

`scripts/tmp-verify-rounding-fix.mjs` を作成する。

```javascript
// 一時検証スクリプト: 予測の早すぎる四捨五入バグ修正の実データ検証。
// 実行後に削除する。コミットしない。
import { readFileSync } from 'node:fs';
import { computeBaseline } from './lib/forecast-engine.mjs';

const K = 5; // learning 到達時の校正係数 (診断書の証拠と同条件)

const lines = readFileSync('data/taxi-pool-history.jsonl', 'utf8')
  .split('\n').filter(l => l.trim());
const history = lines.map(l => JSON.parse(l));
const baseline = computeBaseline(history);

let nonNull = 0, oldNonZero = 0, newNonZero = 0, recovered = 0;
for (const slot of baseline.slots) {
  for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
    const b = slot[name];
    if (b === null || b === undefined) continue;
    nonNull++;
    const oldVal = Math.round(b) * K;          // バグ: 丸めてから ×k
    const newVal = Math.round(b * K);          // 修正: ×k してから丸め
    if (oldVal > 0) oldNonZero++;
    if (newVal > 0) newNonZero++;
    if (oldVal === 0 && newVal > 0) recovered++;
  }
}

console.log(`非 null baseline slot 値: ${nonNull}`);
console.log(`旧 (round(b)×k>0): ${oldNonZero}`);
console.log(`新 (round(b×k)>0): ${newNonZero}`);
console.log(`0→非0 に回復したスロット: ${recovered}  (${(recovered / nonNull * 100).toFixed(1)}%)`);
console.log(recovered > 0 && newNonZero > oldNonZero
  ? 'OK: 修正により非0スロットが増加。診断書の ~166/704 (24%) と整合するか確認。'
  : 'NG: 回復スロットなし。データor実装を再確認。');
```

- [ ] **Step 2: 検証スクリプトを実行**

Run: `cd 乗務地図関係 && node scripts/tmp-verify-rounding-fix.mjs`
Expected: `0→非0 に回復したスロット` が診断書の 166/704（約24%）とおおむね整合する出力。`OK:` 行が表示されること。`data/taxi-pool-history.jsonl` の蓄積量により実数は診断時から増減しうるが、回復スロット割合が 20〜28% 程度なら整合とみなす。乖離が大きい場合は停止してユーザーに報告する。

- [ ] **Step 3: 検証スクリプトを削除**

Run: `cd 乗務地図関係 && rm scripts/tmp-verify-rounding-fix.mjs`
一時ファイルなのでコミットしない。`git status` に残っていないことを確認する。

- [ ] **Step 4: main へ push**

```bash
cd 乗務地図関係
git pull --rebase --autostash origin main
git push origin main
```

rebase で再生成系 JSON（`data/stall-*.json` 等）が衝突したら `git checkout --theirs <file>` → `git add` → `git rebase --continue`。append-only 観測ファイルの未コミット行は working tree に残す（次 observe-tick が回収）。`git reset --hard` は禁止。

---

## 完了条件

- Task 1〜3 の回帰テスト3件が小数出力前提でパスする。
- `npm test` 454 件 ＋ Python 42 件が全てパス（回帰なし）。
- 実データ検証で 0→非0 回復スロットが診断書の約24%と整合する。
- 修正3コミットが `origin/main` に反映される。

## Self-Review

- **Spec coverage:** 設計書の変更内容4ファイル → forecast-engine(Task1)/pattern-matcher(Task2)/ensemble-engine(Task3)、throughput-calibration は「変更なし」で Task 不要。テスト方針 → Task1-3 のTDD＋Task4の全回帰。実データ検証 → Task5。波及・確認事項 → Task4で回帰確認。全要件にタスクが対応。
- **Placeholder scan:** TBD/TODO なし。全ステップに実コード・実コマンド・期待出力を記載。
- **Type consistency:** `computeForecast` / `computePatternMatch` / `computeEnsemble` のシグネチャは既存テストの呼び出しと一致。`makeRow`(6引数: ts,lum,s1d..s4d)、`makeForecast`/`makePatternMatch`(slotStalls 配列)、`makeArrivals`(flights) は各テストファイルの既存定義と一致。`computeBaseline` は forecast-engine.mjs の既存 export。

---

## Task 6: correction-engine.mjs（applyLevelCorrection）の中間丸めを除去

> **追加タスク（2026-05-18）** — Task 1-5 完了後の最終レビューで判明した4つ目の早すぎる丸め。
> `stall-ensemble.json` のパイプラインは `observe-taxi-pool.mjs` 行 435-437 で
> `computeForecast → applyLevelCorrection → computeEnsemble → applyThroughputScale` であり、
> `applyLevelCorrection` が forecast を再び整数化していた。Task 1-3 と同型の修正。

**Files:**
- Modify: `scripts/lib/correction-engine.mjs`（`applyLevelCorrection` 内、61行付近）
- Test: `tests/correction-engine.test.mjs`（既存テスト1件を小数前提に更新＋回帰テスト1件を追加）

- [ ] **Step 1: 既存テストを小数前提に更新し、回帰テストを追加**

`tests/correction-engine.test.mjs` の既存テスト（`applyLevelCorrection: lead30 factor 1.5 → round 乗算・total 再計算`）を以下に置き換える。

置き換え前:
```javascript
test('applyLevelCorrection: lead30 factor 1.5 → round 乗算・total 再計算', () => {
  const fc = makeForecast([[2, 1, 3, 0]]); // slot0 = lead 5min → lead30
  const corrections = { level: { lead30: { factor: 1.5 }, lead60: { factor: 1.0 }, lead120: { factor: 1.0 } } };
  const r = applyLevelCorrection(fc, corrections);
  assert.equal(r.slots[0].stall1, 3); // round(2*1.5)
  assert.equal(r.slots[0].stall3, 5); // round(3*1.5=4.5)
  assert.equal(r.slots[0].total, 3 + 2 + 5 + 0);
});
```

置き換え後（小数前提に更新＋直後に回帰テストを追加）:
```javascript
test('applyLevelCorrection: lead30 factor 1.5 → 小数乗算・total 再計算 (丸めない)', () => {
  const fc = makeForecast([[2, 1, 3, 0]]); // slot0 = lead 5min → lead30
  const corrections = { level: { lead30: { factor: 1.5 }, lead60: { factor: 1.0 }, lead120: { factor: 1.0 } } };
  const r = applyLevelCorrection(fc, corrections);
  // 早すぎる四捨五入を行わない。整数化は書き出し時の applyThroughputScale で1回だけ。
  assert.equal(r.slots[0].stall1, 3);   // 2 * 1.5
  assert.equal(r.slots[0].stall3, 4.5); // 3 * 1.5 — round で 5 に潰してはいけない
  assert.equal(r.slots[0].total, 3 + 1.5 + 4.5 + 0); // 9
});

test('applyLevelCorrection: 小数の forecast 値を factor 1.0 で 0 に潰さない (早すぎる四捨五入バグ回帰)', () => {
  // computeForecast は小数を出す。factor=1.0 (学習20件未満のブートストラップ既定) で
  // round すると 0.333 → 0 に潰れ stall-ensemble.json がほぼ0になる。丸めてはいけない。
  const fc = makeForecast([[1 / 3, 0, 0, 0]]);
  const corrections = { level: { lead30: { factor: 1.0 }, lead60: { factor: 1.0 }, lead120: { factor: 1.0 } } };
  const r = applyLevelCorrection(fc, corrections);
  assert.equal(r.slots[0].stall1, 1 / 3);
  assert.equal(r.slots[0].total, 1 / 3);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

Run: `node --test tests/correction-engine.test.mjs`
Expected: FAIL — 更新したテストで `r.slots[0].stall3` が `5`（`Math.round(4.5)`）、`total` が `10` になり期待値 `4.5` / `9` と一致しない。回帰テストでも `stall1` が `0`（`Math.round(1/3)`）になり `1/3` と一致しない。

- [ ] **Step 3: 中間丸めを除去**

`scripts/lib/correction-engine.mjs` の `applyLevelCorrection` 内、61行付近。

変更前:
```javascript
    for (const name of STALL_NAMES) {
      const v = Math.round((slot[name] || 0) * factor);
      out[name] = v;
      total += v;
    }
```

変更後:
```javascript
    for (const name of STALL_NAMES) {
      // 小数のまま保持する。整数化は書き出し時の applyThroughputScale (round(値×k)) で1回だけ行う。
      const v = (slot[name] || 0) * factor;
      out[name] = v;
      total += v;
    }
```

- [ ] **Step 4: テストを実行して成功を確認**

Run: `node --test tests/correction-engine.test.mjs`
Expected: PASS — 更新したテストと新規回帰テストを含む correction-engine の全テストがパス。

- [ ] **Step 5: 全回帰テスト**

Run: `cd 乗務地図関係 && npm test`
Expected: PASS — 全件パス（Task 1-3 で 454 件、本タスクで回帰テスト1件追加 = 455 件）。失敗が出たら停止してユーザーに報告する。

- [ ] **Step 6: コミット**

```bash
cd 乗務地図関係
git add scripts/lib/correction-engine.mjs tests/correction-engine.test.mjs
git diff --cached --name-only   # data/ が含まれないことを確認
git commit -m "$(cat <<'EOF'
fix(correction-engine): applyLevelCorrection の早すぎる四捨五入を除去

stall-ensemble.json パイプラインは computeForecast → applyLevelCorrection →
computeEnsemble → applyThroughputScale。applyLevelCorrection が forecast を
Math.round((slot[name]||0)*factor) で再整数化し、小数を 0 に潰していた
(特に factor=1.0 のブートストラップ時)。中間丸めを外す。これで ensemble
パイプライン全体が小数を保持し、整数化は applyThroughputScale に一本化。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```
