#!/bin/bash
set -e
MODEL_DIR="$(cd "$(dirname "$0")/../models" && pwd)"
mkdir -p "$MODEL_DIR"

# yolov8m.onnx (~103MB) はAndreyGermanov/yolov8_onnx_nodejs リポジトリから取得。
# 公式 Ultralytics は .pt のみ配布で .onnx は提供していないため、第三者ホストを利用。
# 1MB以上であれば本物の .onnx と判定。
YOLO_ONNX_URL="${YOLO_ONNX_URL:-https://github.com/AndreyGermanov/yolov8_onnx_nodejs/raw/main/yolov8m.onnx}"
echo "Downloading YOLOv8m ONNX from $YOLO_ONNX_URL ..."
curl -fL --retry 3 -o "$MODEL_DIR/yolov8m.onnx" "$YOLO_ONNX_URL"
SIZE=$(wc -c < "$MODEL_DIR/yolov8m.onnx")
if [ "$SIZE" -lt 1000000 ]; then
  echo "Error: downloaded file is only $SIZE bytes (expected ~103 MB). URL may be returning a non-model response."
  rm -f "$MODEL_DIR/yolov8m.onnx"
  exit 1
fi
echo "Downloaded $SIZE bytes to $MODEL_DIR/yolov8m.onnx"
