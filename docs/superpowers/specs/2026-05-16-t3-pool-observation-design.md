# T3乗り場・待機所プール観測 設計 (Phase E-1)

- 日付: 2026-05-16
- 対象: 乗務地図関係 / 観測対象の拡張 (T3乗り場 + 待機所プール)
- 関連: Phase A 観測 (`taxi-pool-history.jsonl`)、`2026-05-11-observation-schema-v2-plan.md`
- 前提: D-4 (`2026-05-16-terminal-share-correction-design.md`) で T3 は観測4 stall に無く `unobservable` とした。本フェーズで T3 の観測手段を新設する。

## 背景

現在の観測 (`observe-taxi-pool.mjs`) は ttc.taxi-inf.jp の `Real01_line.jpg` / `Real02.jpg` の2画像から stall1-4 (T1/T2 乗り場) の占有を測り `taxi-pool-history.jsonl` に記録している。T3 (国際線) の乗り場と、タクシー待機所プールは観測していない。

ttc サイト (公益財団法人 東京タクシーセンター 羽田空港TPシステム) には他のカメラページがある:

- **No5TaxiStand.php** = 第3ターミナルタクシー乗り場 (= 第5乗り場)。画像 `Real106.jpg` (乗り場先頭・乗車中の歩道側) / `Real107.jpg` (別角度)。
- **no23.php** = 第3・第4待機所 (タクシープール)。画像 `Real03.jpg` / `Real109.jpg` (タクシー密集プール) / `Real04.jpg` / `Real108.jpg` (グリッド駐車場)。

T3乗り場の先頭は「T3 需要のパルス」、待機所プールの埋まり具合は「タクシー供給量」を表す。これらを収集すれば T3 の需給ダイナミクスが見えるようになる。

本フェーズは **収集のみ** (Phase A と同じ「まず集める」)。ROI 精密校正・占有/台数推定・予測への接続は後フェーズ。

## 設計方針

1. **既存観測と並行。** 既存の `taxi-pool-history.jsonl` (schema v3) と既存の forecast/accuracy/ensemble/correction パイプラインには一切触れない。
2. **独立した新ファイル。** 新観測は `data/t3-pool-history.jsonl` に記録する。`taxi-pool-history.jsonl` の schema を拡張しない。理由: `buildActualMap` (accuracy-evaluator.mjs) と `computeBaseline` (forecast-engine.mjs) が `schema_version !== 3` の行をスキップするため、v4 に上げると D-1〜D-4 が全行を無視して壊れる。完全分離が安全。
3. **収集のみ。** 各画像の全体メトリクスを記録する。ROI 精密校正・占有推定はしない (後フェーズ)。
4. **fail-safe。** 新観測ステップは try/catch で囲み、失敗しても既存観測 (`taxi-pool-history.jsonl` 追記) と本処理に影響しない。
5. **同一 tick・同一ジョブ。** 既存の `observe-taxi-pool.mjs` にステップを追加する。別スクリプト・別 launchd ジョブにはしない。

## アーキテクチャ

```
[observe-tick] 5分毎 (既存 launchd ジョブ observe-tick-local.sh)
  既存処理: Real01_line + Real02 → taxi-pool-history.jsonl (schema v3、不変)
  既存処理: forecast / pattern-match / D-1 / D-3 / D-2 (不変)
  新規ステップ (try/catch):
    1. Real106, Real107, Real03, Real04, Real108, Real109 を取得
    2. 各画像の全体メトリクスを算出
    3. data/t3-pool-history.jsonl に 1 行追記 (schema_version=1)
```

## 観測対象6画像

| 画像 | ページ | 内容 | グループ |
|---|---|---|---|
| `Real106.jpg` | No5TaxiStand.php | T3乗り場 先頭 (歩道側) | `t3_stand` |
| `Real107.jpg` | No5TaxiStand.php | T3乗り場 別角度 | `t3_stand` |
| `Real03.jpg` | no23.php | 第3待機所 (密集プール) | `pool` |
| `Real04.jpg` | no23.php | 第4待機所 (グリッド駐車場) | `pool` |
| `Real108.jpg` | no23.php | 第3待機所 別ビュー | `pool` |
| `Real109.jpg` | no23.php | 第3待機所 (密集プール 別角度) | `pool` |

画像 URL は `https://ttc.taxi-inf.jp/<name>.jpg`。

## 記録メトリクス (画像全体・ROIなし)

各画像について以下を算出する。既存の画像解析ロジック (`image-pool-analyzer.mjs`) を画像全体に対して適用する (calibrated sub-ROI は使わない)。

| キー | 内容 |
|---|---|
| `name` | 画像名 (例 `Real106`) |
| `sha256` | 画像バイト列の SHA-256 (重複 tick 検出用) |
| `size_bytes` | 画像バイトサイズ |
| `black_ratio` | 暗画素比率 (夜間・障害検出用) |
| `edge_density` | エッジ密度 (画像内の構造量 ≒ 車両量の粗い代理) |
| `luminance_mean` | 輝度平均 |
| `luminance_std` | 輝度標準偏差 |
| `diff_from_prev` | 前 tick の同名画像との差分比率。前 tick が無い・取得失敗時は `null` |

`diff_from_prev` は `t3-pool-history.jsonl` の最終行から同名画像のメトリクスを引いて算出する。前回値が無ければ `null`。

## 新ファイル `data/t3-pool-history.jsonl` (schema v1)

1 tick = 1 行 (JSON Lines)。

```json
{
  "schema_version": 1,
  "ts": "2026-05-16T11:14:27+09:00",
  "tick_seq": 1162,
  "t3_stand": [
    { "name": "Real106", "sha256": "...", "size_bytes": 13961, "black_ratio": 0.05, "edge_density": 0.12, "luminance_mean": 180.2, "luminance_std": 40.1, "diff_from_prev": 0.03 },
    { "name": "Real107", "sha256": "...", "size_bytes": 18899, "black_ratio": 0.08, "edge_density": 0.18, "luminance_mean": 150.5, "luminance_std": 38.0, "diff_from_prev": null }
  ],
  "pool": [
    { "name": "Real03", "sha256": "...", "size_bytes": 225500, "black_ratio": 0.11, "edge_density": 0.30, "luminance_mean": 120.0, "luminance_std": 42.0, "diff_from_prev": 0.01 },
    { "name": "Real04", "...": "..." },
    { "name": "Real108", "...": "..." },
    { "name": "Real109", "...": "..." }
  ]
}
```

`tick_seq` は既存観測と同じ tick 連番を共有する (`observe-taxi-pool.mjs` 内で既に算出済みの値を使う)。`ts` も同じ tick タイムスタンプ。

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| 一部画像の取得失敗 | その画像のエントリを省略 (配列から除く)。他画像は記録 |
| 全画像取得失敗 (`t3_stand` も `pool` も空) | その tick は `t3-pool-history.jsonl` への追記をスキップ (空行は記録価値が無い) |
| 新ステップ全体の例外 | try/catch で握り、`console.error` のみ。既存観測・本処理は継続 |
| 前 tick 行が無い・壊れている | `diff_from_prev` は `null` |

## 配線

- `scripts/observe-taxi-pool.mjs`: 既存処理の後に新ステップを追加 (try/catch)。
- `scripts/observe-tick-local.sh`: `git add` 対象に `data/t3-pool-history.jsonl` を追加。append-only なので pull 前 `git checkout HEAD --` 対象には**含めない** (観測行を捨てないため)。
- `.gitattributes`: `data/t3-pool-history.jsonl merge=union` を追加 (`taxi-pool-history.jsonl` と同じ append-only 衝突回避)。

## テスト方針

`observe-taxi-pool.mjs` は副作用 (ネットワーク・ファイル I/O) を持つオーケストレーターで既存もユニットテストされていない。新規ステップで純粋ロジックを切り出せる部分 (例: 画像メトリクス → 行オブジェクト整形、`diff_from_prev` 算出) があれば純関数化し `node:test` でテストする。ネットワーク取得部は単発実行 (`node scripts/observe-taxi-pool.mjs`) で生成行を目視確認する。

## スコープ外 (後フェーズ)

- ROI 精密校正 (`stall-rois.json` 相当を新画像に作る) と占有/台数推定
- T3 share 補正 (D-4 の `unobservable` だった T3) への接続
- 待機所プール供給量の forecast への組み込み
- `forecast.html` / `arrivals.html` での表示
- 既存 `taxi-pool-history.jsonl` / forecast・accuracy・ensemble・correction 系の変更

## 完了条件

- `observe-taxi-pool.mjs` が毎 tick で6画像を取得し `data/t3-pool-history.jsonl` に1行追記する
- 行は schema v1 で `t3_stand` (Real106/107) と `pool` (Real03/04/108/109) を含む
- 各画像エントリに `sha256` / `size_bytes` / `black_ratio` / `edge_density` / `luminance_mean` / `luminance_std` / `diff_from_prev` がある
- 新ステップ失敗時も `taxi-pool-history.jsonl` 追記と既存処理が継続する
- `taxi-pool-history.jsonl` の schema v3 と forecast/accuracy/ensemble/correction は不変
- `observe-tick-local.sh` の git add に `t3-pool-history.jsonl` 追加、`.gitattributes` に merge=union 追加
- 純関数化した部分に `node:test` のテストがある
