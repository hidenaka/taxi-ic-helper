#!/bin/bash
# launchd から 5 分ごとに呼ばれる観測ジョブのエントリポイント。
# 1. リポジトリ最新を pull
# 2. observe-taxi-pool.mjs で 1 tick 観測
# 3. data/taxi-pool-history.jsonl に変更があれば commit & push (3 回までリトライ)
#
# launchd plist の StartInterval: 300 (5 分) で起動される。
# 失敗してもステータス 0 で終了 (launchd の retry を待たず、次の周期で続行)。
#
# Phase A 終了日: STOP_DATE 以降は何もせず skip する (uninstall は手動)。

set +e

STOP_DATE="2026-06-01"
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
  git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json 2>/dev/null || true
  # 残った staged 変更を unstage
  git reset HEAD 2>/dev/null || true
fi

# --- pull 前に forecast/pattern-match の working tree 変更を捨てる ---
# observe-taxi-pool.mjs が毎 tick 全体上書き再生成するので、pull 前にローカルを HEAD に揃えれば衝突しない。
# 次の observe 実行で最新内容に上書きされる。
git checkout HEAD -- data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json 2>/dev/null || true

git pull --rebase --autostash origin main 2>&1 | tail -3

node scripts/observe-taxi-pool.mjs
NODE_EXIT=$?
if [ "$NODE_EXIT" -ne 0 ]; then
  echo "[observe-tick] observe script exit $NODE_EXIT, abort tick"
  exit 0
fi

# Phase F-1: YOLOv8 車両検出 (並行・fail-safe。venv が無い/失敗しても tick は継続)
# venv は .nosync 名で iCloud Drive 同期を除外 (各マシンが自前で作成)
if [ -x .venv.nosync/bin/python3 ]; then
  .venv.nosync/bin/python3 scripts/detect_vehicles.py || true
else
  echo "[observe-tick] .venv.nosync not found, skip vehicle detection"
fi

if [ -z "$(git status --porcelain data/taxi-pool-history.jsonl)" ]; then
  echo "[observe-tick] no jsonl change, skip commit"
  exit 0
fi

# 観測関連ファイル 3 点を 1 コミットにまとめる (Web UI が forecast/pattern-match の最新を必要とする)
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json data/t3-pool-history.jsonl data/vehicle-detection-history.jsonl 2>/dev/null || true
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
