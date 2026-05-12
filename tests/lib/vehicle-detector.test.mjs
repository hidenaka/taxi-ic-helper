import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectVehicles, loadModel } from '../../scripts/lib/vehicle-detector.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '../fixtures/observation/sample-real01.jpg');
const MODEL = join(__dirname, '../../models/yolov8m.onnx');

const skipUnlessModelExists = existsSync(MODEL) ? false : true;

test('loadModel: ONNXモデルをロードできる', { skip: skipUnlessModelExists }, async () => {
  const model = await loadModel(MODEL);
  assert.ok(model);
});

test('detectVehicles: fixture画像から最低1台の車両を検出', { skip: skipUnlessModelExists || !existsSync(FIXTURE) }, async () => {
  const model = await loadModel(MODEL);
  const buf = readFileSync(FIXTURE);
  const detections = await detectVehicles(buf, model, { confidenceThreshold: 0.3 });
  assert.ok(Array.isArray(detections));
  assert.ok(detections.length >= 1, `Expected at least 1 vehicle, got ${detections.length}`);
  for (const d of detections) {
    assert.equal(d.bbox.length, 4);
    assert.ok(d.confidence >= 0.3);
    assert.ok(['car', 'truck'].includes(d.class));
  }
});

test('detectVehicles: confidenceで絞り込み', { skip: skipUnlessModelExists || !existsSync(FIXTURE) }, async () => {
  const model = await loadModel(MODEL);
  const buf = readFileSync(FIXTURE);
  const high = await detectVehicles(buf, model, { confidenceThreshold: 0.9 });
  const low = await detectVehicles(buf, model, { confidenceThreshold: 0.1 });
  assert.ok(low.length >= high.length);
});
