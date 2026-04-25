import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJson } from './helpers.js';
import { judgeRoute } from '../js/judge.js';

function loadAll() {
  return {
    ics: loadJson('data/ics.json').ics,
    deduction: loadJson('data/deduction.json'),
    shutokoDist: loadJson('data/shutoko_distances.json'),
    shutokoRoutes: loadJson('data/shutoko_routes.json'),
    shutokoGraph: loadJson('data/shutoko_graph.json'),
    gaikanDist: loadJson('data/gaikan_distances.json'),
    routes: loadJson('data/routes.json'),
  };
}

// ── 社内ルール: 控除距離 (deductionKm) は社内表 (deduction.json) の値で固定 ──
// 物理走行距離 (distanceKm) の修正は控除距離に影響を与えてはならない。
// この回帰テストは、走行距離側の改修で誤って控除値を巻き込んでいないことを保証する。

test('D-INT1 全エントリ: deductionKmOneway = deduction.json の控除値と完全一致', () => {
  const data = loadAll();
  const exitIc = data.ics.find((x) => x.id === 'kasumigaseki');
  const mismatches = [];
  let total = 0;
  for (const dir of data.deduction.directions) {
    for (const entry of dir.entries) {
      const ic = data.ics.find((x) => x.id === entry.ic_id);
      if (!ic) continue;
      total++;
      const r = judgeRoute({ outerRoute: dir.id, entryIc: ic, exitIc, roundTrip: false }, data);
      if (Math.abs(r.totals.deductionKmOneway - entry.km) > 0.001) {
        mismatches.push({
          dir: dir.id, ic: entry.ic_id, expected: entry.km, actual: r.totals.deductionKmOneway,
        });
      }
    }
  }
  assert.ok(total > 100, '少なくとも100件以上を検証');
  assert.deepEqual(mismatches, [], '控除距離 不一致: ' + JSON.stringify(mismatches));
});

test('D-INT2 viaGaikan: 控除距離は viaGaikan の有無で変わらない (走行距離だけ変わる)', () => {
  const data = loadAll();
  const exitIc = data.ics.find((x) => x.id === 'kasumigaseki');
  // viaGaikan を持ち得る方面 (kanetsu/joban) 全エントリで non-viaGaikan vs viaGaikan の控除値比較
  for (const dirId of ['kanetsu', 'joban']) {
    const dir = data.deduction.directions.find((d) => d.id === dirId);
    for (const entry of dir.entries) {
      const ic = data.ics.find((x) => x.id === entry.ic_id);
      if (!ic) continue;
      const r1 = judgeRoute({ outerRoute: dirId, entryIc: ic, exitIc, roundTrip: false }, data);
      const r2 = judgeRoute({
        outerRoute: dirId, entryIc: { ...ic, _viaGaikan: true }, exitIc, roundTrip: false,
      }, data);
      assert.equal(r1.totals.deductionKmOneway, r2.totals.deductionKmOneway,
        `${dirId} ${entry.ic_id}: 控除距離が viaGaikan で変動 ` +
        `(non-viaGaikan=${r1.totals.deductionKmOneway}, viaGaikan=${r2.totals.deductionKmOneway})`);
      // 走行距離は変わってOK (むしろ変わるべき)
    }
  }
});

test('D-INT3 outer trunk seg: deductionKm = 控除値、distanceKm は別系列 (混同していない)', () => {
  const data = loadAll();
  const find = (id) => data.ics.find((x) => x.id === id);
  // 関越所沢: 控除9.4、distanceは物理 (non=9.4, viaGaikan=8.6)
  const r1 = judgeRoute({
    outerRoute: 'kanetsu', entryIc: find('tokorozawa'),
    exitIc: find('kasumigaseki'), roundTrip: false,
  }, data);
  const seg1 = r1.segments.find((s) => s.route === 'kanetsu');
  assert.equal(seg1.deductionKm, 9.4, '関越セグの控除km = 社内表値 9.4');
  // distanceKm は物理走行距離。控除値と一致してもよいが、概念は別。
  assert.ok(typeof seg1.distanceKm === 'number' && seg1.distanceKm > 0);

  const r2 = judgeRoute({
    outerRoute: 'kanetsu', entryIc: { ...find('tokorozawa'), _viaGaikan: true },
    exitIc: find('kasumigaseki'), roundTrip: false,
  }, data);
  const seg2 = r2.segments.find((s) => s.route === 'kanetsu');
  assert.equal(seg2.deductionKm, 9.4, '関越セグの控除km = 社内表値 9.4 (viaGaikanでも不変)');
  // viaGaikan時は distanceKm が大泉JCT分岐分 (0.8km) 短くなる
  assert.ok(Math.abs(seg2.distanceKm - 8.6) <= 0.001,
    `viaGaikan 関越 distanceKm=${seg2.distanceKm}, 期待 8.6 (=9.4-0.8)`);
});

test('D-INT4 shutoko seg: deductionKm は常に 0 (首都高区間は控除対象外)', () => {
  const data = loadAll();
  const find = (id) => data.ics.find((x) => x.id === id);
  // 各方面 baseline → kasumigaseki で shutoko セグの控除を確認
  for (const [route, entryId] of [
    ['kanetsu', 'tokorozawa'],
    ['tomei', 'yokohama_aoba'],
    ['joban', 'kashiwa'],
    ['keiyo', 'makuhari'],
    ['tokan', 'narita_kukou'],
    ['aqua', 'kisarazu_kaneda'],
    ['third_keihin', 'totsuka'],
  ]) {
    const r = judgeRoute({
      outerRoute: route, entryIc: find(entryId),
      exitIc: find('kasumigaseki'), roundTrip: false,
    }, data);
    const shutoko = r.segments.find((s) => s.route === 'shutoko');
    assert.equal(shutoko.deductionKm, 0,
      `${route} ${entryId}: shutokoセグ deductionKm が 0 でない (=${shutoko.deductionKm})`);
  }
});

test('D-INT5 gaikan seg: deductionKm は常に 0 (外環道は控除対象外)', () => {
  const data = loadAll();
  const find = (id) => data.ics.find((x) => x.id === id);
  // viaGaikan ルートで gaikan セグの控除確認
  const cases = [
    ['kanetsu', { ...find('tokorozawa'), _viaGaikan: true }],
    ['joban', { ...find('kashiwa'), _viaGaikan: true }],
    ['tohoku', find('urawa')], // tohoku は常に viaGaikan
    ['gaikan_direct', find('oizumi')],
  ];
  for (const [route, entryIc] of cases) {
    const r = judgeRoute({
      outerRoute: route, entryIc, exitIc: find('kasumigaseki'), roundTrip: false,
    }, data);
    const gaikan = r.segments.find((s) => s.route === 'gaikan');
    assert.ok(gaikan, `${route}: gaikan セグが存在`);
    assert.equal(gaikan.deductionKm, 0,
      `${route}: gaikanセグ deductionKm が 0 でない (=${gaikan.deductionKm})`);
  }
});
