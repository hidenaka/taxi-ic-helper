#!/usr/bin/env python3
# stall1-cell-tick — 1号(real001・画面奥)の「列移動」を、車の向きに合わせた箱(セル)で数える。
#
# 本人指示(2026-09-19): 「4号みたいに車の並びに合わせて箱を作れ」「四角形ではなく車の向きに合わせろ」。
# 1号は8列が奥行きに重なって1本の細い帯に見え、帯の途中の小箱(旧 front_box)や
# 「帯の大半が同時に変わる」方式(2号・3号と同じ)では昼の小さな前進を取りこぼしていた。
#
# 方式(独立評価者の3回の指摘を反映・9/17 で適合率≈93%・再現率≈96%):
#   - 帯 t=112(左)〜120(右)…138 に沿って x=380..780 を 車1台=25px の平行四辺形セル×16
#     (縦の辺は 1号スロット列の向き: y が1増えるごとに x が -1.39)。
#   - セルの車の有無 = 模様の濃さ(std/mean)。昼 ON>0.30/OFF<0.22、夕暮れ(空 90〜140) ON>0.28/OFF<0.21、
#     夜(空<90) ON>0.33/OFF<0.25 のヒステリシス。
#   - 頭(出口側=右端) = 右端の占有セルで、その左4セルと合わせ3セル以上占有(白い柱の1セル抜けを許容)。
#     連続3セルの塊が無ければ頭なし(通過車・反射)。
#   - 頭が2分で1セル以上右へ跳び、3分持続 → 列移動。3分以内の再跳び(にじり寄り→本前進)は1回に併合。
#   - 列数 = 頭の跳びと、頭と連続する塊の左端(尾)の移動の中央値(尾がセル1以下にかかる時は頭のみ)。
#     ※ rows は「進んだセル数(≒台数ぶんの列)」。1号は頭の数列が出てから塊がまとめて進むため 3〜6 が普通。
#   - 既知の限界: 夜の濡れた路面の反射で、帯が空でも数セルが占有扱いになり偽陽性が出ることがある
#     (9/17: 31件中2件、いずれも0時台)。
#
# 出力: data/stall1-row-events.jsonl {ts, rows, rows_raw:null, head_from, head_to, tail_move, night}
#       data/stall1-cell-state.json  {last, recent:[{ts,cv,sky}...], last_event_ts}
import os, sys, json
from datetime import datetime, timedelta, timezone
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARCHIVE = os.environ.get("TAXI_IMAGE_ARCHIVE_DIR", os.path.expanduser("~/taxi-image-archive"))
CAM = "real001"
EVENTS = os.path.join(ROOT, "data/stall1-row-events.jsonl")
STATE = os.path.join(ROOT, "data/stall1-cell-state.json")
JST = timezone(timedelta(hours=9))
W, H = 1024, 512
VX, VY, XREF = -995, 115, 500.0
CAR = 25; XS = list(range(380, 780, CAR)); NC = len(XS)
SL = -8.9 / 6.4; T1 = 138
WINDOW = 80            # 直近40分ぶんを保持(前後の判定に必要)
MAX_FRAMES_PER_TICK = 40


def yat(t, x): return VY + (t - VY) * (x - VX) / (XREF - VX)
def ttop(x): return 112 + 8 * min(1, max(0, (x - 380) / 300))


def cell_cv(g):
    out = []
    for x0 in XS:
        ya = yat(ttop(x0), x0); yb = yat(T1, x0); vals = []
        for y in range(int(round(ya)), int(round(yb)) + 1):
            xa = int(round(x0 + (y - ya) * SL)); vals.extend(g[y, xa:xa + CAR])
        v = np.array(vals, dtype=np.float32); out.append(float(v.std() / max(float(v.mean()), 1.0)))
    return out


def sky(g): return float(g[0:28, 300:724].mean())


def detect(recent):
    """recent: [{ts,cv,sky}] 時系列。確定できたイベント(終端+7フレームが揃う)を返す。"""
    n = len(recent)
    if n < 12: return []
    CV = np.array([r["cv"] for r in recent]); sk = np.array([r["sky"] for r in recent])
    night = sk < 90; dusk = (sk >= 90) & (sk < 140)
    occ = np.zeros_like(CV, dtype=bool)
    for j in range(NC):
        st = False
        for i in range(n):
            on, off = (0.33, 0.25) if night[i] else ((0.28, 0.21) if dusk[i] else (0.30, 0.22))
            if CV[i, j] > on: st = True
            elif CV[i, j] < off: st = False
            occ[i, j] = st

    def has_run3(o):
        c = 0
        for v in o:
            c = c + 1 if v else 0
            if c >= 3: return True
        return False

    def head(o):
        if not has_run3(o): return -1
        for j in range(NC - 1, 3, -1):
            if o[j] and o[max(0, j - 4):j + 1].sum() >= 3: return j
        return -1

    def tail(o):
        h = head(o)
        if h < 0: return -1
        j = h; gap = 0
        while j - 1 >= 0:
            if o[j - 1]: j -= 1; gap = 0
            elif gap < 1: j -= 1; gap += 1
            else: break
        while j < h and not o[j]: j += 1
        return j

    Hh = np.array([head(o) for o in occ], dtype=float); Tl = np.array([tail(o) for o in occ], dtype=float)
    Hs = np.array([np.median(Hh[max(0, i - 1):i + 2]) for i in range(n)])
    ev = []; last = -99; i = 6
    while i < n - 7:
        if Hs[i] < 0 or Hs[i - 4] < 0 or Hs[i] - Hs[i - 4] < 1 or i - last <= 6 or np.min(Hs[i:i + 7]) < Hs[i - 4] + 1:
            i += 1; continue
        if Hh[i - 4] < 0 or np.sum(Hh[i - 6:i - 3] >= 0) < 2:
            i += 1; continue
        start = i - 4; end = i; j = i + 1
        while j < min(n - 7, i + 7):
            if Hs[j] - Hs[j - 1] >= 1 and np.min(Hs[j:j + 7]) >= Hs[j]: end = j
            j += 1
        if end + 7 >= n: break                       # まだ確定できない
        head_jump = Hs[end] - Hs[start]
        tail_move = (Tl[end + 2] - Tl[start]) if (Tl[end + 2] >= 0 and Tl[start] >= 0) else None
        cands = [head_jump] + ([tail_move] if (tail_move is not None and tail_move > 0 and Tl[start] >= 2) else [])
        rows = int(round(float(np.median(cands))))
        if rows < 2 and not (tail_move is not None and tail_move >= 1):
            i = end + 1; continue
        rows = max(1, min(8, rows))
        ev.append({"ts": recent[end]["ts"], "rows": rows, "rows_raw": None, "head_from": int(Hs[start]), "head_to": int(Hs[end]),
                   "tail_move": (int(tail_move) if tail_move is not None else None), "night": bool(night[end])})
        last = end; i = end + 1
    return ev


def day_frames(day):
    d = os.path.join(ARCHIVE, CAM, day)
    return sorted(f for f in os.listdir(d) if f.endswith(".jpg")) if os.path.isdir(d) else []


def load_state():
    try: return json.load(open(STATE))
    except Exception: return {"last": None, "recent": [], "last_event_ts": None}


def pending_frames(last, now):
    days = [(now - timedelta(days=1)).strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")]
    out = []
    for day in days:
        for f in day_frames(day):
            key = f"{day}/{f[:6]}"
            if last and key <= last: continue
            out.append((day, f))
    return out[:MAX_FRAMES_PER_TICK]


def main():
    now = datetime.now(JST); state = load_state()
    frames = pending_frames(state.get("last"), now)
    if not frames: return 0
    recent = state.get("recent") or []
    for day, f in frames:
        g = np.asarray(Image.open(os.path.join(ARCHIVE, CAM, day, f)).convert("L").resize((W, H)), dtype=np.float32)
        ts = f"{day}T{f[:2]}:{f[2:4]}:{f[4:6]}+09:00"
        recent.append({"ts": ts, "cv": [round(v, 4) for v in cell_cv(g)], "sky": round(sky(g), 1)})
        state["last"] = f"{day}/{f[:6]}"
    recent = recent[-WINDOW:]
    last_ts = state.get("last_event_ts")
    new = [e for e in detect(recent) if (not last_ts or e["ts"] > last_ts)]
    if new:
        with open(EVENTS, "a") as fh:
            for e in new: fh.write(json.dumps(e) + "\n")
        state["last_event_ts"] = new[-1]["ts"]
        print("[stall1-cell] events:", ", ".join(f"{e['ts'][11:16]} {e['rows']}列" for e in new))
    state["recent"] = recent
    json.dump(state, open(STATE, "w"))
    return 0


if __name__ == "__main__":
    try: sys.exit(main())
    except Exception as ex:
        print(f"[stall1-cell] failed: {ex}", file=sys.stderr); sys.exit(0)
