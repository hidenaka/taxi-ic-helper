import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  isLightningCode,
  findLastLightningEndedAt,
  parseOpenMeteoResponse
} from '../scripts/lib/weather-detector.mjs';

test('isLightningCode: 95 / 96 / 99 だけ雷扱い', () => {
  assert.equal(isLightningCode(95), true);
  assert.equal(isLightningCode(96), true);
  assert.equal(isLightningCode(99), true);
  assert.equal(isLightningCode(0), false);
  assert.equal(isLightningCode(80), false);
  assert.equal(isLightningCode(null), false);
});

test('findLastLightningEndedAt: 直近に雷なし → null', () => {
  const history = [
    { time: '2026-04-25T12:00', weatherCode: 1 },
    { time: '2026-04-25T12:15', weatherCode: 80 },
    { time: '2026-04-25T12:30', weatherCode: 0 }
  ];
  const r = findLastLightningEndedAt(history, '2026-04-25T13:00');
  assert.equal(r, null);
});

test('findLastLightningEndedAt: 雷が活動中 → null（まだ終わってない）', () => {
  const history = [
    { time: '2026-04-25T12:00', weatherCode: 95 },
    { time: '2026-04-25T12:15', weatherCode: 95 },
    { time: '2026-04-25T12:30', weatherCode: 95 }
  ];
  const r = findLastLightningEndedAt(history, '2026-04-25T12:30');
  assert.equal(r, null);
});

test('findLastLightningEndedAt: 雷終了済み → 最後の活動時刻 + 15分', () => {
  const history = [
    { time: '2026-04-25T12:00', weatherCode: 95 },
    { time: '2026-04-25T12:15', weatherCode: 95 },
    { time: '2026-04-25T12:30', weatherCode: 80 },
    { time: '2026-04-25T12:45', weatherCode: 1 }
  ];
  const r = findLastLightningEndedAt(history, '2026-04-25T13:00');
  // 最後の雷は 12:15 → 終了は 12:30
  assert.equal(r, '2026-04-25T12:30');
});

test('findLastLightningEndedAt: 古い雷（2時間以上前）は無視', () => {
  const history = [
    { time: '2026-04-25T09:00', weatherCode: 95 },
    { time: '2026-04-25T09:15', weatherCode: 80 },
    { time: '2026-04-25T11:00', weatherCode: 0 }
  ];
  const r = findLastLightningEndedAt(history, '2026-04-25T13:00');
  // 09:15 が最後の雷活動 → 終了 09:30 は 13:00 から 3.5h 前 → 無視
  assert.equal(r, null);
});

test('parseOpenMeteoResponse: 現在雷 → lightningActive=true', () => {
  const resp = {
    current: { time: '2026-04-25T13:00', weather_code: 95 },
    minutely_15: {
      time: ['2026-04-25T12:30', '2026-04-25T12:45', '2026-04-25T13:00'],
      weather_code: [95, 95, 95]
    }
  };
  const r = parseOpenMeteoResponse(resp);
  assert.equal(r.lightningActive, true);
  assert.equal(r.lastLightningEndedAt, null);
  assert.equal(r.weatherCode, 95);
});

test('parseOpenMeteoResponse: 雷終了直後 → lastLightningEndedAt セット', () => {
  const resp = {
    current: { time: '2026-04-25T13:00', weather_code: 80 },
    minutely_15: {
      time: ['2026-04-25T12:00', '2026-04-25T12:15', '2026-04-25T12:30', '2026-04-25T12:45', '2026-04-25T13:00'],
      weather_code: [95, 95, 80, 80, 80]
    }
  };
  const r = parseOpenMeteoResponse(resp);
  assert.equal(r.lightningActive, false);
  assert.equal(r.lastLightningEndedAt, '2026-04-25T12:30');
  assert.equal(r.weatherCode, 80);
});

test('parseOpenMeteoResponse: 通常時 → 全 null', () => {
  const resp = {
    current: { time: '2026-04-25T13:00', weather_code: 1 },
    minutely_15: {
      time: ['2026-04-25T12:30', '2026-04-25T12:45', '2026-04-25T13:00'],
      weather_code: [1, 1, 1]
    }
  };
  const r = parseOpenMeteoResponse(resp);
  assert.equal(r.lightningActive, false);
  assert.equal(r.lastLightningEndedAt, null);
});

test('parseOpenMeteoResponse: history15min を含めて返す', () => {
  const resp = {
    current: { time: '2026-04-25T13:00', weather_code: 1 },
    minutely_15: {
      time: ['2026-04-25T12:30', '2026-04-25T12:45', '2026-04-25T13:00'],
      weather_code: [95, 80, 1]
    }
  };
  const r = parseOpenMeteoResponse(resp);
  assert.equal(r.history15min.length, 3);
  assert.equal(r.history15min[0].time, '2026-04-25T12:30');
  assert.equal(r.history15min[0].weatherCode, 95);
  assert.equal(r.history15min[0].isLightning, true);
});
