#!/bin/bash
# 安全な main 同期 & push のための共有関数。自動コミッタ (observe-tick-local.sh 等) から source する。
#
# 解決する問題 (2026-06-15 にアプリが 21 時間「最終調整時刻」凍結した事故):
#   1. 中断された rebase の残骸 .git/rebase-merge / .git/rebase-apply が残ると、
#      以降の `git pull --rebase` が全て "already a rebase-merge directory" で失敗し、
#      push されず relay も発火せずアプリが凍結する。`git rebase --abort` では消えない
#      孤立ケースがあるため rm -rf で強制除去する (← 事故の直接原因)。
#   2. push 失敗を握りつぶすと誰も気づかない。失敗時はフラグファイル + デスクトップ通知で可視化。
#   3. update-weather / update-arrivals が 15 分ごとに main へ auto-commit するため
#      non-fast-forward が常時起こる。fetch → rebase → push をリトライして競合に勝つ。
#
# テスト用環境変数:
#   GIT_SAFE_SYNC_NO_NOTIFY=1  osascript 通知を抑制
#   GIT_SAFE_SYNC_FAST=1       リトライ間 sleep を無効化

# --- リポジトリ単位の git ロック ---------------------------------------------
# observe-tick は数分ごとに `git pull --rebase --autostash` を回す。人が手で
# `git add` してから `git commit` するまでの間にこれが挟まると、autostash が
# ステージを巻き取って変更が消える (2026-08-31 実害: コード修正が全部未ステージへ)。
# git を触る処理は必ずこのロックを取り、直列化する。
#
# shlock はロック内の PID が生きているかを見るので、異常終了で残ったロックは
# 次の取得時に自動的に破棄される (デッドロックしない)。
GIT_LOCK_WAIT_SEC="${GIT_LOCK_WAIT_SEC:-90}"
GIT_LOCK_POLL_SEC="${GIT_LOCK_POLL_SEC:-3}"

git_lock_file() {
  echo "${GIT_LOCK_FILE:-${TMPDIR:-/tmp}/taxi-ic-helper-git.lock}"
}

# ロックを取ってコマンドを実行する。取れなければ実行せず 75 を返す。
# 呼び手が「今回は諦めて次の tick に回す」か「失敗として扱う」かを決める。
git_with_lock() {
  local lock waited=0 rc
  lock="$(git_lock_file)"
  while ! /usr/bin/shlock -f "$lock" -p $$ 2>/dev/null; do
    if [ "$waited" -ge "$GIT_LOCK_WAIT_SEC" ]; then
      echo "[git-lock] 他の処理が git を使用中で取得できず (${waited}秒待機): $lock" >&2
      return 75
    fi
    sleep "$GIT_LOCK_POLL_SEC"
    waited=$((waited + GIT_LOCK_POLL_SEC))
  done
  "$@"
  rc=$?
  rm -f "$lock" 2>/dev/null || true
  return "$rc"
}

# 孤立した rebase/merge/cherry-pick 状態を強制的に片付ける (冪等・常に成功扱い)。
git_clean_interrupted_state() {
  git rebase --abort 2>/dev/null || true   # 進行中 rebase があれば autostash も復元される
  git merge --abort 2>/dev/null || true
  rm -rf .git/rebase-merge .git/rebase-apply 2>/dev/null || true   # abort で消えない孤立残骸を強制除去
  rm -f .git/MERGE_HEAD .git/CHERRY_PICK_HEAD 2>/dev/null || true
  git reset -q HEAD 2>/dev/null || true    # staged を戻す (working tree とコミットは保持)
}

# ベストエフォートのアラート (Mac mini の GUI セッションにデスクトップ通知)。
_git_sync_alert() {
  local msg="$1"
  echo "[git-safe-sync] ALERT: $msg" >&2
  if [ -z "$GIT_SAFE_SYNC_NO_NOTIFY" ]; then
    osascript -e "display notification \"${msg//\"/}\" with title \"taxi-ic-helper: push 停止\"" 2>/dev/null || true
  fi
}

_git_sync_sleep() {
  [ -n "$GIT_SAFE_SYNC_FAST" ] && return 0
  sleep "$1" 2>/dev/null || true
}

# main を origin に同期して push する。
#   $1 = リポジトリルート (省略時 cwd)
#   $2 = ブランチ (既定 main)
#   $3 = 最大試行回数 (既定 5)
# 戻り値: 0 = push 成功 または push 不要 (同期済み) / 1 = 失敗 (.local/push-stuck.flag を残置)
git_safe_sync_and_push() {
  local repo="${1:-$PWD}"
  local branch="${2:-main}"
  local max="${3:-5}"
  cd "$repo" || return 1
  local flag="$repo/.local/push-stuck.flag"
  mkdir -p "$repo/.local" 2>/dev/null || true

  git_clean_interrupted_state

  local i behind ahead
  for ((i=1; i<=max; i++)); do
    git fetch -q origin "$branch" 2>/dev/null || true

    behind="$(git rev-list --count "${branch}..origin/${branch}" 2>/dev/null || echo 0)"
    if [ "${behind:-0}" -gt 0 ]; then
      if ! git pull --rebase --autostash -q origin "$branch" 2>/dev/null; then
        _git_sync_alert "rebase 失敗 (試行 ${i}/${max}) — 残骸を掃除して再試行"
        git_clean_interrupted_state
        _git_sync_sleep "$((i*2))"
        continue
      fi
    fi

    ahead="$(git rev-list --count "origin/${branch}..${branch}" 2>/dev/null || echo 0)"
    if [ "${ahead:-0}" -eq 0 ]; then
      rm -f "$flag" 2>/dev/null || true
      return 0   # 押すものが無い = 同期済み
    fi

    if git push -q origin "$branch" 2>/dev/null; then
      rm -f "$flag" 2>/dev/null || true
      return 0
    fi

    # push 失敗 (大抵 non-fast-forward: その間に weather/arrivals が割り込んだ) → 次周回で再 fetch+rebase。
    _git_sync_sleep "$((i*2))"
  done

  # 全試行失敗 → 無音にせず可視化する。
  ahead="$(git rev-list --count "origin/${branch}..${branch}" 2>/dev/null || echo '?')"
  {
    date '+%Y-%m-%dT%H:%M:%S%z'
    echo "branch=${branch}"
    echo "unpushed_commits=${ahead}"
  } > "$flag" 2>/dev/null || true
  _git_sync_alert "push が ${max} 回失敗。未push=${ahead} 件。手動確認を ($flag)"
  return 1
}
