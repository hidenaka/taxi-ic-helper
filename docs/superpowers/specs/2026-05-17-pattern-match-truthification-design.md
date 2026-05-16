# stall-pattern-match.json の真値化 設計

- 日付: 2026-05-17
- 対象: 乗務地図関係 / pattern-match 予測 JSON を真の出庫 throughput 単位にする
- 前提 spec: `2026-05-16-baseline-output-truthification-design.md`（G-5）、`2026-05-17-accuracy-truthification-design.md`（G-6）

## 背景

G-5 で `stall-forecast.json` / `stall-ensemble.json` を、G-6 で `forecast-accuracy.json` を真値化（calibration 係数 `k` で真の出庫台数単位に）した。残る予測 JSON `stall-pattern-match.json` は net-diff 単位のまま。UI が3つの予測 JSON を並べると pattern-match だけ単位が食い違う。本タスクで揃える。

## pattern-match オブジェクトの構造（現状）

`computePatternMatch` の戻り値 = `stall-pattern-match.json` の内容:

```
{
  schemaVersion, generatedAt,
  today: { date, dayType, month, ..., filterTier },   // メタデータ
  candidateCount,                                      // 数 (カウント)
  similarDays: [ { date, dayType, month, similarity, label, ... } ],  // メタデータ (outflow 数値なし)
  historicalCurve: [ { slotStart, slotEnd, stall1, stall2, stall3, stall4, total } ]  // 予測 outflow
}
```

outflow 数値を持つのは `historicalCurve` の各 slot の `stall1`〜`stall4` と `total` のみ。これは forecast の `slots[].stall1-4/total` と構造が同一。`similarDays`・`today`・`candidateCount`・`schemaVersion`・`generatedAt` は outflow 数値を持たないメタデータ。

## 設計方針

1. **出力境界スケーリング。** G-5/G-6 と同じく、`k` の適用は `stall-pattern-match.json` を書き出す瞬間のみ。`historicalCurve` の slot outflow を `k` 倍する。`computePatternMatch` の内部ロジックは変更しない。
2. **`applyThroughputScale` を一般化して再利用。** G-5 の `applyThroughputScale(obj, k)` は `obj.slots` をスケールする。pattern-match の outflow 配列はキーが `historicalCurve` で、slot の中身（`stall1-4/total`）は forecast の `slots` と同一構造。よって専用関数を新設せず、`applyThroughputScale` に「配列キー」をパラメータとして渡せるよう一般化する（専用関数は純粋な重複になる）。
3. **in-memory の patternMatchResult は未スケール。** `observe-taxi-pool.mjs` で `patternMatchResult` は `computeEnsemble` の入力にも使われる。ensemble は内部で forecast と pattern-match を net-diff のまま混合し、ensemble 出力は G-5 が別途スケールする。よって `patternMatchResult`（in-memory）は net-diff のまま保つ。スケール版は `stall-pattern-match.json` 書き出し用にのみ生成する。

## ① `applyThroughputScale` の一般化（`scripts/lib/throughput-calibration.mjs`）

`applyThroughputScale(obj, k)` に第3引数 `slotsKey`（既定 `'slots'`）を追加する。

- 関数シグネチャ: `applyThroughputScale(obj, k, slotsKey = 'slots')`。
- 現在 `obj.slots` を参照している箇所を `obj[slotsKey]` に置換:
  - 配列判定: `if (!Array.isArray(obj[slotsKey])) return { ...obj, throughputScaleK: scale };`
  - スケール対象: `obj[slotsKey].map(slot => ...)`。
  - 戻り値: `return { ...obj, [slotsKey]: scaledSlots, throughputScaleK: scale };`
- slot 内の処理（`stall1`〜`stall4` を `Math.round(値 × scale)`、`total` をスケール後 stall 合計で再計算、`slotStart`/`slotEnd` 等その他フィールドはコピー）は不変。
- `k` 正規化（非数値・非正なら `1.0`）、`throughputScaleK` 付与、非破壊も不変。

**後方互換**: `slotsKey` の既定値 `'slots'` により、G-5 の既存呼び出し（forecast / ensemble の `applyThroughputScale(obj, k)`）は挙動不変。pattern-match は `applyThroughputScale(obj, k, 'historicalCurve')` で呼ぶ。

## ② `observe-taxi-pool.mjs` の配線

- `stall-pattern-match.json` の書き出し: 現在 `patternMatchResult` を `JSON.stringify` している箇所を、`applyThroughputScale(patternMatchResult, throughputK, 'historicalCurve')` を `JSON.stringify` する形に変更。
- `throughputK` は G-5 で外側スコープに hoist 済みの変数をそのまま使う。
- `applyThroughputScale` の import は G-5 で追加済み（新規 import なし）。
- `patternMatchResult` 変数自体は変更しない（`applyThroughputScale` は新オブジェクトを返す）。後段で `computeEnsemble` に `{ historicalCurve: patternMatchResult.historicalCurve }` として渡る `patternMatchResult` は未スケール net-diff のまま → ensemble の内部混合・重み計算は不変。

## ③ 据え置くもの

- `similarDays`（メタデータ、outflow 数値なし）・`today`・`candidateCount`・`schemaVersion`・`generatedAt` はスケールしない。`applyThroughputScale` は `slotsKey` 配下の配列のみを変換し、他のトップレベルフィールドは `{ ...obj }` でそのままコピーするため、自動的にこの要件を満たす。
- `computePatternMatch` の内部ロジック・`computeEnsemble`・`pattern-matcher.mjs` は不変。

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| `historicalCurve` が空配列（候補日ゼロ時） | `[].map()` → `[]`。`{ ...obj, historicalCurve: [], throughputScaleK }` を返す。正常 |
| `historicalCurve` が配列でない | `applyThroughputScale` の防御で `throughputScaleK` だけ付けて返す |
| `k` が非数値・非正 | `1.0` 扱い |
| forecast ブロックが catch に落ちる | `throughputK` 既定 `1.0`（恒等） |

`applyThroughputScale` は純関数・副作用なし。書き出しは既存 try ブロック内のまま。

## テスト方針

### `tests/throughput-calibration.test.mjs`（node:test）

- 既存の `applyThroughputScale` テスト（`slots` を使用）は `slotsKey` の既定値で従来どおり pass — 不変。
- 追加: 第3引数 `'historicalCurve'` を渡すと、`historicalCurve[]` の各 slot の `stall1-4` が ×k・`total` がスケール後合計で再計算され、`slots` キーは見ない。pattern-match 形オブジェクト（`historicalCurve` + `similarDays` + `today`）を作り、`similarDays`/`today` が保持されることも検証。
- 追加: 第3引数を省略すると従来どおり `slots` を見ることを再確認（後方互換）。

### 回帰

- `npm test`（node:test）全 pass。`computePatternMatch` / pattern-matcher / ensemble 系のテストは net-diff のまま不変。
- `observe-taxi-pool.mjs` はネットワーク I/O のため、構文/import チェック + `npm test` 回帰で検証。

## デプロイ

新 pip/npm 依存なし、launchd 変更なし。Mac mini は observe-tick の `git pull` で自動反映。`k` が `bootstrapping`（=1.0）の間は出力不変。`learning` 到達後、`stall-pattern-match.json` の `historicalCurve` の outflow が真の出庫台数になり、`throughputScaleK` に適用値が出る。これで forecast・ensemble・accuracy・pattern-match の4出力 JSON がすべて真値単位で揃う。

## スコープ外（後続）

- `computePatternMatch` の内部ロジック変更。
- C 再測定（`DIST_THRESHOLD` 0.025 適用後の確認）。
- 検出ベース並行 forecast。

## 完了条件

- `applyThroughputScale` が第3引数 `slotsKey`（既定 `'slots'`）を持ち、`obj[slotsKey]` をスケールする。G-5 の既存呼び出しは後方互換で不変。
- `observe-taxi-pool.mjs` が `stall-pattern-match.json` を `applyThroughputScale(patternMatchResult, throughputK, 'historicalCurve')` 経由で書き出す。
- 書き出される `stall-pattern-match.json` が `k` 倍された `historicalCurve` の outflow と `throughputScaleK` を持つ。
- in-memory の `patternMatchResult`（`computeEnsemble` 入力）は未スケール net-diff のまま。
- `computePatternMatch` / `computeEnsemble` は不変。
- `npm test` 全 pass。
