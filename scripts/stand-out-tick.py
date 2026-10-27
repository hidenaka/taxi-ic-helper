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
TOL = 30; LOOK = 0.30; MISS_MAX = 2; SIZE_MAX = 1.4
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
            tr_, c_ = tracks[i - 1], cur[j - 1]
            ok = c_["k"] <= tr_["k"] + TOL   # 後ろへは下がらない(少しの揺れは許す)
            # 同じくらいの位置にいるのに箱の幅が 1.4 倍以上違う → 似た色の別の車が入れ替わった(2026-10-14 1号の夜で 12→13 台・目視 13〜14)
            if ok and tr_.get("w") and c_["by"] > 250 and abs(c_["by"] - tr_["by"]) < 40 \
                    and max(c_["w"], tr_["w"]) / max(1.0, min(c_["w"], tr_["w"])) > SIZE_MAX:
                ok = False
            if ok:
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
            tracks[t].update(k=cur[j]["k"], by=cur[j]["by"], h=cur[j]["h"], w=cur[j]["w"], miss=0)
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
                hidden[0].update(k=c["k"], by=c["by"], h=c["h"], w=c["w"], miss=0); continue
            keep.append({"k": c["k"], "by": c["by"], "h": c["h"], "w": c["w"], "miss": 0})
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
# 「いつもの日」の1時間ごとの台数(アプリの今日1日のグラフに線で重ねる)。1日1回作り直す。
DAYPROF = os.path.join(ROOT, "data/stand-out-dayprofile.json")
DAYPROF_DAYS, DAYPROF_MIN = 42, 7


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


SNAPS = os.path.join(ROOT, "data/arrivals-snapshots")
ARRIVALS = os.path.join(ROOT, "data/arrivals.json")
SEAT_TYP = os.path.join(ROOT, "data/stand-out-seat-typical.json")
SEAT_SHIFT = 15   # ロビーに出てから乗り場を出るまでのずれ(分)。いまから30分の枠には、15分前〜15分後にロビーに出る便を数える


def _hm(sv):
    try:
        h, m = str(sv).split(":")[:2]
        return int(h) * 60 + int(m)
    except Exception:
        return None


def _lobby(f):
    return _hm(f.get("lobbyExitTime") or f.get("estimatedTime") or f.get("scheduledTime"))


def seat_typical(today):
    """号ごとの「いつもの座席数」(30分ごと48枠・過去14日の平均)。1日1回だけ作り直す。"""
    try:
        with open(SEAT_TYP) as f:
            d = json.load(f)
        if d.get("date") == today:
            return d["lanes"]
    except Exception:
        pass
    days = sorted(x for x in os.listdir(SNAPS) if x.startswith("arrivals-") and x < f"arrivals-{today}")[-14:]
    acc = {str(n): [0.0] * 48 for n in (1, 2, 3, 4)}
    nd = 0
    for fn in days:
        try:
            with open(os.path.join(SNAPS, fn)) as f:
                last = f.read().strip().splitlines()[-1]
            fl = json.loads(last)["flights"]
        except Exception:
            continue
        nd += 1
        for x in fl:
            ln, t = x.get("poolLane"), _lobby(x)
            if ln not in (1, 2, 3, 4) or t is None or x.get("status") == "欠航":
                continue
            acc[str(ln)][t // 30 % 48] += x.get("seatCount") or 0
    lanes = {k: [round(v / max(nd, 1)) for v in arr] for k, arr in acc.items()}
    try:
        with open(SEAT_TYP, "w") as f:
            json.dump({"date": today, "days": nd, "lanes": lanes}, f)
    except Exception:
        pass
    return lanes


def seats_in(flights, lane, a, b):
    tot = 0
    for x in flights:
        t = _lobby(x)
        if x.get("poolLane") != lane or t is None or x.get("status") == "欠航":
            continue
        d = (t - a) % 1440
        if d < (b - a):
            tot += x.get("seatCount") or 0
    return tot


MODEL = os.path.join(ROOT, "data/stand-out-model.json")
FC_PAIRS = os.path.join(ROOT, "data/stand-out-fc-pairs.jsonl")
W0 = [0.5, 0.5, 0.5]   # 学ぶ前の重み: 直近の出方 / いつもの台数 / 座席数の多い少ない(= 2026-10-14 夕方の手置きの式と同じ)


def load_model():
    try:
        with open(MODEL) as f:
            return json.load(f)
    except Exception:
        return {}


def forecast30(stall, now, bins30, typical, flights=None, seat_typ=None, model=None):
    """これから出る台数の見込み(いま〜30分後・30分後〜60分後)と、その材料。
    材料 x = [直近の出方(30分あたり), その時間帯のいつもの台数, (両者の平均)×(座席数の比−1)]。見込み = 重み・x (0 未満は 0)。
    重みは学ぶ前は W0 (= 直近といつもを半分ずつ、座席数の多い少ないを半分だけ効かせる)。
    1日1回、ためた答え合わせ (stand-out-fc-pairs.jsonl) から号ごと・30分後/60分後ごとに学び直す (learn_model)。
    2026-10-14 本人指示「予測と実績を残せるから自動で学習していく仕組みを」。"""
    recent = (bins30[-1] + bins30[-2]) / 2
    slots = (typical.get(stall) or {}).get("slots")
    lane = int(stall[-1])
    nowm = now.hour * 60 + now.minute
    preds, feats = [], []
    for k in (0, 1):
        t = nowm + 30 * k
        slot = slots[(t // 30) % 48] if slots else recent
        rho = 1.0
        if flights is not None and seat_typ:
            a = (t - SEAT_SHIFT) % 1440
            got = seats_in(flights, lane, a, a + 30)
            ty = seat_typ.get(str(lane), [0] * 48)
            usual = (ty[(a // 30) % 48] + ty[((a + 29) // 30) % 48]) / 2
            if usual >= 150:
                rho = max(0.5, min(1.8, got / usual))
        x = [round(recent, 2), round(slot, 2), round((recent + slot) / 2 * (rho - 1), 3)]
        w = ((model or {}).get(stall, {}).get(str(k), {}) or {}).get("w") or W0
        preds.append(int(round(max(0.0, sum(a * b for a, b in zip(w, x))))))
        feats.append(x)
    return preds, feats


def settle(state, evs_all, now):
    """答え合わせ: 終わった枠の見込みに、実際に出た台数を付けて stand-out-fc-pairs.jsonl へ。"""
    keep, done = [], []
    for fc in state.get("fc_pending", []):
        st = state.get(fc["stall"], {})
        last = st.get("last")
        if not last or last < fc["end"]:          # その枠の画像をまだ数え終えていない
            if fc["end"] > (now - timedelta(hours=3)).isoformat():
                keep.append(fc)
            continue
        act = sum(e["out"] for e in evs_all if e["stall"] == fc["stall"] and fc["start"] < e["ts"] <= fc["end"])
        done.append({**fc, "actual": act})
    if done:
        with open(FC_PAIRS, "a") as f:
            for d in done:
                f.write(json.dumps(d, ensure_ascii=False) + "\n")
    state["fc_pending"] = keep
    return len(done)


def learn_model(now, days=14, lam=30.0):
    """1日1回: 直近 days 日の答え合わせから、号ごと・k ごとに重みを解き直す (W0 へ引き寄せるリッジ回帰)。
    サンプルが 100 未満のうちは W0 のまま。外れ(平均の差)は学ぶ前の式と並べて残す。"""
    import numpy as np
    since = (now - timedelta(days=days)).isoformat()
    rows = []
    if os.path.exists(FC_PAIRS):
        with open(FC_PAIRS) as f:
            for line in f:
                try: d = json.loads(line)
                except Exception: continue
                if d.get("made", "") >= since: rows.append(d)
    model = {"learnedAt": now.isoformat(timespec="seconds"), "days": days}
    for stall in STALLS:
        for k in (0, 1):
            rs = [r for r in rows if r["stall"] == stall and r["k"] == k]
            ent = {"n": len(rs), "w": None}
            if rs:
                X = np.array([r["x"] for r in rs], float); y = np.array([r["actual"] for r in rs], float)
                p0 = np.clip(X @ np.array(W0), 0, None)
                ent["maeBefore"] = round(float(np.abs(p0 - y).mean()), 2)
                if len(rs) >= 100:
                    w0 = np.array(W0)
                    w = np.linalg.solve(X.T @ X + lam * np.eye(3), X.T @ y + lam * w0)
                    w = np.clip(w, [0, 0, 0], [1.5, 1.5, 1.5])
                    ent["w"] = [round(float(v), 3) for v in w]
                    ent["maeAfter"] = round(float(np.abs(np.clip(X @ w, 0, None) - y).mean()), 2)
            model.setdefault(stall, {})[str(k)] = ent
    tmp = MODEL + ".tmp"
    with open(tmp, "w") as f: json.dump(model, f, ensure_ascii=False, indent=1)
    os.replace(tmp, MODEL)
    return model


def rebuild_typical(evs_all, typical, now, max_days=14):
    """1日1回: 記録した台数から、号ごとの「いつもの台数」(30分ごと48枠)を作り直す。
    丸1日数えた日(0:30 までに数え始めた日)だけを使い、いまの「いつもの台数」より多くの日数がそろったら差し替える。"""
    byday = {}
    for e in evs_all:
        byday.setdefault((e["stall"], e["ts"][:10]), []).append(e)
    today = now.strftime("%Y-%m-%d")
    changed = False
    for stall in STALLS:
        full = sorted(d for (st, d), es in byday.items() if st == stall and d < today and min(x["ts"] for x in es)[11:16] <= "00:30")[-max_days:]
        cur_days = len((typical.get(stall) or {}).get("days") or [])
        if len(full) >= 3 and len(full) >= cur_days:
            slots = [0.0] * 48
            for d in full:
                for e in byday[(stall, d)]:
                    slots[(int(e["ts"][11:13]) * 60 + int(e["ts"][14:16])) // 30] += e["out"]
            typical[stall] = {"slots": [round(v / len(full), 1) for v in slots], "days": full, "source": "events"}
            changed = True
    if changed:
        with open(TYPICAL, "w") as f: json.dump(typical, f, ensure_ascii=False)
    return typical


def rebuild_dayprofile(now):
    """号ごとに、丸1日数えた日(0:30までに数え始め23時台まで数えた日)の直近42日で、1時間ごとの平均台数を作る。
    7日たまるまでは出さない。2026-10-17 の分析で、平日と土日・到着便の座席数で分けても外れは小さくならなかったので、全部の日の平均にする。"""
    today = now.strftime("%Y-%m-%d")
    lo = (now - timedelta(days=DAYPROF_DAYS + 1)).strftime("%Y-%m-%d")
    byday = {}
    with open(EVENTS) as f:
        for line in f:
            try: e = json.loads(line)
            except Exception: continue
            d = e["ts"][:10]
            if lo <= d < today:
                v = byday.setdefault((e["stall"], d), {"h": [0] * 24, "first": e["ts"], "last": e["ts"]})
                v["h"][int(e["ts"][11:13])] += e["out"]
                v["first"] = min(v["first"], e["ts"]); v["last"] = max(v["last"], e["ts"])
    prof = {"builtOn": today}
    for stall in STALLS:
        days = sorted(d for (st, d), v in byday.items() if st == stall and v["first"][11:16] <= "00:30" and v["last"][11:13] == "23")[-DAYPROF_DAYS:]
        if len(days) >= DAYPROF_MIN:
            prof[stall] = {"hourly": [round(sum(byday[(stall, d)]["h"][h] for d in days) / len(days), 1) for h in range(24)],
                           "days": len(days), "from": days[0], "to": days[-1]}
    with open(DAYPROF, "w") as f: json.dump(prof, f, ensure_ascii=False)
    return prof


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
    # 答え合わせ用に14日ぶんの記録も読む(見込みの学び直し・いつもの台数の作り直しに使う)
    evs_all = []
    since14 = (now - timedelta(days=15)).isoformat()
    if os.path.exists(EVENTS):
        with open(EVENTS) as f:
            for line in f:
                try: e = json.loads(line)
                except Exception: continue
                if e["ts"] >= since14: evs_all.append(e)
    settle(state, evs_all, now)
    if state.get("learnedOn") != today:
        typical = rebuild_typical(evs_all, typical, now)
        learn_model(now)
        state["learnedOn"] = today
    model = load_model()
    try:
        with open(DAYPROF) as f: dayprof = json.load(f)
    except Exception:
        dayprof = {}
    if dayprof.get("builtOn") != today:
        dayprof = rebuild_dayprofile(now)
    try:
        with open(ARRIVALS) as f:
            flights = json.load(f).get("flights") or []
        seat_typ = seat_typical(today)
    except Exception as e:
        print(f"[stand-out] 到着便が読めないので座席数は使わない: {e}")
        flights, seat_typ = None, None
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
        fc, feats = forecast30(s, now, bins30, typ, flights, seat_typ, model) if fresh else (None, None)
        if fresh and fc is not None:
            for k in (0, 1):
                a, b = now + timedelta(minutes=30 * k), now + timedelta(minutes=30 * (k + 1))
                state.setdefault("fc_pending", []).append({"made": now.isoformat(timespec="seconds"), "stall": s, "k": k,
                    "start": a.isoformat(timespec="seconds"), "end": b.isoformat(timespec="seconds"), "pred": fc[k], "x": feats[k]})
        stalls[s] = {
            "lastHour": last_hour if fresh else None,
            "last30": bins30[-1] if fresh else None,
            "bins30": bins30 if fresh else None,
            "countingSince": min((e["ts"] for e in today_evs), default=None),
            # これから出る台数の見込み(30分ごと2本: いま〜30分後・30分後〜60分後)。
            # 仮の出し方(2026-10-14): 直近1時間の出方と、その時間帯のいつもの台数(過去の日の平均)を半分ずつ。
            # いつもの台数がまだ無い号は、直近の出方だけ。10/17 の分析で作る予測に置き換える予定。
            "forecast30": fc if fresh else None,
            "forecastWeights": ((model.get(s) or {}).get("0") or {}).get("w") or W0,
            "forecastBase": "own" if s in typical else ("stall4" if s in typ else "recent"),
            "todayHourly": hourly,
            # いつもの日の1時間ごとの台数と、その平均に使った日数(7日たまるまでは null)
            "typicalHourly": (dayprof.get(s) or {}).get("hourly"),
            "typicalDays": (dayprof.get(s) or {}).get("days"),
            "inQueue": len(st.get("tracks", [])) if fresh else None,
            "lastFrameAt": last,
            "status": "ok" if fresh else "stale",
        }
    acc = {}
    if os.path.exists(FC_PAIRS):
        since7 = (now - timedelta(days=7)).isoformat()
        with open(FC_PAIRS) as f:
            for line in f:
                try: d = json.loads(line)
                except Exception: continue
                if d.get("made", "") >= since7:
                    a = acc.setdefault(d["stall"], {}).setdefault(str(d["k"]), [0, 0.0])
                    a[0] += 1; a[1] += abs(d["pred"] - d["actual"])
    for st_, ks in acc.items():
        if st_ in stalls:
            stalls[st_]["forecastEval"] = {k: {"n": n, "mae": round(t / n, 2)} for k, (n, t) in ks.items()}
    ends = [(now - timedelta(minutes=30 * k)).strftime("%H:%M") for k in range(3, -1, -1)]
    out = {"generatedAt": now.isoformat(timespec="seconds"), "unit": "台", "bins30End": ends, "stalls": stalls}
    tmp = OUT + ".tmp"
    with open(tmp, "w") as f: json.dump(out, f, ensure_ascii=False, indent=1)
    os.replace(tmp, OUT)


# アプリに出す乗り場の写真。号ごとに、タクシーの列が写る範囲を縦長に切り出す(1024x574 の座標)。
CAM_CROP = {"stall1": (320, 20, 675, 574), "stall2": (410, 60, 740, 574), "stall3": (700, 30, 1024, 574), "stall4": (150, 60, 480, 574)}
# 2026-10-27 本人「車ではなく左側の待ちの乗客が見えるように・押したら元の画像全体を」。
# 左側の歩道(待っている乗客)と列の先頭を縦長に切り出す(-wait.jpg)。全体は -full.jpg。
# 本番が -wait.jpg に切り替わったら、上の CAM_CROP(列の車中心)と stand-cam-N.jpg は外してよい。
CAM_CROP_WAIT = {"stall1": (80, 0, 440, 574), "stall2": (110, 30, 470, 574), "stall3": (380, 0, 760, 574), "stall4": (0, 40, 210, 574)}


def save_cams(now):
    # 写真ごとの撮影時刻(元画像のファイル名 YYYY-MM-DD/HHMMSS.jpg)。アプリが写真の上に出す。
    times = {}
    for s, cfg in STALLS.items():
        fs = sorted(glob.glob(os.path.join(ARCHIVE, cfg["cam"], now.strftime("%Y-%m-%d"), "*.jpg")))
        if not fs:
            continue
        try:
            im = Image.open(fs[-1]).convert("RGB")
            if im.size != (W, H):
                im = im.resize((W, H))
            n = s[-1]
            outs = [(f"stand-cam-{n}-full.jpg", im, 62)]
            for name, box in ((f"stand-cam-{n}.jpg", CAM_CROP[s]), (f"stand-cam-{n}-wait.jpg", CAM_CROP_WAIT[s])):
                t = im.crop(box)
                t.thumbnail((240, 420))
                outs.append((name, t, 68))
            for name, img, q in outs:
                dst = os.path.join(ROOT, "data", name)
                img.save(dst + ".tmp.jpg", quality=q)
                os.replace(dst + ".tmp.jpg", dst)
        except Exception as e:
            print(f"[stand-out] cam {s} failed: {e}")
            continue
        day, hms = fs[-1].split(os.sep)[-2], os.path.basename(fs[-1])[:6]
        times[n] = f"{day}T{hms[:2]}:{hms[2:4]}:{hms[4:6]}+09:00"
    if times:
        dst = os.path.join(ROOT, "data/stand-cam.json")
        with open(dst + ".tmp", "w") as f: json.dump({"shotAt": times}, f)
        os.replace(dst + ".tmp", dst)


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
            st["tracks"] = [{"k": t["k"], "by": t["by"], "w": round(float(t.get("w") or 0), 1), "miss": t["miss"], "h": [round(float(v), 4) for v in t["h"]]} for t in tracks]
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
    publish(now, state)   # 見込みの記録・答え合わせ・学び直しの日付を state に足す → もう一度書く
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f: json.dump(state, f)
    os.replace(tmp, STATE)
    save_cams(now)
    print(f"[stand-out] events +{len(new_events)} out={sum(e['out'] for e in new_events)}")


if __name__ == "__main__":
    main()
