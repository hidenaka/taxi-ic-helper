import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadJson } from './helpers.js';

test('ics.json: すべてのICに id / name / gps が揃っている', () => {
  const { ics } = loadJson('data/ics.json');
  assert.ok(Array.isArray(ics) && ics.length > 0, 'ics must be a non-empty array');
  for (const ic of ics) {
    assert.ok(ic.id, `missing id: ${JSON.stringify(ic)}`);
    assert.ok(ic.name, `missing name: ${ic.id}`);
    assert.ok(ic.gps && typeof ic.gps.lat === 'number' && typeof ic.gps.lng === 'number',
              `missing gps: ${ic.id}`);
  }
});

test('ics.json: id は一意', () => {
  const { ics } = loadJson('data/ics.json');
  const ids = ics.map(x => x.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate ids found');
});

test('deduction.json: 全 ic_id が ics.json に存在する', () => {
  const { ics } = loadJson('data/ics.json');
  const { directions } = loadJson('data/deduction.json');
  const icIds = new Set(ics.map(x => x.id));

  for (const dir of directions) {
    assert.ok(icIds.has(dir.baseline.ic_id),
      `baseline not found in ics.json: ${dir.id} / ${dir.baseline.ic_id}`);
    for (const entry of dir.entries) {
      assert.ok(icIds.has(entry.ic_id),
        `entry not found in ics.json: ${dir.id} / ${entry.ic_id}`);
    }
  }
});

test('shutoko_distances.json: 全 from/to が ics.json に存在', () => {
  const { ics } = loadJson('data/ics.json');
  const { entries } = loadJson('data/shutoko_distances.json');
  const icIds = new Set(ics.map(x => x.id));
  for (const e of entries) {
    assert.ok(icIds.has(e.from), `from not in ics.json: ${e.from}`);
    assert.ok(icIds.has(e.to), `to not in ics.json: ${e.to}`);
    assert.ok(typeof e.km === 'number' && e.km > 0, `invalid km: ${e.from}→${e.to}`);
  }
});

test('gaikan_distances.json: 全 from/to が ics.json に存在', () => {
  const { ics } = loadJson('data/ics.json');
  const { entries } = loadJson('data/gaikan_distances.json');
  const icIds = new Set(ics.map(x => x.id));
  for (const e of entries) {
    assert.ok(icIds.has(e.from), `from not in ics.json: ${e.from}`);
    assert.ok(icIds.has(e.to), `to not in ics.json: ${e.to}`);
    assert.ok(typeof e.km === 'number' && e.km > 0, `invalid km: ${e.from}→${e.to}`);
  }
});

test('map.svg: data-ic-id 属性が ics.json の全 id をカバー', () => {
  const { ics } = loadJson('data/ics.json');
  const svgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'svg/map.svg');
  const svgText = readFileSync(svgPath, 'utf8');
  for (const ic of ics) {
    assert.ok(svgText.includes(`data-ic-id="${ic.id}"`),
      `svg missing node for: ${ic.id}`);
  }
});
