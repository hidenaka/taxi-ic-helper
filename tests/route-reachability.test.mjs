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
