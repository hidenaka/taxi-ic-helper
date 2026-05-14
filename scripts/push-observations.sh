#!/bin/bash
# Mac mini で 30 分毎に launchd から呼ばれる。
# data/taxi-pool-history.jsonl に変更があれば commit + push する。
# jsonl 以外のファイルは触らない（他作業との衝突を避ける）。
#
# 手動実行:  ./scripts/push-observations.sh
# 想定: Mac mini 側のローカル clone で観測ジョブが走っている前提

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO"

FILE="data/taxi-pool-history.jsonl"

if [ ! -f "$FILE" ]; then
  echo "[push-observations] $FILE not found, skipping"
  exit 0
fi

if git diff --quiet "$FILE" && git diff --cached --quiet "$FILE"; then
  echo "[push-observations] no changes in $FILE, skipping"
  exit 0
fi

LINES=$(wc -l < "$FILE" | tr -d ' ')
TS=$(date +"%Y-%m-%d %H:%M JST")
BRANCH=$(git rev-parse --abbrev-ref HEAD)

git add "$FILE"
git commit -m "chore(observe): jsonl sync ${LINES} lines (${TS})"

if git push origin HEAD; then
  echo "[push-observations] pushed ${LINES} lines to origin/${BRANCH}"
  exit 0
fi

echo "[push-observations] push rejected, retrying with rebase"
if git pull --rebase --autostash origin HEAD; then
  if git push origin HEAD; then
    echo "[push-observations] pushed after rebase (${LINES} lines, branch=${BRANCH})"
    exit 0
  fi
fi

echo "[push-observations] FAILED: manual intervention needed on branch ${BRANCH}" >&2
exit 1
