# セッション引き継ぎ (HANDOFF)

> 最終更新: 2026-05-16 / このファイルは「次セッションが即座に作業を再開する」ための引き継ぎ。

## 次にやること（ユーザー選択）

**G-1〜G-8 は完了・本番稼働中**（G-1 throughput→forecast 接続 / G-2 トラッカー stall ROI 制限 / G-3 複数カメラ追跡 / G-4 jitter 計装＝C 前半 / G-5 baseline 出力の真値化＝B案 / G-6 forecast-accuracy.json の真値単位移行 / G-7 DIST_THRESHOLD 適正化＝C 後半 / G-8 stall-pattern-match.json の真値化）。**forecast/ensemble/accuracy/pattern-match の4出力 JSON はすべて真値単位で揃った。** 次タスクは未確定。候補：

- **C の再測定（要データ蓄積）** — G-7 で `DIST_THRESHOLD` を 0.06→0.025 にした。デプロイ後 `matched_dists` を再蓄積し、real01_line のマッチ距離分布が締まったか確認。締まらず 0.03 付近に厚いままなら、貪欲＋距離マッチを IoU ベース等に変える別タスクへエスカレーション（`2026-05-17-dist-threshold-tuning-design.md` スコープ外節）。
- **検出ベースの並行 forecast** — F-2 データ蓄積後。

次セッションはユーザーがどれをやるか決めてから `superpowers:brainstorming` で開始（下記ワークフロー参照）。

### G-1 〜 G-8 の状態（参考）
- spec/plan: `docs/superpowers/{specs,plans}/2026-05-16-throughput-forecast-connection*`、同 `2026-05-16-tracker-stall-roi-restriction*`、同 `2026-05-16-multi-camera-tracking*`、同 `2026-05-16-tracker-jitter-instrumentation*`、同 `2026-05-16-baseline-output-truthification*`。
- **G-4**: `update_tracks` がマッチ距離を `matched_dists` で返し、v3 行の `cameras[*].matched_dists` に記録（加算的、schema 3 不変）。C 後半の `DIST_THRESHOLD` 設定はこのデータ蓄積待ち。
- **G-5**: `applyThroughputScale` で `stall-forecast.json`/`stall-ensemble.json` を書き出し時に `k` 倍（真の出庫台数）。内部（log・accuracy・correction・ensemble 計算）は net-diff 据え置き。`k=bootstrapping` 中は ×1.0 で出力不変、`learning` 到達後に効く。出力に `throughputScaleK` マーカー。
- **G-6**: `applyThroughputScaleToAccuracy` で `forecast-accuracy.json` の MAE を書き出し時に `k` 倍（MAE は同次なので k 倍で真値化）。in-memory `accuracyResult` は net-diff 据え置き → `computeWeights`/ensemble 不変。`evaluateAccuracy`・`forecast-log.jsonl` も net-diff のまま。
- **G-7**: `matched_dists` 実測 3154 サンプル分析（main cluster≤0.005、累積94%≤0.025、駐車間隔0.035）→ `DIST_THRESHOLD` 0.06→0.025。real02 はジッター極小、real01_line はマッチ距離が広がる（p90 0.033）— 0.025 で再測定し締まらなければ IoU マッチへエスカレーション検討。
- **G-8**: `applyThroughputScale` を `slotsKey` 引数で一般化（既定 `'slots'`、後方互換）し、`stall-pattern-match.json` の `historicalCurve` を書き出し時に `k` 倍。in-memory `patternMatchResult` は net-diff 据え置き（ensemble 入力不変）。これで4出力 JSON が真値単位で統一。
- **G-2 で判明・修正した根本問題**: F-3 トラッカーがカメラ全域を追跡し `departed` の約80%が stall 外の道路車両だった（G-1 検証で `k≈7` の異常値から発覚）。G-2 で検出を stall ROI union に絞った。
- **G-3**: トラッカーを Real02（stall4）にも拡張。`track-state.json`・`vehicle-track-history.jsonl` を per-camera 構造（schema 3）に。G-1 calibration は v3 行のみ採用・全カメラ `departed` 合算・net-diff を stall1〜4 に拡張。
- デプロイ後、`track-state.json` は schema マーカーで自動リセット。`vehicle-track-history.jsonl` の旧 v1/v2 行は calibration から無視され、v3 データ蓄積に従い `bootstrapping`→`learning` へ進む。`learning` 到達で `stall-forecast.json` の `trendWindow.source` が `track` に変わる。
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

## 実装済みフェーズ（D-1〜G-8、全て本番稼働）

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
| G-2 | F-3 トラッカーを stall ROI 制限（`departed` を真の出庫 throughput に修正、track 行 schema v2、track-state 自己回復） | `track_vehicles.py`（`stall_rois_for_camera`/`filter_to_rois`/`state_from_json`）, `throughput-calibration.mjs`（`TRACK_SCHEMA_VERSION`） |
| G-3 | 複数カメラ追跡（Real02/stall4 追加、per-camera schema v3、G-1 を全 stall(1-4) calibration に拡張） | `track_vehicles.py`（`TRACK_CAMERAS`/`camera_state`）, `throughput-calibration.mjs`（`trackRowDeparted`） |
| G-4 | トラッカー jitter 計装（`update_tracks` がマッチ距離 `matched_dists` を返し v3 行に記録、C 前半） | `track_vehicles.py`（`update_tracks` の `matched_dists`） |
| G-5 | baseline 出力の真値化（`stall-forecast.json`/`stall-ensemble.json` を書き出し時に `k` 倍、B案） | `throughput-calibration.mjs`（`applyThroughputScale`）, `observe-taxi-pool.mjs` |
| G-6 | forecast-accuracy.json の真値単位移行（MAE を書き出し時に `k` 倍） | `throughput-calibration.mjs`（`applyThroughputScaleToAccuracy`）, `observe-taxi-pool.mjs` |
| G-7 | `DIST_THRESHOLD` 適正化（実測ジッター由来 0.06→0.025、C 後半） | `track_vehicles.py`（`DIST_THRESHOLD` 定数） |
| G-8 | stall-pattern-match.json の真値化（`historicalCurve` を書き出し時に `k` 倍） | `throughput-calibration.mjs`（`applyThroughputScale` を `slotsKey` 引数で一般化）, `observe-taxi-pool.mjs` |

各フェーズの spec/plan は `docs/superpowers/{specs,plans}/2026-05-16-*` にある。

## テスト

- `npm test`（node:test）= 451 件。`.mjs` / `.js` 対象。
- Python: `.venv*/bin/python3 -m unittest tests.test_detect_vehicles tests.test_track_vehicles`（detect 13 + track 29 = 42 件）。`.py` は node:test 非対象。
- 回帰時は両方確認。

## 既知の状態 / データタイミング

- D-3 の level 補正は `learning` で稼働中（forecast-log 蓄積済）。share / D-4 / E-2 は完了日7日窓が埋まる ~5/23 以降に `learning`/`directional` 化。
- F-1/F-2/F-3 は検出・追跡データの蓄積中（本セッション稼働開始）。
- working tree に `M data/taxi-pool-history.jsonl` / `M data/t3-pool-history.jsonl` が残ることがある（観測の未コミット行、次 tick が回収。正常）。

## ロードマップ残

- トラッカー `DIST_THRESHOLD` の適正化（C、要ジッター実測）
- baseline 出力の真値化（B 案、G-1 の続き、別 spec）
- 検出ベースの並行 forecast（F-2 データ蓄積後）
