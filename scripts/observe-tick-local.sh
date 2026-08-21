#!/bin/bash
# launchd から 5 分ごとに呼ばれる観測ジョブのエントリポイント。
# 1. リポジトリ最新を pull
# 2. observe-taxi-pool.mjs で 1 tick 観測
# 3. data/taxi-pool-history.jsonl に変更があれば commit & push (3 回までリトライ)
#
# launchd plist の StartInterval: 300 (5 分) で起動される。
# 失敗してもステータス 0 で終了 (launchd の retry を待たず、次の周期で続行)。
#
# STOP_DATE 以降は何もせず skip する (uninstall は手動)。
# 観測は手動停止まで継続する方針のため、STOP_DATE は実質無期限 (2099-01-01) に設定。
# 期限を再設定する場合はこの日付を変更する。

set +e

STOP_DATE="2099-01-01"
TODAY_JST=$(TZ=Asia/Tokyo date '+%Y-%m-%d')
if [[ "$TODAY_JST" > "$STOP_DATE" || "$TODAY_JST" == "$STOP_DATE" ]]; then
  echo "[observe-tick] STOP_DATE=$STOP_DATE reached (today=$TODAY_JST), skip tick. Run './scripts/install-observe-launchd.sh uninstall' to fully stop."
  exit 0
fi

# REPO はスクリプトの親ディレクトリから自動解決 (どの Mac に移しても動く)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO" || { echo "[observe-tick] cd failed"; exit 0; }

# Node 22 を Homebrew or .nvm から拾う想定
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "[observe-tick] node not found in PATH"
  exit 0
fi

# 共有 git 同期関数を読み込む (孤立 rebase 残骸の強制掃除 + push 失敗の可視化 + 競合リトライ)。
# 2026-06-15 のアプリ 21 時間凍結 (push 停止 → relay 不発) の再発防止。
source "$SCRIPT_DIR/lib/git-safe-sync.sh"

# --- 自己回復: 前回 tick で残った rebase/merge 残骸を検出してリセット ---
# unmerged index entries (ls-files -u) or rebase/merge 状態ディレクトリがあれば異常
if [ -n "$(git ls-files -u 2>/dev/null)" ] || [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ]; then
  echo "[observe-tick] WARN: dirty merge/rebase state detected, cleaning up"
  git_clean_interrupted_state   # rebase/merge 残骸を強制除去 (abort で消えない孤立残骸も rm -rf)
  # forecast / pattern-match は次 tick で再生成されるので捨ててよい
  git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/stall-actuals.json data/coefficient-corrections.json data/throughput-calibration.json data/t3-pool-fill.json 2>/dev/null || true
fi

# --- pull 前に forecast/pattern-match の working tree 変更を捨てる ---
# observe-taxi-pool.mjs が毎 tick 全体上書き再生成するので、pull 前にローカルを HEAD に揃えれば衝突しない。
# 次の observe 実行で最新内容に上書きされる。
git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/stall-actuals.json data/coefficient-corrections.json data/throughput-calibration.json data/t3-pool-fill.json 2>/dev/null || true

git_clean_interrupted_state   # pull 前に孤立残骸を掃除 (これが無いと pull --rebase が永久に失敗する)
git pull --rebase --autostash origin main 2>&1 | tail -3

node scripts/observe-taxi-pool.mjs
NODE_EXIT=$?
if [ "$NODE_EXIT" -ne 0 ]; then
  echo "[observe-tick] observe script exit $NODE_EXIT, abort tick"
  exit 0
fi

# 最奥 stall1/2 の占有率(テクスチャ)を計測。台数カウント不可の遠景でも占有割合は出せる(2026-06-20)。
if [ -x .venv/bin/python3 ]; then .venv/bin/python3 scripts/texture-occupancy-tick.py || true; fi
# 号別(1〜4)全レーン埋まり率 tick (昼=学習モデル/夜=行灯)。publish が直近 median を pool-status に載せる。
if [ -x .venv/bin/python3 ]; then .venv/bin/python3 scripts/noriba-fill-tick.py || true; fi
# 号別の実台数カウント(新カメラ・昼=タイルYOLO/夜=行灯/薄暮=両方)。2026-08-21〜
if [ -x .venv/bin/python3 ]; then .venv/bin/python3 scripts/vehicle-count-tick.py || true; fi

# 現況バンドル (pool-status.json + サムネ) を生成 (fail-safe)
node scripts/publish-pool-status.mjs || true

# 段階B: 初回のみ、羽田公式APIの過去日(searchDt)から到着需要をバックフィル(即学習用)。
# 完成便は出口がほぼ全便埋まっているため過去の号別需要を再構成できる。以降は publish が日々追記。
# v6: 列移動検出を補充エッジ方式(detectReplenishments)に作り替えたので、過去の advance-count-history を
#     新方式で上書き再構築させる(backfill-arrival-demand 内 backfillAdvanceHistory が新 binAdvanceCounts 経由)。
if [ ! -f data/.arrival-backfill-done-v7 ]; then
  if node scripts/backfill-arrival-demand.mjs; then touch data/.arrival-backfill-done-v7; fi
fi

# 前進カウント(実測+予測)を data/advance-forecast.json に生成 (fail-safe)。
# 学習履歴(advance-count-history.jsonl)が無ければ publish 側で skip。
# 段階A: 到着便(乗り場号)を予測に反映。段階B学習用に到着需要も追記。
node scripts/publish-advance-forecast.mjs || true

# 段階B: 到着→列移動のラグを履歴学習し data/arrival-advance-coeffs.json を更新 (fail-safe・ローカル学習)。
# データが貯まるまでは applied:false(lag0=従来動作)。次回 publish がこの係数を読む。
node scripts/learn-arrival-advance.mjs || true

# 羽田プール現地案内テキスト取得 (fail-safe・Phase1)
node scripts/fetch-pool-notice.mjs || true

# 乗り場(号)の実績学習: 現地掲示で確定した「実際に着いた号」を貯めて
# A(便別)/B(時間帯×航空会社)のパターンを更新する (fail-safe)。
node scripts/publish-lane-patterns.mjs || true

# 健康チェック (計測停止/バックアップ不全の可視化 — 2026-08-08 追加)。
# 「待機車両計測の7時間停止」「5月からのバックアップ失敗」に誰も気づけなかった再発防止。
# read-only + フラグ/デスクトップ通知のベストエフォート。本流は止めない。
# 早期 exit (no derived-data change) より前に置くこと。
source "$SCRIPT_DIR/lib/health-check.sh" && health_check_all || true

# movement-shift シャドウ観測は専用 launchd ジョブ(jp.taxi-ic-helper.movement-shift, 60秒)に
# 移行したため、この5分ループからは呼ばない。data/movement-shift-history.jsonl の commit/push は
# 下の git add に含めて従来どおりこのループが担う(slot-occupancy と同じ構造)。

# Phase F-1: YOLOv8 車両検出 — 2026-05-23 停止。
# 占有は fill 自動較正(slot-occupancy-tick)が主系で実用域。YOLOは全画面でもROIクロップでも
# frame間ノイズが大きく(stall1=1↔10)、平滑化前提でも fill を上回らないと過去画像で実証された
# (本番UI/予測はどれも vehicle-detection-history を消費していない=純R&Dログ)。
# 再開する場合は下行のコメントを外す。scripts/detect_vehicles.py は温存。
# if [ -x .venv/bin/python3 ]; then .venv/bin/python3 scripts/detect_vehicles.py || true; fi

# コミット要否ゲート: 生履歴 jsonl は git 管理外 (ローカルのみ・容量肥大回避) にしたため、
# 毎 tick 再生成される派生 json の変化で判定する。advance-forecast.json は generatedAt が
# 毎 tick 変わるので、新しい観測があれば必ずここで commit→push→relay→アプリ更新まで流れる。
if [ -z "$(git status --porcelain data/advance-forecast.json data/pool-status.json data/stall-forecast.json)" ]; then
  echo "[observe-tick] no derived-data change, skip commit"
  exit 0
fi

# 配信に必要な派生 json + サムネだけを commit する。
# 生履歴 (taxi-pool / slot-occupancy / t3-pool / vehicle-* / movement-shift / t3-front-flow の各 history.jsonl)
# は Mac mini ローカルのみで保持し push しない (アプリ非配信・8.5G 画像アーカイブから再生成可・GitHub 100MB 制限回避)。
git add data/lane-patterns.json data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/stall-actuals.json data/coefficient-corrections.json data/throughput-calibration.json data/t3-pool-fill.json data/pool-status.json data/pool-cam-real01.jpg data/pool-cam-real02.jpg data/advance-forecast.json data/pool-notice.json 2>/dev/null || true
git commit -m "chore(observe): tick $(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')" || true

# 同期 + push (残骸掃除 → fetch → rebase → push を最大 5 回リトライ。
# weather/arrivals の 15 分ごとの auto-commit による non-fast-forward 競合に勝つ。
# 失敗時は .local/push-stuck.flag + デスクトップ通知で可視化し、無音で詰まらせない)。
if git_safe_sync_and_push "$REPO" main 5; then
  echo "[observe-tick] push ok"
else
  echo "[observe-tick] push STILL failing after retries — see .local/push-stuck.flag"
fi
exit 0
