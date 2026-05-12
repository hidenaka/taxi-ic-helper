#!/bin/bash
# launchd ジョブ jp.taxi-ic-helper.calibrate-transit-share を install / uninstall する。
# 毎日 JST 02:00 に scripts/calibrate-transit-share.mjs を実行する。
#
# 使い方:
#   ./scripts/install-calibrate-launchd.sh install   # plist を配置・load
#   ./scripts/install-calibrate-launchd.sh uninstall # unload・plist を削除
#   ./scripts/install-calibrate-launchd.sh status    # ジョブの状態確認

set -e

LABEL="jp.taxi-ic-helper.calibrate-transit-share"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO/.local"
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"

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
    <string>$NODE_BIN</string>
    <string>$REPO/scripts/calibrate-transit-share.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>2</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/calibrate-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/calibrate-stderr.log</string>
</dict>
</plist>
EOF
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"
    echo "Installed $LABEL (runs daily at JST 02:00)"
    echo "Logs: $LOG_DIR/calibrate-{stdout,stderr}.log"
    ;;
  uninstall)
    if [ -f "$PLIST_PATH" ]; then
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      rm -f "$PLIST_PATH"
      echo "Uninstalled $LABEL"
    else
      echo "$PLIST_PATH not found (already uninstalled?)"
    fi
    ;;
  status)
    launchctl list | grep "$LABEL" || echo "$LABEL: not loaded"
    ;;
  *)
    echo "Usage: $0 {install|uninstall|status}"
    exit 1
    ;;
esac
