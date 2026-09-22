#!/usr/bin/env python3
# stall4-row-shift-tick v2 — 4号後列(real002)の「列移動」を、線ごとの前縁ジャンプで数える。
#
# 定義(本人確定 2026-09-18): 列=横一列。列移動=列1(前の横一列)が出たあと、後ろの列が塊ごと前(カメラ側)へ進むこと。
# 数えるのは回数(本人指示 2026-09-19)。rows(何列ぶん)は付帯情報。
#
# v1(前縁の中央値・1分おき・谷→台)は独立評価で 夜の再現率≈30%(21時台 9回中1回)・適合率≈70%。原因:
#   3点中央値と「直後4分安定」ゲートが、夜の「出る→1分以内に詰める→次が出る」を潰す / 部分出発を中央値が見ない /
#   線1(x=470)が静止エッジで固定値、線3・4が走査開始点(コーン・チェーン)で偽値 / 入庫・再配置を列移動に数える。
# v2(この版):
#   - 30秒おきの全フレーム。線ごとに前縁 y を取り、走査開始点±3px・y≤100 は無効値。
#   - 線ごとに「2分以内に前縁が手前(y大)へ 0.7列ぶん以上ジャンプ」を検出。1列ぶんの px は y に依存
#     (実測: y≈440 で≈100px、y≈300 で≈75px、y≈170 で≈50px → rowpx(y)=0.2*y+15)。
#   - 7本中3本以上が2分以内にジャンプ → 列移動1回。約90秒内の二重は1回(画像は実質1分1枚)。
#   - 入庫・再配置の除外: ジャンプ前2分に有効な線が3本未満(塊が無い)なら数えない。
#   - 退出車の通過の取り消し: ジャンプ後2分以内に前縁が元の位置まで戻ったら数えない。
#   - rows = ジャンプした線の中央値(列ぶん・区間中点の目盛り)。丸めは 1.85/2.85 境界。集計は回数(rows は付帯情報)。
#   - v3.2(2026-09-20): 雨の少数台の日は塊に掛かる線が3本しかなく、y_after>340→線4本ルールが本物を全落とし(15-17時 5回中1回)。
#     線の本数の絶対値ではなく「動いた線のうち前へ跳んだ線の割合≥0.6」に変更し、y_after>340 ルールを撤去。
#   - v3.5(2026-09-23): 前進だけでなく「直前に前縁が後退していた(列1が出た)」ことを必須に。入庫の数え上げを止める。
#     9日分(9/14〜9/22)で 380→271回。落とす側32件を画像確認し全件が入庫、残す側16件は約7割が本物の列移動。
#   - v3.3(2026-09-20): 前縁がコーン線に張り付いたまま前列が入れ替わる(1分以内に出て詰める)を前列パッチ差分で拾う(kind=swap)。
#     取りこぼしは 9/13(日曜・混雑) 52回に対し11回、9/19 3回、9/17 0回だった。
#     swap は奥ブロックの台数(vehicle-count-history back.yolo/lantern)≥10 のときだけ(後ろに列が無ければ列移動は起きない。9/20 08:03 の1列だけの詰め直し等を除外)。
#   - 独立評価(9/17): v3 再現率≈86%・適合率≈88%(y_after>340 除外と100秒二重除外で≈96%見込み)。
#     残る取りこぼし=前列に1〜2台残る部分出発(21:55型)。格子方式(案A)は昼の少数台の並べ直しを拾うため不採用(2026-09-19)。
# 出力: data/stall4-row-events.jsonl {ts, rows, rows_raw, lines, y_before, y_after}
#       data/stall4-row-shift-state.json {last, recent:[{ts,fe[7]}], last_event_ts}
import os, sys, json, glob
from datetime import datetime, timedelta, timezone
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARCHIVE = os.environ.get("TAXI_IMAGE_ARCHIVE_DIR", os.path.expanduser("~/taxi-image-archive"))
CAM = "real002"
EVENTS = os.path.join(ROOT, "data/stall4-row-events.jsonl")
STATE = os.path.join(ROOT, "data/stall4-row-shift-state.json")
STATIC_DIR = os.path.join(ROOT, "data/stall4-static-edge")
JST = timezone(timedelta(hours=9))
W, H = 1024, 512
VP = (75, -200)
XS = [470, 560, 650, 740, 830, 920, 1010]
Y0, Y1 = 470, 60
YSTART = [350, 350, 440, 440, 420, 395, 395]
EDGE_THR = 11.0; RUN = 32; HALF = 14
FRAMES_2MIN = 4; DEBOUNCE = 3; MIN_LINES = 3; JUMP_ROWS = 0.7; ACTIVE_RATIO = 0.6
FALL_LOOK = 8; FALL_ROWS = 0.7; FALL_NEED = 0.5   # v3.5: 列1が出た(前縁が一度後退した)線が、跳んだ線の半分以上あること
SWAP_THR = 20.0; CONE_MARGIN = 35   # 前縁がコーン線に張り付いたまま前列の中身が入れ替わる(1分以内に出て詰める)を拾う(v3.3)
PREV_GRAY = os.path.join(ROOT, "data/stall4-prev-gray.npy")
VCOUNT = os.path.join(ROOT, "data/vehicle-count-history.jsonl")
SWAP_MIN_CARS = 10   # 入れ替え(swap)は「後ろに列がある」ときだけ: 奥ブロックの台数(YOLO/夜は行灯)≥10。1列だけ・ほぼ空のときは列移動が起きようがない   # 画像は実質1分1枚(同一画像が続く)なので DEBOUNCE=3フレーム≈90秒
WINDOW = 60; MAX_FRAMES_PER_TICK = 240   # 遅れても1tickで2時間ぶん追いつける(処理≈0.1秒/枚)


def rowpx(y): return 0.2 * y + 15
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
        if Y0 - i > ystart: continue
        cnt = cnt + 1 if v else 0
        if cnt >= RUN:
            y = Y0 - (i - RUN + 1)
            if y <= 100: return None      # 画面上端の固定値は無効。走査開始点付近(コーン列まで来た本物の前縁)は有効のまま
            #   ※ 走査開始点の固定値(コーン/チェーン)はジャンプを起こさないので線ごとの判定では害にならない(2026-09-19)
            return y
    return None


def day_frames(day):
    d = os.path.join(ARCHIVE, CAM, day)
    return sorted(f for f in os.listdir(d) if f.endswith(".jpg")) if os.path.isdir(d) else []


def static_edges_for(day):
    os.makedirs(STATIC_DIR, exist_ok=True)
    cache = os.path.join(STATIC_DIR, f"{day}.npy")
    if os.path.exists(cache): return np.load(cache)
    prev = (datetime.strptime(day, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
    src = prev if len(day_frames(prev)) >= 400 else day
    fs = day_frames(src)[::12]
    if len(fs) < 20: return None
    emin = None
    for f in fs:
        e = edge_map(os.path.join(ARCHIVE, CAM, src, f)); emin = e if emin is None else np.minimum(emin, e)
    np.save(cache, emin)
    for old in sorted(glob.glob(os.path.join(STATIC_DIR, "*.npy")))[:-3]:
        try: os.remove(old)
        except OSError: pass
    return emin


class BackCount:
    """vehicle-count-history の back(奥ブロック台数: yolo / 夜は lantern)を時刻で引く。15分より古い記録しか無ければ None。"""
    def __init__(self, path=VCOUNT):
        self.rows = []
        try:
            with open(path) as fh:
                for l in fh:
                    try: r = json.loads(l)
                    except Exception: continue
                    b = r.get("back") or {}
                    n = max(int(b.get("yolo") or 0), int(b.get("lantern") or 0))
                    self.rows.append((datetime.fromisoformat(r["ts"]), n))
        except Exception: pass
        self.rows.sort()
    def at(self, ts_iso):
        t = datetime.fromisoformat(ts_iso); best = None
        lo, hi = 0, len(self.rows)
        while lo < hi:
            mid = (lo + hi) // 2
            if self.rows[mid][0] <= t: lo = mid + 1
            else: hi = mid
        if lo == 0: return None
        rt, n = self.rows[lo - 1]
        return n if (t - rt).total_seconds() <= 900 else None


def frame_fe(path, emin):
    e = edge_map(path)
    if emin is not None: e = np.maximum(e - emin, 0)
    return [front_edge(e, p, ys) for p, ys in zip(LINES, YSTART)]


def frame_feat(path, emin, prev_gray):
    """fe[7] と、線ごとの前列パッチ(前縁から1列ぶん奥まで・幅±20px)の前フレームとの平均差分 diff[7]。gray も返す。"""
    fe = frame_fe(path, emin)
    g = np.asarray(Image.open(path).convert("L").resize((W, H)), dtype=np.float32)
    diffs = [None] * len(XS)
    if prev_gray is not None and prev_gray.shape == g.shape:
        for L, (pts, y) in enumerate(zip(LINES, fe)):
            if y is None: continue
            y0 = int(y - 0.9 * rowpx(y)); vals = []
            for (x, yy) in pts:
                yi = int(round(yy))
                if y0 <= yi <= y:
                    xi = int(round(x)); a = g[yi, max(0, xi - 20):xi + 21]; b = prev_gray[yi, max(0, xi - 20):xi + 21]
                    vals.append(float(np.abs(a - b).mean()))
            if vals: diffs[L] = round(float(np.mean(vals)), 1)
    return fe, diffs, g


def detect(recent):
    """recent: [{ts, fe[7]}] 30秒おき。確定できたイベントを返す(終端+FRAMES_2MIN が揃うもの)。"""
    n = len(recent)
    if n < 12: return []
    FE = np.array([[np.nan if v is None else v for v in r["fe"]] for r in recent], dtype=float)
    valid = ~np.isnan(FE)
    ev = []; last = -99; i = FRAMES_2MIN + 4
    while i < n - FRAMES_2MIN:
        if i - last <= DEBOUNCE: i += 1; continue
        # 線ごと: i-4..i の間に手前へ 0.7列以上ジャンプしたか(直前の有効値との差)
        jumps = []; active = 0
        for L in range(len(XS)):
            if not valid[i, L]: continue
            prev = [FE[k, L] for k in range(i - FRAMES_2MIN, i) if valid[k, L]]
            if not prev: continue
            yb = min(prev); d = FE[i, L] - yb
            if abs(d) >= 0.3 * rowpx(yb): active += 1   # 動いた線(塊に掛かっている線)。動かない線は塊の外か固定エッジ
            if d >= JUMP_ROWS * rowpx(yb): jumps.append((L, yb, FE[i, L], d / rowpx((yb + FE[i, L]) / 2)))   # 列数は区間の中点の目盛りで
        if len(jumps) < MIN_LINES:
            # v3.3 入れ替え検出: 前縁が3本以上コーン線に張り付いたまま(前後フレームとも)、前列パッチの中身が大きく変わった
            #   = 前列が出て1分以内に次列が詰めた(前縁ジャンプが画像に写らない)。静止時の差分は p90≈8・本物は中央値≈42(9/13,9/17,9/19)。
            #   画像確認(9/13: 12件中11本物, 9/19: 4件中3本物)。
            dif = recent[i].get("diff") or [None] * len(XS)
            cone = [L for L in range(len(XS)) if valid[i, L] and valid[i - 1, L] and FE[i, L] >= YSTART[L] - CONE_MARGIN
                    and FE[i - 1, L] >= YSTART[L] - CONE_MARGIN and dif[L] is not None]
            n4 = recent[i].get("n4")
            if len(cone) >= 3 and float(np.median([dif[L] for L in cone])) >= SWAP_THR and n4 is not None and n4 >= SWAP_MIN_CARS:
                # 入れ替えのあと2分は前列が埋まったままであること(出ただけで詰まらなかった=列移動ではない、9/16 19:56 型)
                emptied = False
                for k in range(i + 1, min(n, i + FRAMES_2MIN + 1)):
                    m = [FE[k, L] for L in cone if valid[k, L]]
                    if len(m) < 2 or np.median([FE[k, L] - (YSTART[L] - CONE_MARGIN) for L in cone if valid[k, L]]) < -0.5 * rowpx(400): emptied = True; break
                if emptied: i += 1; continue
                if not (ev and (datetime.fromisoformat(recent[i]['ts']) - datetime.fromisoformat(ev[-1]['ts'])).total_seconds() < 100):
                    ev.append({"ts": recent[i]["ts"], "rows": 1, "rows_raw": 1.0, "lines": len(cone), "kind": "swap",
                               "diff": round(float(np.median([dif[L] for L in cone])), 1),
                               "y_before": round(float(np.median([FE[i, L] for L in cone])), 1), "y_after": round(float(np.median([FE[i, L] for L in cone])), 1)})
                    last = i
            i += 1; continue
        # 塊が細い日(雨・少数台)は塊に掛かる線が3〜4本しかない。線の本数ではなく「動いた線のうち前へ跳んだ割合」で見る(v3.2)
        if len(jumps) / max(active, 1) < ACTIVE_RATIO: i += 1; continue
        # 入庫・再配置の除外: ジャンプ前2分に有効線が3本未満なら塊が無かった
        if (valid[i - FRAMES_2MIN - 4:i - FRAMES_2MIN].sum(axis=1) >= MIN_LINES).sum() < 2: i += 1; continue
        # 退出車の通過の取り消し: 2分以内に戻る
        # 通過車の取り消し: 2分以内に前縁が「元の位置まで」戻ったときだけ(部分的に戻る本物の列移動は残す)
        back = False
        yb_med = float(np.median([yb for (_, yb, _, _) in jumps]))
        for k in range(i + 1, min(n, i + FRAMES_2MIN + 1)):
            m = [FE[k, L] for (L, yb, ya, r) in jumps if valid[k, L]]
            if m and np.median(m) <= yb_med + 0.3 * rowpx(yb_med): back = True; break
        if back: i += 1; continue
        # v3.5: 「列1が出る(前縁が後退)→塊が詰める(前縁が前進)」の対だけ数える。
        #   入庫(空の乗り場に車が入って列ができる)は前進だけで後退が無いので落ちる。
        #   9/14〜9/22 の全イベントから抜き出した落とす側32件を画像確認: 32件すべて入庫(本物の列移動は無し)。
        hits = 0
        for (L, yb, ya, r) in jumps:
            prev = [FE[k, L] for k in range(max(0, i - FALL_LOOK), i) if valid[k, L]]
            if prev and max(prev) >= yb + FALL_ROWS * rowpx(yb): hits += 1
        fall_ok = hits >= max(1, int(np.ceil(FALL_NEED * len(jumps))))
        if not fall_ok:
            last = i; i += 1; continue      # 入庫と判定。次フレームで同じ前進を数え直さないよう debounce は進める
        # (v3.2 で撤去) 「y_after>340 は線4本以上」は、塊が細い日(9/20 雨)の本物(線3本)を全部落としていた。
        #   9/12・9/17・9/19 で撤去後の増分を画像で確認: 本物 12 / 偽 2(9/17 深夜の光筋)。
        # 二重除外は実時間で100秒(同一画像が続く30秒フレームなのでフレーム数では揺れる)
        if ev and (datetime.fromisoformat(recent[i]['ts']) - datetime.fromisoformat(ev[-1]['ts'])).total_seconds() < 100: i += 1; continue
        raw = float(np.median([r for (_, _, _, r) in jumps]))
        rows = 1 if raw < 1.85 else (2 if raw < 2.85 else 3)
        ev.append({"ts": recent[i]["ts"], "rows": rows, "rows_raw": round(raw, 2), "lines": len(jumps),
                   "y_before": round(float(np.median([yb for (_, yb, _, _) in jumps])), 1), "y_after": round(float(np.median([ya for (_, _, ya, _) in jumps])), 1)})
        last = i; i += 1
    return ev


def run_day(day, emin=None):
    """バックフィル用: 1日ぶんを通しで処理。"""
    fs = day_frames(day)
    if emin is None: emin = static_edges_for(day)
    recent = []; g = None; bc = BackCount()
    for f in fs:
        fe, dif, g = frame_feat(os.path.join(ARCHIVE, CAM, day, f), emin, g)
        ts = jst_iso(day, f[:6])
        recent.append({"ts": ts, "fe": fe, "diff": dif, "n4": bc.at(ts)})
    return detect(recent)


def jst_iso(day, hhmmss): return f"{day}T{hhmmss[:2]}:{hhmmss[2:4]}:{hhmmss[4:6]}+09:00"


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


def later_than(ts, ref, gap_sec=100):
    """ts が ref より gap_sec 秒以上あと(判定窓をまたいだ二重を防ぐ)。"""
    a = datetime.fromisoformat(ts); b = datetime.fromisoformat(ref)
    return (a - b).total_seconds() >= gap_sec




def _last_event_ts(path):
    """イベントファイル末尾の ts。書き込み時の重複防止(同じ列移動を2回数えない)に使う。"""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2); size = fh.tell(); back = min(size, 4096); fh.seek(size - back)
            lines = [l for l in fh.read().decode("utf-8", "ignore").splitlines() if l.strip()]
        return json.loads(lines[-1])["ts"] if lines else None
    except Exception:
        return None


def _dedupe_by_file(events, path, min_gap):
    """直前に書き込み済みのイベントから min_gap 秒未満のものは落とす(窓をまたいだ二重計上の防止)。"""
    ref = _last_event_ts(path); out = []
    for e in events:
        if ref:
            try:
                if (datetime.fromisoformat(e["ts"]) - datetime.fromisoformat(ref)).total_seconds() < min_gap: continue
            except Exception: pass
        out.append(e); ref = e["ts"]
    return out


def main():
    now = datetime.now(JST); state = load_state()
    frames = pending_frames(state.get("last"), now)
    if not frames: return 0
    recent = state.get("recent") or []; emin_cache = {}
    try: g = np.load(PREV_GRAY).astype(np.float32)
    except Exception: g = None
    bc = BackCount()
    last_ts = state.get("last_event_ts"); new_all = []
    # 遅れて追いつくときも判定窓(WINDOW)からイベントがこぼれないよう、20枚ずつ足しては判定する
    CHUNK = 20
    for c0 in range(0, len(frames), CHUNK):
        for day, f in frames[c0:c0 + CHUNK]:
            if day not in emin_cache: emin_cache[day] = static_edges_for(day)
            fe, dif, g = frame_feat(os.path.join(ARCHIVE, CAM, day, f), emin_cache[day], g)
            ts = jst_iso(day, f[:6])
            recent.append({"ts": ts, "fe": fe, "diff": dif, "n4": bc.at(ts)})
            state["last"] = f"{day}/{f[:6]}"
        recent = recent[-WINDOW:]
        new = [e for e in detect(recent) if (not last_ts or later_than(e["ts"], last_ts, 100))]
        new = _dedupe_by_file(new, EVENTS, 100)
        if new:
            with open(EVENTS, "a") as fh:
                for e in new: fh.write(json.dumps(e) + "\n")
            last_ts = new[-1]["ts"]; new_all += new
    if new_all:
        state["last_event_ts"] = last_ts
        print("[stall4-row-shift] events:", ", ".join(f"{e['ts'][11:16]} {e['rows']}列" for e in new_all))
    state["recent"] = recent
    json.dump(state, open(STATE, "w"))
    if g is not None: np.save(PREV_GRAY, g.astype(np.uint8))
    return 0


if __name__ == "__main__":
    try: sys.exit(main())
    except Exception as ex:
        print(f"[stall4-row-shift] failed: {ex}", file=sys.stderr); sys.exit(0)
