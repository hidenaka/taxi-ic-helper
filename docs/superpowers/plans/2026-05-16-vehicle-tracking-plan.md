# 車両フレーム間追跡 実装プラン (Phase F-3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 60秒間隔で Real01_line を YOLO 検出し、駐車中の車を位置ベースでフレーム間追跡、消えたトラック＝出庫として throughput を `vehicle-track-history.jsonl` に記録する。

**Architecture:** スタンドアロン Python スクリプト `track_vehicles.py` を新 launchd ジョブ（StartInterval 60）で回す。`detect_vehicles.py` の YOLO 関数を import 再利用。トラッカーの純関数 `update_tracks` を `unittest` でテスト。60秒ループは git 操作をせず、5分 observe-tick が出力を commit。

**Tech Stack:** Python 3 / `onnxruntime` / `numpy` / Python `unittest` / launchd

**設計ドキュメント:** `docs/superpowers/specs/2026-05-16-vehicle-tracking-design.md`

---

## File Structure

| ファイル | 種別 | 役割 |
|---|---|---|
| `scripts/track_vehicles.py` | Create | 60秒トラッキング。純関数 `update_tracks` + I/O + main |
| `tests/test_track_vehicles.py` | Create | `update_tracks` の `unittest` テスト |
| `scripts/install-track-launchd.sh` | Create | 60秒 launchd ジョブ `jp.taxi-ic-helper.track` の install/uninstall/status |
| `data/vehicle-track-history.jsonl` | Create (生成物) | throughput ログ（git 管理・append-only） |
| `scripts/observe-tick-local.sh` | Modify | git add 対象に `vehicle-track-history.jsonl` 追加 |
| `.gitignore` | Modify | `data/track-state.json` 追加 |
| `.gitattributes` | Modify | `vehicle-track-history.jsonl merge=union` 追加 |

実装順序: **純関数 + テスト先行（TDD）→ 単発実行 → launchd インストーラ → 配線 → 最終整合 + push**。

前提（F-1/F-2 で確認済み）: `detect_vehicles.py` に `fetch_image(name)`（→ PIL Image）、`detect_image(session, img)`（→ box dict list `{cls,conf,x,y,w,h}`）、`MODEL_PATH` がある。Mac mini の venv（`.venv`）に `onnxruntime`/`numpy`/`pillow` 済み。新 pip 依存なし。`.py` は `node --test` 対象外（`npm test` 407 件不変）。

---

## Task 1: `track_vehicles.py` + `update_tracks` テスト (TDD)

**Files:**
- Create: `scripts/track_vehicles.py`
- Create: `tests/test_track_vehicles.py`

- [ ] **Step 1.1: 失敗テストを作成**

`tests/test_track_vehicles.py` の内容:

```python
import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
from track_vehicles import update_tracks


def _det(x, y):
    return {'cls': 'car', 'conf': 0.8, 'x': x, 'y': y, 'w': 0.05, 'h': 0.05}


def _trk(tid, x, y, missed=0):
    return {'id': tid, 'x': x, 'y': y, 'w': 0.05, 'h': 0.05, 'missed': missed}


class TestUpdateTracks(unittest.TestCase):
    def test_match_same_position(self):
        r = update_tracks([_trk(1, 0.5, 0.3)], [_det(0.5, 0.3)], 2, 2, 0.06)
        self.assertEqual(len(r['tracks']), 1)
        self.assertEqual(r['tracks'][0]['id'], 1)
        self.assertEqual(r['tracks'][0]['missed'], 0)
        self.assertEqual(r['arrived'], 0)
        self.assertEqual(r['departed'], 0)

    def test_new_detection_new_track(self):
        r = update_tracks([], [_det(0.2, 0.2)], 5, 2, 0.06)
        self.assertEqual(len(r['tracks']), 1)
        self.assertEqual(r['tracks'][0]['id'], 5)
        self.assertEqual(r['next_id'], 6)
        self.assertEqual(r['arrived'], 1)

    def test_unmatched_track_missed_increments(self):
        r = update_tracks([_trk(1, 0.5, 0.3, missed=0)], [], 2, 2, 0.06)
        self.assertEqual(len(r['tracks']), 1)
        self.assertEqual(r['tracks'][0]['missed'], 1)
        self.assertEqual(r['departed'], 0)

    def test_track_departs_after_max_missed(self):
        # missed=2、未マッチで 3 になり max_missed=2 超 → departed
        r = update_tracks([_trk(1, 0.5, 0.3, missed=2)], [], 2, 2, 0.06)
        self.assertEqual(len(r['tracks']), 0)
        self.assertEqual(r['departed'], 1)

    def test_far_detection_not_matched(self):
        # track (0.5,0.3) と detection (0.9,0.9) は距離 > 0.06 → 別物扱い
        r = update_tracks([_trk(1, 0.5, 0.3)], [_det(0.9, 0.9)], 2, 2, 0.06)
        ids = sorted(t['id'] for t in r['tracks'])
        self.assertEqual(ids, [1, 2])  # track 1 は missed で残り、det は新 track 2
        self.assertEqual(r['arrived'], 1)

    def test_no_detections_all_increment(self):
        r = update_tracks([_trk(1, 0.1, 0.1), _trk(2, 0.9, 0.9)], [], 3, 2, 0.06)
        self.assertEqual(len(r['tracks']), 2)
        self.assertTrue(all(t['missed'] == 1 for t in r['tracks']))


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 1.2: テスト実行 → 失敗確認**

```bash
.venv/bin/python3 -m unittest tests/test_track_vehicles.py
```

Expected: FAIL（`ModuleNotFoundError: No module named 'track_vehicles'`）

- [ ] **Step 1.3: `track_vehicles.py` を作成**

`scripts/track_vehicles.py` の内容:

```python
#!/usr/bin/env python3
"""車両フレーム間追跡 (Phase F-3)。

設計: docs/superpowers/specs/2026-05-16-vehicle-tracking-design.md

60秒間隔で Real01_line を YOLO 検出し、駐車中の車を位置ベースで
フレーム間追跡する。消えたトラック = 出庫として throughput を記録。
git 操作はしない (5分 observe-tick が出力を commit する)。
"""
import json
import math
import os
import sys
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, SCRIPT_DIR)
from detect_vehicles import fetch_image, detect_image, MODEL_PATH

STATE_PATH = os.path.join(REPO_ROOT, 'data', 'track-state.json')
OUTPUT_PATH = os.path.join(REPO_ROOT, 'data', 'vehicle-track-history.jsonl')
TRACK_IMAGE = 'Real01_line'
STOP_DATE = '2026-06-01'
MAX_MISSED = 2
DIST_THRESHOLD = 0.06


def update_tracks(prev_tracks, detections, next_id, max_missed, dist_threshold):
    """検出を既存トラックに位置ベースで対応付ける純関数。

    prev_tracks: [{id,x,y,w,h,missed}, ...]
    detections:  [{x,y,w,h,...}, ...]
    戻り値: {tracks, next_id, arrived, departed}
    - マッチ: 中心座標のユークリッド距離が最小かつ dist_threshold 以内
    - 未マッチ検出 → 新トラック (arrived++)
    - 未マッチトラック → missed++、missed > max_missed で消滅 (departed++)
    """
    unmatched = list(range(len(detections)))
    out_tracks = []
    arrived = 0
    departed = 0
    for tr in prev_tracks:
        best_i, best_d = None, dist_threshold
        for i in unmatched:
            d = detections[i]
            dist = math.hypot(d['x'] - tr['x'], d['y'] - tr['y'])
            if dist <= best_d:
                best_d, best_i = dist, i
        if best_i is not None:
            d = detections[best_i]
            unmatched.remove(best_i)
            out_tracks.append({'id': tr['id'], 'x': d['x'], 'y': d['y'],
                               'w': d['w'], 'h': d['h'], 'missed': 0})
        else:
            missed = tr.get('missed', 0) + 1
            if missed > max_missed:
                departed += 1
            else:
                out_tracks.append({**tr, 'missed': missed})
    for i in unmatched:
        d = detections[i]
        out_tracks.append({'id': next_id, 'x': d['x'], 'y': d['y'],
                           'w': d['w'], 'h': d['h'], 'missed': 0})
        next_id += 1
        arrived += 1
    return {'tracks': out_tracks, 'next_id': next_id, 'arrived': arrived, 'departed': departed}


def jst_now_iso():
    """現在時刻の JST ISO 文字列 (秒精度)。"""
    return datetime.now(timezone(timedelta(hours=9))).isoformat(timespec='seconds')


def is_past_stop_date():
    """観測停止日 (STOP_DATE) 以降なら True。"""
    today = datetime.now(timezone(timedelta(hours=9))).strftime('%Y-%m-%d')
    return today >= STOP_DATE


def load_state():
    """track-state.json を (tracks, next_id) で返す。無い・壊れていれば ([], 1)。"""
    try:
        with open(STATE_PATH, 'r', encoding='utf-8') as f:
            s = json.load(f)
        tracks = s.get('tracks', [])
        next_id = s.get('next_id', 1)
        if isinstance(tracks, list) and isinstance(next_id, int):
            return tracks, next_id
    except Exception:
        pass
    return [], 1


def save_state(tracks, next_id):
    """track-state.json を上書き保存。"""
    with open(STATE_PATH, 'w', encoding='utf-8') as f:
        json.dump({'tracks': tracks, 'next_id': next_id}, f)


def main():
    import onnxruntime as ort
    if is_past_stop_date():
        print(f'[track] STOP_DATE {STOP_DATE} reached, skip', file=sys.stderr)
        return
    if not os.path.exists(MODEL_PATH):
        print(f'ERROR: model not found: {MODEL_PATH}', file=sys.stderr)
        sys.exit(1)
    tracks, next_id = load_state()
    try:
        session = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
        img = fetch_image(TRACK_IMAGE)
        detections = detect_image(session, img)
    except Exception as e:
        print(f'[track] detect failed, skip tick: {e}', file=sys.stderr)
        return
    result = update_tracks(tracks, detections, next_id, MAX_MISSED, DIST_THRESHOLD)
    save_state(result['tracks'], result['next_id'])
    row = {
        'schema_version': 1,
        'ts': jst_now_iso(),
        'detected': len(detections),
        'active': len(result['tracks']),
        'arrived': result['arrived'],
        'departed': result['departed'],
    }
    with open(OUTPUT_PATH, 'a', encoding='utf-8') as f:
        f.write(json.dumps(row) + '\n')
    print(f"[track] ok: detected={row['detected']} active={row['active']} "
          f"arrived={row['arrived']} departed={row['departed']}")


if __name__ == '__main__':
    main()
```

- [ ] **Step 1.4: テスト実行 → パス**

```bash
.venv/bin/python3 -m unittest tests/test_track_vehicles.py
```

Expected: PASS（`Ran 6 tests` / `OK`）

- [ ] **Step 1.5: 構文チェック**

```bash
.venv/bin/python3 -m py_compile scripts/track_vehicles.py && echo "syntax OK"
```

期待: `syntax OK`。

- [ ] **Step 1.6: 単発実行 → throughput ログ生成確認**

```bash
.venv/bin/python3 scripts/track_vehicles.py
.venv/bin/python3 scripts/track_vehicles.py
python3 -c "
import json
for line in open('data/vehicle-track-history.jsonl'):
    print(json.loads(line))
print('--- track-state ---')
s = json.load(open('data/track-state.json'))
print('tracks:', len(s['tracks']), 'next_id:', s['next_id'])
"
```

期待: 2 回実行で `[track] ok: detected=N active=N arrived=N departed=N` が 2 行。`vehicle-track-history.jsonl` に2行（1回目は全車 arrived、2回目はほぼ全車マッチで arrived/departed 少）。`track-state.json` にトラックが永続。

- [ ] **Step 1.7: commit**

```bash
git add scripts/track_vehicles.py tests/test_track_vehicles.py data/vehicle-track-history.jsonl
git commit -m "feat(track): frame-to-frame vehicle tracker (update_tracks + 60s loop)"
```

---

## Task 2: `install-track-launchd.sh` 作成

**Files:**
- Create: `scripts/install-track-launchd.sh`

- [ ] **Step 2.1: インストーラを作成**

`scripts/install-track-launchd.sh` の内容:

```bash
#!/bin/bash
# launchd ジョブ jp.taxi-ic-helper.track を install / uninstall する (Phase F-3)。
# 60 秒間隔 (StartInterval 60) で .venv/bin/python3 scripts/track_vehicles.py を呼ぶ。
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
PYTHON="$REPO/.venv/bin/python3"
TRACK_SCRIPT="$REPO/scripts/track_vehicles.py"

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
    <string>$PYTHON</string>
    <string>$TRACK_SCRIPT</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/track-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/track-stderr.log</string>
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
    echo "Logs: $LOG_DIR/track-stdout.log and track-stderr.log"
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
```

- [ ] **Step 2.2: 構文チェック**

```bash
bash -n scripts/install-track-launchd.sh && echo "syntax OK"
```

期待: `syntax OK`。

- [ ] **Step 2.3: commit**

```bash
git add scripts/install-track-launchd.sh
git commit -m "feat(track): add install-track-launchd.sh (60s launchd job)"
```

---

## Task 3: 配線 (observe-tick-local.sh / .gitignore / .gitattributes)

**Files:**
- Modify: `scripts/observe-tick-local.sh`
- Modify: `.gitignore`
- Modify: `.gitattributes`

- [ ] **Step 3.1: `observe-tick-local.sh` の git add に追加**

変更前:

```bash
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json data/t3-pool-history.jsonl data/vehicle-detection-history.jsonl 2>/dev/null || true
```

変更後:

```bash
git add data/taxi-pool-history.jsonl data/stall-forecast.json data/stall-pattern-match.json data/forecast-accuracy.json data/stall-ensemble.json data/coefficient-corrections.json data/t3-pool-history.jsonl data/vehicle-detection-history.jsonl data/vehicle-track-history.jsonl 2>/dev/null || true
```

- [ ] **Step 3.2: `.gitignore` に `track-state.json` を追加**

`.gitignore` の変更前:

```
.venv*
models/
```

変更後:

```
.venv*
models/
data/track-state.json
```

- [ ] **Step 3.3: `.gitattributes` に merge=union を追加**

`.gitattributes` の変更前:

```
data/taxi-pool-history.jsonl merge=union
data/t3-pool-history.jsonl merge=union
data/vehicle-detection-history.jsonl merge=union
```

変更後:

```
data/taxi-pool-history.jsonl merge=union
data/t3-pool-history.jsonl merge=union
data/vehicle-detection-history.jsonl merge=union
data/vehicle-track-history.jsonl merge=union
```

- [ ] **Step 3.4: 構文チェック**

```bash
bash -n scripts/observe-tick-local.sh && echo "syntax OK"
```

期待: `syntax OK`。

- [ ] **Step 3.5: commit**

```bash
git add scripts/observe-tick-local.sh .gitignore .gitattributes
git commit -m "chore(track): wire vehicle-track-history into observe-tick git flow"
```

---

## Task 4: 最終整合 + push

- [ ] **Step 4.1: scope check (触ったファイル一覧)**

```bash
cd "/Users/hideakimacbookair/Library/Mobile Documents/com~apple~CloudDocs/タクシー乗務アプリ/乗務地図関係"
git log origin/main..HEAD --name-only --pretty=format:'%h %s'
```

期待: 触ったのは以下のみ:
- `scripts/track_vehicles.py`
- `tests/test_track_vehicles.py`
- `scripts/install-track-launchd.sh`
- `data/vehicle-track-history.jsonl`
- `scripts/observe-tick-local.sh`
- `.gitignore`
- `.gitattributes`
- （docs の spec / plan）

`detect_vehicles.py` / `observe-taxi-pool.mjs` / `correction-engine.mjs` / `taxi-pool-history.jsonl` / 既存 forecast 系は含まれないこと。

- [ ] **Step 4.2: Python テスト最終パス**

```bash
.venv/bin/python3 -m unittest tests/test_track_vehicles.py
.venv/bin/python3 -m unittest tests/test_detect_vehicles.py
```

期待: 両方 PASS（track 6 件 / detect 13 件）。

- [ ] **Step 4.3: node テスト回帰なし確認**

```bash
npm test 2>&1 | grep -E "^# (tests|pass|fail)"
```

期待: 407 件パス、fail 0。

- [ ] **Step 4.4: git pull --rebase --autostash で観測 push との衝突回避**

```bash
git pull --rebase --autostash origin main 2>&1 | tail -5
```

autostash 適用でコンフリクトが出た場合は **`git reset --hard` を使わないこと**。再生成系 JSON（`data/stall-*.json` / `data/forecast-accuracy.json` / `data/coefficient-corrections.json`）のみ `git checkout HEAD --` で破棄。append-only の `data/taxi-pool-history.jsonl` / `data/t3-pool-history.jsonl` / `data/vehicle-detection-history.jsonl` / `data/vehicle-track-history.jsonl` の未コミット観測行は working tree に残す。再生成系 JSON が rebase コミット適用で衝突した場合は `git checkout --theirs <file>` → `git add` → `git rebase --continue`。解決後、autostash を `git stash drop`。

- [ ] **Step 4.5: push (3 回までリトライ)**

```bash
for i in 1 2 3; do
  if git push origin main; then
    echo "[push ok attempt $i]"
    break
  fi
  echo "[retry $i]"
  git pull --rebase --autostash origin main
  sleep 2
done
```

- [ ] **Step 4.6: 完了報告**

最終状態を要約。Mac mini 側の F-3 デプロイ手順を案内する:
1. `cd ~/repos/taxi-ic-helper && git pull`
2. `./scripts/install-track-launchd.sh install`
3. `tail -f .local/track-stdout.log` で `[track] ok: ...` が 60 秒毎に出ることを確認

venv・モデルは F-1 で配置済みのため追加セットアップ不要。

---

## 検証コマンド一覧 (チートシート)

```bash
.venv/bin/python3 -m unittest tests/test_track_vehicles.py
.venv/bin/python3 scripts/track_vehicles.py
python3 -c "import json; [print(json.loads(l)) for l in open('data/vehicle-track-history.jsonl')]"
npm test
```

---

## 完了条件 (再掲)

- [ ] `update_tracks` が純関数として実装され `unittest` テストがある（6 件パス）
- [ ] `track_vehicles.py` が60秒毎に Real01_line を検出・追跡し `data/vehicle-track-history.jsonl` に schema v1 の行を追記する
- [ ] 行に `detected` / `active` / `arrived` / `departed` がある
- [ ] `data/track-state.json` でトラッカー状態が tick 間で永続する
- [ ] `scripts/install-track-launchd.sh` で60秒ジョブを install/uninstall/status できる
- [ ] `observe-tick-local.sh` の git add に `vehicle-track-history.jsonl`、`.gitignore` に `track-state.json`、`.gitattributes` に merge=union
- [ ] `track_vehicles.py` は git 操作をしない
- [ ] `npm test` 407 件パス（回帰なし）
- [ ] `detect_vehicles.py` / `observe-taxi-pool.mjs` / 既存 forecast 系・F-1・F-2 は不変
