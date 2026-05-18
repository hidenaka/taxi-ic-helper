# セッション引き継ぎ (HANDOFF)

> 最終更新: 2026-05-18 / このファイルは「次セッションが即座に作業を再開する」ための引き継ぎ。

## 次にやること（ユーザー選択）

**G-1〜G-9 は完了・本番稼働中**（G-1 throughput→forecast 接続 / G-2 トラッカー stall ROI 制限 / G-3 複数カメラ追跡 / G-4 jitter 計装＝C 前半 / G-5 baseline 出力の真値化＝B案 / G-6 forecast-accuracy.json の真値単位移行 / G-7 DIST_THRESHOLD 適正化＝C 後半 / G-8 stall-pattern-match.json の真値化 / G-9 本番画面の実測校正バナー表示）。**forecast/ensemble/accuracy/pattern-match の4出力 JSON はすべて真値単位で揃い、予測画面にも校正済みであることが表示される。**

### 進行中タスク

なし。

**直近完了（2026-05-18）: 予測の早すぎる四捨五入バグ修正** — `stall-ensemble.json` が「ほぼ0＋5の倍数スパイク」になる不具合を解消。小数の出庫レート（中央値0.333）を `Math.round` で整数化してから校正係数 `×k` を掛けるため0に潰れていた。早すぎる丸めを **4か所** 除去（`forecast-engine.mjs` `computeForecast` / `pattern-matcher.mjs` `historicalCurve` / `ensemble-engine.mjs` `computeEnsemble` / `correction-engine.mjs` `applyLevelCorrection`）。整数化は書き出し時の `applyThroughputScale` の `round(値×k)` 1回に集約。4つ目の `applyLevelCorrection` は当初の診断（3か所想定）が見落としていた段で、最終レビューで発覚し追加修正した（`stall-ensemble.json` パイプラインは `computeForecast → applyLevelCorrection → computeEnsemble → applyThroughputScale`）。診断書 `docs/research/2026-05-18-forecast-rounding-bug-diagnosis.md`・設計書/計画 `docs/superpowers/{specs,plans}/2026-05-18-forecast-rounding-bug-fix*`。全455テストpass。`origin/main 5f6eb9e3`。実データ検証で baseline スロットの 0→非0 回復を確認済み。

**直近完了（2026-05-18）: トラッカー実測アンカー型 予測土台 再設計** — 予測が需要ピーク（満車）時に「全スロット0」になる構造欠陥を解消。原因＝予測の土台 baseline が net-diff（占有数の変化）由来で、満車時は出庫しても即埋まり diff=0 になり「出庫0」と読む。一方 F-3 トラッカーは満車でも実出庫を検出（実測で直近60分69台）。対策＝`computeForecast` に**トラッカーアンカー経路**を追加（`trackTrend` 有効時は予測レベルをトラッカー実測出庫レートにアンカー、前向き形状はフライト需要比、乗り場別は占有比で按分。`trackTrend` 無効時は従来の net-diff 経路へフォールバック）。`computeEnsemble` に pattern-match 構造的0スロットの希釈ガード。新ヘルパー `flightDemand`/`splitTotalToStalls`。`trendWindow.levelSource`（`track-anchored`/`netdiff-fallback`）追加。設計書/計画 `docs/superpowers/{specs,plans}/2026-05-18-tracker-anchored-forecast*`。全466テスト＋Python42pass。`origin/main 661a3c40`。実データ検証で満車・net-diff=0 でも `track-anchored` で24/24スロット非0を確認。

### 次タスク候補

- **pattern-match（類似日マッチ）のトラッカー実測ベース化** — `historicalCurve` はまだ net-diff 由来で満車時0。現状は ensemble の希釈ガードで forecast 100% に倒して凌いでいる。トラッカーアンカー型予測の follow-up として `computePatternMatch` の土台もトラッカー化する。設計書 `2026-05-18-tracker-anchored-forecast-design.md` の §3「スコープ外」参照。
- **検出ベースの並行 forecast** — F-2 データ蓄積後。F-1/F-2 は 5/16 稼働開始、まだ蓄積初期。着手前に検出データ量を確認。

（C の再測定は 2026-05-17 完了。0.025 デプロイ後 matched_dists を集計し real01_line p90 0.033→0.0038・両カメラ100%≤0.025 でクリーン確定。IoU エスカレーション不要。詳細は `docs/superpowers/specs/2026-05-17-dist-threshold-tuning-design.md` の「後続検証」節。）

次セッションはユーザーがどれをやるか決めてから `superpowers:brainstorming` で開始（下記ワークフロー参照）。

### G-1 〜 G-9 の状態（参考）
- spec/plan: `docs/superpowers/{specs,plans}/2026-05-16-throughput-forecast-connection*`、同 `2026-05-16-tracker-stall-roi-restriction*`、同 `2026-05-16-multi-camera-tracking*`、同 `2026-05-16-tracker-jitter-instrumentation*`、同 `2026-05-16-baseline-output-truthification*`。
- **G-4**: `update_tracks` がマッチ距離を `matched_dists` で返し、v3 行の `cameras[*].matched_dists` に記録（加算的、schema 3 不変）。C 後半の `DIST_THRESHOLD` 設定はこのデータ蓄積待ち。
- **G-5**: `applyThroughputScale` で `stall-forecast.json`/`stall-ensemble.json` を書き出し時に `k` 倍（真の出庫台数）。内部（log・accuracy・correction・ensemble 計算）は net-diff 据え置き。`k=bootstrapping` 中は ×1.0 で出力不変、`learning` 到達後に効く。出力に `throughputScaleK` マーカー。
- **G-6**: `applyThroughputScaleToAccuracy` で `forecast-accuracy.json` の MAE を書き出し時に `k` 倍（MAE は同次なので k 倍で真値化）。in-memory `accuracyResult` は net-diff 据え置き → `computeWeights`/ensemble 不変。`evaluateAccuracy`・`forecast-log.jsonl` も net-diff のまま。
- **G-7**: `matched_dists` 実測 3154 サンプル分析（main cluster≤0.005、累積94%≤0.025、駐車間隔0.035）→ `DIST_THRESHOLD` 0.06→0.025。**C 再測定（2026-05-17 完了）**: 0.025 デプロイ後の matched_dists で real01_line p90 0.033→0.0038・両カメラ100%≤0.025 → 分布クリーン確定、IoU マッチへのエスカレーション不要。
- **G-8**: `applyThroughputScale` を `slotsKey` 引数で一般化（既定 `'slots'`、後方互換）し、`stall-pattern-match.json` の `historicalCurve` を書き出し時に `k` 倍。in-memory `patternMatchResult` は net-diff 据え置き（ensemble 入力不変）。これで4出力 JSON が真値単位で統一。
- **G-9**: 予測画面 `forecast.html` の `<main>` 冒頭に校正バナー（`#throughput-banner`）を追加。`forecast-render.js` の `renderThroughputBanner(el, obj)` が ensemble の `throughputScaleK` を読み、`>1` なら「🚕 予測台数は車両追跡の実測で校正済み（校正係数 ×k）」、それ以外は「占有差分ベース（校正データ蓄積中）」を表示。`forecast-app.js` が ensemble fetch 後に呼ぶ。表示のみ・JSON 側不変。spec/plan: `docs/superpowers/{specs,plans}/2026-05-17-forecast-ui-throughput-label*`。
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

## 実装済みフェーズ（D-1〜G-9、全て本番稼働）

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
| G-9 | 本番画面に実測校正バナー表示（`throughputScaleK` を読み校正済み/蓄積中を表示） | `forecast.html`（`#throughput-banner`+CSS）, `js/forecast-render.js`（`renderThroughputBanner`）, `js/forecast-app.js`（配線） |

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

- 検出ベースの並行 forecast（F-2 データ蓄積後）
