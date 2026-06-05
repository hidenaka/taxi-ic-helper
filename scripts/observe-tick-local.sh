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

# --- 自己回復: 前回 tick で残った rebase/merge 残骸を検出してリセット ---
# unmerged index entries (ls-files -u) or rebase/merge 状態ディレクトリがあれば異常
if [ -n "$(git ls-files -u 2>/dev/null)" ] || [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ]; then
  echo "[observe-tick] WARN: dirty merge/rebase state detected, cleaning up"
  git rebase --abort 2>/dev/null || true
  git merge --abort 2>/dev/null || true
  # 観測 jsonl の append-only 変更は救出 (merge=union で衝突しないが念のため)
  # forecast / pattern-match は次 tick で再生成されるので捨ててよい
  git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/stall-actuals.json data/coefficient-corrections.json data/throughput-calibration.json data/t3-pool-fill.json 2>/dev/null || true
  # 残った staged 変更を unstage
  git reset HEAD 2>/dev/null || true
fi

# --- pull 前に forecast/pattern-match の working tree 変更を捨てる ---
# observe-taxi-pool.mjs が毎 tick 全体上書き再生成するので、pull 前にローカルを HEAD に揃えれば衝突しない。
# 次の observe 実行で最新内容に上書きされる。
git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/stall-actuals.json data/coefficient-corrections.json data/throughput-calibration.json data/t3-pool-fill.json 2>/dev/null || true

git pull --rebase --autostash origin main 2>&1 | tail -3

node scripts/observe-taxi-pool.mjs
NODE_EXIT=$?
if [ "$NODE_EXIT" -ne 0 ]; then
  echo "[observe-tick] observe script exit $NODE_EXIT, abort tick"
  exit 0
fi

# 現況バンドル (pool-status.json + サムネ) を生成 (fail-safe)
node scripts/publish-pool-status.mjs || true

# 段階B: 初回のみ、羽田公式APIの過去日(searchDt)から到着需要をバックフィル(即学習用)。
# 完成便は出口がほぼ全便埋まっているため過去の号別需要を再構成できる。以降は publish が日々追記。
# v6: 列移動検出を補充エッジ方式(detectReplenishments)に作り替えたので、過去の advance-count-history を
#     新方式で上書き再構築させる(backfill-arrival-demand 内 backfillAdvanceHistory が新 binAdvanceCounts 経由)。
if [ ! -f data/.arrival-backfill-done-v6 ]; then
  if node scripts/backfill-arrival-demand.mjs; then touch data/.arrival-backfill-done-v6; fi
fi

# 前進カウント(実測+予測)を data/advance-forecast.json に生成 (fail-safe)。
# 学習履歴(advance-count-history.jsonl)が無ければ publish 側で skip。
# 段階A: 到着便(乗り場号)を予測に反映。段階B学習用に到着需要も追記。
node scripts/publish-advance-forecast.mjs || true

# 段階B: 到着→列移動のラグを履歴学習し data/arrival-advance-coeffs.json を更新 (fail-safe・ローカル学習)。
# データが貯まるまでは applied:false(lag0=従来動作)。次回 publish がこの係数を読む。
node scripts/learn-arrival-advance.mjs || true

# movement-shift シャドウ観測は専用 launchd ジョブ(jp.taxi-ic-helper.movement-shift, 60秒)に
# 移行したため、この5分ループからは呼ばない。data/movement-shift-history.jsonl の commit/push は
# 下の git add に含めて従来どおりこのループが担う(slot-occupancy と同じ構造)。

# Phase F-1: YOLOv8 車両検出 — 2026-05-23 停止。
# 占有は fill 自動較正(slot-occupancy-tick)が主系で実用域。YOLOは全画面でもROIクロップでも
# frame間ノイズが大きく(stall1=1↔10)、平滑化前提でも fill を上回らないと過去画像で実証された
# (本番UI/予測はどれも vehicle-detection-history を消費していない=純R&Dログ)。
# 再開する場合は下行のコメントを外す。scripts/detect_vehicles.py は温存。
# if [ -x .venv/bin/python3 ]; then .venv/bin/python3 scripts/detect_vehicles.py || true; fi

if [ -z "$(git status --porcelain data/taxi-pool-history.jsonl)" ]; then
  echo "[observe-tick] no jsonl change, skip commit"
  exit 0
fi

# 観測関連ファイル 3 点を 1 コミットにまとめる (Web UI が forecast/pattern-match の最新を必要とする)
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/stall-actuals.json data/coefficient-corrections.json data/t3-pool-history.jsonl data/vehicle-detection-history.jsonl data/vehicle-track-history.jsonl data/throughput-calibration.json data/slot-occupancy-history.jsonl data/t3-pool-fill.json data/pool-status.json data/pool-cam-real01.jpg data/pool-cam-real02.jpg data/movement-shift-history.jsonl data/advance-forecast.json 2>/dev/null || true
git commit -m "chore(observe): tick $(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')" || true

for i in 1 2 3; do
  git push origin main 2>&1 | tail -3
  push_status=${PIPESTATUS[0]}
  if [ "$push_status" -eq 0 ]; then
    echo "[observe-tick] push ok (attempt $i)"
    exit 0
  fi
  echo "[observe-tick] push failed (attempt $i, exit=$push_status), pull-rebase and retry"
  git pull --rebase --autostash origin main 2>&1 | tail -3
  sleep $((i * 3))
done

echo "[observe-tick] push failed after 3 attempts"
exit 0
