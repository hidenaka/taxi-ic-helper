# 車両フレーム間追跡 設計 (Phase F-3)

- 日付: 2026-05-16
- 対象: 乗務地図関係 / Real01_line の車両を60秒間隔で追跡し出庫 throughput を計測
- 前提 spec: `2026-05-16-vehicle-detection-design.md` (F-1、実装済)、`2026-05-16-t1t2-detection-analysis-design.md` (F-2、実装済)
- 由来: ユーザーの「起点車を FIFO で追って出庫台数を数える」案。本フェーズで全車追跡として実装する。

## 背景

F-1 で YOLOv8 車両検出、F-2 で stall 別検出カウントが稼働した。だがこれらは各 tick の「占有スナップショット」で、「何台が出庫したか (throughput)」は分からない。占有の差分 (net-diff) は「5分の間に入れ替わった分」を取りこぼす。

ユーザーの当初案は「起点車1台を選び、FIFO (並んだ順は前後しない) で位置の前進量から出庫台数を数える」。だが起点車の追跡は「フレーム間で車があまり動かない」ことが前提で、5分間隔では成立しない。

本フェーズは **60秒間隔の高頻度サブループ**を新設し、Real01_line の車を**全車フレーム間追跡**する。駐車中の車は60秒でほぼ静止 → 位置ベースの対応付けが安定 → 消えたトラック = 出庫。細かいサンプリングでは全車追跡が「起点車1台 + FIFO」の上位互換 (FIFO 仮定も単一列も不要) なので、全車追跡として実装する。

## 設計方針

1. **git と切り離した60秒ループ。** 60秒毎の git コミットは過剰。トラッキングジョブはローカルファイル I/O のみ。出力 `vehicle-track-history.jsonl` は既存の5分 observe-tick が git add する (コミット頻度は現状維持)。
2. **既存を変えない。** F-1 (`detect_vehicles.py`) / F-2 / observe-taxi-pool.mjs / forecast・D系・E系は不変。`detect_vehicles.py` の YOLO 関数を import 再利用するのみ。
3. **新 pip 依存なし。** onnxruntime 等は F-1 の venv をそのまま使う。
4. **収集のみ。** throughput を記録するだけ。forecast への接続は後フェーズ。
5. **fail-safe。** 取得・推論失敗時はその tick をスキップ、状態据え置き、次 tick 継続。

## アーキテクチャ

```
[新 launchd ジョブ jp.taxi-ic-helper.track]  StartInterval 60
  .venv/bin/python3 scripts/track_vehicles.py
    1. data/track-state.json をロード (前フレームのトラック)
    2. Real01_line を取得 → YOLO 検出 (detect_vehicles.py の関数を再利用)
    3. update_tracks: 検出を既存トラックに位置で対応付け
    4. data/track-state.json を保存 + data/vehicle-track-history.jsonl に1行追記
  ※ git 操作は一切しない

[既存 observe-tick-local.sh]  5分毎
  git add 対象に data/vehicle-track-history.jsonl を追加 → 5分毎にコミット
```

## トラッカー: `update_tracks` (純関数)

トラックの表現: `{ "id": int, "x": float, "y": float, "w": float, "h": float, "missed": int }`。`x`/`y` は中心の 0-1 正規化座標。

`update_tracks(prev_tracks, detections, next_id, max_missed, dist_threshold)`:
- `prev_tracks`: 前 tick のトラック list。
- `detections`: 今 tick の YOLO 検出 box list (`{x, y, w, h, ...}`)。
- 各検出について、未マッチのトラックの中から中心座標のユークリッド距離が最小かつ `dist_threshold` 以内のものを貪欲にマッチ。
  - マッチ成立 → トラックの `x/y/w/h` を検出値で更新、`missed = 0`。
  - 未マッチの検出 → 新トラック (`id = next_id`、`next_id += 1`)、`arrived += 1`。
  - 未マッチのトラック → `missed += 1`。`missed > max_missed` ならトラック消滅 (`departed += 1`、結果から除外)。`missed <= max_missed` なら box 据え置きで残す。
- 戻り値: `{ tracks: [...], next_id: int, arrived: int, departed: int }`。

定数: `MAX_MISSED = 2` (2 tick 連続で見えなければ出庫確定、YOLO の取りこぼし1回を吸収)、`DIST_THRESHOLD = 0.06` (正規化中心距離)。駐車中の車はほぼ静止のため、対応付けは位置一致でほぼ確定する。

## `track_vehicles.py` のフロー

1. `STOP_DATE = "2026-06-01"` 以降なら何もせず終了 (観測停止日チェック)。
2. `data/track-state.json` をロード。無ければ `{ tracks: [], next_id: 1 }`。
3. Real01_line を取得し、`detect_vehicles.py` の `fetch_image` / `detect_image` で車両 box を得る (失敗時はその tick スキップ、state 据え置き)。
4. `update_tracks(state.tracks, detections, state.next_id, MAX_MISSED, DIST_THRESHOLD)`。
5. `data/track-state.json` を `{ tracks, next_id }` で上書き保存。
6. `data/vehicle-track-history.jsonl` に1行追記。

## 出力スキーマ

### `data/vehicle-track-history.jsonl` (schema v1、git 管理・append-only)

60秒 tick = 1行:

```json
{
  "schema_version": 1,
  "ts": "2026-05-16T13:01:00+09:00",
  "detected": 16,
  "active": 15,
  "arrived": 1,
  "departed": 2
}
```

- `detected`: その tick の YOLO 検出数。
- `active`: 更新後の生存トラック数。
- `arrived`: 今 tick で新規になったトラック数。
- `departed`: 今 tick で消滅 (出庫確定) したトラック数。`departed` の累計が throughput。

### `data/track-state.json` (ローカルのみ・gitignore)

```json
{ "tracks": [ { "id": 1, "x": 0.5, "y": 0.3, "w": 0.1, "h": 0.08, "missed": 0 } ], "next_id": 12 }
```

トラッカーの内部状態。60秒ループの各 tick で読み書きする。git では配らない (各実行機ローカル)。

## 配線・セットアップ

- `scripts/install-track-launchd.sh` (新規): `jp.taxi-ic-helper.track` を `StartInterval 60` で install/uninstall/status。`install-observe-launchd.sh` と同じ作り。`ProgramArguments` はラッパーシェルを介さず、インストーラが解決した絶対パスで `<REPO>/.venv/bin/python3 <REPO>/scripts/track_vehicles.py` を直接呼ぶ (`track_vehicles.py` は `__file__` からリポジトリパスを自己解決するため cwd 非依存)。ログは `.local/track-stdout.log` / `.local/track-stderr.log`。
- `scripts/observe-tick-local.sh`: `git add` 対象に `data/vehicle-track-history.jsonl` を追加 (append-only なので pull 前 checkout 対象には含めない)。
- `.gitignore`: `data/track-state.json` を追加。
- `.gitattributes`: `data/vehicle-track-history.jsonl merge=union` を追加。
- 新 pip 依存なし。Mac mini デプロイは `git pull` 後 `./scripts/install-track-launchd.sh install` のみ。

## エラーハンドリング

| 事象 | 対応 |
|---|---|
| Real01_line 取得・推論失敗 | その tick はスキップ。`track-state.json` 据え置き、`vehicle-track-history.jsonl` 追記なし。次 tick で継続 |
| `track-state.json` が無い・壊れている | `{ tracks: [], next_id: 1 }` から開始 |
| `models/yolov8m.onnx` が無い | 標準エラーを出して非ゼロ終了。launchd は次 tick で再試行 |
| `STOP_DATE` 以降 | 何もせず終了 |

## テスト方針

`tests/test_track_vehicles.py` (`unittest`) で `update_tracks` をテスト:
- 検出が前トラックと同位置 → マッチして継続 (`missed=0`、id 保持)
- 新規位置の検出 → 新トラック、`arrived` 増加
- 前トラックに対応する検出なし → `missed` 増加、`max_missed` 超で `departed` 増加・除外
- `missed` が `max_missed` 以内 → トラック据え置きで残る
- 距離が `dist_threshold` 超 → マッチせず別トラック扱い
- 検出ゼロ → 全トラック `missed` 増加

ネットワーク取得・ONNX 推論部は単発実行で目視確認。`npm test` (node:test、407 件) は不変。

## スコープ外 (後フェーズ)

- throughput の forecast / outflow への接続
- 複数カメラ (MVP は Real01_line のみ)
- 起点車の appearance ベース re-identification (全車位置追跡で代替済み)
- カルマンフィルタ等の高度な動き予測 (駐車プールは静止物が大半のため不要)
- `observe-taxi-pool.mjs` / `detect_vehicles.py` / forecast・accuracy・ensemble・correction・E系の変更

## 完了条件

- `scripts/track_vehicles.py` が60秒毎に Real01_line を検出・追跡し `data/vehicle-track-history.jsonl` に schema v1 の行を追記する
- `update_tracks` が純関数として実装され `unittest` テストがある
- 行に `detected` / `active` / `arrived` / `departed` がある
- `data/track-state.json` でトラッカー状態が tick 間で永続する
- `scripts/install-track-launchd.sh` で60秒ジョブ `jp.taxi-ic-helper.track` を install/uninstall できる
- `observe-tick-local.sh` の git add に `vehicle-track-history.jsonl`、`.gitignore` に `track-state.json`、`.gitattributes` に merge=union
- 60秒ループは git 操作をしない
- `detect_vehicles.py` / `observe-taxi-pool.mjs` / 既存 forecast 系・F-1・F-2 は不変
