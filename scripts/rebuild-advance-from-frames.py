#!/usr/bin/env python3
# 列移動を画像から数え直す(新旧カメラ共通の方式)。
#
# 方式: 全フレーム(約30秒間隔)で「t と t-5分 の先頭エリアの差」を測る。
#   ・画面全体の変化(共通成分)を引く       … 照明の一斉変化を打ち消す
#   ・画面の明るさで正規化する              … 暗いと変化が小さく見えるので昼夜を揃える
#   ・先頭エリアに明るい点が無い場面は捨てる … 空のプールを通過車のヘッドライトが
#                                            照らしただけを列移動と誤らないため
#     (2026-07-15 01:50/01:55 の実例で確認: 誤検出は明るい点0.0%、本物は2.2-5.5%)
#
# 区画は期間で切り替える:
#   旧カメラ(〜2026-08-20, real01_line 800x600) … data/stall-slots-legacy-20260522.json の
#                                                slots から先頭列を算出(front_box は当時無い)
#   新カメラ(2026-08-21〜, real001 1024x512)    … scripts/lib/stall-slots.json の front_box
import glob, json, os, sys, time
import numpy as np
from PIL import Image

ARCHIVE_EXT = "/Volumes/ADATA HV620/taxi-image-archive"
ARCHIVE_LOCAL = os.path.expanduser("~/taxi-image-archive")
OUT = "data/advance-count-rebuilt.jsonl"
DONE = "data/.rebuild-done"
STALLS = ["stall1", "stall2", "stall3", "stall4"]
THR = 30.0
DEBOUNCE = 300
GAP = 300
SZ = (96, 48)
REF_LUM = 100.0
BRIGHT_T = 140      # 「明るい点」とみなす輝度
MIN_BRIGHT = 0.01   # 先頭エリアに1%以上の明るい点が要る(空+ヘッドライト除け)
SWITCH_DAY = "2026-08-21"   # この日から新カメラ

_old = json.load(open("data/stall-slots-legacy-20260522.json"))
_newbox = json.load(open("data/front-box-real001.json"))
TWO_LINE = {"stall1", "stall2", "stall3"}


def box_old(stall):
    slots = _old["stalls"][stall]["slots"]
    ss = sorted(slots, key=lambda s: s["cy"])
    if stall in TWO_LINE:
        mid = sum(s["cx"] for s in slots) / len(slots)
        pick = [s for s in ss if s["cx"] < mid][:2] + [s for s in ss if s["cx"] >= mid][:2]
    else:
        pick = ss[:3]
    xs = [s["cx"] for s in pick]; ys = [s["cy"] for s in pick]
    rr = max(s.get("r", 0.02) for s in pick)
    return (min(xs) - rr, max(xs) + rr, min(ys) - rr, max(ys) + rr)


def box_new(stall):
    b = _newbox["front_box"].get(stall)
    if not b:
        return None
    return (b["x0"], b["x1"], b["y0"], min(b["y1"], 1.0))


# しきい値はカメラごとに違う(画角と拡大率が違うため)。
# 旧カメラ=30 / 新カメラ=25 で、どちらも1日の回数が同水準になり目視でも本物と確認済み。
THR_BY_CAM = {"real01_line": 30.0, "real001": 25.0}


def config_for(day):
    if day >= SWITCH_DAY:
        return "real001", {s: box_new(s) for s in STALLS}
    return "real01_line", {s: box_old(s) for s in STALLS}


def frames(cam, day):
    for root in (ARCHIVE_EXT, ARCHIVE_LOCAL):
        fs = sorted(glob.glob(f"{root}/{cam}/{day}/*.jpg"))
        if len(fs) > 50:
            return fs
    return []


def process(day):
    cam, BOX = config_for(day)
    fs = frames(cam, day)
    if len(fs) < 100:
        return None
    rows = []
    for f in fs:
        nm = os.path.basename(f)[:6]
        if not nm.isdigit():
            continue
        try:
            im = Image.open(f).convert("L")
        except Exception:
            continue
        W, H = im.size
        small = np.asarray(im.resize((160, 80)), dtype=np.float32)
        rec = {"t": int(nm[:2]) * 3600 + int(nm[2:4]) * 60 + int(nm[4:6]),
               "full": small, "lum": float(small.mean())}
        for s in STALLS:
            bx = BOX.get(s)
            if not bx:
                rec[s] = None; continue
            x0, x1, y0, y1 = bx
            c = im.crop((max(0, int(x0 * W)), max(0, int(y0 * H)),
                         min(W, int(x1 * W)), min(H, int(y1 * H))))
            rec[s] = np.asarray(c.resize(SZ), dtype=np.float32) if c.size[0] > 5 and c.size[1] > 5 else None
        rows.append(rec)
    if len(rows) < 50:
        return None
    thr = THR_BY_CAM.get(cam, THR)
    ts = [r["t"] for r in rows]
    events = {s: [] for s in STALLS}
    last = {s: -10 ** 9 for s in STALLS}
    j = 0
    for i in range(len(rows)):
        while j + 1 < len(rows) and ts[j + 1] <= ts[i] - GAP:
            j += 1
        d = ts[i] - ts[j]
        if d < GAP * 0.7 or d > GAP * 2.5:
            continue
        a = rows[j]; r = rows[i]
        common = float(np.median(np.abs(r["full"] - a["full"])))
        scale = REF_LUM / max(r["lum"], 8.0)
        for s in STALLS:
            if r[s] is None or a[s] is None:
                continue
            # 車がいた形跡が無い場面は数えない
            if max(float((a[s] >= BRIGHT_T).mean()), float((r[s] >= BRIGHT_T).mean())) < MIN_BRIGHT:
                continue
            val = max(0.0, float(np.abs(r[s] - a[s]).mean()) - common) * scale
            if val >= thr and ts[i] - last[s] >= DEBOUNCE:
                events[s].append(ts[i]); last[s] = ts[i]
    bins = {}
    for s in STALLS:
        for t in events[s]:
            b = (t // 900) * 900
            key = f"{day}T{b // 3600:02d}:{(b % 3600) // 60:02d}:00+09:00"
            bins.setdefault(key, {})
            bins[key][s] = bins[key].get(s, 0) + 1
    return bins, {s: len(events[s]) for s in STALLS}, len(rows), cam


done = set()
if os.path.exists(DONE):
    done = set(open(DONE).read().split())
days = set()
for root in (ARCHIVE_EXT, ARCHIVE_LOCAL):
    for cam in ("real01_line", "real001"):
        for d in glob.glob(f"{root}/{cam}/2026-*"):
            days.add(os.path.basename(d))
days = sorted(days)
todo = [d for d in days if d not in done]
print(f"対象 {len(days)}日 / 未処理 {len(todo)}日", flush=True)
for k, day in enumerate(todo):
    t0 = time.time()
    try:
        res = process(day)
    except Exception as e:
        print(f"  {day} 失敗: {e}", flush=True); continue
    if res is None:
        print(f"  {day} 画像不足でスキップ", flush=True)
        open(DONE, "a").write(day + "\n"); continue
    bins, tot, nframes, cam = res
    with open(OUT, "a") as f:
        for key in sorted(bins):
            f.write(json.dumps({"ts": key, "stalls": bins[key],
                                "method": "frame-diff-v4", "cam": cam}, ensure_ascii=False) + "\n")
    open(DONE, "a").write(day + "\n")
    print(f"  [{k+1}/{len(todo)}] {day} {cam} 枚数{nframes} → "
          f"1号{tot['stall1']} 2号{tot['stall2']} 3号{tot['stall3']} 4号{tot['stall4']} "
          f"({time.time()-t0:.0f}秒)", flush=True)
print("完了", flush=True)
