#!/bin/bash
# launchd ジョブ jp.taxi-ic-helper.t3-front-flow を install / uninstall する。
# 60 秒間隔 (StartInterval 60) で node scripts/t3-front-flow-tick.mjs を呼ぶ。
# Real108 の実更新は約1〜2分のため、tick 側が Last-Modified/md5 で同一フレームを skip する。
# data/t3-front-flow-history.jsonl への追記専用で git は触らない
# (commit/push は5分の observe ループが担う = movement-shift と同じ構造)。
#
# 使い方:
#   ./scripts/install-t3-front-flow-launchd.sh install
#   ./scripts/install-t3-front-flow-launchd.sh uninstall
#   ./scripts/install-t3-front-flow-launchd.sh status

set -e

LABEL="jp.taxi-ic-helper.t3-front-flow"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO/.local"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
TICK_SCRIPT="$REPO/scripts/t3-front-flow-tick.mjs"

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
  <string>$LOG_DIR/t3-front-flow-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/t3-front-flow-stderr.log</string>
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
    echo "[install] loaded: $LABEL (every 60s)"
    ;;
  uninstall)
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "[uninstall] removed: $LABEL"
    ;;
  status)
    launchctl list | grep "$LABEL" || echo "not loaded"
    ;;
  *)
    echo "usage: $0 {install|uninstall|status}"
    exit 1
    ;;
esac
