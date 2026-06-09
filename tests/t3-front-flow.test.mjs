import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  parseT3FrontFlowRois, gateToBox, isSameFrame, toJstIso, buildFlowRow,
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

// ---- isSameFrame (dedup) ----

test('isSameFrame: Last-Modified が同じなら true', () => {
  const prev = { last_modified: 'Tue, 09 Jun 2026 17:18:11 GMT', frame_hash: 'aaa' };
  assert.equal(isSameFrame(prev, { lastModified: 'Tue, 09 Jun 2026 17:18:11 GMT', hash: 'bbb' }), true);
});

test('isSameFrame: Last-Modified が異なれば false (hash が同じでも)', () => {
  const prev = { last_modified: 'Tue, 09 Jun 2026 17:18:11 GMT', frame_hash: 'aaa' };
  assert.equal(isSameFrame(prev, { lastModified: 'Tue, 09 Jun 2026 17:20:17 GMT', hash: 'aaa' }), false);
});

test('isSameFrame: Last-Modified が両方無ければ hash で判定', () => {
  const prev = { last_modified: null, frame_hash: 'aaa' };
  assert.equal(isSameFrame(prev, { lastModified: null, hash: 'aaa' }), true);
  assert.equal(isSameFrame(prev, { lastModified: null, hash: 'bbb' }), false);
});

test('isSameFrame: prev が無い(初回)は false', () => {
  assert.equal(isSameFrame(null, { lastModified: 'x', hash: 'y' }), false);
  assert.equal(isSameFrame(undefined, { lastModified: 'x', hash: 'y' }), false);
});

test('isSameFrame: 片方だけ Last-Modified 無しは hash フォールバック', () => {
  const prev = { last_modified: 'Tue, 09 Jun 2026 17:18:11 GMT', frame_hash: 'aaa' };
  assert.equal(isSameFrame(prev, { lastModified: null, hash: 'aaa' }), true);
});

// ---- toJstIso ----

test('toJstIso: Date → JST ISO 文字列 (+09:00)', () => {
  // 2026-06-09T17:18:11Z = JST 2026-06-10T02:18:11+09:00
  const d = new Date('2026-06-09T17:18:11Z');
  assert.equal(toJstIso(d), '2026-06-10T02:18:11+09:00');
});

test('toJstIso: HTTP Last-Modified 形式の文字列も受ける', () => {
  assert.equal(toJstIso(new Date('Tue, 09 Jun 2026 17:18:11 GMT')), '2026-06-10T02:18:11+09:00');
});

// ---- buildFlowRow ----

test('buildFlowRow: schema_version 1 の履歴行を組み立てる', () => {
  const row = buildFlowRow({
    frameTs: '2026-06-10T02:18:11+09:00',
    tickTs: '2026-06-10T02:19:36+09:00',
    camera: 'Real108',
    isNight: false,
    frontDensity: 84.234,
    frameHash: 'af655cd',
  });
  assert.deepEqual(row, {
    schema_version: 1,
    frame_ts: '2026-06-10T02:18:11+09:00',
    tick_ts: '2026-06-10T02:19:36+09:00',
    camera: 'Real108',
    is_night: false,
    front_density: 84.23,
    frame_hash: 'af655cd',
  });
});

test('buildFlowRow: front_density は小数2桁に丸める', () => {
  const row = buildFlowRow({
    frameTs: 'a', tickTs: 'b', camera: 'Real108',
    isNight: true, frontDensity: 12.3456, frameHash: 'h',
  });
  assert.equal(row.front_density, 12.35);
});
