# セッション引き継ぎ (HANDOFF)

> 最終更新: 2026-05-16 / このファイルは「次セッションが即座に作業を再開する」ための引き継ぎ。

## 次にやること（ユーザー依頼）

**追跡 throughput を forecast に接続する。**

- F-3 で `data/vehicle-track-history.jsonl` に 60 秒毎の `{detected, active, arrived, departed}` が記録される。`departed` の累計＝出庫 throughput。
- 現在の forecast (`scripts/lib/forecast-engine.mjs` の `computeBaseline`/`computeForecast`) は stall 占有の net-diff を outflow 代理に使っている。net-diff は「5 分間に入れ替わった分」を取りこぼす。
- このタスク＝追跡ベースの正確な throughput を forecast/baseline の outflow 信号として接続する。
- **未着手。** 次セッションは `superpowers:brainstorming` から開始すること（下記ワークフロー参照）。

### 着手前の注意（設計時に必ず考慮）
- `vehicle-track-history.jsonl` は本セッションで稼働開始したばかり → データはほぼ空。機構先行・データ後追い（D-1〜F-3 と同じパターン）。
- 観測は `observe-tick-local.sh` の `STOP_DATE=2026-06-01` で約2週間後に停止予定。
- 追跡は Real01_line 1 カメラのみ（F-3 MVP）。forecast は stall1-4 単位 → カメラ全体 throughput を stall 別 outflow にどう対応づけるかが設計論点。

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

各フェーズの spec/plan は `docs/superpowers/{specs,plans}/2026-05-16-*` にある。

## テスト

- `npm test`（node:test）= 407 件。`.mjs` のみ対象。
- Python: `.venv*/bin/python3 -m unittest tests/test_detect_vehicles.py tests/test_track_vehicles.py`（detect 13 + track 6 = 19 件）。`.py` は node:test 非対象。
- 回帰時は両方確認。

## 既知の状態 / データタイミング

- D-3 の level 補正は `learning` で稼働中（forecast-log 蓄積済）。share / D-4 / E-2 は完了日7日窓が埋まる ~5/23 以降に `learning`/`directional` 化。
- F-1/F-2/F-3 は検出・追跡データの蓄積中（本セッション稼働開始）。
- working tree に `M data/taxi-pool-history.jsonl` / `M data/t3-pool-history.jsonl` が残ることがある（観測の未コミット行、次 tick が回収。正常）。

## ロードマップ残（このタスクの後）

- 複数カメラ追跡（F-3 は Real01_line のみ）
- 検出ベースの並行 forecast（F-2 データ蓄積後）
