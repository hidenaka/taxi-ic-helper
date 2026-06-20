"""学習版 占有判定 — 全乗り場(stall1-4 + stall4_back)・2カメラ対応。numpy+PILのみ・自己完結。

各スロット中心の 23x23 パッチから 19 特徴(輝度統計/勾配/エッジ密度/色/平坦度/簡易HOG)を取り、
標準化 + ロジスティック回帰で「車あり/なし」を確率判定。号別占有 = 占有スロット数。

カメラ別重み:
  real01_line: stall1(16,最奥) / stall2(14) / stall3(16,中距離) / stall4(4,近景)
  real02     : stall4_back(8,別視点) ← 第4乗り場の奥
第4乗り場(4号)占有 = stall4(real01) + stall4_back(real02) を合算
  (pool-status.mjs STALL_KEYS.stall4 = ['stall4','stall4_back'] と一致)。

モデル JSON スキーマ(新): {"real01": {w,b,mu,sd,thr,dim}, "real02": {...}, "_meta": {...}}
旧スキーマ({w,b,mu,sd,thr,dim} のトップレベル)も load_model でそのまま読め、
infer() は後方互換で stall1/2 を返す(既存 texture-occupancy-tick.py を壊さない)。

検証(2026-06-20, ホールドアウト=2026-06-19): 号別ホールドアウト acc は build_report.txt 参照。
暗所(region brightness < DARK_GATE)は学習未検証域。呼び出し側で fill へ退避すること。
"""
import json
import numpy as np

PATCH = 11  # 半径 → 23x23

# stall → camera（4号は real01 の stall4 と real02 の stall4_back 両方）
STALL_CAM = {
    "stall1": "real01", "stall2": "real01", "stall3": "real01", "stall4": "real01",
    "stall4_back": "real02",
}
# 第N乗り場 → 構成 stall（4号のみ2カメラ合算）
NORIBA_STALLS = {1: ["stall1"], 2: ["stall2"], 3: ["stall3"], 4: ["stall4", "stall4_back"]}


def _feats(patch):
    a = np.asarray(patch, dtype=np.float32)
    if a.shape[0] < 3 or a.shape[1] < 3:
        return None
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    g = (0.299 * R + 0.587 * G + 0.114 * B) / 255.0
    gx = np.abs(np.diff(g, axis=1)); gy = np.abs(np.diff(g, axis=0))
    edge = float((np.sqrt(gx[:-1, :] ** 2 + gy[:, :-1] ** 2) > 0.06).mean())
    f = [g.mean(), g.std(), g.min(), g.max(), np.percentile(g, 25), np.percentile(g, 75),
         gx.mean(), gy.mean(), edge, (R - B).mean() / 255., (R - G).mean() / 255., (G - B).mean() / 255.,
         R.std() / 255., B.std() / 255., np.abs(g - g.mean()).mean()]
    ang = np.arctan2(gy[:, :-1], gx[:-1, :] + 1e-6); mag = np.sqrt(gx[:-1, :] ** 2 + gy[:, :-1] ** 2)
    bins = np.zeros(4)
    for bi in range(4):
        lo = -np.pi / 2 + bi * np.pi / 4
        m = (ang >= lo) & (ang < lo + np.pi / 4); bins[bi] = mag[m].sum()
    f += list(bins / (bins.sum() + 1e-6))
    return np.array(f, dtype=np.float32)


def _patch_at(arr, cx, cy, W, H):
    x0 = int(round(cx)) - PATCH; y0 = int(round(cy)) - PATCH
    x1 = x0 + 2 * PATCH + 1; y1 = y0 + 2 * PATCH + 1
    x0 = max(0, x0); y0 = max(0, y0); x1 = min(W, x1); y1 = min(H, y1)
    return arr[y0:y1, x0:x1, :]


def _arrify(sub):
    sub = dict(sub)
    for k in ("w", "mu", "sd"):
        sub[k] = np.asarray(sub[k], dtype=np.float64)
    sub["b"] = float(sub["b"]); sub.setdefault("thr", 0.5)
    return sub


def load_model(path):
    """新スキーマ(カメラ別)も旧スキーマ(トップレベル単一)も読む。
    返り値: {"real01": submodel, "real02": submodel?, "_legacy": bool}
    旧スキーマは {"real01": <旧>, "_legacy": True} に正規化(stall1-4 全部 real01 重みを使う)。"""
    M = json.load(open(path))
    if "w" in M:  # 旧スキーマ(単一モデル)
        return {"real01": _arrify(M), "_legacy": True}
    out = {"_legacy": False}
    for cam in ("real01", "real02"):
        if cam in M:
            out[cam] = _arrify(M[cam])
    out["_meta"] = M.get("_meta", {})
    return out


def _prob(arr, p, W, H, sub):
    fv = _feats(_patch_at(arr, p["cx"] * W, p["cy"] * H, W, H))
    if fv is None:
        return 0.0
    z = ((fv - sub["mu"]) / sub["sd"]) @ sub["w"] + sub["b"]
    return float(1.0 / (1.0 + np.exp(-z)))


def _infer_stall_on(arr, W, H, name, slots_json, sub, corr=None):
    cnt = 0; per = {}
    # corr(model["centers"][name]) があれば補正中心を優先(枠ズレ修正)。無ければ stall-slots.json。
    if corr:
        slots = [{"cx": c[0], "cy": c[1], "id": name + "-c" + str(i)} for i, c in enumerate(corr)]
    else:
        slots = slots_json["stalls"][name]["slots"]
    for p in slots:
        prob = _prob(arr, p, W, H, sub)
        occ = int(prob > sub["thr"])
        per[p["id"]] = {"p": round(prob, 4), "occ": occ}
        cnt += occ
    return cnt, per


def infer(pil_image, model, slots_json, stalls=("stall1", "stall2")):
    """後方互換: 単一 real01 画像で指定 stall の占有を返す。
    {stallname:int, ..., per_slot:{id:{p,occ}}}。model は load_model の返り値 or 旧 submodel。"""
    # 旧コードが load_model せず直接 dict を渡す場合に備える
    if "w" in model:
        model = {"real01": _arrify(model), "_legacy": True}
    sub = model["real01"]
    im = pil_image.convert("RGB"); W, H = im.size
    arr = np.asarray(im, dtype=np.uint8)
    out = {"per_slot": {}}
    for name in stalls:
        cam = STALL_CAM.get(name, "real01")
        s = model.get(cam, sub)
        c, per = _infer_stall_on(arr, W, H, name, slots_json, s, model.get("centers", {}).get(name))
        out[name] = c; out["per_slot"].update(per)
    return out


def infer_all(images_by_cam, model, slots_json, dark_gate=55.0):
    """全号(1-4)の占有を返す。
    images_by_cam: {"real01_line": PIL or None, "real02": PIL or None}
       (キーは 'real01_line'/'real02' でも 'real01'/'real02' でも可)
    返り値:
      {"stalls": {stall1..stall4_back: {"occ":int,"n":int,"dark":bool,"per_slot":{...}}},
       "noriba": {1:int,2:int,3:int,4:int},  # 第N乗り場占有(4号=stall4+stall4_back)
       "noriba_dark": {N:bool}}              # その号の構成カメラが暗所=信頼不可
    暗所カメラの stall は occ=0,dark=True を返す(呼び出し側で fill 退避判断に使う)。"""
    def getim(cam):
        for k in (cam, cam.replace("_line", ""), cam + "_line"):
            if k in images_by_cam and images_by_cam[k] is not None:
                return images_by_cam[k]
        return None
    cams = {}
    for cam, key in (("real01", "real01_line"), ("real02", "real02")):
        im = getim(key)
        if im is None:
            cams[cam] = None; continue
        im = im.convert("RGB"); arr = np.asarray(im, dtype=np.uint8)
        g = np.asarray(im.convert("L"), dtype=np.float32)
        cams[cam] = (arr, im.size, float(g.mean()))

    stalls_out = {}
    for name, cam in STALL_CAM.items():
        c = cams.get(cam)
        sub = model.get(cam) or model.get("real01")
        if c is None or sub is None:
            stalls_out[name] = {"occ": 0, "n": len(slots_json["stalls"][name]["slots"]),
                                "dark": False, "missing": True, "per_slot": {}}
            continue
        arr, (W, H), brightness = c
        dark = brightness < dark_gate
        if dark:
            stalls_out[name] = {"occ": 0, "n": len(slots_json["stalls"][name]["slots"]),
                                "dark": True, "per_slot": {}}
        else:
            cnt, per = _infer_stall_on(arr, W, H, name, slots_json, sub, model.get("centers", {}).get(name))
            stalls_out[name] = {"occ": cnt, "n": len(per), "dark": False, "per_slot": per}

    noriba = {}; noriba_dark = {}
    for N, members in NORIBA_STALLS.items():
        total = 0; anydark = False; anymissing = False
        for m in members:
            s = stalls_out[m]
            total += s["occ"]
            anydark = anydark or s.get("dark", False)
            anymissing = anymissing or s.get("missing", False)
        noriba[N] = total
        noriba_dark[N] = anydark or anymissing
    return {"stalls": stalls_out, "noriba": noriba, "noriba_dark": noriba_dark}
