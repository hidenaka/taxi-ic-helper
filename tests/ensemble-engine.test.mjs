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

// --- computeEnsemble ---

import { computeEnsemble, ENSEMBLE_SCHEMA_VERSION } from '../scripts/lib/ensemble-engine.mjs';

function makeForecast(slotStalls) {
  return {
    slots: slotStalls.map((v, i) => ({
      slotStart: `${String(17 + Math.floor((i + 1) / 12)).padStart(2, '0')}:${String(((i + 1) % 12) * 5).padStart(2, '0')}`,
      stall1: v[0], stall2: v[1], stall3: v[2], stall4: v[3],
      total: v[0] + v[1] + v[2] + v[3],
    })),
  };
}
function makePatternMatch(slotStalls) {
  return {
    historicalCurve: slotStalls.map((v, i) => ({
      slotStart: `${String(17 + Math.floor((i + 1) / 12)).padStart(2, '0')}:${String(((i + 1) % 12) * 5).padStart(2, '0')}`,
      stall1: v[0], stall2: v[1], stall3: v[2], stall4: v[3],
      total: v[0] + v[1] + v[2] + v[3],
    })),
  };
}

test('computeEnsemble: forecast 空 → slots 空配列', () => {
  const r = computeEnsemble({ slots: [] }, { historicalCurve: [] }, null, new Date('2026-06-01T17:00:00+09:00'));
  assert.equal(r.schemaVersion, ENSEMBLE_SCHEMA_VERSION);
  assert.deepEqual(r.slots, []);
});

test('computeEnsemble: pattern-match 空 → 各 slot forecast 100%', () => {
  const fc = makeForecast([[2, 0, 4, 1]]);
  const r = computeEnsemble(fc, { historicalCurve: [] }, null, new Date('2026-06-01T17:00:00+09:00'));
  assert.equal(r.slots[0].stall1, 2);
  assert.equal(r.slots[0].stall3, 4);
  assert.equal(r.slots[0].total, 7);
});

test('computeEnsemble: 正常入力 (pm 非0) → 重み付き平均 + leadBucket 付与', () => {
  // pm total>0 のスロットは従来どおり加重平均。
  const fc = makeForecast([[4, 0, 0, 0]]);
  const pm = makePatternMatch([[2, 0, 0, 0]]); // total=2 で非0
  const accuracy = {
    recent24h: {
      forecast:     { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
      patternMatch: { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
    },
  };
  const r = computeEnsemble(fc, pm, accuracy, new Date('2026-06-01T17:00:00+09:00'));
  assert.equal(r.slots[0].stall1, 3); // 4*0.5 + 2*0.5
  assert.equal(r.slots[0].leadBucket, 'lead30');
  assert.equal(r.weights.lead30.source, 'mae');
});

test('computeEnsemble: 加重平均の小数値を丸めず保持する (早すぎる四捨五入バグ回帰)', () => {
  // forecast stall1 = 3、pattern-match stall1 = 2 (total=2 で非0)、mae 同値 → 重み w_fc=w_pm=0.5。
  // 加重平均 = 3*0.5 + 2*0.5 = 2.5。Math.round(2.5)=3 で潰してはいけない。
  // なお pm total=0 の場合は希釈ガードにより forecast 100% になるため、このテストは pm 非0で行う。
  const fc = makeForecast([[3, 0, 0, 0]]);
  const pm = makePatternMatch([[2, 0, 0, 0]]); // total=2 で非0
  const accuracy = {
    recent24h: {
      forecast:     { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
      patternMatch: { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
    },
  };
  const r = computeEnsemble(fc, pm, accuracy, new Date('2026-06-01T17:00:00+09:00'));
  assert.equal(r.slots[0].stall1, 2.5);
  assert.equal(r.slots[0].total, 2.5);
});

test('computeEnsemble: pattern-match slot が構造的0 → forecast 100% (希釈ガード)', () => {
  // forecast=4, pattern-match=0。希釈ガードが無ければ 4*0.5+0*0.5=2 だが、
  // pm 側 total=0 は「構造的に利用不可」とみなし forecast 100% → 4。
  const fc = makeForecast([[4, 0, 0, 0]]);
  const pm = makePatternMatch([[0, 0, 0, 0]]);
  const accuracy = {
    recent24h: {
      forecast:     { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
      patternMatch: { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
    },
  };
  const r = computeEnsemble(fc, pm, accuracy, new Date('2026-06-01T17:00:00+09:00'));
  assert.equal(r.slots[0].stall1, 4);
  assert.equal(r.slots[0].total, 4);
});

test('computeEnsemble: pattern-match slot が非0 → 従来どおり加重平均', () => {
  const fc = makeForecast([[4, 0, 0, 0]]);
  const pm = makePatternMatch([[2, 0, 0, 0]]); // total=2 で非0
  const accuracy = {
    recent24h: {
      forecast:     { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
      patternMatch: { lead30: { mae_total: 1, n: 50 }, lead60: { mae_total: 1, n: 50 }, lead120: { mae_total: 1, n: 50 } },
    },
  };
  const r = computeEnsemble(fc, pm, accuracy, new Date('2026-06-01T17:00:00+09:00'));
  assert.equal(r.slots[0].stall1, 3); // 4*0.5 + 2*0.5
});
