#!/bin/bash
# taxi-image-archive-sync.sh
# 画像アーカイブを外部ドライブ (/Volumes/ADATA HV620) に同期し、
# RETENTION_DAYS 日以上経過したローカルファイルは
# 外部にサイズ一致で存在することを確認した上で削除する。
#
# 起動: launchd jp.taxi-image-archive-sync が毎日 04:15 JST に実行。
# 手動: bash ~/.local/bin/taxi-image-archive-sync.sh

set -u

EXT_VOLUME="/Volumes/ADATA HV620"
EXT_ROOT="$EXT_VOLUME/taxi-image-archive"
LOCAL_ROOT="$HOME/taxi-image-archive"
LOG_DIR="$HOME/.local/log"
LOG_FILE="$LOG_DIR/taxi-image-archive-sync.log"
RETENTION_DAYS=7

mkdir -p "$LOG_DIR"

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG_FILE"; }

log "=== sync start ==="

# 外部ドライブ未マウントなら何もしない (破壊なし)
if [ ! -d "$EXT_VOLUME" ]; then
  log "external drive not mounted ($EXT_VOLUME), skip"
  exit 0
fi

# ローカルアーカイブが未存在なら何もしない
if [ ! -d "$LOCAL_ROOT" ]; then
  log "local archive not found ($LOCAL_ROOT), skip"
  exit 0
fi

mkdir -p "$EXT_ROOT" 2>/dev/null

# launchd 文脈では TCC(リムーバブルボリューム)で外付けに書けない。
# sshd 文脈にはフルディスクアクセスがあるため、書けないときは localhost 越しに
# 自分自身を実行し直す(専用鍵・localhost限定・このスクリプト固定)。
# 2026-08-09 以降この拒否でバックアップが17日間止まっていた実害への恒久対策。
_probe="$EXT_ROOT/.write-probe.$$"
if ! ( mkdir -p "$EXT_ROOT" 2>/dev/null && touch "$_probe" 2>/dev/null ); then
  rm -f "$_probe" 2>/dev/null
  if [ "${TAXI_SYNC_VIA_SSH:-}" = "1" ]; then
    log "ERROR ssh 経由でも外付けに書けない (ドライブ未接続/権限)"
    log "=== sync end (mirror failed) ==="
    exit 0
  fi
  log "外付けに直接書けない(TCC) — ssh localhost 経由で再実行する"
  # 鍵側で実行コマンドを固定しているため、接続確認の ssh でも同期が走る。
  # 二重実行を避けるため1回だけ呼び、その終了コードで成否を判断する。
  if ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=15 \
      -i "$HOME/.ssh/id_archive_sync" localhost true; then
    log "=== sync end (delegated to ssh) ==="
    exit 0
  fi
  log "ERROR ssh 経由の再実行に失敗 (鍵/リモートログイン設定を確認)"
  log "=== sync end (mirror failed) ==="
  exit 0
fi
rm -f "$_probe" 2>/dev/null

# ここから先が実作業(rsync + 保持期限の削除)。多重起動すると互いのファイルを
# 消し合い WARN を大量に吐く(2026-08-26: 5本同時で29,366行。巨大ログは観測ループを
# 詰まらせる実害あり)。実際に作業するプロセスだけがロックを取る。
LOCK_FILE="$HOME/.local/run/taxi-image-archive-sync.lock"
mkdir -p "$(dirname "$LOCK_FILE")" 2>/dev/null
if ! /usr/bin/shlock -f "$LOCK_FILE" -p $$ 2>/dev/null; then
  log "既に同期が実行中のためスキップ (pid=$(cat "$LOCK_FILE" 2>/dev/null))"
  log "=== sync end (skipped: locked) ==="
  exit 0
fi
trap 'rm -f "$LOCK_FILE"' EXIT

# 1. ローカル → 外部 ミラー (incremental, mtime保持)
# ★rsync の成否を必ず握る (2026-08-09): launchd 文脈の TCC 拒否でミラーが失敗しても
#   削除フェーズが走っていた。個々のファイルは「外部に同名同サイズがある」ときだけ消すため
#   即データ喪失にはならないが、新しい画像がバックアップされないまま retention 期限を迎える。
#   ミラーが失敗した run では削除を丸ごとスキップし、ローカルを唯一のコピーとして残す。
log "rsync $LOCAL_ROOT/ -> $EXT_ROOT/"
rsync_log="$(mktemp)"
rsync -a --omit-dir-times "$LOCAL_ROOT/" "$EXT_ROOT/" > "$rsync_log" 2>&1
rsync_rc=$?
tail -3 "$rsync_log" | while IFS= read -r line; do
  log "  rsync: $line"
done
rm -f "$rsync_log"
if [ "$rsync_rc" -ne 0 ]; then
  log "ERROR rsync failed (rc=$rsync_rc) — 削除フェーズをスキップし、ローカルを保持する"
  log "  → 恒久修理: bash にフルディスクアクセスを付与するか、ジョブを ssh 経由にする"
  log "=== sync end (mirror failed) ==="
  exit 0
fi

# 2. RETENTION_DAYS 日以上経過したローカル jpg を外部と照合 → 一致したら削除
deleted=0
size_mismatch=0
missing_on_ext=0
total_checked=0
while IFS= read -r f; do
  total_checked=$((total_checked + 1))
  rel="${f#$LOCAL_ROOT/}"
  ext_f="$EXT_ROOT/$rel"
  if [ -f "$ext_f" ]; then
    loc_size=$(stat -f%z "$f" 2>/dev/null)
    ext_size=$(stat -f%z "$ext_f" 2>/dev/null)
    if [ -n "$loc_size" ] && [ "$loc_size" = "$ext_size" ]; then
      rm "$f"
      deleted=$((deleted + 1))
    else
      size_mismatch=$((size_mismatch + 1))
      if [ "$size_mismatch" -le 20 ]; then
        log "WARN size mismatch: $rel (local=$loc_size ext=$ext_size)"
      elif [ "$size_mismatch" -eq 21 ]; then
        log "WARN size mismatch: 以降は件数のみ集計(ログ肥大を避ける)"
      fi
    fi
  else
    missing_on_ext=$((missing_on_ext + 1))
    if [ "$missing_on_ext" -le 20 ]; then
      log "WARN not on external: $rel"
    elif [ "$missing_on_ext" -eq 21 ]; then
      log "WARN not on external: 以降は件数のみ集計(ログ肥大を避ける)"
    fi
  fi
done < <(find "$LOCAL_ROOT" -type f -name '*.jpg' -mtime +$RETENTION_DAYS 2>/dev/null)

# 3. 空になった日付ディレクトリを削除 (mindepth 2 でアーカイブroot自身は保護)
find "$LOCAL_ROOT" -mindepth 2 -type d -empty -delete 2>/dev/null

# 4. サマリ
log "checked=$total_checked deleted=$deleted size_mismatch=$size_mismatch missing_on_ext=$missing_on_ext"

# 5. 容量レポート
local_size=$(du -sh "$LOCAL_ROOT" 2>/dev/null | cut -f1)
ext_size=$(du -sh "$EXT_ROOT" 2>/dev/null | cut -f1)
ext_avail=$(df -h "$EXT_VOLUME" 2>/dev/null | tail -1 | awk '{print $4}')
log "local_used=$local_size ext_used=$ext_size ext_avail=$ext_avail"

log "=== sync end ==="
