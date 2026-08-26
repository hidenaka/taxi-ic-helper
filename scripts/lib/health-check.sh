#!/bin/bash
# health-check — 計測パイプラインの「静かな死」を可視化する軽量ヘルスチェック。
#
# 背景 (2026-08-07/08 の実害):
#   - noriba-fill (待機車両) が基準画像の削除で 7 時間停止したが誰も気づかなかった
#   - 画像バックアップが TCC 拒否で 5 月から失敗し続けていたが誰も気づかなかった
#   第三者レビュー2系統の一致指摘 =「個別精度より、失敗に気づけないことが最大リスク」。
#
# 検査 (すべて read-only・観測ループから毎 tick 呼ばれる想定):
#   1. noriba-fill-history.jsonl の最終行が HEALTH_FILL_MAX_AGE_MIN 分より古い → 計測停止
#   2. バックアップ同期ログの最終実行に失敗痕跡 (Operation not permitted / missing_on_ext>0)
#      または最終実行が HEALTH_BACKUP_MAX_AGE_H 時間より古い → バックアップ不全
#   3. (拡張枠) 呼び出し側が任意メッセージで alert を投げられる
#
# 通知は git-safe-sync と同じ流儀: .local/health-alert.flag に追記 + デスクトップ通知
# (ベストエフォート)。同じ症状の連続通知は HEALTH_RENOTIFY_MIN 分に 1 回へ抑制。
#
# テスト用環境変数:
#   HEALTH_NO_NOTIFY=1   osascript 通知を抑制
#   HEALTH_NOW_EPOCH     現在時刻 (epoch 秒) を固定

HEALTH_FILL_MAX_AGE_MIN="${HEALTH_FILL_MAX_AGE_MIN:-30}"
HEALTH_BACKUP_MAX_AGE_H="${HEALTH_BACKUP_MAX_AGE_H:-26}"
HEALTH_RENOTIFY_MIN="${HEALTH_RENOTIFY_MIN:-120}"

_health_now() {
  if [ -n "$HEALTH_NOW_EPOCH" ]; then echo "$HEALTH_NOW_EPOCH"; else date +%s; fi
}

# 同一 key の通知を HEALTH_RENOTIFY_MIN 分に 1 回へ抑制しつつフラグ+デスクトップ通知。
# $1=key (英数) $2=メッセージ
health_alert() {
  local key="$1" msg="$2"
  local repo_local="${HEALTH_LOCAL_DIR:-.local}"
  mkdir -p "$repo_local" 2>/dev/null
  local stamp_file="$repo_local/health-alert.$key.stamp"
  local now; now="$(_health_now)"
  if [ -f "$stamp_file" ]; then
    local last; last=$(cat "$stamp_file" 2>/dev/null || echo 0)
    if [ $((now - last)) -lt $((HEALTH_RENOTIFY_MIN * 60)) ]; then
      return 0  # 抑制中 (フラグには既に書いてある)
    fi
  fi
  echo "$now" > "$stamp_file"
  echo "[health] ALERT($key): $msg" >&2
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $key $msg" >> "$repo_local/health-alert.flag"
  if [ -z "$HEALTH_NO_NOTIFY" ]; then
    osascript -e "display notification \"${msg//\"/}\" with title \"taxi-ic-helper: 健康異常\"" 2>/dev/null || true
  fi
}

# key の異常が解消したときに stamp を消す (次回発生時に即通知させる)
health_clear() {
  local key="$1"
  local repo_local="${HEALTH_LOCAL_DIR:-.local}"
  rm -f "$repo_local/health-alert.$key.stamp" 2>/dev/null || true
}

# 1. noriba-fill の鮮度。 $1=history path
health_check_fill_freshness() {
  local hist="${1:-data/noriba-fill-history.jsonl}"
  [ -s "$hist" ] || { health_alert fill_missing "noriba-fill 履歴が無い ($hist)"; return 1; }
  local last_ts
  last_ts=$(tail -1 "$hist" | sed -n 's/.*"ts": *"\([^"]*\)".*/\1/p')
  [ -n "$last_ts" ] || { health_alert fill_parse "noriba-fill 最終行の ts が読めない"; return 1; }
  local last_epoch now age_min
  last_epoch=$(date -j -f '%Y-%m-%dT%H:%M:%S%z' "${last_ts/+09:00/+0900}" +%s 2>/dev/null)
  [ -n "$last_epoch" ] || { health_alert fill_parse "noriba-fill ts のパース失敗: $last_ts"; return 1; }
  now="$(_health_now)"
  age_min=$(( (now - last_epoch) / 60 ))
  if [ "$age_min" -gt "$HEALTH_FILL_MAX_AGE_MIN" ]; then
    health_alert fill_stale "待機車両の計測が ${age_min} 分止まっている (最終 $last_ts)"
    return 1
  fi
  health_clear fill_stale
  return 0
}

# 2. バックアップ同期の健全性。 $1=sync log path
health_check_backup() {
  local log="${1:-$HOME/.local/log/taxi-image-archive-sync.log}"
  [ -s "$log" ] || { health_alert backup_missing "バックアップ同期ログが無い ($log)"; return 1; }
  # 最終 run の抜き出し (最後の "=== sync start ===" 以降)。
  # ★必ず tail で読む量を先に絞る: 全量を awk の buf 連結 (O(n^2)) に食わせると、
  # 巨大ログ (2026-08-09 実害: キャッチアップ同期の WARN 1,558万行) で事実上終わらず、
  # observe tick が刺さって配信全停止した。1 run は高々数百行なので末尾800行で十分。
  local last_run
  last_run=$(tail -n 800 "$log" | awk '/=== sync start ===/{buf=""} {buf=buf ORS $0} END{print buf}')
  # 失敗痕跡
  if echo "$last_run" | grep -q "Operation not permitted"; then
    health_alert backup_tcc "バックアップが権限拒否で失敗している (TCC)"
    return 1
  fi
  local missing
  missing=$(echo "$last_run" | sed -n 's/.*missing_on_ext=\([0-9]*\).*/\1/p' | tail -1)
  if [ -n "$missing" ] && [ "$missing" -gt 0 ]; then
    health_alert backup_missing_files "バックアップ未転送が ${missing} 件ある"
    return 1
  fi
  # 鮮度 (最終 run の行頭タイムスタンプ)
  local last_ts last_epoch now age_h
  last_ts=$(echo "$last_run" | sed -n 's/^\[\([0-9T:+-]*\)\].*/\1/p' | tail -1)
  last_epoch=$(date -j -f '%Y-%m-%dT%H:%M:%S%z' "$last_ts" +%s 2>/dev/null)
  if [ -n "$last_epoch" ]; then
    now="$(_health_now)"
    age_h=$(( (now - last_epoch) / 3600 ))
    if [ "$age_h" -gt "$HEALTH_BACKUP_MAX_AGE_H" ]; then
      health_alert backup_stale "バックアップ最終実行が ${age_h} 時間前 ($last_ts)"
      return 1
    fi
  fi
  health_clear backup_tcc; health_clear backup_missing_files; health_clear backup_stale
  return 0
}

# 3. 現行の台数計測 (vehicle-count-history) の鮮度。
# 旧 noriba-fill はカメラ入れ替え(2026-08-20)で恒久停止したため、こちらが本系。
# 2026-08-24: 配信元の解像度変更でこの計測が2日止まったが、監視が旧系統を
# 見ていたため気づけなかった。同じ取りこぼしを防ぐ。
health_check_vehicle_count() {
  local hist="${1:-data/vehicle-count-history.jsonl}"
  [ -s "$hist" ] || { health_alert vcount_missing "台数計測の履歴が無い ($hist)"; return 1; }
  local last_ts
  last_ts=$(tail -1 "$hist" | sed -n 's/.*"ts": *"\([^"]*\)".*/\1/p')
  [ -n "$last_ts" ] || { health_alert vcount_parse "台数計測 最終行の ts が読めない"; return 1; }
  local last_epoch now age_min
  last_epoch=$(date -j -f '%Y-%m-%dT%H:%M:%S%z' "${last_ts/+09:00/+0900}" +%s 2>/dev/null)
  [ -n "$last_epoch" ] || { health_alert vcount_parse "台数計測 ts のパース失敗: $last_ts"; return 1; }
  now="$(_health_now)"
  age_min=$(( (now - last_epoch) / 60 ))
  if [ "$age_min" -gt "${HEALTH_VCOUNT_MAX_AGE_MIN:-30}" ]; then
    health_alert vcount_stale "羽田プールの台数計測が ${age_min} 分止まっている (最終 $last_ts)"
    return 1
  fi
  health_clear vcount_stale
  return 0
}

# まとめて実行 (observe-tick から 1 行で呼ぶ)。常に exit 0 相当 (本流を止めない)。
# 旧 noriba-fill の鮮度監視は恒久停止のため既定で外す(鳴り続ける警報は警報にならない)。
# 復活させたい場合は HEALTH_WATCH_LEGACY_FILL=1。
health_check_all() {
  health_check_vehicle_count || true
  [ -n "$HEALTH_WATCH_LEGACY_FILL" ] && { health_check_fill_freshness "$@" || true; }
  health_check_backup || true
  return 0
}
