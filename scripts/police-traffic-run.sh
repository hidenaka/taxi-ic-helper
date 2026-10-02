#!/bin/bash
# 警察の交通量（断面交通量情報・東京）を取り込んで詰め直す。
#   引数なし : 公式ページの最新月を取る（launchd で毎日。取り済みなら何もしない）
#   backfill : 過去分（2017年〜）を保管庫から1か月ずつ取る（初回だけ・数時間）
# 置き場: /Volumes/ADATA HV620/police-traffic（外付け。内蔵は空きが少ない）
#
# launchd 文脈では TCC で外付けに書けない（taxi-image-archive-sync と同じ問題）。
# 書けないときは localhost に ssh して自分を実行し直す（専用鍵・localhost限定・このスクリプト固定）。
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
VOL="/Volumes/ADATA HV620"
ROOT="$VOL/police-traffic"
LOG_DIR="$HOME/.local/log"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/police-traffic.log"
log() { echo "[$(date "+%Y-%m-%dT%H:%M:%S%z")] $*" >> "$LOG"; }

if [ ! -d "$VOL" ]; then log "外付けドライブが無い。今回は何もしない"; exit 0; fi

probe="$ROOT/.write-probe.$$"
if ! ( mkdir -p "$ROOT" 2>/dev/null && touch "$probe" 2>/dev/null ); then
  rm -f "$probe" 2>/dev/null
  if [ "${POLICE_VIA_SSH:-}" = "1" ]; then log "ERROR ssh 経由でも外付けに書けない"; exit 0; fi
  log "外付けに直接書けない(TCC) — ssh localhost 経由で再実行する"
  # 鍵側で実行コマンドを固定してあるので、1回だけ呼んで終了コードで判断する
  if ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=15 \
      -i "$HOME/.ssh/id_police_traffic" localhost true; then
    log "ssh 経由で実行した"; exit 0
  fi
  log "ERROR ssh 経由の再実行に失敗（鍵/リモートログイン設定を確認）"; exit 0
fi
rm -f "$probe" 2>/dev/null

# 実際に作業するプロセスだけがロックを取る（毎日の実行と過去分の取り込みが重ならないように）
LOCK="$HOME/.local/run/police-traffic.lock"
mkdir -p "$(dirname "$LOCK")"
if ! /usr/bin/shlock -f "$LOCK" -p $$ 2>/dev/null; then
  log "既に実行中のためスキップ (pid=$(cat "$LOCK" 2>/dev/null))"; exit 0
fi
trap "rm -f \"$LOCK\"" EXIT

PY="$REPO/.venv/bin/python"
if [ "${1:-}" = "backfill" ]; then
  log "過去分の取り込み開始"
  "$PY" scripts/police-traffic-fetch.py --root "$ROOT" --backfill --pause 60 >> "$LOG" 2>&1
else
  "$PY" scripts/police-traffic-fetch.py --root "$ROOT" --latest >> "$LOG" 2>&1
fi
"$PY" scripts/police-traffic-pack.py --root "$ROOT" >> "$LOG" 2>&1
log "おわり"
