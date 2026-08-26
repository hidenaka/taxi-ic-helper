#!/usr/bin/env python3
# 旧カメラ期(94日)の列移動を「前後の変化」方式で数え直す。
# 既存の advance-count-history.jsonl は壊さず、別ファイルに書く。
# 日ごとに追記し、既に済んだ日は飛ばす(途中で止めても再開できる)。
import glob, json, os, sys, time
import numpy as np
from PIL import Image

EXT="/Volumes/ADATA HV620/taxi-image-archive"; CAM="real01_line"
OUT="data/advance-count-rebuilt.jsonl"
DONE="data/.rebuild-done"
old=json.load(open("/tmp/slots-old.json")); TWO_LINE={"stall1","stall2","stall3"}
STALLS=["stall1","stall2","stall3","stall4"]
THR=30.0; DEBOUNCE=300; GAP=300; SZ=(96,48); REF_LUM=100.0
# 明るさで正規化する。暗いと変化量そのものが小さくなり、夜が丸ごと落ちるため
# (2026-07-15の夜は検出0%だった)。画面の明るさで割って昼夜のものさしを揃える。

def front_box(stall):
    slots=old["stalls"][stall]["slots"]; ss=sorted(slots,key=lambda s:s["cy"])
    if stall in TWO_LINE:
        mid=sum(s["cx"] for s in slots)/len(slots)
        pick=[s for s in ss if s["cx"]<mid][:2]+[s for s in ss if s["cx"]>=mid][:2]
    else: pick=ss[:3]
    xs=[s["cx"] for s in pick]; ys=[s["cy"] for s in pick]; rr=max(s.get("r",0.02) for s in pick)
    return (min(xs)-rr,max(xs)+rr,min(ys)-rr,max(ys)+rr)
BOX={s:front_box(s) for s in STALLS}

def process(day):
    fs=sorted(glob.glob(f"{EXT}/{CAM}/{day}/*.jpg"))
    if len(fs)<100: return None
    rows=[]
    for f in fs:
        nm=os.path.basename(f)[:6]
        if not nm.isdigit(): continue
        try: im=Image.open(f).convert("L")
        except Exception: continue
        W,H=im.size
        rec={"t":int(nm[:2])*3600+int(nm[2:4])*60+int(nm[4:6])}
        for s in STALLS:
            x0,x1,y0,y1=BOX[s]
            c=im.crop((max(0,int(x0*W)),max(0,int(y0*H)),min(W,int(x1*W)),min(H,int(y1*H))))
            rec[s]=np.asarray(c.resize(SZ),dtype=np.float32) if c.size[0]>5 and c.size[1]>5 else None
        small=np.asarray(im.resize((128,64)),dtype=np.float32)
        rec["full"]=small; rec["lum"]=float(small.mean())
        rows.append(rec)
    if len(rows)<50: return None
    ts=[r["t"] for r in rows]
    events={s:[] for s in STALLS}; last={s:-10**9 for s in STALLS}
    j=0
    for i in range(len(rows)):
        while j+1<len(rows) and ts[j+1]<=ts[i]-GAP: j+=1
        d=ts[i]-ts[j]
        if d<GAP*0.7 or d>GAP*2.5: continue
        a=rows[j]; r=rows[i]
        common=float(np.abs(r["full"]-a["full"]).mean())
        scale=REF_LUM/max(r["lum"],8.0)
        for s in STALLS:
            if r[s] is None or a[s] is None: continue
            val=max(0.0,float(np.abs(r[s]-a[s]).mean())-common)*scale
            if val>=THR and ts[i]-last[s]>=DEBOUNCE:
                events[s].append(ts[i]); last[s]=ts[i]
    # 15分ビンへ
    bins={}
    for s in STALLS:
        for t in events[s]:
            b=(t//900)*900
            key=f"{day}T{b//3600:02d}:{(b%3600)//60:02d}:00+09:00"
            bins.setdefault(key,{})
            bins[key][s]=bins[key].get(s,0)+1
    return bins, {s:len(events[s]) for s in STALLS}, len(rows)

done=set()
if os.path.exists(DONE): done=set(open(DONE).read().split())
days=sorted(os.path.basename(d) for d in glob.glob(f"{EXT}/{CAM}/2026-*"))
todo=[d for d in days if d not in done]
print(f"対象 {len(days)}日 / 未処理 {len(todo)}日", flush=True)
for k,day in enumerate(todo):
    t0=time.time()
    try: res=process(day)
    except Exception as e:
        print(f"  {day} 失敗: {e}", flush=True); continue
    if res is None:
        print(f"  {day} 画像不足でスキップ", flush=True)
        open(DONE,"a").write(day+"\n"); continue
    bins,tot,nframes=res
    with open(OUT,"a") as f:
        for key in sorted(bins):
            f.write(json.dumps({"ts":key,"stalls":bins[key],"method":"frame-diff-v2-lumnorm"},ensure_ascii=False)+"\n")
    open(DONE,"a").write(day+"\n")
    print(f"  [{k+1}/{len(todo)}] {day} 枚数{nframes} → "
          f"1号{tot['stall1']} 2号{tot['stall2']} 3号{tot['stall3']} 4号{tot['stall4']} "
          f"({time.time()-t0:.0f}秒)", flush=True)
print("完了", flush=True)
