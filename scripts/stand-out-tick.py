#!/usr/bin/env python3
# stand-out-tick — 第1〜第4乗り場のカメラ(hnd1.php / hnd2.php)で「乗り場から出た台数」を1台ずつ数える。
#
# カメラは乗り場の列を後ろから撮っていて、手前の車＝列の最後尾。新しい車は必ず手前から入る。
# 数え方(2026-10-14 試作→採用):
#   - 1分1枚の画像ごとに YOLO で車を見つけ、乗り場の列(LANE)の中の車だけ残す。
#   - 前の画像の列と今の画像の列を、先頭から順番を保ったまま対応づける(列の中で追い越しは無い)。
#     対応づけの点数=車体の色の分布(HSV ヒストグラム)の重なり。後ろへ下がる対応は許さない。
#   - 前にいて今いない車を「出た」。YOLO が1枚だけ見落とすことがあるので、2枚続けて見えないときに出たとする。
#     後ろの車が自分の位置より前へ進んでいたら、その時点で出たとする。
#   - 今いて前にいない車を「入った」。
#   - 何台同時に出ても・列の途中で客を乗せて出ても数えられる。
# 目視との比べ(4号 10/13): 17:01-17:37 目視18台/仕組み16台、21:35-21:55 目視9台/仕組み9台。時刻は±1分ずれる。
# 出力: data/stand-out-events.jsonl {ts, stall, out, in, n}(1分1行・出入りがあった画像だけ)
#       data/stand-out.json(アプリ配信用) / data/stand-out-state.json(追跡中の車)
import os, sys, json, glob
from datetime import datetime, timedelta, timezone
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
ARCHIVE = os.environ.get("TAXI_IMAGE_ARCHIVE_DIR", os.path.expanduser("~/taxi-image-archive"))
EVENTS = os.path.join(ROOT, "data/stand-out-events.jsonl")
STATE = os.path.join(ROOT, "data/stand-out-state.json")
OUT = os.path.join(ROOT, "data/stand-out.json")
JST = timezone(timedelta(hours=9))
W, H = 1024, 574

# 乗り場の列の範囲(車の箱の下辺中央が入るか)。縁石の黄色線から車1台ぶん道路側まで。
STALLS = {
    # 1〜3号(2026-10-14 本人指示で稼働): 乗り場から出た台数が優先(列移動の根拠はこの台数)。
    # 既知の弱点=手前の車が1分の間に似た色の車へ入れ替わると取りこぼす/奥の小さい車の見落としで偽の出入り。目視で精度を確かめながら直す。
    "stall1": {"cam": "real119_line", "enabled": True, "lane": [(330, 40), (400, 40), (800, 574), (465, 574)]},
    "stall2": {"cam": "real121_line", "enabled": True, "lane": [(415, 80), (480, 80), (860, 574), (485, 574)]},
    "stall3": {"cam": "real123_line", "enabled": True, "lane": [(730, 50), (790, 50), (1024, 560), (1024, 574), (785, 574)]},
    # 4号: 右下で合流待ちの車(左向き)は列に入れない
    "stall4": {"cam": "real104_line", "enabled": True, "lane": [(150, 120), (265, 120), (430, 330), (770, 574), (330, 574), (175, 330)]},
}
CONF = 0.30; MIN_W = 25
TOL = 30; LOOK = 0.30; MISS_MAX = 2
MAX_FRAMES_PER_TICK = 30     # 1tick(5分)で最大30分ぶん追いつく
START_BACK_MIN = 60          # 初回は直近60分から
STALE_MIN = 15               # 最後の画像がこれより古ければアプリに数を出さない


def in_lane(x, y, P):
    inside = False
    for i in range(len(P)):
        (x1, y1), (x2, y2) = P[i], P[(i + 1) % len(P)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def lane_cars(boxes, img, lane):
    hsv = None
    out = []
    for b in boxes:
        x, y, w, h, c, cl = b["x"], b["y"], b["w"], b["h"], b["conf"], b["cls"]
        if cl not in ("car", "truck") or c < CONF or w * W < MIN_W:
            continue
        bx, by = x * W, min((y + h / 2) * H, H - 1)
        if not in_lane(bx, by, lane):
            continue
        if hsv is None:
            hsv = img.convert("HSV")
        x1, y1, x2, y2 = (x - w / 2) * W, (y - h / 2) * H, (x + w / 2) * W, (y + h / 2) * H
        # 車体の中央部分だけ(背景を減らす)
        cx1, cx2 = x1 + (x2 - x1) * .2, x2 - (x2 - x1) * .2
        cy1, cy2 = y1 + (y2 - y1) * .25, y2 - (y2 - y1) * .15
        a = np.asarray(hsv.crop((int(cx1), int(cy1), int(cx2) + 1, int(cy2) + 1))).reshape(-1, 3).astype(float)
        if len(a) == 0:
            continue
        hist = np.concatenate([np.histogram(a[:, 0], 12, (0, 256))[0], np.histogram(a[:, 1], 6, (0, 256))[0],
                               np.histogram(a[:, 2], 8, (0, 256))[0]]).astype(float)
        hist /= hist.sum() + 1e-9
        out.append({"by": by, "bx": bx, "w": w * W, "h": hist})
    # 同じ車の二重検出を除く
    ded = []
    for c in sorted(out, key=lambda c: -c["w"]):
        if any(abs(c["by"] - o["by"]) < 20 and abs(c["bx"] - o["bx"]) < 60 for o in ded):
            continue
        ded.append(c)
    for c in ded:
        # 奥→手前で大きくなる。手前で画面下に切れた車は by が同じになるので幅で並べる
        c["k"] = c["by"] + (c["w"] * 0.2 if c["by"] >= 560 else 0)
    return sorted(ded, key=lambda c: c["k"])


def sim(a, b):
    return float(np.minimum(np.asarray(a["h"]), np.asarray(b["h"])).sum())


def align(tracks, cur):
    """順番を保った対応づけ(動的計画法)。点数=似ている度合いの合計。cur の各車に対応する track 番号を返す。"""
    n, m = len(tracks), len(cur)
    NEG = -1e9
    best = [[NEG] * (m + 1) for _ in range(n + 1)]
    back = [[None] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1): best[i][0] = 0
    for j in range(m + 1): best[0][j] = 0
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            opts = [(best[i - 1][j], "skip_t"), (best[i][j - 1], "skip_c")]
            if cur[j - 1]["k"] <= tracks[i - 1]["k"] + TOL:   # 後ろへは下がらない(少しの揺れは許す)
                s = sim(tracks[i - 1], cur[j - 1])
                if s >= LOOK:
                    opts.append((best[i - 1][j - 1] + s, "match"))
            best[i][j], back[i][j] = max(opts, key=lambda o: o[0])
    match = [None] * m
    i, j = n, m
    while i > 0 and j > 0:
        b = back[i][j]
        if b == "match": match[j - 1] = i - 1; i -= 1; j -= 1
        elif b == "skip_t": i -= 1
        else: j -= 1
    return match


def step(tracks, cur):
    """1枚ぶん進める。戻り値 (新しい tracks, 入った台数, 出た台数)。"""
    match = align(tracks, cur)
    matched_t = {t for t in match if t is not None}
    for j, t in enumerate(match):
        if t is not None:
            tracks[t].update(k=cur[j]["k"], by=cur[j]["by"], h=cur[j]["h"], miss=0)
    departed, keep = 0, []
    for t, tr in enumerate(tracks):
        if t in matched_t:
            keep.append(tr); continue
        tr["miss"] += 1
        # 自分より後ろの車が自分の位置より前へ進んでいたら、もう列にいない
        passed = any(cur[j]["k"] < tr["k"] - TOL for j, tt in enumerate(match) if tt is not None and tt > t)
        if tr["miss"] >= MISS_MAX or passed:
            departed += 1
        else:
            keep.append(tr)
    entered = 0
    for j, t in enumerate(match):
        if t is None:
            c = cur[j]
            # 1枚見落としていた車がまた見えた
            hidden = [tr for tr in keep if tr["miss"] > 0 and abs(tr["k"] - c["k"]) < 60]
            if hidden:
                hidden[0].update(k=c["k"], by=c["by"], h=c["h"], miss=0); continue
            keep.append({"k": c["k"], "by": c["by"], "h": c["h"], "miss": 0})
            entered += 1
    return sorted(keep, key=lambda t: t["k"]), entered, departed


def frame_ts(path):
    d = os.path.basename(os.path.dirname(path)); t = os.path.basename(path)[:6]
    return datetime.strptime(d + t, "%Y-%m-%d%H%M%S").replace(tzinfo=JST)


def frames_after(cam, last_iso, now):
    days = [(now - timedelta(days=1)).strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")]
    fs = []
    for d in days:
        fs += sorted(glob.glob(os.path.join(ARCHIVE, cam, d, "*.jpg")))
    since = datetime.fromisoformat(last_iso) if last_iso else now - timedelta(minutes=START_BACK_MIN)
    return [f for f in fs if frame_ts(f) > since]


def load_json(p, default):
    try:
        with open(p) as f: return json.load(f)
    except Exception:
        return default


TYPICAL = os.path.join(ROOT, "data/stand-out-typical.json")


def borrowed_slots(stall, typical, evs, today):
    """いつもの台数がまだ無い号(1〜3号)は、4号のいつもの形を借りる(本人指示 2026-10-14・暫定)。
    量は、今日その号を数え始めてからの台数と、同じ時間に4号が出た台数の比で合わせる。"""
    base = (typical.get("stall4") or {}).get("slots")
    mine = [e for e in evs if e["stall"] == stall and e["ts"][:10] == today]
    if not base or not mine:
        return None
    since = min(e["ts"] for e in mine)
    a = sum(e["out"] for e in mine)
    b = sum(e["out"] for e in evs if e["stall"] == "stall4" and e["ts"][:10] == today and e["ts"] >= since)
    if b < 20:   # 4号の数が少なすぎると比がぶれる
        return None
    r = a / b
    return [round(v * r, 1) for v in base]


def forecast30(stall, now, bins30, typical):
    recent = (bins30[-1] + bins30[-2]) / 2
    slots = (typical.get(stall) or {}).get("slots")
    out = []
    for k in (0, 1):
        t = now + timedelta(minutes=30 * k)
        if slots:
            v = 0.5 * recent + 0.5 * slots[(t.hour * 60 + t.minute) // 30]
        else:
            v = recent
        out.append(int(round(v)))
    return out


def publish(now, state):
    since = now - timedelta(hours=26)
    evs = []
    if os.path.exists(EVENTS):
        with open(EVENTS) as f:
            for line in f:
                try: e = json.loads(line)
                except Exception: continue
                if datetime.fromisoformat(e["ts"]) >= since: evs.append(e)
    today = now.strftime("%Y-%m-%d")
    try:
        with open(TYPICAL) as f:
            typical = json.load(f)
    except Exception:
        typical = {}
    stalls = {}
    for s, cfg in STALLS.items():
        if not cfg["enabled"]:
            stalls[s] = {"lastHour": None, "status": "preparing"}
            continue
        st = state.get(s, {})
        last = st.get("last")
        fresh = bool(last) and (now - datetime.fromisoformat(last)) <= timedelta(minutes=STALE_MIN)
        mine = [e for e in evs if e["stall"] == s]
        hourly = [0] * 24
        for e in mine:
            t = datetime.fromisoformat(e["ts"])
            if t.strftime("%Y-%m-%d") == today: hourly[t.hour] += e["out"]
        last_hour = sum(e["out"] for e in mine if datetime.fromisoformat(e["ts"]) > now - timedelta(hours=1))
        # 直近2時間を30分ごとに(古い→新しい)。最後が「直近30分」。
        bins30 = []
        for k in range(4, 0, -1):
            a, b = now - timedelta(minutes=30 * k), now - timedelta(minutes=30 * (k - 1))
            bins30.append(sum(e["out"] for e in mine if a < datetime.fromisoformat(e["ts"]) <= b))
        today_evs = [e for e in mine if e["ts"][:10] == today]
        typ = typical if s in typical else {**typical, **({s: {"slots": bs}} if (bs := borrowed_slots(s, typical, evs, today)) else {})}
        stalls[s] = {
            "lastHour": last_hour if fresh else None,
            "last30": bins30[-1] if fresh else None,
            "bins30": bins30 if fresh else None,
            "countingSince": min((e["ts"] for e in today_evs), default=None),
            # これから出る台数の見込み(30分ごと2本: いま〜30分後・30分後〜60分後)。
            # 仮の出し方(2026-10-14): 直近1時間の出方と、その時間帯のいつもの台数(過去の日の平均)を半分ずつ。
            # いつもの台数がまだ無い号は、直近の出方だけ。10/17 の分析で作る予測に置き換える予定。
            "forecast30": forecast30(s, now, bins30, typ) if fresh else None,
            "forecastBase": "own" if s in typical else ("stall4" if s in typ else "recent"),
            "todayHourly": hourly,
            "inQueue": len(st.get("tracks", [])) if fresh else None,
            "lastFrameAt": last,
            "status": "ok" if fresh else "stale",
        }
    ends = [(now - timedelta(minutes=30 * k)).strftime("%H:%M") for k in range(3, -1, -1)]
    out = {"generatedAt": now.isoformat(timespec="seconds"), "unit": "台", "bins30End": ends, "stalls": stalls}
    tmp = OUT + ".tmp"
    with open(tmp, "w") as f: json.dump(out, f, ensure_ascii=False, indent=1)
    os.replace(tmp, OUT)


# アプリに出す乗り場の写真。号ごとに、タクシーの列が写る範囲を縦長に切り出す(1024x574 の座標)。
CAM_CROP = {"stall1": (320, 20, 675, 574), "stall2": (410, 60, 740, 574), "stall3": (700, 30, 1024, 574), "stall4": (150, 60, 480, 574)}


def save_cams(now):
    for s, cfg in STALLS.items():
        fs = sorted(glob.glob(os.path.join(ARCHIVE, cfg["cam"], now.strftime("%Y-%m-%d"), "*.jpg")))
        if not fs:
            continue
        try:
            im = Image.open(fs[-1]).convert("RGB")
            if im.size != (W, H):
                im = im.resize((W, H))
            im = im.crop(CAM_CROP[s])
            im.thumbnail((240, 420))
            dst = os.path.join(ROOT, f"data/stand-cam-{s[-1]}.jpg")
            im.save(dst + ".tmp.jpg", quality=68)
            os.replace(dst + ".tmp.jpg", dst)
        except Exception as e:
            print(f"[stand-out] cam {s} failed: {e}")


def main():
    # 同時に2つ走ると、同じ画像を2回数えて記録が二重になる(2026-10-14 実際に起きた)。鍵が取れなければ何もしない。
    import fcntl
    lock = open(os.path.join(ROOT, "data/.stand-out.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("[stand-out] 別の回が動いているので今回は休む")
        return
    import detect_vehicles as dv
    import onnxruntime as ort
    now = datetime.now(JST)
    state = load_json(STATE, {})
    sess = None
    new_events = []
    for s, cfg in STALLS.items():
        if not cfg["enabled"]:
            continue
        st = state.setdefault(s, {"last": None, "tracks": []})
        for f in frames_after(cfg["cam"], st.get("last"), now)[:MAX_FRAMES_PER_TICK]:
            ts = frame_ts(f)
            try:
                img = Image.open(f).convert("RGB")
            except Exception:
                st["last"] = ts.isoformat(); continue
            if img.size != (W, H):
                img = img.resize((W, H))
            if sess is None:
                sess = ort.InferenceSession(dv.MODEL_PATH, providers=["CPUExecutionProvider"])
            # 前の画像から30分以上あいたら、追跡をやり直す(出たと数えない)
            if st.get("last") and ts - datetime.fromisoformat(st["last"]) > timedelta(minutes=30):
                st["tracks"] = []
            cur = lane_cars(dv.detect_image(sess, img, conf_threshold=0.25), img, cfg["lane"])
            fresh_start = not st["tracks"] and not st.get("last")
            tracks, entered, departed = step(st["tracks"], cur)
            st["tracks"] = [{"k": t["k"], "by": t["by"], "miss": t["miss"], "h": [round(float(v), 4) for v in t["h"]]} for t in tracks]
            st["last"] = ts.isoformat()
            if fresh_start:
                continue   # 最初の1枚は「入った」と数えない
            if entered or departed:
                new_events.append({"ts": ts.isoformat(), "stall": s, "out": departed, "in": entered, "n": len(cur)})
    if new_events:
        with open(EVENTS, "a") as f:
            for e in new_events: f.write(json.dumps(e, ensure_ascii=False) + "\n")
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f: json.dump(state, f)
    os.replace(tmp, STATE)
    publish(now, state)
    save_cams(now)
    print(f"[stand-out] events +{len(new_events)} out={sum(e['out'] for e in new_events)}")


if __name__ == "__main__":
    main()
