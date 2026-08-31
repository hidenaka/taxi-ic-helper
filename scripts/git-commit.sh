#!/bin/bash
# git-commit.sh — このリポジトリで手作業のコミットを安全に行う唯一の入口。
#
# なぜ必要か (2026-08-31 の実害):
#   observe-tick-local.sh が数分ごとに `git pull --rebase --autostash` を回している。
#   人が `git add` を打ってから `git commit` を打つまでの数十秒の間にこれが挟まると、
#   autostash がステージを巻き取り、add した内容が消える。実際に一度消えた。
#
# 対策は2つ、両方が要る:
#   1. add と commit を 1 プロセスにまとめる (このスクリプト)
#   2. tick と同じロックを取って直列化する (git_with_lock)
#
# 使い方:
#   scripts/git-commit.sh -m "メッセージ" <path> [<path>...]
#   scripts/git-commit.sh -F msg.txt <path> [<path>...]
#   scripts/git-commit.sh --dry-run -m "..." <path>     # 何がコミットされるか見るだけ
#
# 終了コード: 0=コミットした / 1=引数や状態の誤り / 3=対象に変更が無い / 75=ロックが取れない
set -uo pipefail

# 実行した場所のリポジトリを対象にする (どこから呼んでも動くように)。
# git 管理下でなければスクリプト自身のリポジトリに落とす。
REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO" ] || REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/git-safe-sync.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/git-safe-sync.sh"

MSG=""
MSG_FILE=""
DRY_RUN=""
PATHS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -m) MSG="${2:-}"; shift 2 ;;
    -F) MSG_FILE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    --) shift; PATHS+=("$@"); break ;;
    -*) echo "不明なオプション: $1" >&2; exit 1 ;;
    *) PATHS+=("$1"); shift ;;
  esac
done

if [ -z "$MSG" ] && [ -z "$MSG_FILE" ]; then
  echo "コミットメッセージがありません (-m か -F を指定)" >&2; exit 1
fi
if [ -n "$MSG_FILE" ] && [ ! -s "$MSG_FILE" ]; then
  echo "メッセージファイルが空か見つかりません: $MSG_FILE" >&2; exit 1
fi
if [ "${#PATHS[@]}" -eq 0 ]; then
  echo "コミット対象のパスがありません" >&2; exit 1
fi

_do_commit() {
  cd "$REPO" || return 1
  # 追跡外の残骸を巻き込まないよう、対象は明示されたパスだけ。
  if ! git add -- "${PATHS[@]}"; then
    echo "git add に失敗しました" >&2; return 1
  fi
  if git diff --cached --quiet; then
    echo "対象に変更がありません (コミットしません)"
    git reset -q -- "${PATHS[@]}" 2>/dev/null || true
    return 3
  fi
  echo "--- コミットする内容 ---"
  git diff --cached --stat
  if [ -n "$DRY_RUN" ]; then
    echo "--- --dry-run のため取り消します ---"
    git reset -q -- "${PATHS[@]}" 2>/dev/null || true
    return 0
  fi
  if [ -n "$MSG_FILE" ]; then
    git commit -q -F "$MSG_FILE" || return 1
  else
    git commit -q -m "$MSG" || return 1
  fi
  echo "--- コミットしました ---"
  git log --oneline -1
  local ahead
  ahead="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo '?')"
  echo "未 push のコミット: ${ahead} 件 (次の tick が push します)"
  return 0
}

git_with_lock _do_commit
rc=$?
if [ "$rc" -eq 75 ]; then
  echo "tick が git を使用中です。少し待ってからもう一度実行してください。" >&2
fi
exit "$rc"
