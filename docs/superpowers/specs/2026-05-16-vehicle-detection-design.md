# YOLOv8 車両検出 設計 (Phase F-1)

- 日付: 2026-05-16
- 対象: 乗務地図関係 / 観測画像の車両検出・台数カウント基盤
- 関連: `2026-05-16-t3-pool-observation-design.md` (E-1)、`2026-05-11-observation-schema-v2-design.md` (「物体検出 ML モデル (YOLO等) の導入」を将来候補として記載)
- 後続: F-2 (起点車追跡 + FIFO throughput)

## 背景

現在の観測は画像統計 (黒比率・エッジ密度・輝度) で stall 占有を推定している。これは「満杯プールの台数」や「curb の throughput」を正確に測れない。ユーザーの「起点車を FIFO で追って出庫台数を数える」案 (F-2) を実現するには、まず「車がどこにあるか」を検出する基盤が要る。

`models/yolov8m.onnx` (YOLOv8 medium、103MB) は既にダウンロード済みだが未配線 (`onnxruntime` 依存なし・コードから未使用)。本フェーズ F-1 でこれを観測に配線し、車両検出・台数カウントを**並行収集**する。F-2 (起点追跡) は F-1 の検出 box を土台に後続フェーズで作る。

## 設計方針

1. **収集のみ。** 各 tick で観測画像の車両を検出し台数・box を記録するだけ。占有推定の置き換え・forecast への接続はしない (後フェーズ)。E-1 と同じ「まず集める」。
2. **完全独立。** 既存の `observe-taxi-pool.mjs` / `taxi-pool-history.jsonl` / forecast・accuracy・ensemble・correction・E-1 を一切変更しない。検出結果は独立した新ファイル `data/vehicle-detection-history.jsonl` に記録。
3. **独立 Python プロセス。** YOLO 推論は Python (`onnxruntime`) で行う。YOLOv8 出力のデコード + NMS が numpy で簡潔・堅牢なため。`scripts/detect-vehicles.py` をスタンドアロン化し、`observe-tick-local.sh` から並行ステップとして呼ぶ。`observe-taxi-pool.mjs` は経由しない。
4. **fail-safe。** 検出ステップは `|| true` で囲み、失敗しても既存観測・本処理は継続。

## アーキテクチャ

```
[observe-tick-local.sh] 5分毎 (既存 launchd ジョブ)
  既存: node scripts/observe-taxi-pool.mjs  (taxi-pool-history / forecast / D-* / E-1、不変)
  新規: python3 scripts/detect-vehicles.py || true
        1. ttc の観測8画像を取得
        2. 各画像を 640x640 にレターボックス → yolov8m.onnx 推論
        3. 出力 [1,84,8400] をデコード → NMS → 車両クラス抽出
        4. data/vehicle-detection-history.jsonl に1行追記
```

## 検出対象8画像

E-1 までで観測している全画像。URL は `https://ttc.taxi-inf.jp/<name>.jpg`。

| 画像 | 内容 |
|---|---|
| `Real01_line` | T1/T2 プール (stall1-3 観測元) |
| `Real02` | T1/T2 プール (stall4 観測元) |
| `Real106` / `Real107` | T3乗り場 |
| `Real03` / `Real04` / `Real108` / `Real109` | 待機所プール |

## YOLOv8 推論

- **モデル**: `models/yolov8m.onnx`。入力 `images` テンソル `[1,3,640,640]`、RGB、0-1 正規化、NCHW、レターボックス (アスペクト比保持・余白パディング)。
- **出力**: `[1,84,8400]`。84 = 4 (cx,cy,w,h) + 80 クラススコア。8400 アンカー。
- **デコード**: 各アンカーのクラススコア最大値が `CONF_THRESHOLD` 以上なら検出。bbox は 640 空間。
- **NMS**: クラス非依存、IoU しきい値 `NMS_IOU = 0.45`。
- **車両クラス**: COCO の `car`(2) / `motorcycle`(3) / `bus`(5) / `truck`(7) のみ採用。タクシーは `car`。
- **座標変換**: bbox をレターボックス逆変換で元画像座標に戻し、元画像サイズで 0-1 正規化。

### 定数

| 定数 | 値 | 意味 |
|---|---|---|
| `CONF_THRESHOLD` | 0.30 | 検出信頼度しきい値 |
| `NMS_IOU` | 0.45 | NMS の IoU しきい値 |
| `INPUT_SIZE` | 640 | モデル入力辺長 |

## `data/vehicle-detection-history.jsonl` (schema v1)

1 tick = 1 行。

```json
{
  "schema_version": 1,
  "ts": "2026-05-16T11:50:00+09:00",
  "images": [
    {
      "name": "Real01_line",
      "vehicle_count": 47,
      "boxes": [
        { "cls": "car", "conf": 0.82, "x": 0.512, "y": 0.301, "w": 0.104, "h": 0.083 }
      ]
    }
  ]
}
```

- `ts`: スクリプト実行時刻の JST ISO 文字列 (Python が自前生成。`observe-taxi-pool.mjs` の tick_seq とは共有しない — 独立ファイルのため)。
- `vehicle_count`: その画像の車両クラス検出数。
- `boxes`: 各検出。`cls` は車両クラス名、`conf` は信頼度、`x`/`y` は box 中心の正規化座標、`w`/`h` は正規化幅高。F-2 (起点追跡) が位置を使う。
- 一部画像の取得・推論失敗 → その画像エントリを省略。全画像失敗 → その tick は追記スキップ。

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| `models/yolov8m.onnx` が無い | スクリプトが標準エラーを出して非ゼロ終了。`observe-tick-local.sh` の `|| true` で tick は継続 |
| 一部画像の取得・推論失敗 | その画像をスキップ。他画像は記録 |
| 全画像失敗 | `vehicle-detection-history.jsonl` への追記スキップ |
| `onnxruntime` 等の未インストール | スクリプトが import エラーで終了。`|| true` で tick 継続 (検出は記録されないが既存観測は無傷) |

## 配線・セットアップ

- `scripts/observe-tick-local.sh`: `node scripts/observe-taxi-pool.mjs` の後に `python3 scripts/detect-vehicles.py || true` を追加。`git add` 対象に `data/vehicle-detection-history.jsonl` を追加 (append-only なので pull 前 checkout 対象には含めない)。
- `.gitignore`: `models/` を追加。`yolov8m.onnx` は 103MB で GitHub の1ファイル100MB上限を超えるため git に乗せられない。各実行機に手動配置する。
- `.gitattributes`: `data/vehicle-detection-history.jsonl merge=union` を追加。
- `requirements.txt` を新規作成 (`onnxruntime` / `numpy` / `pillow`)。Mac mini (観測実行機) と検証マシンで `pip install -r requirements.txt` を一度実行する**手動セットアップ手順**。

## テスト方針

`scripts/detect-vehicles.py` のうち純粋ロジック (`decode_yolo_output`、`nms`、レターボックス座標逆変換) を関数化し、Python 標準ライブラリ `unittest` で `tests/test_detect_vehicles.py` をテストする。ネットワーク取得・ONNX 推論部は単発実行 (`python3 scripts/detect-vehicles.py`) で生成行を目視確認する。`npm test` (node:test) には影響しない。

## スコープ外 (後フェーズ)

- **F-2: 起点車追跡 + FIFO throughput** — `boxes` を使い、起点車を選んで追跡し出庫台数を数える本体。
- **T1/T2 の検出ベース並行分析** — ユーザー要望: F-1 がある程度できたら、T1/T2 についても YOLO 検出ベースの分析を現行の黒比率ベース機構と**並行して**走らせる。検出台数で stall 占有・forecast を作り直す parallel pipeline。F-1 完了後の別フェーズ。
- 検出台数で既存の黒比率占有を置き換えること
- forecast / share補正 への接続
- `taxi-pool-history.jsonl` / 既存 forecast・accuracy・ensemble・correction・E-1 の変更

## 完了条件

- `scripts/detect-vehicles.py` が8画像を YOLOv8m で検出し `data/vehicle-detection-history.jsonl` に schema v1 の行を追記する
- 行は `images` 配列を持ち、各エントリに `name` / `vehicle_count` / `boxes` がある
- `boxes` の座標は 0-1 正規化
- `observe-tick-local.sh` に検出ステップが `|| true` 付きで配線され、git add 対象に新ファイルが入る
- `.gitignore` に `models/`、`.gitattributes` に新ファイルの merge=union
- `requirements.txt` がある
- `decode_yolo_output` / `nms` に `unittest` テストがある
- `observe-taxi-pool.mjs` / `taxi-pool-history.jsonl` / 既存 forecast 系・E-1 は不変
