# T1/T2 検出ベース並行占有分析 設計 (Phase F-2)

- 日付: 2026-05-16
- 対象: 乗務地図関係 / YOLO 検出による T1/T2 stall 占有の並行分析
- 前提 spec: `2026-05-16-vehicle-detection-design.md` (F-1、実装済)
- 後続: 起点車追跡 + FIFO throughput (旧 F-2 → F-3 に後ろ倒し)

## 背景

現在の T1/T2 観測は `observe-taxi-pool.mjs` の `analyzeStalls` が黒比率 (暗画素率) で stall1-4 の占有を推定している。F-1 で YOLOv8 車両検出が稼働し、観測8画像の車両 box が `vehicle-detection-history.jsonl` に記録され始めた。

本フェーズは F-1 の検出 box を使い、T1/T2 の stall 別車両台数を算出して、現行の黒比率機構と**並行して**記録する。同じ stall を「黒比率推定 (`occupied_estimate`)」と「YOLO 検出カウント」の2系統で測り、後から精度を比較できるようにする。ユーザー要望「F-1 がある程度できたら T1/T2 も検出ベースで現行と並行して分析する仕組みを走らせる」に対応。

## 設計方針

1. **並行・非置換。** 黒比率 `analyzeStalls` (`observe-taxi-pool.mjs`) は一切変更しない。検出ベースの stall カウントは別系統として `vehicle-detection-history.jsonl` に記録。2系統が並走する。
2. **F-1 のスクリプトを拡張。** 検出 box は `detect_vehicles.py` が既に持っている。stall 別カウントもそこで算出する (別スクリプトにしない)。
3. **既存 ROI を再利用。** stall 別の領域は `scripts/lib/stall-rois.json` の ROI を使う。黒比率機構と同じ ROI を使うことで stall 単位で直接比較できる。
4. **収集のみ。** stall 別検出台数 + 前 tick 差分を記録するだけ。検出ベースの forecast は後フェーズ (baseline 蓄積が要る)。

## アーキテクチャ

```
[observe-tick-local.sh] 5分毎
  既存: node observe-taxi-pool.mjs
        → analyzeStalls (黒比率) → taxi-pool-history.jsonl の stalls (不変)
  F-1+F-2: python detect_vehicles.py
        → 8画像を YOLO 検出 (F-1)
        → Real01_line/Real02 の検出 box を stall ROI に振り分け、stall 別台数算出 (F-2)
        → vehicle-detection-history.jsonl に images[] + t1t2_stalls を1行追記
```

## stall 別カウントのロジック

`scripts/lib/stall-rois.json` の構造 (既存):

```json
{
  "_meta": { "image_size": [800, 600] },
  "stalls": {
    "stall1": { "source": "real01_line", "roi": { "x": 600, "y": 80, "width": 200, "height": 170 } },
    "stall2": { "source": "real01_line", "roi": { ... } },
    "stall3": { "source": "real01_line", "roi": { ... } },
    "stall4": { "source": "real02", "roi": { ... } }
  }
}
```

純関数 `count_boxes_per_stall(boxes_by_image, stall_rois)`:

- 入力 `boxes_by_image`: `{ "Real01_line": [box, ...], "Real02": [box, ...] }`。box は F-1 の `{cls, conf, x, y, w, h}` (`x`/`y` は中心の 0-1 正規化座標)。
- 各 stall について:
  - `source` (`real01_line` / `real02`) を画像名 (`Real01_line` / `Real02`) に変換する (`source` の先頭を大文字化 = Python `str.capitalize()`)。
  - `roi` (ピクセル) を `_meta.image_size` で割って 0-1 正規化: `rx = roi.x / W`, `ry = roi.y / H`, `rw = roi.width / W`, `rh = roi.height / H`。
  - その画像の box のうち、box 中心 `(x, y)` が `rx <= x < rx+rw` ∧ `ry <= y < ry+rh` を満たすものを数える。
- 戻り値: `{ "stall1": n, "stall2": n, "stall3": n, "stall4": n }`。

`stall-rois.json` に無い stall、`source` 画像の box が未取得の場合はその stall を 0 とする。

## 前 tick 差分 (出庫の代理)

`detect_vehicles.py` が `vehicle-detection-history.jsonl` の最終行を読み、各 stall の `count` と前 tick の `count` の差を `diff_from_prev` とする。前 tick 行が無い・`t1t2_stalls` を持たない (v1 行) 場合は `null`。負の差 = その stall から車両が減った = 出庫の代理。

## スキーマ: `vehicle-detection-history.jsonl` v2

F-1 の v1 (`schema_version: 1`, `images[]`) を拡張。`schema_version` を 2 に、`t1t2_stalls` を追加:

```json
{
  "schema_version": 2,
  "ts": "2026-05-16T12:30:00+09:00",
  "images": [ { "name": "Real01_line", "vehicle_count": 16, "boxes": [ ... ] }, ... 8画像 ... ],
  "t1t2_stalls": {
    "stall1": { "count": 7, "diff_from_prev": -1 },
    "stall2": { "count": 5, "diff_from_prev": 0 },
    "stall3": { "count": 8, "diff_from_prev": -2 },
    "stall4": { "count": 3, "diff_from_prev": 1 }
  }
}
```

`images[]` は F-1 v1 と同一。`t1t2_stalls` は stall1-4 を必ず含む。

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| `stall-rois.json` が無い・不正 | `t1t2_stalls` を省略 (検出 `images[]` のみ記録)。`schema_version` は 2 のまま |
| Real01_line / Real02 の検出が失敗 (F-1 でその画像エントリ無し) | その画像が source の stall は `count: 0` |
| 前 tick 行が無い / v1 行 | 全 stall `diff_from_prev: null` |
| `t1t2_stalls` 算出中の例外 | try/except で握り、`t1t2_stalls` を省略。`images[]` の記録と既存処理は継続 |

## テスト方針

`tests/test_detect_vehicles.py` に `count_boxes_per_stall` のテストを追加 (`unittest`):
- box が ROI 内 → その stall に計上
- box 中心が ROI 外 → 計上しない
- `source` が異なる画像の box は混ざらない (Real01_line の box が stall4=Real02 に入らない)
- box ゼロ → 全 stall 0
- ピクセル ROI と正規化座標の対応が正しい (image_size で割った範囲判定)

完了条件: `python3 -m unittest tests/test_detect_vehicles.py` 全件パス。`npm test` (node:test、407 件) は不変。

## スコープ外 (後フェーズ)

- 検出ベースの並行 forecast (検出占有 → baseline → 予測)。baseline は多日の検出履歴蓄積が前提のため別フェーズ
- 黒比率機構 (`analyzeStalls`) の置き換え — 当面は2系統並走で比較
- 起点車追跡 + FIFO throughput (F-3)
- `forecast.html` での黒比率 vs 検出の2系統比較表示
- `observe-taxi-pool.mjs` / `taxi-pool-history.jsonl` / 既存 forecast・accuracy・ensemble・correction の変更

## 完了条件

- `detect_vehicles.py` が Real01_line/Real02 の検出 box から stall 別車両台数を算出し、`vehicle-detection-history.jsonl` の行に `t1t2_stalls` を追加する
- `schema_version` が 2
- `t1t2_stalls` の各 stall に `count` と `diff_from_prev` がある
- `count_boxes_per_stall` が純関数として実装され `unittest` テストがある
- 黒比率 `analyzeStalls` / `taxi-pool-history.jsonl` / `observe-taxi-pool.mjs` は不変
- `stall-rois.json` 欠損・例外時も `images[]` の記録と既存処理が継続する
