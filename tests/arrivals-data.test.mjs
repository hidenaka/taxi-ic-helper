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

import { summarizeFlights, detectTopics } from '../js/arrivals-data.js';

test('summarizeFlights: totalTaxiPax / reachNoneCount / peakTaxiBin を返す', () => {
  const flights = [
    { estimatedTime: '18:30', estimatedPax: 200, estimatedTaxiPax: 48, isInternational: false, status: '定刻', reachTier: 'high' },
    { estimatedTime: '18:45', estimatedPax: 100, estimatedTaxiPax: 24, isInternational: false, status: '定刻', reachTier: 'high' },
    { estimatedTime: '24:30', estimatedPax: 150, estimatedTaxiPax: 33, isInternational: false, status: '遅延', reachTier: 'none' }
  ];
  const s = summarizeFlights(flights);
  assert.equal(s.totalTaxiPax, 48 + 24 + 33);
  assert.equal(s.reachNoneCount, 1);
  assert.equal(s.peakTaxiBin.bin, '18:30');
  assert.equal(s.peakTaxiBin.value, 48 + 24);
});

test('summarizeFlights: 既存フィールドを維持', () => {
  const flights = [
    { estimatedTime: '15:00', estimatedPax: 200, estimatedTaxiPax: 40, isInternational: true, status: '定刻', reachTier: 'high' }
  ];
  const s = summarizeFlights(flights);
  assert.equal(s.totalPax, 200);
  assert.equal(s.internationalPax, 200);
  assert.equal(s.totalFlights, 1);
  assert.equal(s.internationalCount, 1);
  assert.equal(s.delayedCount, 0);
  assert.equal(s.unknownCount, 0);
  assert.equal(s.windowLabel, '直近3時間');
});

test('summarizeFlights: 空配列でも peakTaxiBin はデフォルト返す', () => {
  const s = summarizeFlights([]);
  assert.equal(s.totalTaxiPax, 0);
  assert.equal(s.reachNoneCount, 0);
  assert.equal(s.peakTaxiBin.bin, null);
  assert.equal(s.peakTaxiBin.value, 0);
});

test('detectTopics: reachTier=none の便がトピックに入る', () => {
  const flights = [
    { flightNumber: 'NH001', estimatedTime: '24:30', scheduledTime: '23:00', status: '遅延', estimatedPax: 100, estimatedTaxiPax: 30, isInternational: false, reachTier: 'none', taxiDelayBoost: 1.15, terminal: 'T2', fromName: '福岡' }
  ];
  const topics = detectTopics(flights);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].reachNone, true);
  assert.equal(topics[0].delayBoost, true);
  assert.equal(topics[0].estimatedTaxiPax, 30);
  assert.equal(topics[0].delayMin, 90);
});

test('detectTopics: 通常便（reach high & delayBoost なし）はトピックに入らない', () => {
  const flights = [
    { flightNumber: 'JL001', estimatedTime: '14:00', scheduledTime: '14:00', status: '定刻', estimatedPax: 150, estimatedTaxiPax: 25, isInternational: false, reachTier: 'high', taxiDelayBoost: 1.0, terminal: 'T1', fromName: '伊丹' }
  ];
  const topics = detectTopics(flights);
  assert.equal(topics.length, 0);
});

test('detectTopics: 到着済み便はトピックから除外', () => {
  const flights = [
    { flightNumber: 'NH002', estimatedTime: '24:00', scheduledTime: '23:00', status: '到着', estimatedPax: 100, estimatedTaxiPax: 30, reachTier: 'none', taxiDelayBoost: 1.15, terminal: 'T2', fromName: '福岡' }
  ];
  const topics = detectTopics(flights);
  assert.equal(topics.length, 0);
});

import { sortFlightsByTime } from '../js/arrivals-data.js';

test('sortFlightsByTime: estimatedTime 昇順に並べ替える', () => {
  const flights = [
    { flightNumber: 'B', scheduledTime: '18:30', estimatedTime: '18:30' },
    { flightNumber: 'A', scheduledTime: '17:00', estimatedTime: '17:00' },
    { flightNumber: 'C', scheduledTime: '20:00', estimatedTime: '20:00' }
  ];
  const sorted = sortFlightsByTime(flights);
  assert.deepEqual(sorted.map(f => f.flightNumber), ['A', 'B', 'C']);
});

test('sortFlightsByTime: estimatedTime が無ければ scheduledTime で並べる', () => {
  const flights = [
    { flightNumber: 'X', scheduledTime: '19:00' },
    { flightNumber: 'Y', scheduledTime: '17:30' }
  ];
  assert.deepEqual(sortFlightsByTime(flights).map(f => f.flightNumber), ['Y', 'X']);
});

test('sortFlightsByTime: 元配列を破壊しない', () => {
  const flights = [
    { flightNumber: 'B', estimatedTime: '20:00' },
    { flightNumber: 'A', estimatedTime: '17:00' }
  ];
  const original = flights.slice();
  sortFlightsByTime(flights);
  assert.deepEqual(flights, original);
});

test('sortFlightsByTime: 時刻情報なし便は末尾に', () => {
  const flights = [
    { flightNumber: 'C' },
    { flightNumber: 'A', estimatedTime: '18:00' },
    { flightNumber: 'B', estimatedTime: '19:00' }
  ];
  assert.deepEqual(sortFlightsByTime(flights).map(f => f.flightNumber), ['A', 'B', 'C']);
});
