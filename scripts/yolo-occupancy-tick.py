#!/usr/bin/env python3
# yolo-occupancy-tick — 最奥 stall1/2 の占有を YOLO クロップ検出で計測し
# data/yolo-occupancy-history.jsonl に追記する(シャドウ記録)。
# fill(背景差分)は遠景マスクが極小で満車/空を分離できないため、車を直接検出する YOLO を使う。
# publish-pool-status が昼の stall1/2 occ にこの値の median を採用する(Phase B)。
import sys, os, json
from datetime import datetime, timezone, timedelta
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
import onnxruntime as ort
import detect_vehicles as dv

REPO = os.path.dirname(SCRIPT_DIR)
OUT = os.path.join(REPO, "data", "yolo-occupancy-history.jsonl")
LIB = os.path.join(SCRIPT_DIR, "lib")
JST = timezone(timedelta(hours=9))

def main():
    if not os.path.exists(dv.MODEL_PATH):
        print("ERROR: model not found", file=sys.stderr); return 1
    try:
        img = dv.fetch_image("Real01_line")
    except Exception as e:
        print(f"[yolo-occ] fetch failed: {e}", file=sys.stderr); return 0
    session = ort.InferenceSession(dv.MODEL_PATH, providers=["CPUExecutionProvider"])
    counts = dv.crop_count_stalls(session, {"real01_line": img}, LIB)
    row = {"ts": datetime.now(JST).isoformat(timespec="seconds"),
           "stall1": int(counts.get("stall1", 0)),
           "stall2": int(counts.get("stall2", 0))}
    with open(OUT, "a") as f:
        f.write(json.dumps(row) + "\n")
    print(f"[yolo-occ] {row}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
