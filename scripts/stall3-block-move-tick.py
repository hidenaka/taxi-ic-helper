#!/usr/bin/env python3
# stall3-block-move-tick — 2〜3号(real001)の「列移動」を、帯の大半が同時に変わる瞬間(=塊ごと動く)で数える。
# (名前は最初に作った3号のまま。2026-09-18 に 2号・1号も同じ仕組みで追加)
#
# なぜ 4号(前縁追跡)と違うやり方か(2026-09-18 画像研究):
#   3号の列1(出口側=画面左端)は、混んでいる時間は画面の外にある。前縁が見えないので
#   「出た→進んだ」を端で追えない。代わりに、列移動が起きると画面に映っている塊ぜんぶが
#   一斉に動くことを使う。1台だけの出入りは帯の一部しか変わらないので区別できる。
#   動いた量(1列か2列か)は、黒い車が並ぶと1台ぶんずれても同じに見えて測れないため、
#   1回=1列として記録する(rows=1・rows_raw=null)。
#
# 判定(9/13〜9/17 の30秒画像 約2万枚で検証・目視 12/12 が本物の移動):
#   1) 帯(t=235..405 の6本線)に沿った明るさプロファイル g(x) とエッジ占有 occ(x) を毎フレーム作る
#   2) 直前フレームとの |Δg| が 10 を超える割合(占有部分の中)= extent。extent>=0.45 かつ占有長>=150px
#   3) 次の2フレームで変化が収まっている(連続変化=照明のちらつきは除外)
#   4) 並びがそのまま(ずれ0の相関>=0.85)なら照明変化とみなし除外
#   5) 3分以内の二重検出は1回
#   ※ 3〜8時は乗り場停止(入庫の並べ替えが混ざる)なので publish 側の運用時間ゲートで落とす
#   ※ 2号・1号(遠くて小さい・行灯のまぶしさが支配的)は、露出変化に引きずられないよう
#      (a) プロファイルの中央値を引いてから差を取る (b) 画面全体の変化(gdiff)が大きい瞬間は除く。
#      3号は近くて見え方が安定しているので検証済みの元の判定のまま(guard=False)。
#
# 出力: data/stall{1,2,3}-row-events.jsonl {ts, rows:1, extent, corr0}
#       data/stall{1,2,3}-block-move-state.json 処理位置・直前プロファイル・保留フレーム
import os, sys, json, glob
from datetime import datetime, timedelta, timezone
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARCHIVE = os.environ.get("TAXI_IMAGE_ARCHIVE_DIR", os.path.expanduser("~/taxi-image-archive"))
CAM = "real001"
STATIC_DIR = os.path.join(ROOT, "data/stall3-static-edge")   # real001 のエッジ最小値キャッシュ(全帯で共用)
STALLS = {
    "stall3": {"ts": [235, 270, 305, 340, 375, 405], "x0": 95, "x1": 760, "half": 6, "ethr": 11.0, "dthr": 10.0,
               "region_min": 150, "win": 360, "guard": False},
    "stall2": {"ts": [146, 160, 175, 190, 205], "x0": 120, "x1": 980, "half": 4, "ethr": 9.0, "dthr": 8.0,
               "region_min": 120, "win": 300, "guard": True},
    # stall1 は scripts/stall1-cell-tick.py(車の向きに合わせた箱・2026-09-19)へ移行。ここでは扱わない。
}
GDIFF_MAX = 6.0
def events_path(k): return os.path.join(ROOT, f"data/{k}-row-events.jsonl")
def state_path(k): return os.path.join(ROOT, f"data/{k}-block-move-state.json")
JST = timezone(timedelta(hours=9))

W, H = 1024, 512
VX, VY, XREF = -995, 115, 500.0          # noriba-bands.json real001 の消失点(帯は白線と平行)
EXT_THR = 0.45; SETTLE_THR = 0.35; LIGHT_CORR = 0.85
DEBOUNCE_FRAMES = 6                        # ≈3分(30秒間隔)
MAX_FRAMES_PER_TICK = 40


def yat(t, x):
    return VY + (t - VY) * (x - VX) / (XREF - VX)


def load(path):
    im = Image.open(path).convert("L").resize((W, H))
    g = np.asarray(im, dtype=np.float32)
    e = np.asarray(im.filter(ImageFilter.FIND_EDGES), dtype=np.float32)
    return g, e


def band_profiles(g, e, emin, c):
    ed = np.maximum(e - emin, 0) if emin is not None else e
    gp = []; ep = []; h = c["half"]
    for t in c["ts"]:
        gv = []; ev = []
        for x in range(c["x0"], c["x1"]):
            y = int(round(yat(t, x)))
            gv.append(float(g[y - h:y + h + 1, x - 1:x + 2].mean()))
            ev.append(float(ed[y - h:y + h + 1, x - 2:x + 3].mean()))
        gp.append(gv); ep.append(ev)
    gp = np.mean(gp, axis=0)
    ep = np.convolve(np.mean(ep, axis=0), np.ones(9) / 9, mode="same")
    return gp, ep > c["ethr"]


def corr0(g0, g1, occ, win):
    idx = np.where(occ)[0]
    if len(idx) < 80:
        return None
    lo, hi = int(idx[0]), int(min(idx[-1], idx[0] + win))
    a = g0[lo:hi] - g0[lo:hi].mean(); b = g1[lo:hi] - g1[lo:hi].mean()
    if a.std() < 2 or b.std() < 2:
        return None
    return float(np.corrcoef(a, b)[0, 1])


def global_diff(g, prev_small):
    small = g.reshape(32, 16, 64, 16).mean(axis=(1, 3))
    d = float(np.median(np.abs(small - prev_small))) if prev_small is not None else 0.0
    return d, small


def day_frames(day):
    d = os.path.join(ARCHIVE, CAM, day)
    return sorted(f for f in os.listdir(d) if f.endswith(".jpg")) if os.path.isdir(d) else []


def static_edges_for(day):
    os.makedirs(STATIC_DIR, exist_ok=True)
    cache = os.path.join(STATIC_DIR, f"{day}.npy")
    if os.path.exists(cache):
        return np.load(cache)
    prev = (datetime.strptime(day, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
    src = prev if len(day_frames(prev)) >= 400 else day
    fs = day_frames(src)[::12]
    if len(fs) < 20:
        return None
    emin = None
    for f in fs:
        _, e = load(os.path.join(ARCHIVE, CAM, src, f))
        emin = e if emin is None else np.minimum(emin, e)
    np.save(cache, emin)
    for old in sorted(glob.glob(os.path.join(STATIC_DIR, "*.npy")))[:-3]:
        try: os.remove(old)
        except OSError: pass
    return emin


def jst_iso(day, hhmmss):
    return f"{day}T{hhmmss[:2]}:{hhmmss[2:4]}:{hhmmss[4:6]}+09:00"


def load_state(k):
    try:
        return json.load(open(state_path(k)))
    except Exception:
        return {"last": None, "prev": None, "pending": [], "last_event_frame": -99, "frame_no": 0, "small": None}


def pending_frames(last, now):
    days = [(now - timedelta(days=1)).strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")]
    out = []
    for day in days:
        for f in day_frames(day):
            key = f"{day}/{f[:6]}"
            if last and key <= last:
                continue
            out.append((day, f))
    return out[:MAX_FRAMES_PER_TICK]


def run_stall(k, c, now, emin_cache):
    state = load_state(k)
    frames = pending_frames(state.get("last"), now)
    if not frames:
        return
    prev = state.get("prev"); pending = state.get("pending") or []
    frame_no = state.get("frame_no", 0); last_event_frame = state.get("last_event_frame", -99)
    prev_small = np.array(state["small"], dtype=np.float32) if state.get("small") else None
    new_events = []
    for day, f in frames:
        if day not in emin_cache:
            emin_cache[day] = static_edges_for(day)
        g, e = load(os.path.join(ARCHIVE, CAM, day, f))
        gdiff, prev_small = global_diff(g, prev_small)
        gp, occ = band_profiles(g, e, emin_cache[day], c)
        frame_no += 1
        ts = jst_iso(day, f[:6])
        extent = 0.0; region = 0
        if prev is not None:
            pg = np.array(prev["gp"], dtype=np.float32); pocc = np.array(prev["occ"], dtype=bool)
            reg = occ | pocc; region = int(reg.sum())
            if region > 0:
                a, b = (gp - np.median(gp), pg - np.median(pg)) if c["guard"] else (gp, pg)
                extent = float((np.abs(a - b)[reg] > c["dthr"]).mean())
        still = []
        for cand in pending:
            cand["after"].append(extent)
            if len(cand["after"]) >= 2:
                if not (cand["after"][0] > SETTLE_THR and cand["after"][1] > SETTLE_THR):
                    g0 = np.array(cand["gp_before"], dtype=np.float32); occ0 = np.array(cand["occ_before"], dtype=bool)
                    g1 = np.array(cand["gp_after"], dtype=np.float32)
                    c0 = corr0(g0, g1, occ0, c["win"])
                    if not (c0 is not None and c0 >= LIGHT_CORR) and cand["frame_no"] - last_event_frame > DEBOUNCE_FRAMES:
                        new_events.append({"ts": cand["ts"], "rows": 1, "rows_raw": None, "extent": round(cand["extent"], 2),
                                           "corr0": (round(c0, 2) if c0 is not None else None)})
                        last_event_frame = cand["frame_no"]
                continue
            if len(cand["after"]) == 1:
                cand["gp_after"] = gp.astype(float).round(1).tolist()
            still.append(cand)
        pending = still
        gate = (not c["guard"]) or gdiff <= GDIFF_MAX
        if prev is not None and gate and extent >= EXT_THR and region >= c["region_min"] and frame_no - last_event_frame > DEBOUNCE_FRAMES:
            pending.append({"ts": ts, "frame_no": frame_no, "extent": extent,
                            "gp_before": prev["gp"], "occ_before": prev["occ"], "after": []})
        prev = {"gp": gp.astype(float).round(1).tolist(), "occ": occ.tolist()}
        state["last"] = f"{day}/{f[:6]}"
    new_events = _dedupe_by_file(new_events, events_path(k), 150)
    if new_events:
        with open(events_path(k), "a") as fh:
            for ev in new_events:
                fh.write(json.dumps(ev) + "\n")
        print(f"[{k}-block-move] events:", ", ".join(e["ts"][11:16] for e in new_events))
    state.update({"prev": prev, "pending": pending, "frame_no": frame_no, "last_event_frame": last_event_frame,
                  "small": (prev_small.round(1).tolist() if prev_small is not None else None)})
    json.dump(state, open(state_path(k), "w"))




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
    now = datetime.now(JST)
    emin_cache = {}
    for k, c in STALLS.items():
        try:
            run_stall(k, c, now, emin_cache)
        except Exception as ex:
            print(f"[{k}-block-move] failed: {ex}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as ex:
        print(f"[stall3-block-move] failed: {ex}", file=sys.stderr)
        sys.exit(0)
