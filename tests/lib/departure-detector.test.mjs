import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectDepartures } from '../../scripts/lib/departure-detector.mjs';

// 新設計: lost 側に lane/front_row が事前付与されていることを前提とする。
// observe-taxi-pool.mjs の runYoloPipeline で assignLane を呼んで lost に lane を付ける。

test('detectDepartures: lost の front_row=true → 出庫', () => {
  const lost = [
    { id: 100, lane: '第一-一般', front_row: true },
    { id: 101, lane: '第二-一般', front_row: false }
  ];
  const ts = '2026-05-12T15:30:00+09:00';
  const events = detectDepartures([], [], lost, ts);
  assert.equal(events.length, 1);
  assert.equal(events[0].lane, '第一-一般');
  assert.equal(events[0].vehicle_id, 100);
  assert.equal(events[0].ts, ts);
});

test('detectDepartures: front_row=false の lost は無視', () => {
  const lost = [{ id: 100, lane: '第二-一般', front_row: false }];
  const events = detectDepartures([], [], lost, '2026-05-12T15:30:00+09:00');
  assert.equal(events.length, 0);
});

test('detectDepartures: lane=null の lost は無視', () => {
  const lost = [{ id: 100, lane: null, front_row: true }];
  const events = detectDepartures([], [], lost, '2026-05-12T15:30:00+09:00');
  assert.equal(events.length, 0);
});

test('detectDepartures: 複数同時出庫', () => {
  const lost = [
    { id: 100, lane: '第一-一般', front_row: true },
    { id: 200, lane: '第三-一般', front_row: true }
  ];
  const events = detectDepartures([], [], lost, '2026-05-12T15:30:00+09:00');
  assert.equal(events.length, 2);
});

test('detectDepartures: lost が空なら出庫なし', () => {
  const events = detectDepartures([], [], [], '2026-05-12T15:30:00+09:00');
  assert.equal(events.length, 0);
});
