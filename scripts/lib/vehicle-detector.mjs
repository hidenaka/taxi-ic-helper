import * as ort from 'onnxruntime-node';
import { Jimp } from 'jimp';

const INPUT_SIZE = 640;
const COCO_CAR_CLASS = 2;
const COCO_TRUCK_CLASS = 7;
const TARGET_CLASSES = { 2: 'car', 7: 'truck' };

export async function loadModel(modelPath) {
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu']
  });
  return session;
}

// 画像を 640x640 にリサイズ + パディング (letterbox)
async function preprocess(buffer) {
  const img = await Jimp.read(buffer);
  const { width, height } = img.bitmap;
  const scale = Math.min(INPUT_SIZE / width, INPUT_SIZE / height);
  const newW = Math.round(width * scale);
  const newH = Math.round(height * scale);
  img.resize({ w: newW, h: newH });

  const canvas = new Jimp({ width: INPUT_SIZE, height: INPUT_SIZE, color: 0x727272ff });
  const padX = Math.floor((INPUT_SIZE - newW) / 2);
  const padY = Math.floor((INPUT_SIZE - newH) / 2);
  canvas.composite(img, padX, padY);

  const data = canvas.bitmap.data;
  const float32 = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  for (let y = 0; y < INPUT_SIZE; y++) {
    for (let x = 0; x < INPUT_SIZE; x++) {
      const srcIdx = (y * INPUT_SIZE + x) * 4;
      const r = data[srcIdx] / 255;
      const g = data[srcIdx + 1] / 255;
      const b = data[srcIdx + 2] / 255;
      float32[0 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = r;
      float32[1 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = g;
      float32[2 * INPUT_SIZE * INPUT_SIZE + y * INPUT_SIZE + x] = b;
    }
  }
  return { tensor: float32, origWidth: width, origHeight: height, scale, padX, padY };
}

function nms(boxes, iouThreshold = 0.5) {
  const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  while (sorted.length > 0) {
    const top = sorted.shift();
    kept.push(top);
    for (let i = sorted.length - 1; i >= 0; i--) {
      const [ax, ay, aw, ah] = top.bbox;
      const [bx, by, bw, bh] = sorted[i].bbox;
      const x1 = Math.max(ax, bx);
      const y1 = Math.max(ay, by);
      const x2 = Math.min(ax + aw, bx + bw);
      const y2 = Math.min(ay + ah, by + bh);
      if (x2 > x1 && y2 > y1) {
        const inter = (x2 - x1) * (y2 - y1);
        const u = aw * ah + bw * bh - inter;
        if (inter / u >= iouThreshold) sorted.splice(i, 1);
      }
    }
  }
  return kept;
}

export async function detectVehicles(buffer, model, opts = {}) {
  const confidenceThreshold = opts.confidenceThreshold ?? 0.4;
  const { tensor, origWidth, origHeight, scale, padX, padY } = await preprocess(buffer);
  const inputTensor = new ort.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const inputName = model.inputNames[0];
  const outputs = await model.run({ [inputName]: inputTensor });
  const outputName = model.outputNames[0];
  const output = outputs[outputName]; // shape [1, 84, 8400]
  const data = output.data;
  const numAnchors = 8400;

  const candidates = [];
  for (let i = 0; i < numAnchors; i++) {
    const cx = data[0 * numAnchors + i];
    const cy = data[1 * numAnchors + i];
    const w = data[2 * numAnchors + i];
    const h = data[3 * numAnchors + i];
    for (const classId of [COCO_CAR_CLASS, COCO_TRUCK_CLASS]) {
      const conf = data[(4 + classId) * numAnchors + i];
      if (conf < confidenceThreshold) continue;
      const x = (cx - w / 2 - padX) / scale;
      const y = (cy - h / 2 - padY) / scale;
      const bw = w / scale;
      const bh = h / scale;
      if (x < 0 || y < 0 || x + bw > origWidth || y + bh > origHeight) continue;
      candidates.push({
        bbox: [Math.round(x), Math.round(y), Math.round(bw), Math.round(bh)],
        confidence: conf,
        class: TARGET_CLASSES[classId]
      });
    }
  }

  return nms(candidates, 0.5);
}
