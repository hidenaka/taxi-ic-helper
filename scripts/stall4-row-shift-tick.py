#!/usr/bin/env python3
# stall4-row-shift-tick — 4号後列(real002)の「列移動」を、列1(前の横一列)の前縁の動きから数える。
#
# 定義(本人確定 2026-09-18):
#   列 = 横に並んだ車の一行。列移動 = 列1が出たあと、後ろの列が塊ごと前(カメラ側)へ進むこと。
#   1回の前進が 1列ぶんか 2列ぶんかを区別して記録する(深夜〜早朝は2列が多い)。
#
# なぜ従来の front_box(コーンの手前線の小箱)では駄目だったか:
#   列1はふだんコーンの手前線よりずっと奥で止まる(箱まで来るのは塊が長い日だけ)。
#   空の箱では「出る→埋まる」が起きないので、4号だけ日に 3〜23 回しか数えられなかった
#   (画像で追うと 23〜31 回・列ぶんで 28〜43)。
#
# 方式(8日×24時間の画像で検証・目視 16/20 一致):
#   1) 車の向きに沿った奥行き線を7本引き、各線で「前から見て最初に車がある位置」を取る
#      → その中央値 = 列1の前縁 y(大きいほど手前)。1分おきのアーカイブ画像を使う。
#   2) 静止物(側溝の格子・コーン・白線)は「前日のエッジ最小値」を引いて消す。
#   3) 前縁が3分で40px以上手前へ動いたら候補。直前6分の最も奥(谷)→直後4分の中央値(台)を
#      行数に直し(奥行き目盛り KNOTS)、0.6列以上なら列移動 1回、列数は四捨五入(1〜3)。
#   4) ゲート: 前縁を検出できた線が4本未満(車1〜2台)なら数えない / 台が落ち着かない(標準偏差>15px)
#      なら数えない(通過車) / 5分以内の二重検出は1回。
#
# 出力:
#   data/stall4-front-history.jsonl  {ts, y, n, fe[7]}  1分おきの前縁
#   data/stall4-row-events.jsonl     {ts, rows, rows_raw, from_y, to_y}  列移動イベント
#   data/stall4-row-shift-state.json 処理位置と直近の系列
# 使い方: observe-tick-local.sh から5分おきに呼ぶ(失敗しても本流を止めない)。
import os, sys, json, glob
from datetime import datetime, timedelta, timezone
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARCHIVE = os.environ.get("TAXI_IMAGE_ARCHIVE_DIR", os.path.expanduser("~/taxi-image-archive"))
CAM = "real002"
HIST = os.path.join(ROOT, "data/stall4-front-history.jsonl")
EVENTS = os.path.join(ROOT, "data/stall4-row-events.jsonl")
STATE = os.path.join(ROOT, "data/stall4-row-shift-state.json")
STATIC_DIR = os.path.join(ROOT, "data/stall4-static-edge")
JST = timezone(timedelta(hours=9))

W, H = 1024, 512
VP = (75, -200)                      # 列(奥行き)方向の消失点。車の前後軸から実測(2026-09-18)
XS = [470, 560, 650, 740, 830, 920, 1010]   # y=470 での奥行き線の通過x(列1の車の位置)
Y0, Y1 = 470, 60
YSTART = [350, 350, 440, 440, 420, 395, 395] # 線ごとの走査開始(コーン/チェーン/側溝格子を避ける)
# y → 行数(手前=0)。観測: 手前側は1列≈95px、奥は縮む(9/17 の実画像から)
KNOTS = [(440, 0.0), (345, 1.0), (250, 2.0), (195, 3.0), (150, 4.0), (115, 5.0), (85, 6.0), (60, 7.0)]
EDGE_THR = 11.0; RUN = 32; HALF = 14
MIN_JUMP_PX = 40; MIN_ROWS = 0.6; DEBOUNCE_MIN = 5; MIN_LINES = 4; MAX_STD = 15
MAX_FRAMES_PER_TICK = 40             # 積み残しがあっても1回の tick で処理する上限(5分tickなら5〜6枚)


def row_of(y):
    ys = [k[0] for k in KNOTS]; rs = [k[1] for k in KNOTS]
    if y >= ys[0]:
        return rs[0] - (y - ys[0]) / 95.0
    for (ya, ra), (yb, rb) in zip(KNOTS, KNOTS[1:]):
        if yb <= y <= ya:
            return ra + (ya - y) / (ya - yb) * (rb - ra)
    return rs[-1] + (ys[-1] - y) / 25.0


def line_pts(x0):
    dx, dy = VP[0] - x0, VP[1] - Y0
    return [(x0 + dx * ((y - Y0) / dy), y) for y in range(Y0, Y1, -1)]


LINES = [line_pts(x) for x in XS]


def edge_map(path):
    im = Image.open(path).convert("L").resize((W, H))
    return np.asarray(im.filter(ImageFilter.FIND_EDGES), dtype=np.float32)


def front_edge(e, pts, ystart):
    vals = []
    for (x, y) in pts:
        xi = int(round(x)); yi = int(round(y))
        seg = e[max(0, yi - 2):yi + 3, max(0, xi - HALF):xi + HALF + 1]
        vals.append(float(seg.mean()) if seg.size else 0.0)
    sm = np.convolve(np.array(vals), np.ones(10) / 10, mode="same")
    cnt = 0
    for i, v in enumerate(sm > EDGE_THR):
        if Y0 - i > ystart:
            continue
        cnt = cnt + 1 if v else 0
        if cnt >= RUN:
            return Y0 - (i - RUN + 1)
    return None


def day_frames(day):
    d = os.path.join(ARCHIVE, CAM, day)
    if not os.path.isdir(d):
        return []
    return sorted(f for f in os.listdir(d) if f.endswith(".jpg"))


def static_edges_for(day):
    """前日(無ければ当日ここまで)の全フレーム(6枚おき)のエッジ最小値。日付ごとにキャッシュ。"""
    os.makedirs(STATIC_DIR, exist_ok=True)
    cache = os.path.join(STATIC_DIR, f"{day}.npy")
    if os.path.exists(cache):
        return np.load(cache)
    prev = (datetime.strptime(day, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
    src_day = prev if len(day_frames(prev)) >= 200 else day
    fs = day_frames(src_day)[::6]
    if len(fs) < 20:
        return None
    emin = None
    for f in fs:
        e = edge_map(os.path.join(ARCHIVE, CAM, src_day, f))
        emin = e if emin is None else np.minimum(emin, e)
    np.save(cache, emin)
    # 古いキャッシュは3日ぶんだけ残す
    for old in sorted(glob.glob(os.path.join(STATIC_DIR, "*.npy")))[:-3]:
        try: os.remove(old)
        except OSError: pass
    return emin


def jst_iso(day, hhmmss):
    return f"{day}T{hhmmss[:2]}:{hhmmss[2:4]}:{hhmmss[4:6]}+09:00"


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {"last": None, "series": [], "last_event_ts": None}


def pending_frames(state, now):
    """未処理の(1分に1枚へ間引いた)フレームを [ (day, file) ... ] で返す。"""
    days = [(now - timedelta(days=1)).strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")]
    last = state.get("last")  # "YYYY-MM-DD/HHMMSS"
    out = []
    for day in days:
        seen = set()
        for f in day_frames(day):
            key = f"{day}/{f[:6]}"
            if last and key <= last:
                continue
            mk = f[:4]
            if mk in seen:
                continue
            seen.add(mk); out.append((day, f))
    return out[:MAX_FRAMES_PER_TICK]


def detect_events(series, last_event_ts):
    """series: [{ts, y, n}] 1分おき(y は None あり)。確定できた(直後4分がある)イベントだけ返す。"""
    ts = [r["ts"] for r in series]
    v = []; last = None
    for r in series:
        y = r["y"] if r["y"] is not None else last
        v.append(np.nan if y is None else float(y)); last = y
    v = np.array(v, dtype=float)
    sm = np.array([np.nanmedian(v[max(0, i - 1):i + 2]) if not np.all(np.isnan(v[max(0, i - 1):i + 2])) else np.nan for i in range(len(v))])
    nl = [r["n"] for r in series]
    ev = []; last_i = -99
    for i in range(6, len(sm) - 4):
        if np.isnan(sm[i]) or np.isnan(sm[i - 3]):
            continue
        if sm[i] - sm[i - 3] < MIN_JUMP_PX or i - last_i <= DEBOUNCE_MIN:
            continue
        if nl[i] < MIN_LINES:
            continue
        after = sm[i:i + 4]
        if np.nanstd(after) > MAX_STD:
            continue
        trough = np.nanmin(sm[i - 6:i]); plateau = np.nanmedian(after)
        r = row_of(trough) - row_of(plateau)
        if r < MIN_ROWS:
            continue
        if last_event_ts and ts[i] <= last_event_ts:
            last_i = i; continue
        ev.append({"ts": ts[i], "rows": int(max(1, min(3, round(r)))), "rows_raw": round(float(r), 2),
                   "from_y": round(float(trough), 1), "to_y": round(float(plateau), 1)})
        last_i = i
    return ev


def main():
    now = datetime.now(JST)
    state = load_state()
    frames = pending_frames(state, now)
    if not frames:
        return 0
    emin_cache = {}
    for day, f in frames:
        if day not in emin_cache:
            emin_cache[day] = static_edges_for(day)
        emin = emin_cache[day]
        e = edge_map(os.path.join(ARCHIVE, CAM, day, f))
        if emin is not None:
            e = np.maximum(e - emin, 0)
        fe = [front_edge(e, p, ys) for p, ys in zip(LINES, YSTART)]
        valid = [x for x in fe if x is not None]
        y = float(np.median(valid)) if len(valid) >= 3 else None
        row = {"ts": jst_iso(day, f[:6]), "y": y, "n": len(valid), "fe": fe}
        with open(HIST, "a") as fh:
            fh.write(json.dumps(row) + "\n")
        state["series"] = (state.get("series") or []) + [{"ts": row["ts"], "y": y, "n": len(valid)}]
        state["last"] = f"{day}/{f[:6]}"
    state["series"] = state["series"][-40:]          # 直近40分あれば検出に足りる(前6+後4)
    events = detect_events(state["series"], state.get("last_event_ts"))
    if events:
        with open(EVENTS, "a") as fh:
            for ev in events:
                fh.write(json.dumps(ev) + "\n")
        state["last_event_ts"] = events[-1]["ts"]
        print("[stall4-row-shift] events:", ", ".join(f"{e['ts'][11:16]} {e['rows']}列" for e in events))
    json.dump(state, open(STATE, "w"))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as ex:  # 本流(observe tick)を止めない
        print(f"[stall4-row-shift] failed: {ex}", file=sys.stderr)
        sys.exit(0)
