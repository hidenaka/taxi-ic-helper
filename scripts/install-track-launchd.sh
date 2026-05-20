#!/bin/bash
# launchd ジョブ jp.taxi-ic-helper.track を install / uninstall する。
# 30 秒間隔 (StartInterval 30) で node scripts/slot-occupancy-tick.mjs を呼ぶ
# （旧 YOLO トラッカー track_vehicles.py を置き換え、先頭スロット占有方式へ）。
# 30秒に短縮した理由: stall1/4 など出庫→補充が速い乗り場で「補充される前
# の空き状態」を捕捉する確率を倍増させて在台数の減少を取りこぼさないため。
#
# 使い方:
#   ./scripts/install-track-launchd.sh install    # plist を配置・load
#   ./scripts/install-track-launchd.sh uninstall  # unload・plist を削除
#   ./scripts/install-track-launchd.sh status     # ジョブの状態確認

set -e

LABEL="jp.taxi-ic-helper.track"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
# REPO はこのスクリプトの親ディレクトリから自動解決
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO/.local"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
TICK_SCRIPT="$REPO/scripts/slot-occupancy-tick.mjs"

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
  <integer>30</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/slot-occupancy-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/slot-occupancy-stderr.log</string>
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
    echo "Logs: $LOG_DIR/slot-occupancy-stdout.log and slot-occupancy-stderr.log"
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
