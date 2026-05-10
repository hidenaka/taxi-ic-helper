#!/bin/bash
# launchd から 15 分ごとに呼ばれる観測ジョブのエントリポイント。
# 1. リポジトリ最新を pull
# 2. observe-taxi-pool.mjs で 1 tick 観測
# 3. data/taxi-pool-history.jsonl に変更があれば commit & push (3 回までリトライ)
#
# launchd plist の StartInterval: 900 (15 分) で起動される。
# 失敗してもステータス 0 で終了 (launchd の retry を待たず、次の周期で続行)。

set +e

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

git pull --rebase --autostash origin main 2>&1 | tail -3

node scripts/observe-taxi-pool.mjs
NODE_EXIT=$?
if [ "$NODE_EXIT" -ne 0 ]; then
  echo "[observe-tick] observe script exit $NODE_EXIT, abort tick"
  exit 0
fi

if [ -z "$(git status --porcelain data/taxi-pool-history.jsonl)" ]; then
  echo "[observe-tick] no jsonl change, skip commit"
  exit 0
fi

git add data/taxi-pool-history.jsonl
git commit -m "chore(observe): tick $(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')" || true

for i in 1 2 3; do
  if git push origin main 2>&1 | tail -3; then
    echo "[observe-tick] push ok (attempt $i)"
    exit 0
  fi
  echo "[observe-tick] push failed (attempt $i), pull-rebase and retry"
  git pull --rebase --autostash origin main 2>&1 | tail -3
  sleep $((i * 3))
done

echo "[observe-tick] push failed after 3 attempts"
exit 0
