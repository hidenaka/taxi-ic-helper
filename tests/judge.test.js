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

test('lookupDeduction: 調布 は chuo / 7.7km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'chofu');
  assert.strictEqual(e?.direction, 'chuo');
  assert.strictEqual(e?.km, 7.7);
});

test('lookupDeduction: 所沢 は kanetsu / 9.4km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'tokorozawa');
  assert.strictEqual(e?.direction, 'kanetsu');
  assert.strictEqual(e?.km, 9.4);
});

test('lookupDeduction: 浦和 は tohoku / 3.2km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'urawa');
  assert.strictEqual(e?.direction, 'tohoku');
  assert.strictEqual(e?.km, 3.2);
});

test('lookupDeduction: 柏 は joban / 10.8km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'kashiwa');
  assert.strictEqual(e?.direction, 'joban');
  assert.strictEqual(e?.km, 10.8);
});

test('lookupDeduction: 船橋 は keiyo / 5.2km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'funabashi');
  assert.strictEqual(e?.direction, 'keiyo');
  assert.strictEqual(e?.km, 5.2);
});

test('lookupDeduction: 佐倉 は tokan / 29.0km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'sakura_tokan');
  assert.strictEqual(e?.direction, 'tokan');
  assert.strictEqual(e?.km, 29.0);
});

test('lookupDeduction: 木更津金田 は aqua / 15.1km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'kisarazu_kaneda');
  assert.strictEqual(e?.direction, 'aqua');
  assert.strictEqual(e?.km, 15.1);
});

test('lookupDeduction: 君津 は tateyama / 7.9km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'kimitsu');
  assert.strictEqual(e?.direction, 'tateyama');
  assert.strictEqual(e?.km, 7.9);
});

test('lookupDeduction: 原木 は keiyo / 4.4km (corrected)', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'habara');
  assert.strictEqual(e?.direction, 'keiyo');
  assert.strictEqual(e?.km, 4.4);
});

test('lookupDeduction: 京浜川崎 は third_keihin / 2.5km (corrected)', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'keihin_kawasaki');
  assert.strictEqual(e?.direction, 'third_keihin');
  assert.strictEqual(e?.km, 2.5);
});

test('lookupDeduction: 都筑 は third_keihin / 8.1km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'tsuzuki');
  assert.strictEqual(e?.direction, 'third_keihin');
  assert.strictEqual(e?.km, 8.1);
});

test('lookupDeduction: 狩場 は yokoyoko / 22.4km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'kariba');
  assert.strictEqual(e?.direction, 'yokoyoko');
  assert.strictEqual(e?.km, 22.4);
});

test('lookupDeduction: 逗子 は yokoyoko / 41.5km (玉川基準)', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'zushi');
  assert.strictEqual(e?.direction, 'yokoyoko');
  assert.strictEqual(e?.km, 41.5);
});

test('lookupDeduction: 浦賀 は yokoyoko / 54.0km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'uraga');
  assert.strictEqual(e?.direction, 'yokoyoko');
  assert.strictEqual(e?.km, 54.0);
});

test('lookupDeduction: 基準点 高井戸IC は null', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'takaido');
  assert.strictEqual(e, null);
});

test('lookupDeduction: 基準点 川口JCT は null', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'kawaguchi_jct');
  assert.strictEqual(e, null);
});

test('lookupDeduction: 基準点 木更津JCT は aqua エントリ (tateyama の基準点)', () => {
  const deduction = loadJson('data/deduction.json');
  // 木更津JCT は aqua direction の entry かつ tateyama の baseline
  // baseline 判定: aqua の entries に含まれている → aqua/23.7km
  const e = lookupDeduction(deduction, 'kisarazu_jct');
  assert.strictEqual(e?.direction, 'aqua');
  assert.strictEqual(e?.km, 23.7);
});

test('lookupDeduction: 別所（横羽線経由ヒント） は yokohane_route / 2.2km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'bessho', 'yokohane_route');
  assert.strictEqual(e?.direction, 'yokohane_route');
  assert.strictEqual(e?.km, 2.2);
});

test('lookupDeduction: 別所 は wangan_route には存在しない', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'bessho', 'wangan_route');
  assert.strictEqual(e, null);
});

test('lookupDeduction: ヒントなし別所は先頭マッチ（yokoyoko）', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'bessho');
  assert.strictEqual(e?.direction, 'yokoyoko');
});

test('lookupDeduction: 日野（湾岸線経由ヒント） は wangan_route / 8.5km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'hino', 'wangan_route');
  assert.strictEqual(e?.direction, 'wangan_route');
  assert.strictEqual(e?.km, 8.5);
});

test('routes.json: needs_gaikan_transit に全 outerRoute キーがある', () => {
  const r = loadJson('data/routes.json');
  const expected = ['tomei','chuo','kanetsu','tohoku','joban','keiyo','tokan','aqua','tateyama',
                    'third_keihin','yokoyoko','yokohane_route','wangan_route'];
  for (const key of expected) {
    assert.ok(key in r.needs_gaikan_transit, `missing: ${key}`);
  }
});
