"""学習版 占有判定(最奥 stall1/stall2) — numpy+PILのみ・自己完結。
ルール方式(std/差分)が落ちた難所に勝つことを実画像で検証済み:
  雨で最奥フル(2026-06-19 13:15)→16/16, 明るい昼の空→空, 同一画像で完全再現(状態非依存)。
仕組み: 各スロット中心の23x23パッチから19特徴(輝度統計/勾配/エッジ密度/色/平坦度/簡易HOG)を取り、
標準化+ロジスティック回帰で「車あり/なし」を確率判定。号別占有=占有スロット数。重みは occupancy_model.json。
"""
import json
import numpy as np

PATCH = 11  # 半径 → 23x23

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

def load_model(path):
    M = json.load(open(path))
    for k in ("w", "mu", "sd"):
        M[k] = np.asarray(M[k], dtype=np.float64)
    M["b"] = float(M["b"]); M.setdefault("thr", 0.5)
    return M

def infer(pil_image, model, slots_json, stalls=("stall1", "stall2")):
    """号別占有(占有スロット数)を返す。{stall1:int, stall2:int, per_slot:{id:{p,occ}}}"""
    im = pil_image.convert("RGB"); W, H = im.size
    arr = np.asarray(im, dtype=np.uint8)
    out = {"per_slot": {}}
    corr = model.get("centers", {})  # 補正中心(枠ズレ修正)。あればstall-slots.jsonより優先
    for name in stalls:
        cnt = 0
        if name in corr:
            positions = [(c[0], c[1], name + "-c" + str(i)) for i, c in enumerate(corr[name])]
        else:
            positions = [(p["cx"], p["cy"], p["id"]) for p in slots_json["stalls"][name]["slots"]]
        for cx, cy, sid in positions:
            fv = _feats(_patch_at(arr, cx * W, cy * H, W, H))
            prob = 0.0 if fv is None else 1.0 / (1.0 + np.exp(-(((fv - model["mu"]) / model["sd"]) @ model["w"] + model["b"])))
            occ = int(prob > model["thr"])
            out["per_slot"][sid] = {"p": round(float(prob), 4), "occ": occ}
            cnt += occ
        out[name] = cnt
    return out
