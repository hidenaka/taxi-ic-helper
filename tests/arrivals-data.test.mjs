import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { aggregateHeatmapClient } from '../js/arrivals-data.js';

test('aggregateHeatmapClient: bin に totalTaxiPax / taxiDensityTier / reachNoneCount が出る', () => {
  const flights = [
    { estimatedTime: '18:30', estimatedPax: 200, estimatedTaxiPax: 40, isInternational: false, status: '定刻', reachTier: 'high' },
    { estimatedTime: '18:45', estimatedPax: 100, estimatedTaxiPax: 20, isInternational: false, status: '定刻', reachTier: 'high' }
  ];
  const bins = aggregateHeatmapClient(flights);
  assert.equal(bins.length, 1);
  assert.equal(bins[0].totalTaxiPax, 60);
  assert.equal(bins[0].taxiDensityTier, 'mid');
  assert.equal(bins[0].reachNoneCount, 0);
});

test('aggregateHeatmapClient: reachTier=none の便が reachNoneCount にカウント', () => {
  const flights = [
    { estimatedTime: '24:30', estimatedPax: 150, estimatedTaxiPax: 33, isInternational: false, status: '遅延', reachTier: 'none' },
    { estimatedTime: '24:35', estimatedPax: 80, estimatedTaxiPax: 12, isInternational: false, status: '定刻', reachTier: 'low' }
  ];
  const bins = aggregateHeatmapClient(flights);
  assert.equal(bins[0].reachNoneCount, 1);
});

test('aggregateHeatmapClient: estimatedTaxiPax=undefined の便も合計に影響しない（0扱い）', () => {
  const flights = [
    { estimatedTime: '15:00', estimatedPax: 100, isInternational: false, status: '定刻' }
  ];
  const bins = aggregateHeatmapClient(flights);
  assert.equal(bins[0].totalTaxiPax, 0);
  assert.equal(bins[0].taxiDensityTier, 'low');
});

test('aggregateHeatmapClient: taxi 70人以上で high 階層', () => {
  const flights = [
    { estimatedTime: '17:00', estimatedPax: 300, estimatedTaxiPax: 75, isInternational: false, status: '定刻', reachTier: 'high' }
  ];
  const bins = aggregateHeatmapClient(flights);
  assert.equal(bins[0].taxiDensityTier, 'high');
});

test('aggregateHeatmapClient: 既存 totalPax / densityTier / internationalPax の挙動を維持', () => {
  const flights = [
    { estimatedTime: '12:00', estimatedPax: 700, estimatedTaxiPax: 100, isInternational: true, status: '定刻', reachTier: 'high' }
  ];
  const bins = aggregateHeatmapClient(flights);
  assert.equal(bins[0].totalPax, 700);
  assert.equal(bins[0].internationalPax, 700);
  assert.equal(bins[0].densityTier, 'high');
});
