#!/bin/bash
set -e
MODEL_URL="https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.pt"
MODEL_DIR="$(cd "$(dirname "$0")/../models" && pwd)"
mkdir -p "$MODEL_DIR"

# .pt → .onnx 変換は Python の ultralytics CLI で行う必要があるため、
# 既に変換済みの .onnx ファイルがある場合は URL を変えること
ONNX_URL="${YOLOV8N_ONNX_URL:-https://huggingface.co/Ultralytics/YOLOv8/resolve/main/yolov8n.onnx}"
echo "Downloading YOLOv8n ONNX from $ONNX_URL ..."
curl -L -o "$MODEL_DIR/yolov8n.onnx" "$ONNX_URL"
echo "Downloaded $(ls -la "$MODEL_DIR/yolov8n.onnx" | awk '{print $5}') bytes to $MODEL_DIR/yolov8n.onnx"
