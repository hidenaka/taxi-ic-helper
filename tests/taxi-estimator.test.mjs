import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { estimateTaxiPax, pickBucket, pickBoost } from '../scripts/lib/taxi-estimator.mjs';

const transitShare = {
  buckets: [
    { id: 'early',     label: '7-9時',     fromHHMM: '07:00', toHHMM: '09:00', rates: { T1: 0.08, T2: 0.08, T3: 0.10 } },
    { id: 'morning',   label: '9-12時',    fromHHMM: '09:00', toHHMM: '12:00', rates: { T1: 0.11, T2: 0.11, T3: 0.12 } },
    { id: 'noon',      label: '12-15時',   fromHHMM: '12:00', toHHMM: '15:00', rates: { T1: 0.14, T2: 0.14, T3: 0.16 } },
    { id: 'afternoon', label: '15-17時',   fromHHMM: '15:00', toHHMM: '17:00', rates: { T1: 0.18, T2: 0.18, T3: 0.20 } },
    { id: 'peak1',     label: '17-19時',   fromHHMM: '17:00', toHHMM: '19:00', rates: { T1: 0.24, T2: 0.24, T3: 0.22 } },
    { id: 'evening',   label: '19-21:30',  fromHHMM: '19:00', toHHMM: '21:30', rates: { T1: 0.14, T2: 0.14, T3: 0.18 } },
    { id: 'peak2',     label: '21:30-24時',fromHHMM: '21:30', toHHMM: '24:00', rates: { T1: 0.21, T2: 0.21, T3: 0.22 } },
    { id: 'midnight',  label: '24時以降',  fromHHMM: '24:00', toHHMM: '27:00', rates: { T1: 0.05, T2: 0.05, T3: 0.22 } }
  ],
  reachBoost: [
    { minRate: 0.9, boost: 1.0 },
    { minRate: 0.5, boost: 1.3 },
    { minRate: 0.1, boost: 1.8 },
    { minRate: 0.0, boost: 2.5 }
  ],
  delayBoost: { minDelayMinutes: 60, minLobbyExitTime: '23:30', boost: 1.15 },
  maxRatio: 0.85,
  fallbackRate: 0.10
};

test('pickBucket: 18:30 → peak1', () => {
  assert.equal(pickBucket('18:30', transitShare).id, 'peak1');
});

test('pickBucket: 21:00 → evening (境界 21:30 未満)', () => {
  assert.equal(pickBucket('21:00', transitShare).id, 'evening');
});

test('pickBucket: 21:30 → peak2 (境界 ちょうど)', () => {
  assert.equal(pickBucket('21:30', transitShare).id, 'peak2');
});

test('pickBucket: 24:30 → midnight', () => {
  assert.equal(pickBucket('24:30', transitShare).id, 'midnight');
});

test('pickBucket: 06:30 → null（範囲外）', () => {
  assert.equal(pickBucket('06:30', transitShare), null);
});

test('pickBoost: reachRate=1.0 → 1.0', () => {
  assert.equal(pickBoost(1.0, transitShare), 1.0);
});

test('pickBoost: reachRate=0.6 → 1.3', () => {
  assert.equal(pickBoost(0.6, transitShare), 1.3);
});

test('pickBoost: reachRate=0 → 2.5', () => {
  assert.equal(pickBoost(0, transitShare), 2.5);
});

test('estimateTaxiPax: T2 18:30 reach=1.0 → 推定降客×0.24', () => {
  const r = estimateTaxiPax({
    estimatedPax: 200, terminal: 'T2', lobbyExitTime: '18:30', delayMinutes: 0
  }, transitShare, 1.0);
  assert.equal(r.estimatedTaxiPax, Math.round(200 * 0.24 * 1.0));
});

test('estimateTaxiPax: T3 23:00 reach=0 → 0.22 × 2.5、上限0.85クランプ', () => {
  const r = estimateTaxiPax({
    estimatedPax: 300, terminal: 'T3', lobbyExitTime: '23:00', delayMinutes: 0
  }, transitShare, 0.0);
  assert.equal(r.estimatedTaxiPax, Math.round(300 * 0.22 * 2.5));
  assert.equal(r.appliedBoost, 2.5);
  assert.equal(r.appliedDelayBoost, 1.0);
});

test('estimateTaxiPax: T1 24:30 遅延60分以上 → 遅延ブースト適用', () => {
  const r = estimateTaxiPax({
    estimatedPax: 150, terminal: 'T1', lobbyExitTime: '24:30', delayMinutes: 70
  }, transitShare, 0.0);
  assert.equal(r.appliedDelayBoost, 1.15);
  assert.equal(r.estimatedTaxiPax, Math.round(150 * 0.05 * 2.5 * 1.15));
});

test('estimateTaxiPax: 上限0.85クランプが効く（極端値）', () => {
  const extreme = JSON.parse(JSON.stringify(transitShare));
  extreme.buckets[7].rates.T3 = 0.50;
  const r = estimateTaxiPax({
    estimatedPax: 100, terminal: 'T3', lobbyExitTime: '24:30', delayMinutes: 70
  }, extreme, 0.0);
  assert.equal(r.estimatedTaxiPax, Math.round(100 * 0.85));
  assert.equal(r.clamped, true);
});

test('estimateTaxiPax: estimatedPax=null → null', () => {
  const r = estimateTaxiPax({
    estimatedPax: null, terminal: 'T1', lobbyExitTime: '12:00', delayMinutes: 0
  }, transitShare, 1.0);
  assert.equal(r.estimatedTaxiPax, null);
});

test('estimateTaxiPax: バケット範囲外（早朝5時）→ fallbackRate', () => {
  const r = estimateTaxiPax({
    estimatedPax: 100, terminal: 'T1', lobbyExitTime: '05:30', delayMinutes: 0
  }, transitShare, 1.0);
  assert.equal(r.estimatedTaxiPax, 10);
  assert.equal(r.bucket, 'fallback');
});
