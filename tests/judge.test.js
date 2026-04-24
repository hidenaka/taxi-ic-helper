import { test } from 'node:test';
import assert from 'node:assert';
import { loadJson } from './helpers.js';
import { lookupDeduction } from '../js/judge.js';

test('lookupDeduction: 東名川崎 は 7.7km', () => {
  const deduction = loadJson('data/deduction.json');
  const entry = lookupDeduction(deduction, 'tomei_kawasaki');
  assert.strictEqual(entry?.km, 7.7);
  assert.strictEqual(entry?.direction, 'tomei');
});

test('lookupDeduction: 基準点自体（東京IC）は null', () => {
  const deduction = loadJson('data/deduction.json');
  const entry = lookupDeduction(deduction, 'tokyo_ic');
  assert.strictEqual(entry, null);
});

test('lookupDeduction: 存在しないICは null', () => {
  const deduction = loadJson('data/deduction.json');
  assert.strictEqual(lookupDeduction(deduction, 'no_such_ic'), null);
});
