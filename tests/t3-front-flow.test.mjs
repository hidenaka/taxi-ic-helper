import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  parseT3FrontFlowRois, gateToBox,
} from '../scripts/lib/t3-front-flow.mjs';

// ---- parseT3FrontFlowRois ----

const VALID_ROIS = {
  schema_version: 1,
  camera: 'Real108',
  gate: { x: 0.25, y: 0.42, width: 0.5, height: 0.2 },
  params: { nightLum: 60, lanternK: 4, lanternT: 50 },
};

test('parseT3FrontFlowRois: 正常系で camera/gate/params を返す', () => {
  const r = parseT3FrontFlowRois(VALID_ROIS);
  assert.equal(r.camera, 'Real108');
  assert.deepEqual(r.gate, { x: 0.25, y: 0.42, width: 0.5, height: 0.2 });
  assert.equal(r.params.nightLum, 60);
});

test('parseT3FrontFlowRois: schema_version 不一致は throw', () => {
  assert.throws(() => parseT3FrontFlowRois({ ...VALID_ROIS, schema_version: 2 }), /schema_version/);
});

test('parseT3FrontFlowRois: gate 欠損は throw', () => {
  const { gate, ...rest } = VALID_ROIS;
  assert.throws(() => parseT3FrontFlowRois(rest), /gate/);
});

test('parseT3FrontFlowRois: params 省略時はデフォルト(nightLum60/lanternK4/lanternT50)', () => {
  const { params, ...rest } = VALID_ROIS;
  const r = parseT3FrontFlowRois(rest);
  assert.deepEqual(r.params, { nightLum: 60, lanternK: 4, lanternT: 50 });
});

test('parseT3FrontFlowRois: 未校正(width/height が 0)は calibrated=false', () => {
  const r = parseT3FrontFlowRois({ ...VALID_ROIS, gate: { x: 0, y: 0, width: 0, height: 0 } });
  assert.equal(r.calibrated, false);
});

test('parseT3FrontFlowRois: 校正済みは calibrated=true', () => {
  assert.equal(parseT3FrontFlowRois(VALID_ROIS).calibrated, true);
});

// ---- gateToBox ----

test('gateToBox: {x,y,width,height} → {x0,x1,y0,y1}', () => {
  assert.deepEqual(
    gateToBox({ x: 0.25, y: 0.42, width: 0.5, height: 0.2 }),
    { x0: 0.25, x1: 0.75, y0: 0.42, y1: 0.62 }
  );
});

test('gateToBox: 1.0 を超える端は 1.0 にクランプ', () => {
  const b = gateToBox({ x: 0.8, y: 0.9, width: 0.5, height: 0.5 });
  assert.equal(b.x1, 1.0);
  assert.equal(b.y1, 1.0);
});
