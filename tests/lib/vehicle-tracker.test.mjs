import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { updateTracker, createEmptyState } from '../../scripts/lib/vehicle-tracker.mjs';

test('createEmptyState: 空のstateを返す', () => {
  const s = createEmptyState();
  assert.deepEqual(s.vehicles, {});
  assert.equal(s.nextId, 1);
  assert.equal(s.tick, 0);
});

test('updateTracker: 初回検出は全部新ID', () => {
  const state = createEmptyState();
  const bboxes = [[10, 10, 50, 50], [200, 200, 50, 50]];
  const { state: newState, tracked } = updateTracker(state, bboxes);
  assert.equal(tracked.length, 2);
  assert.equal(tracked[0].id, 1);
  assert.equal(tracked[1].id, 2);
  assert.equal(newState.nextId, 3);
  assert.equal(newState.tick, 1);
});

test('updateTracker: 同位置の車両は同一IDで継続', () => {
  let state = createEmptyState();
  ({ state } = updateTracker(state, [[10, 10, 50, 50]]));
  const { tracked } = updateTracker(state, [[12, 11, 49, 51]]); // 軽微なズレ
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].id, 1); // 同じID継続
  assert.equal(tracked[0].age, 2);
});

test('updateTracker: 大きく動いたbboxは新ID', () => {
  let state = createEmptyState();
  ({ state } = updateTracker(state, [[10, 10, 50, 50]]));
  const { state: state2, tracked } = updateTracker(state, [[500, 500, 50, 50]]);
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].id, 2); // 別の車両として扱われる
});

test('updateTracker: 消えた車両は lost で報告', () => {
  let state = createEmptyState();
  ({ state } = updateTracker(state, [[10, 10, 50, 50]]));
  // LOST_THRESHOLD (2) 超えるまで lost にならない
  ({ state } = updateTracker(state, []));
  ({ state } = updateTracker(state, []));
  const { lost } = updateTracker(state, []);
  assert.deepEqual(lost.map(v => v.id), [1]);
});

test('updateTracker: 1tick だけ消えても LOST_THRESHOLD 内なら維持', () => {
  let state = createEmptyState();
  ({ state } = updateTracker(state, [[10, 10, 50, 50]]));
  ({ state } = updateTracker(state, [])); // 1 tick 消失
  const { tracked } = updateTracker(state, [[12, 11, 49, 51]]); // 再出現
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].id, 1); // 同じIDで継続
});
