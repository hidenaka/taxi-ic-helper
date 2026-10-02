#!/bin/bash
# launchd ジョブ jp.taxi-ic-helper.police-traffic を install / uninstall する。
# 毎日 05:40 に scripts/police-traffic-run.sh を呼び、警察の交通量（断面交通量情報・東京）の
# 公開中の月を取り込んで詰め直す（取り済みなら何もしない）。
# 公式ページは最新1か月ぶんしか置かず翌月に消えるので、毎日見に行って取り逃がさない。
# 外付けへの書き込みは police-traffic-run.sh が ssh localhost に委ねる（launchd は TCC で書けない）。
#
# 使い方:
#   ./scripts/install-police-traffic-launchd.sh install
#   ./scripts/install-police-traffic-launchd.sh uninstall
#   ./scripts/install-police-traffic-launchd.sh status
set -e
LABEL="jp.taxi-ic-helper.police-traffic"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO/.local"
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
    <string>$REPO/scripts/police-traffic-run.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>5</integer>
    <key>Minute</key><integer>40</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/police-traffic-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/police-traffic-stderr.log</string>
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
    ;;
  uninstall)
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "Uninstalled: $PLIST_PATH"
    ;;
  status)
    launchctl list | grep "$LABEL" || echo "not loaded"
    ;;
  *)
    echo "usage: $0 install|uninstall|status"; exit 1 ;;
esac
