#!/bin/bash
set -e
MODEL_DIR="$(cd "$(dirname "$0")/../models" && pwd)"
mkdir -p "$MODEL_DIR"

# .pt → .onnx 変換は Python の ultralytics CLI で行う必要があるため、
# 既に変換済みの .onnx ファイルがある場合は URL を変えること
ONNX_URL="${YOLOV8N_ONNX_URL:-https://huggingface.co/Ultralytics/YOLOv8/resolve/main/yolov8n.onnx}"
echo "Downloading YOLOv8n ONNX from $ONNX_URL ..."
curl -fL --retry 3 -o "$MODEL_DIR/yolov8n.onnx" "$ONNX_URL"
SIZE=$(wc -c < "$MODEL_DIR/yolov8n.onnx")
if [ "$SIZE" -lt 1000000 ]; then
  echo "Error: downloaded file is only $SIZE bytes (expected ~12 MB). URL may be returning a non-model response."
  rm -f "$MODEL_DIR/yolov8n.onnx"
  exit 1
fi
echo "Downloaded $SIZE bytes to $MODEL_DIR/yolov8n.onnx"
