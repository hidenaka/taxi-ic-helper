# YOLOv8n ONNX モデル

このディレクトリには `yolov8n.onnx` (約 12MB) を配置する。
git には commit せず、初回セットアップ時に以下を実行:

```bash
./scripts/download-yolo-model.sh
```

モデル取得元: https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.pt
.pt → .onnx 変換は ultralytics CLI で実行 (`yolo export model=yolov8n.pt format=onnx`)。
本リポジトリの README には変換済み .onnx の DLリンクを記載する。
