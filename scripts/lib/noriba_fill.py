#!/usr/bin/env python3
"""号別(1〜4)の全レーン埋まり率を昼夜統合で出す。
昼(real01輝度>=55): 学習占有モデルを各号の全レーン点(noriba-lanes.json)に適用し occ/total。
夜(<55): 行灯カウント(night_lantern) count/capacity(上限100%)。
1号=stall1, 2号=stall2, 3号=stall3, 4号=stall4(real01手前)+stall4_back(real02奥)。
検証: 昼 空0%→満96-100%/過大過小なし、夜 満車~100%(過小解消)・空0%・ブレーキ/街灯除外、
capacityは私とcodexの独立校正一致(差1-2)。"""
import os, sys, json
import numpy as np
from PIL import Image

_LIB = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _LIB)
import occupancy_model as om
import night_lantern as nl

_REPO = os.path.dirname(_LIB)
LANES = os.path.join(os.path.dirname(_REPO), "data/noriba-lanes.json")
MODEL = os.path.join(os.path.dirname(_REPO), "data/occupancy_model.json")
DAY_GATE = 55.0
GO_STALLS = {"1": ["stall1"], "2": ["stall2"], "3": ["stall3"], "4": ["stall4", "stall4_back"]}
STALL_CAM = {"stall1": "real01", "stall2": "real01", "stall3": "real01", "stall4": "real01", "stall4_back": "real02"}

_lanes = None
_model = None
_counter = None


def _load():
    global _lanes, _model, _counter
    if _lanes is None:
        _lanes = json.load(open(LANES))
    if _model is None:
        _model = om.load_model(MODEL)
    if _counter is None:
        _counter = nl.NightLanternCounter()
    return _lanes, _model, _counter


def _day_occ(arr, points, sub):
    W = arr.shape[1]
    H = arr.shape[0]
    occ = 0
    tot = 0
    for cx, cy in points:
        fv = om._feats(om._patch_at(arr, cx * W, cy * H, W, H))
        if fv is None:
            continue
        z = ((fv - sub["mu"]) / sub["sd"]) @ sub["w"] + sub["b"]
        occ += int(1.0 / (1.0 + np.exp(-z)) > sub["thr"])
        tot += 1
    return occ, tot


def compute(real01_path, real02_path):
    """戻り値: {mode, brightness, fill:{1..4 比率0-1}, detail}"""
    lanes, model, counter = _load()
    im1 = Image.open(real01_path).convert("RGB")
    a1 = np.asarray(im1, dtype=np.uint8)
    br = float(np.asarray(im1.convert("L"), dtype=np.float32).mean())
    out = {"brightness": round(br, 1), "fill": {}, "detail": {}}
    if br >= DAY_GATE:
        out["mode"] = "day"
        a2 = None
        if real02_path and os.path.exists(real02_path):
            a2 = np.asarray(Image.open(real02_path).convert("RGB"), dtype=np.uint8)
        for go, stalls in GO_STALLS.items():
            o = 0
            t = 0
            for st in stalls:
                arr = a1 if STALL_CAM[st] == "real01" else a2
                if arr is None:
                    continue
                so, stt = _day_occ(arr, lanes[st], model[STALL_CAM[st]])
                o += so
                t += stt
            out["fill"][go] = round(o / t, 4) if t else None
            out["detail"][go] = {"occ": o, "total": t}
    else:
        out["mode"] = "night"
        res = counter.analyze_pair(real01_path, real02_path)
        c1 = res.get("real01", {}).get("counts", {})
        c2 = res.get("real02", {}).get("counts", {})
        cap = counter.max_counts
        for go, stalls in GO_STALLS.items():
            cnt = sum((c1.get(st, 0) if STALL_CAM[st] == "real01" else c2.get(st, 0)) for st in stalls)
            capg = sum(cap.get(st, 0) for st in stalls)
            out["fill"][go] = round(min(1.0, cnt / capg), 4) if capg else None
            out["detail"][go] = {"count": cnt, "capacity": capg}
    return out
