#!/usr/bin/env python3
# stall3-block-move-tick — 3号(real001)の「列移動」を、帯の大半が同時に変わる瞬間(=塊ごと動く)で数える。
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
#
# 出力: data/stall3-row-events.jsonl {ts, rows:1, extent, corr0}
#       data/stall3-block-move-state.json 処理位置・直前プロファイル・保留フレーム
import os, sys, json, glob
from datetime import datetime, timedelta, timezone
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARCHIVE = os.environ.get("TAXI_IMAGE_ARCHIVE_DIR", os.path.expanduser("~/taxi-image-archive"))
CAM = "real001"
EVENTS = os.path.join(ROOT, "data/stall3-row-events.jsonl")
STATE = os.path.join(ROOT, "data/stall3-block-move-state.json")
STATIC_DIR = os.path.join(ROOT, "data/stall3-static-edge")
JST = timezone(timedelta(hours=9))

W, H = 1024, 512
VX, VY, XREF = -995, 115, 500.0          # noriba-bands.json real001 の消失点(帯は白線と平行)
TS = [235, 270, 305, 340, 375, 405]       # 3号の帯(t=213..420)の内側 6 本
X0, X1 = 95, 760                          # プール左端〜(右は3号の塊の届く範囲)
HALF = 6
EDGE_THR = 11.0; EXT_THR = 0.45; REGION_MIN = 150; SETTLE_THR = 0.35; LIGHT_CORR = 0.85
DEBOUNCE_FRAMES = 6                        # ≈3分(30秒間隔)
MAX_FRAMES_PER_TICK = 40


def yat(t, x):
    return VY + (t - VY) * (x - VX) / (XREF - VX)


def load(path):
    im = Image.open(path).convert("L").resize((W, H))
    g = np.asarray(im, dtype=np.float32)
    e = np.asarray(im.filter(ImageFilter.FIND_EDGES), dtype=np.float32)
    return g, e


def band_profiles(g, e, emin):
    ed = np.maximum(e - emin, 0) if emin is not None else e
    gp = []; ep = []
    for t in TS:
        gv = []; ev = []
        for x in range(X0, X1):
            y = int(round(yat(t, x)))
            gv.append(float(g[y - HALF:y + HALF + 1, x - 1:x + 2].mean()))
            ev.append(float(ed[y - HALF:y + HALF + 1, x - 2:x + 3].mean()))
        gp.append(gv); ep.append(ev)
    gp = np.mean(gp, axis=0)
    ep = np.convolve(np.mean(ep, axis=0), np.ones(9) / 9, mode="same")
    return gp, ep > EDGE_THR


def corr0(g0, g1, occ):
    idx = np.where(occ)[0]
    if len(idx) < 120:
        return None
    lo, hi = int(idx[0]), int(min(idx[-1], idx[0] + 360))
    a = g0[lo:hi] - g0[lo:hi].mean(); b = g1[lo:hi] - g1[lo:hi].mean()
    if a.std() < 3 or b.std() < 3:
        return None
    return float(np.corrcoef(a, b)[0, 1])


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


def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {"last": None, "prev": None, "pending": [], "last_event_frame": -99, "frame_no": 0}


def pending_frames(state, now):
    days = [(now - timedelta(days=1)).strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")]
    last = state.get("last"); out = []
    for day in days:
        for f in day_frames(day):
            key = f"{day}/{f[:6]}"
            if last and key <= last:
                continue
            out.append((day, f))
    return out[:MAX_FRAMES_PER_TICK]


def main():
    now = datetime.now(JST)
    state = load_state()
    frames = pending_frames(state, now)
    if not frames:
        return 0
    emin_cache = {}
    prev = state.get("prev")           # {"gp":[...], "occ":[...]} 直前フレーム
    pending = state.get("pending") or []   # 判定待ち候補 [{ts, frame_no, extent, gp_before, occ_before, after:[extent...]}]
    frame_no = state.get("frame_no", 0)
    last_event_frame = state.get("last_event_frame", -99)
    new_events = []
    for day, f in frames:
        if day not in emin_cache:
            emin_cache[day] = static_edges_for(day)
        g, e = load(os.path.join(ARCHIVE, CAM, day, f))
        gp, occ = band_profiles(g, e, emin_cache[day])
        frame_no += 1
        ts = jst_iso(day, f[:6])
        extent = 0.0; region = 0
        if prev is not None:
            pg = np.array(prev["gp"], dtype=np.float32); pocc = np.array(prev["occ"], dtype=bool)
            reg = occ | pocc; region = int(reg.sum())
            if region > 0:
                extent = float((np.abs(gp - pg)[reg] > 10).mean())
        # 保留中の候補に「その後の変化」を積む。2フレームぶん揃ったら判定
        still = []
        for c in pending:
            c["after"].append(extent)
            if len(c["after"]) >= 2:
                if not (c["after"][0] > SETTLE_THR and c["after"][1] > SETTLE_THR):
                    g0 = np.array(c["gp_before"], dtype=np.float32); occ0 = np.array(c["occ_before"], dtype=bool)
                    # 直後フレーム(=候補の1つ後)のプロファイルは c["gp_after"] に保存済み
                    g1 = np.array(c["gp_after"], dtype=np.float32)
                    c0 = corr0(g0, g1, occ0)
                    if not (c0 is not None and c0 >= LIGHT_CORR) and c["frame_no"] - last_event_frame > DEBOUNCE_FRAMES:
                        new_events.append({"ts": c["ts"], "rows": 1, "rows_raw": None, "extent": round(c["extent"], 2),
                                           "corr0": (round(c0, 2) if c0 is not None else None)})
                        last_event_frame = c["frame_no"]
                continue
            if len(c["after"]) == 1:
                c["gp_after"] = gp.astype(float).round(1).tolist()
            still.append(c)
        pending = still
        if prev is not None and extent >= EXT_THR and region >= REGION_MIN and frame_no - last_event_frame > DEBOUNCE_FRAMES:
            pending.append({"ts": ts, "frame_no": frame_no, "extent": extent,
                            "gp_before": prev["gp"], "occ_before": prev["occ"], "after": []})
        prev = {"gp": gp.astype(float).round(1).tolist(), "occ": occ.tolist()}
        state["last"] = f"{day}/{f[:6]}"
    if new_events:
        with open(EVENTS, "a") as fh:
            for ev in new_events:
                fh.write(json.dumps(ev) + "\n")
        print("[stall3-block-move] events:", ", ".join(e["ts"][11:16] for e in new_events))
    state.update({"prev": prev, "pending": pending, "frame_no": frame_no, "last_event_frame": last_event_frame})
    json.dump(state, open(STATE, "w"))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as ex:
        print(f"[stall3-block-move] failed: {ex}", file=sys.stderr)
        sys.exit(0)
