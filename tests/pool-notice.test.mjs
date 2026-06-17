import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractTdText, stripBoilerplate, parseTailRegulation, hasFlightNotice, buildPoolNotice } from '../scripts/lib/pool-notice.mjs';

const idx = readFileSync(fileURLToPath(new URL('./fixtures/ttc-index.html', import.meta.url)), 'utf8');
const no23 = readFileSync(fileURLToPath(new URL('./fixtures/ttc-no23.html', import.meta.url)), 'utf8');

test('extractTdText: <td>掲示をプレーン化(改行保持)', () => {
  const t = extractTdText(idx);
  assert.match(t, /末尾規制【奇数】/);
  assert.match(t, /おもてなしレーン/);
  assert.doesNotMatch(t, /<br|<\/td>/);
});

test('stripBoilerplate: 常設お知らせとURL行を落とす', () => {
  const t = stripBoilerplate(extractTdText(idx));
  assert.match(t, /末尾規制【奇数】/);
  assert.doesNotMatch(t, /tokyo-tc\.or\.jp/);
  assert.doesNotMatch(t, /について】/);
});

test('parseTailRegulation: 奇数/偶数を抽出', () => {
  assert.equal(parseTailRegulation(extractTdText(idx)), '奇数');
  assert.equal(parseTailRegulation('末尾規制【偶数】'), '偶数');
  assert.equal(parseTailRegulation('規制なし'), null);
});

test('hasFlightNotice: 通常テキストは false', () => {
  const live = stripBoilerplate(extractTdText(idx));
  assert.equal(hasFlightNotice(live), false);
  assert.equal(hasFlightNotice(stripBoilerplate(extractTdText(no23))), false);
});

test('hasFlightNotice: 便名+号+時刻が揃えば true', () => {
  assert.equal(hasFlightNotice('JL015 23:40着 第3乗り場へ'), true);
  assert.equal(hasFlightNotice('NH84便 第1号'), false); // 時刻も遅延語も無い → false
});

test('buildPoolNotice: 通常運用の現テキストを束ねる', () => {
  const n = buildPoolNotice({ no1Text: extractTdText(idx), no34Text: extractTdText(no23), updatedAt: '2026-06-17T10:00:00+09:00' });
  assert.equal(n.tailRegulation, '奇数');
  assert.equal(n.hasFlightNotice, false);
  assert.equal(n.flightNoticeText, '');
  assert.match(n.liveText, /末尾規制【奇数】/);
});
