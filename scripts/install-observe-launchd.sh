#!/bin/bash
# launchd ジョブ jp.taxi-ic-helper.observe を install / uninstall する。
# 15 分間隔で scripts/observe-tick-local.sh を呼ぶ。
#
# 使い方:
#   ./scripts/install-observe-launchd.sh install   # plist を配置・load
#   ./scripts/install-observe-launchd.sh uninstall # unload・plist を削除
#   ./scripts/install-observe-launchd.sh status    # ジョブの状態確認

set -e

LABEL="jp.taxi-ic-helper.observe"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
# REPO はこのスクリプトの親ディレクトリから自動解決 (どの Mac でも動く)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO/.local"
LAUNCHER="$REPO/scripts/observe-tick-local.sh"

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
    <string>/bin/bash</string>
    <string>$LAUNCHER</string>
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/observe-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/observe-stderr.log</string>
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
    echo "Logs: $LOG_DIR/observe-stdout.log and observe-stderr.log"
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
    echo "=== launchctl list | grep $LABEL ==="
    launchctl list | grep "$LABEL" || echo "(not loaded)"
    echo ""
    echo "=== plist ==="
    [ -f "$PLIST_PATH" ] && echo "exists: $PLIST_PATH" || echo "not found: $PLIST_PATH"
    echo ""
    echo "=== recent logs (last 20 lines each) ==="
    tail -20 "$LOG_DIR/observe-stdout.log" 2>/dev/null || echo "(no stdout log)"
    echo "---"
    tail -20 "$LOG_DIR/observe-stderr.log" 2>/dev/null || echo "(no stderr log)"
    ;;
  run-once)
    echo "=== running observe-tick-local.sh once ==="
    "$LAUNCHER"
    ;;
  *)
    echo "Usage: $0 {install|uninstall|status|run-once}"
    exit 1
    ;;
esac
