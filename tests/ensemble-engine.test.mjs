import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { leadBucketOf, computeWeights } from '../scripts/lib/ensemble-engine.mjs';

test('leadBucketOf: 45 分以下 → lead30、46-105 → lead60、106 以上 → lead120', () => {
  assert.equal(leadBucketOf(5), 'lead30');
  assert.equal(leadBucketOf(45), 'lead30');
  assert.equal(leadBucketOf(46), 'lead60');
  assert.equal(leadBucketOf(105), 'lead60');
  assert.equal(leadBucketOf(106), 'lead120');
  assert.equal(leadBucketOf(120), 'lead120');
});

test('computeWeights: accuracy=null → 全 lead 50:50 fallback', () => {
  const w = computeWeights(null);
  for (const k of ['lead30', 'lead60', 'lead120']) {
    assert.equal(w[k].w_fc, 0.5);
    assert.equal(w[k].w_pm, 0.5);
    assert.equal(w[k].source, 'fallback');
  }
});

test('computeWeights: mae が片方 null → そのバケット fallback', () => {
  const accuracy = {
    recent24h: {
      forecast: { lead30: { mae_total: null, n: 50 }, lead60: { mae_total: 2, n: 50 }, lead120: { mae_total: 3, n: 50 } },
      patternMatch: { lead30: { mae_total: 2, n: 50 }, lead60: { mae_total: 2, n: 50 }, lead120: { mae_total: 3, n: 50 } },
    },
  };
  const w = computeWeights(accuracy);
  assert.equal(w.lead30.source, 'fallback');
  assert.equal(w.lead60.source, 'mae');
});

test('computeWeights: n < MIN_SAMPLE (20) → fallback', () => {
  const accuracy = {
    recent24h: {
      forecast: { lead30: { mae_total: 1, n: 10 }, lead60: { mae_total: 2, n: 50 }, lead120: { mae_total: 3, n: 50 } },
      patternMatch: { lead30: { mae_total: 2, n: 50 }, lead60: { mae_total: 2, n: 50 }, lead120: { mae_total: 3, n: 50 } },
    },
  };
  const w = computeWeights(accuracy);
  assert.equal(w.lead30.source, 'fallback');
});

test('computeWeights: 正常な MAE → 逆数加重 (MAE 小さい方の重みが大)', () => {
  const accuracy = {
    recent24h: {
      forecast:     { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 2, n: 50 }, lead120: { mae_total: 3, n: 50 } },
      patternMatch: { lead30: { mae_total: 3, n: 50 }, lead60: { mae_total: 2, n: 50 }, lead120: { mae_total: 1, n: 50 } },
    },
  };
  const w = computeWeights(accuracy);
  assert.ok(w.lead30.w_fc > w.lead30.w_pm);
  assert.ok(w.lead120.w_pm > w.lead120.w_fc);
  assert.ok(Math.abs(w.lead30.w_fc + w.lead30.w_pm - 1) < 1e-9);
  assert.equal(w.lead30.source, 'mae');
});
