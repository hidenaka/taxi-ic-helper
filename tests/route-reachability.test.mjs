import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { computeLobbyExitTime } from '../scripts/lib/route-reachability.mjs';

const egress = {
  T1: { domestic: 15, international: 50 },
  T2: { domestic: 15, international: 50 },
  T3: { domestic: 15, international: 50 }
};

test('国内線 T1 15:30着 → 15:45ロビー出口', () => {
  assert.equal(computeLobbyExitTime('15:30', 'T1', false, egress), '15:45');
});

test('国際線 T3 21:30着 → 22:20ロビー出口', () => {
  assert.equal(computeLobbyExitTime('21:30', 'T3', true, egress), '22:20');
});

test('日跨ぎ国内線 T2 23:50着 → 翌00:05表記（24:05形式で表現）', () => {
  assert.equal(computeLobbyExitTime('23:50', 'T2', false, egress), '24:05');
});

test('estimatedTime null → null', () => {
  assert.equal(computeLobbyExitTime(null, 'T1', false, egress), null);
});

test('terminalがマスタにない → null', () => {
  assert.equal(computeLobbyExitTime('15:30', 'TX', false, egress), null);
});

import { computeReachRate } from '../scripts/lib/route-reachability.mjs';

const sampleRoutes = {
  routes: [
    { id: 'a', weekdayLastArrival: '00:30', holidayLastArrival: '00:30', weight: 0.40, via: ['京急'] },
    { id: 'b', weekdayLastArrival: '23:30', holidayLastArrival: '23:00', weight: 0.30, via: ['モノレール'] },
    { id: 'c', weekdayLastArrival: '21:30', holidayLastArrival: '21:30', weight: 0.30, via: ['リムジンバス'] }
  ]
};

const railOk = { Keikyu: { status: 'OnTime', delayMinutes: 0 }, TokyoMonorail: { status: 'OnTime', delayMinutes: 0 } };

test('全ルート到達可: reachRate = 1.0', () => {
  const r = computeReachRate('20:00', sampleRoutes, 'weekday', railOk);
  assert.equal(r.reachRate, 1.0);
  assert.equal(r.blockedRoutes.length, 0);
});

test('一部不可（c のみ22時超え）: weight比率で 0.7', () => {
  const r = computeReachRate('22:00', sampleRoutes, 'weekday', railOk);
  assert.ok(Math.abs(r.reachRate - 0.7) < 0.001);
  assert.equal(r.blockedRoutes.length, 1);
  assert.equal(r.blockedRoutes[0].id, 'c');
});

test('全不可（24:45）: reachRate = 0', () => {
  const r = computeReachRate('24:45', sampleRoutes, 'weekday', railOk);
  assert.equal(r.reachRate, 0);
});

test('京急運休: 京急経由ルート(a)を除外、reachRate=0.6', () => {
  const railNg = { Keikyu: { status: 'Suspended', delayMinutes: 0 }, TokyoMonorail: { status: 'OnTime', delayMinutes: 0 } };
  const r = computeReachRate('20:00', sampleRoutes, 'weekday', railNg);
  assert.ok(Math.abs(r.reachRate - 0.6) < 0.001);
  const ids = r.blockedRoutes.map(x => x.id);
  assert.ok(ids.includes('a'));
});

test('holiday指定で別の終電時刻を参照', () => {
  const r = computeReachRate('23:15', sampleRoutes, 'holiday', railOk);
  assert.ok(Math.abs(r.reachRate - 0.40) < 0.001);
});
