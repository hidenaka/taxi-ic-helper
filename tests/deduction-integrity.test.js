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

test('D-INT-C 横浜方面 複数経路: 保土ヶ谷IC で 玉川経由 / 保土ヶ谷BP経由 が選択可能', () => {
  const data = loadAll();
  const find = (id) => data.ics.find((x) => x.id === id);
  // 保土ヶ谷IC が hodogaya_route の entries に登録されていること
  const hodogayaRoute = data.deduction.directions.find((d) => d.id === 'hodogaya_route');
  assert.ok(hodogayaRoute, 'hodogaya_route direction が存在');
  const hodEntry = hodogayaRoute.entries.find((e) => e.ic_id === 'hodogaya');
  assert.ok(hodEntry, '保土ヶ谷IC が hodogaya_route entries に登録');
  // BP区間 (3km) は一般道なので控除対象外、physical_km=3 として走行距離に含める
  assert.equal(hodEntry.km, 0, '保土ヶ谷IC の hodogaya_route 控除km = 0 (BPは一般道で控除外)');
  assert.equal(hodEntry.physical_km, 3.0, '物理距離は3km (BP区間)');

  // 玉川経由 (third_keihin)
  const r1 = judgeRoute({
    outerRoute: 'third_keihin', entryIc: find('hodogaya'),
    exitIc: find('kukou_chuou'), roundTrip: false,
  }, data);
  assert.equal(r1.totals.deductionKmOneway, 16.6, '玉川経由: 控除 16.6km');
  assert.equal(r1.totals.paySummary, 'all_company');

  // 保土ヶ谷BP→K1経由 (BP一般道は控除外)
  const r2 = judgeRoute({
    outerRoute: 'hodogaya_route', entryIc: find('hodogaya'),
    exitIc: find('kukou_chuou'), roundTrip: false,
  }, data);
  assert.equal(r2.totals.deductionKmOneway, 0, '保土ヶ谷BP経由: 控除 0km (BPは一般道、本線高速使わず)');
  assert.equal(r2.totals.distanceKmOneway, 25.0, '走行 25km (BP3 + K1接続22)');
});

test('D-INT-D 北西線経由 (hokuseisen_route): 港北IC等で選択可能', () => {
  const data = loadAll();
  const find = (id) => data.ics.find((x) => x.id === id);
  const hokuseisen = data.deduction.directions.find((d) => d.id === 'hokuseisen_route');
  assert.ok(hokuseisen, 'hokuseisen_route direction が存在');
  // 港北IC が登録されていること
  const kohokuEntry = hokuseisen.entries.find((e) => e.ic_id === 'kohoku');
  assert.ok(kohokuEntry, '港北IC が hokuseisen_route entries に登録');
  // 北西線は控除外、東名のみ控除 (kohoku→東京IC = 東名13.3km控除)
  assert.equal(kohokuEntry.km, 13.3, '港北 kohoku の控除13.3km (北西線控除0、東名のみ)');
  const r = judgeRoute({
    outerRoute: 'hokuseisen_route', entryIc: find('kohoku'),
    exitIc: find('kukou_chuou'), roundTrip: false,
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 13.3);
});

test('D-INT-E 北線経由 (kitasen_route) の控除は0 (北西線/北線/K1すべて控除外)', () => {
  const data = loadAll();
  const find = (id) => data.ics.find((x) => x.id === id);
  const kitasen = data.deduction.directions.find((d) => d.id === 'kitasen_route');
  assert.ok(kitasen, 'kitasen_route direction が存在');
  const aobaEntry = kitasen.entries.find((e) => e.ic_id === 'yokohama_aoba');
  assert.equal(aobaEntry.km, 0, '青葉 kitasen_route の控除は0 (北西線/北線/K1は全て控除外)');
  assert.equal(aobaEntry.physical_km, 19.0, '走行距離は19km (有料区間全て)');

  const r = judgeRoute({
    outerRoute: 'kitasen_route', entryIc: find('yokohama_aoba'),
    exitIc: find('wangan_kanpachi'), roundTrip: false,
  }, data);
  assert.equal(r.totals.deductionKmOneway, 0, '控除0');
  assert.equal(r.totals.distanceKmOneway, 33.0, '走行33km (北西7+北線8.2+K1 4 + 湾岸線基点→湾岸環八14)');
});

test('D-INT-A 出口IC = 本線baseline自身 のとき shutokoセグは含めない (本線完結)', () => {
  const data = loadAll();
  const find = (id) => data.ics.find((x) => x.id === id);
  // 本線内で完結するケース: shutoko セグが存在してはいけない
  const cases = [
    ['third_keihin', 'kohoku', 'tamagawa_ic', 11.1],   // 港北→玉川IC
    ['third_keihin', 'totsuka', 'tamagawa_ic', 26.6],  // 戸塚→玉川IC
    ['yokoyoko', 'asahina', 'tamagawa_ic', 35.9],      // 朝比奈→玉川IC (横横玉川経由)
    ['tomei', 'yokohama_aoba', 'tokyo_ic', 13.3],      // 横浜青葉→東京IC
    ['chuo', 'hachioji', 'takaido', 25.8],             // 八王子→高井戸
    ['kanetsu', 'tokorozawa', 'nerima', 9.4],          // 所沢→練馬IC
  ];
  for (const [route, eId, xId, expected] of cases) {
    const r = judgeRoute({
      outerRoute: route, entryIc: find(eId), exitIc: find(xId), roundTrip: false,
    }, data);
    const hasShutoko = r.segments.some((s) => s.route === 'shutoko');
    assert.equal(hasShutoko, false,
      `${route} ${eId}→${xId}: 本線完結なのに shutoko セグが含まれている (segs: ${r.segments.map(s=>s.route).join(',')})`);
    assert.equal(r.totals.distanceKmOneway, expected,
      `${route} ${eId}→${xId}: 走行距離 期待${expected}km、実測${r.totals.distanceKmOneway}km`);
  }
});

test('D-INT-B 外環道IC gaikan_direct: 4 hub (美女木/川口/三郷/高谷) で最短経由を選択', () => {
  const data = loadAll();
  const find = (id) => data.ics.find((x) => x.id === id);
  // 各IC が外環kp ベースで最寄り首都高接続点経由になっていることを確認
  const cases = [
    // [entryId, expected total km, expected shutoko hub keyword]
    // 2026-04-27: shutoko_routes をDijkstra実走km(graph v3)に更新したため total を再計算
    ['oizumi_jct',          33.7, '5号'],          // bijogi 経由 (kp 0)
    ['wako_gaikan',         28.2, '5号'],          // bijogi 経由 (kp 5.5)
    ['bijogi_jct',          25.9, '5号'],          // 自身 (kp 7.8)
    ['toda_higashi',        29.1, '5号'],          // bijogi 経由 (kp 11)
    ['kawaguchi_chuo',      33.7, 'S1'],           // kawaguchi 経由 (kp 12.7)
    ['kawaguchi_jct',       32.0, 'S1'],           // 自身 (kp 14.4)
    ['gaikan_misato_nishi', 28.1, '6号'],          // misato 経由 (kp 19.5)
    ['misato_jct',          26.1, '6号'],          // 自身 (kp 21.5)
    ['misato_minami',       27.6, '6号'],          // misato 経由 (kp 23)
    ['matsudo_gaikan',      32.6, '京葉道'],        // takaya 経由 (kp 29)
    ['ichikawa_minami',     27.1, '京葉道'],        // takaya 経由 (kp 34.5)
    ['takaya_jct',          26.1, '京葉道'],        // 自身 (kp 35.5)
  ];
  for (const [eId, expectedKm, hubKey] of cases) {
    const ic = find(eId);
    assert.ok(ic, `IC ${eId} が ics.json に存在`);
    const r = judgeRoute({
      outerRoute: 'gaikan_direct', entryIc: ic, exitIc: find('kasumigaseki'), roundTrip: false,
    }, data);
    assert.ok(Math.abs(r.totals.distanceKmOneway - expectedKm) <= 0.1,
      `${eId} (kp=${ic.gaikan_kp}): 走行距離 期待${expectedKm}km、実測${r.totals.distanceKmOneway}km`);
    const shutoko = r.segments.find((s) => s.route === 'shutoko');
    assert.ok(shutoko && shutoko.name.includes(hubKey),
      `${eId}: shutokoセグ name に "${hubKey}" を含むべき (実: ${shutoko?.name})`);
    // 控除距離は常に 0 (gaikan_direct なので本線高速 deduction なし)
    assert.equal(r.totals.deductionKmOneway, 0,
      `${eId}: gaikan_direct で控除距離が 0 でない (=${r.totals.deductionKmOneway})`);
    // pay は all_self (外環直乗りは自己負担)
    assert.equal(r.totals.paySummary, 'all_self', `${eId}: 外環直乗りは自己負担`);
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
