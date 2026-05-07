import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyStaleness } from '../js/arrivals-data.js';

// 固定時刻 (JST 12:00) を基準にする。JST 5:00 抑制条件にはかからない。
const NOON_JST_ISO = '2026-05-07T12:00:00+09:00';
const noon = new Date(NOON_JST_ISO);

function minutesAgoIso(min) {
  return new Date(noon.getTime() - min * 60 * 1000).toISOString();
}

test('classifyStaleness: 0 分前 → fresh', () => {
  const r = classifyStaleness(minutesAgoIso(0), noon);
  assert.equal(r.level, 'fresh');
  assert.equal(r.ageMinutes, 0);
});

test('classifyStaleness: 14 分前 → fresh (境界手前)', () => {
  const r = classifyStaleness(minutesAgoIso(14), noon);
  assert.equal(r.level, 'fresh');
  assert.equal(r.ageMinutes, 14);
});

test('classifyStaleness: 15 分前 → warn (境界)', () => {
  const r = classifyStaleness(minutesAgoIso(15), noon);
  assert.equal(r.level, 'warn');
  assert.equal(r.ageMinutes, 15);
});

test('classifyStaleness: 60 分前 → warn (境界)', () => {
  const r = classifyStaleness(minutesAgoIso(60), noon);
  assert.equal(r.level, 'warn');
  assert.equal(r.ageMinutes, 60);
});

test('classifyStaleness: 61 分前 → critical', () => {
  const r = classifyStaleness(minutesAgoIso(61), noon);
  assert.equal(r.level, 'critical');
  assert.equal(r.ageMinutes, 61);
});

test('classifyStaleness: 180 分前 → critical', () => {
  const r = classifyStaleness(minutesAgoIso(180), noon);
  assert.equal(r.level, 'critical');
  assert.equal(r.ageMinutes, 180);
});

test('classifyStaleness: JST 05:00 ちょうど → 抑制解除 (境界、< 5)', () => {
  const fiveAmJst = new Date('2026-05-07T05:00:00+09:00');
  const r = classifyStaleness(
    new Date(fiveAmJst.getTime() - 0).toISOString(),
    fiveAmJst
  );
  assert.equal(r.level, 'fresh');
  assert.equal(r.ageMinutes, 0);
});

test('classifyStaleness: JST 04:30 時点で 8 時間前 → suppressed (朝5時前は抑制)', () => {
  const earlyMorningJst = new Date('2026-05-07T04:30:00+09:00');
  const r = classifyStaleness(
    new Date(earlyMorningJst.getTime() - 8 * 60 * 60 * 1000).toISOString(),
    earlyMorningJst
  );
  assert.equal(r.level, 'suppressed');
});

test('classifyStaleness: JST 06:00 時点で 8 時間前 → critical (抑制が外れる)', () => {
  const sixAmJst = new Date('2026-05-07T06:00:00+09:00');
  const r = classifyStaleness(
    new Date(sixAmJst.getTime() - 8 * 60 * 60 * 1000).toISOString(),
    sixAmJst
  );
  assert.equal(r.level, 'critical');
});

test('classifyStaleness: updatedAtIso が null/undefined → suppressed', () => {
  const r = classifyStaleness(null, noon);
  assert.equal(r.level, 'suppressed');
});
