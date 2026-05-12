# YOLOv8m ONNX モデル

このディレクトリには `yolov8m.onnx` (約103MB) を配置する。
git には commit せず、初回セットアップ時に以下を実行:

```bash
./scripts/download-yolo-model.sh
```

## モデルについて

- **yolov8m (medium)** を使用。当初計画では nano 版を想定したが、Ultralytics 公式が
  `.onnx` を配布していないため、AndreyGermanov/yolov8_onnx_nodejs リポジトリの
  yolov8m 事前変換済みファイル (~103MB) を採用。
- yolov8m は yolov8n よりサイズ大（~12MB→~103MB）・精度高・推論時間長（~1-2秒/画像）。
  ローカル運用（launchd）前提のため許容範囲。

## モデル再変換が必要な場合（公式 nano 版が欲しい等）

Python 環境で:
```bash
pip install ultralytics
yolo export model=yolov8n.pt imgsz=640 format=onnx opset=12
```

生成された `yolov8n.onnx` を `models/` に配置し、`scripts/download-yolo-model.sh` の
`YOLO_ONNX_URL` を変えるか、環境変数で上書きしてダウンロード。
