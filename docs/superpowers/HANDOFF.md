# セッション引き継ぎ (HANDOFF)

> 最終更新: 2026-05-16 / このファイルは「次セッションが即座に作業を再開する」ための引き継ぎ。

## 次にやること（ユーザー選択）

**Phase G-1（追跡 throughput → forecast 接続）は 2026-05-16 完了・本番稼働中。** 次タスクは未確定。候補：

- **B 案：baseline 出力の真値化** — G-1 は `trendFactor` の単位合わせに留め、forecast 出力は net-diff 単位のまま。forecast `total` を真の出庫台数にするには D-1 `buildActualMap`・correction-engine・ensemble の単位移行が必要。別 spec。G-1 の直接の続き。
- **複数カメラ追跡** — F-3 は Real01_line のみ。Real02（stall4）の追跡を追加。
- **検出ベースの並行 forecast** — F-2 データ蓄積後。

次セッションはユーザーがどれをやるか決めてから `superpowers:brainstorming` で開始（下記ワークフロー参照）。

### G-1 の状態（参考）
- spec/plan: `docs/superpowers/{specs,plans}/2026-05-16-throughput-forecast-connection*`。
- `vehicle-track-history.jsonl` は 2026-05-16 13時頃に稼働開始 → 当面は track データ不足で calibration は `bootstrapping`（net-diff 経路フォールバック）。重複 5 分窓が 12 個溜まると `learning` に遷移し `stall-forecast.json` の `trendWindow.source` が `track` に変わる。
- 観測は `observe-tick-local.sh` の `STOP_DATE=2026-06-01` で約2週間後に停止予定。

## 厳守ワークフロー（このプロジェクトの全機能で踏襲してきた）

1 機能 = `brainstorming`（spec化・ユーザー承認）→ `writing-plans`（plan化・ユーザー承認）→ `executing-plans`（TDD実装）。
- spec: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`、plan: `docs/superpowers/plans/`。
- spec/plan は各々ユーザーに `y` 承認をもらってから次へ。実装方式はユーザーが毎回「Inline Execution」を選択。
- 各 Task は TDD（失敗テスト→実装→パス→commit）。

## プロジェクト構成（重要・実機の事実）

- リポジトリ `乗務地図関係` = GitHub `hidenaka/taxi-ic-helper`。タクシー需給予測の機械学習パイプライン。
- **観測は Mac mini が `~/repos/taxi-ic-helper`（GitHub からの独立 clone）で実行。** iCloud Drive 内のこのフォルダ**ではない**。両者は GitHub 経由で同期。デプロイ手順は `~/repos` 側を対象に。
- このフォルダ（iCloud Drive 内）= 開発コピー。Claude はここで作業。
- launchd ジョブ: `jp.taxi-ic-helper.observe`（5分・観測本体）、`jp.taxi-ic-helper.track`（60秒・F-3 車両追跡）。
- Python venv: Mac mini `~/repos` は `.venv`（observe-tick-local.sh が参照）。iCloud フォルダでの検証は `.venv.nosync`（iCloud 同期除外名）。deps: onnxruntime / numpy / pillow（`requirements.txt`）。
- `models/yolov8m.onnx`（103MB）は `.gitignore` 済 → git で配られない。Mac mini に手動配置済み。

## git 運用の鉄則

- **main 直 push 運用**（feature branch なし）。observe-tick が 5 分毎に main へ commit/push。
- push 前に必ず `git pull --rebase --autostash origin main`。
- autostash コンフリクト時: **`git reset --hard` 禁止**。再生成系 JSON（`data/stall-*.json` / `forecast-accuracy.json` / `coefficient-corrections.json`）のみ `git checkout HEAD --` で破棄。append-only 観測ファイル（`taxi-pool-history` / `t3-pool-history` / `vehicle-detection-history` / `vehicle-track-history`）の未コミット行は working tree に残す（次 observe-tick が commit）。解決後 autostash を `git stash drop`。
- rebase コミット適用で再生成系 JSON が衝突したら `git checkout --theirs <file>` → `git add` → `git rebase --continue`。
- **docs コミットに観測データファイルを混ぜない。** spec/plan commit 前に `git diff --cached --name-only` で確認、混入していたら `git restore --staged data/<file>`。
- commit メッセージ末尾: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`。

## 実装済みフェーズ（D-1〜F-3、全て本番稼働）

| Phase | 内容 | 主要ファイル |
|---|---|---|
| D-1 | 予測精度トラッキング | `accuracy-evaluator.mjs`, `forecast-logger.mjs`, `forecast-accuracy.json` |
| D-2 | アンサンブル統合予測 | `ensemble-engine.mjs`, `stall-ensemble.json` |
| D-3 | 係数オンライン補正（forecast level / transit-share） | `correction-engine.mjs`, `coefficient-corrections.json` |
| D-4 | terminal別 share補正（T1/T2 直接、T3 unobservable） | `correction-engine.mjs` |
| E-1 | T3乗り場・待機所プール観測（並行収集） | `aux-observation.mjs`, `t3-pool-history.jsonl` |
| E-2 | T3 需要圧力 方向性補正 | `correction-engine.mjs` (`computeT3DirectionalCorrection`) |
| F-1 | YOLOv8 車両検出 | `detect_vehicles.py`, `vehicle-detection-history.jsonl` |
| F-2 | T1/T2 検出ベース並行占有分析 | `detect_vehicles.py` (`count_boxes_per_stall`) |
| F-3 | 車両フレーム間追跡（60秒・throughput） | `track_vehicles.py`, `vehicle-track-history.jsonl` |
| G-1 | 追跡 throughput → forecast 接続（`trendFactor` 単位合わせ係数 `k`、累積比・bootstrap フォールバック） | `throughput-calibration.mjs`, `throughput-calibration.json`, `forecast-engine.mjs`（`trackTrend` 引数） |

各フェーズの spec/plan は `docs/superpowers/{specs,plans}/2026-05-16-*` にある。

## テスト

- `npm test`（node:test）= 427 件。`.mjs` のみ対象。
- Python: `.venv*/bin/python3 -m unittest tests/test_detect_vehicles.py tests/test_track_vehicles.py`（detect 13 + track 6 = 19 件）。`.py` は node:test 非対象。
- 回帰時は両方確認。

## 既知の状態 / データタイミング

- D-3 の level 補正は `learning` で稼働中（forecast-log 蓄積済）。share / D-4 / E-2 は完了日7日窓が埋まる ~5/23 以降に `learning`/`directional` 化。
- F-1/F-2/F-3 は検出・追跡データの蓄積中（本セッション稼働開始）。
- working tree に `M data/taxi-pool-history.jsonl` / `M data/t3-pool-history.jsonl` が残ることがある（観測の未コミット行、次 tick が回収。正常）。

## ロードマップ残

- baseline 出力の真値化（B 案、G-1 の続き、別 spec）
- 複数カメラ追跡（F-3 は Real01_line のみ）
- 検出ベースの並行 forecast（F-2 データ蓄積後）
