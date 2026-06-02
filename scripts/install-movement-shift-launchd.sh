#!/bin/bash
# launchd ジョブ jp.taxi-ic-helper.movement-shift を install / uninstall する。
# 60 秒間隔 (StartInterval 60) で node scripts/movement-shift-tick.mjs を呼ぶ。
# 配信元画像が約60秒更新なので60秒が最適。最新アーカイブフレームを読むだけで
# 追加のネット取得はしない。data/movement-shift-history.jsonl への追記専用で git は触らない
# (commit/push は5分の observe ループが担う = slot-occupancy と同じ構造)。
#
# 使い方:
#   ./scripts/install-movement-shift-launchd.sh install
#   ./scripts/install-movement-shift-launchd.sh uninstall
#   ./scripts/install-movement-shift-launchd.sh status

set -e

LABEL="jp.taxi-ic-helper.movement-shift"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO/.local"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
TICK_SCRIPT="$REPO/scripts/movement-shift-tick.mjs"

case "${1:-help}" in
  install)
    mkdir -p "$PLIST_DIR" "$LOG_DIR"
    cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$TICK_SCRIPT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO</string>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/movement-shift-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/movement-shift-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"
    echo "Installed and loaded: $PLIST_PATH"
    echo "Logs: $LOG_DIR/movement-shift-stdout.log and movement-shift-stderr.log"
    ;;
  uninstall)
    if [ -f "$PLIST_PATH" ]; then
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      rm -f "$PLIST_PATH"
      echo "Uninstalled: $PLIST_PATH"
    else
      echo "Not installed (no plist at $PLIST_PATH)"
    fi
    ;;
  status)
    launchctl list | grep "$LABEL" || echo "Not loaded"
    ;;
  *)
    echo "Usage: $0 {install|uninstall|status}"
    ;;
esac
