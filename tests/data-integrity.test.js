import { test } from 'node:test';
import assert from 'node:assert';
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

test('favorites.json: 全 ic_id が ics.json に存在', () => {
  const { ics } = loadJson('data/ics.json');
  const { exit_favorites } = loadJson('data/favorites.json');
  const icIds = new Set(ics.map(x => x.id));
  for (const f of exit_favorites) {
    assert.ok(icIds.has(f.ic_id), `favorite not in ics.json: ${f.ic_id}`);
  }
});

test('shutoko_routes.json: 全 from/to が ics.json に存在', () => {
  const { ics } = loadJson('data/ics.json');
  const { pairs } = loadJson('data/shutoko_routes.json');
  const icIds = new Set(ics.map(x => x.id));
  for (const p of pairs) {
    assert.ok(icIds.has(p.from), `shutoko_routes from not in ics.json: ${p.from}`);
    assert.ok(icIds.has(p.to),   `shutoko_routes to not in ics.json: ${p.to}`);
    assert.ok(Array.isArray(p.options) && p.options.length > 0, `no options: ${p.from}→${p.to}`);
    for (const opt of p.options) {
      assert.ok(opt.id && opt.label && typeof opt.km === 'number',
        `invalid option: ${p.from}→${p.to}/${opt.id}`);
    }
  }
});

test('shutoko_graph.json: 全 edge の from/to が ics.json に存在', () => {
  const { ics } = loadJson('data/ics.json');
  const graph = loadJson('data/shutoko_graph.json');
  const icIds = new Set(ics.map(x => x.id));
  for (const e of graph.edges) {
    assert.ok(icIds.has(e.from), `edge from not in ics.json: ${e.from}`);
    assert.ok(icIds.has(e.to),   `edge to not in ics.json: ${e.to}`);
    assert.ok(typeof e.km === 'number' && e.km > 0, `invalid edge km: ${e.from}→${e.to}`);
  }
});

