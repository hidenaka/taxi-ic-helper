import { test } from 'node:test';
import assert from 'node:assert';
import { loadJson } from './helpers.js';
import { buildAdjacency, shortestPath } from '../js/shutoko-graph.js';

function loadAdj() {
  const graph = loadJson('data/shutoko_graph.json');
  return buildAdjacency(graph);
}

test('shutoko-graph: identical from/to → 0km', () => {
  const adj = loadAdj();
  const r = shortestPath(adj, 'kasumigaseki', 'kasumigaseki');
  assert.strictEqual(r.km, 0);
});

test('shutoko-graph: disconnected pair → null', () => {
  const adj = new Map([
    ['A', [{ to: 'B', km: 3, route: 'x' }]],
    ['B', [{ to: 'A', km: 3, route: 'x' }]],
    ['C', []]
  ]);
  const r = shortestPath(adj, 'A', 'C');
  assert.strictEqual(r.km, null);
});

test('shutoko-graph: kasumigaseki→gaien shortest path via C1', () => {
  const adj = loadAdj();
  const r = shortestPath(adj, 'kasumigaseki', 'gaien');
  assert.ok(r.km !== null, 'should find a path');
  assert.ok(r.km > 0 && r.km < 5, `expected ~1.5km, got ${r.km}`);
});

test('shutoko-graph: kasumigaseki→tokyo_ic via 3号', () => {
  const adj = loadAdj();
  const r = shortestPath(adj, 'kasumigaseki', 'tokyo_ic');
  assert.ok(r.km !== null, 'should find a path');
  assert.ok(r.km >= 8 && r.km <= 15, `expected ~10km, got ${r.km}`);
});

test('shutoko-graph: shibaura→kukou_chuou via 1号羽田線', () => {
  const adj = loadAdj();
  const r = shortestPath(adj, 'shibaura', 'kukou_chuou');
  assert.ok(r.km !== null, 'should find a path');
  assert.ok(r.km >= 8 && r.km <= 20, `expected ~11-14km, got ${r.km}`);
});

test('shutoko-graph: maihama→kasumigaseki via 湾岸→C1', () => {
  const adj = loadAdj();
  const r = shortestPath(adj, 'maihama', 'kasumigaseki');
  assert.ok(r.km !== null, 'should find a path');
  assert.ok(r.km >= 12 && r.km <= 20, `expected ~15km, got ${r.km}`);
});
