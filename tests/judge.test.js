import { test } from 'node:test';
import assert from 'node:assert';
import { loadJson } from './helpers.js';
import { lookupDeduction, calcOneWayDeduction, judgeDeduction, computeShutokoPay, judgeRoute } from '../js/judge.js';

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

test('lookupDeduction: 佐倉 は tokan 指定で 29.0km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'sakura_tokan', 'tokan');
  assert.strictEqual(e?.direction, 'tokan');
  assert.strictEqual(e?.km, 29.0);
});

test('lookupDeduction: 佐倉 は keiyo 指定で 32.6km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'sakura_tokan', 'keiyo');
  assert.strictEqual(e?.direction, 'keiyo');
  assert.strictEqual(e?.km, 32.6);
});

test('lookupDeduction: 木更津金田 は aqua / 15.1km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'kisarazu_kaneda');
  assert.strictEqual(e?.direction, 'aqua');
  assert.strictEqual(e?.km, 15.1);
});

test('lookupDeduction: 君津 は tateyama 指定で 7.9km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'kimitsu', 'tateyama');
  assert.strictEqual(e?.direction, 'tateyama');
  assert.strictEqual(e?.km, 7.9);
});

test('lookupDeduction: 君津 は aqua 指定で 31.6km (アクア→館山経由)', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'kimitsu', 'aqua');
  assert.strictEqual(e?.direction, 'aqua');
  assert.strictEqual(e?.km, 31.6);
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

test('lookupDeduction: 別所 は wangan_route 指定で 4.0km (推定値)', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'bessho', 'wangan_route');
  assert.strictEqual(e?.direction, 'wangan_route');
  assert.strictEqual(e?.km, 4.0);
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

// ── Task 12: calcOneWayDeduction ──────────────────────────────────────────────

test('calcOneWayDeduction: A=外, B=内 → 表[A]', () => {
  const ded = loadJson('data/deduction.json');
  const ics = loadJson('data/ics.json').ics;
  const A = ics.find(x => x.id === 'tomei_kawasaki');
  const B = ics.find(x => x.id === 'kasumigaseki');
  assert.strictEqual(calcOneWayDeduction(A, B, ded), 7.7);
});

test('calcOneWayDeduction: A=内, B=外 → 表[B]（対称）', () => {
  const ded = loadJson('data/deduction.json');
  const ics = loadJson('data/ics.json').ics;
  const A = ics.find(x => x.id === 'kasumigaseki');
  const B = ics.find(x => x.id === 'tomei_kawasaki');
  assert.strictEqual(calcOneWayDeduction(A, B, ded), 7.7);
});

test('calcOneWayDeduction: A=外/B=外 同方面 → |表[A]-表[B]|', () => {
  const ded = loadJson('data/deduction.json');
  const ics = loadJson('data/ics.json').ics;
  const A = ics.find(x => x.id === 'atsugi');         // tomei 35.0
  const B = ics.find(x => x.id === 'tomei_kawasaki'); // tomei 7.7
  assert.strictEqual(calcOneWayDeduction(A, B, ded), 27.3);
});

test('calcOneWayDeduction: A=内/B=内 → 0', () => {
  const ded = loadJson('data/deduction.json');
  const ics = loadJson('data/ics.json').ics;
  const A = ics.find(x => x.id === 'kasumigaseki');
  const B = ics.find(x => x.id === 'tokyo_ic');
  assert.strictEqual(calcOneWayDeduction(A, B, ded), 0);
});

test('calcOneWayDeduction: 異方面 → 0', () => {
  const ded = loadJson('data/deduction.json');
  const ics = loadJson('data/ics.json').ics;
  const A = ics.find(x => x.id === 'tomei_kawasaki');
  const B = ics.find(x => x.id === 'tokorozawa');
  assert.strictEqual(calcOneWayDeduction(A, B, ded), 0);
});

// ── Task 13: judgeDeduction ───────────────────────────────────────────────────

test('judgeDeduction: 東名川崎⇔霞ヶ関 往復 = 15.4km', () => {
  const ded = loadJson('data/deduction.json');
  const ics = loadJson('data/ics.json').ics;
  const A = ics.find(x => x.id === 'tomei_kawasaki');
  const B = ics.find(x => x.id === 'kasumigaseki');
  assert.strictEqual(judgeDeduction(A, B, ded, true), 15.4);
});

test('judgeDeduction: 片道指定 = 7.7km', () => {
  const ded = loadJson('data/deduction.json');
  const ics = loadJson('data/ics.json').ics;
  const A = ics.find(x => x.id === 'tomei_kawasaki');
  const B = ics.find(x => x.id === 'kasumigaseki');
  assert.strictEqual(judgeDeduction(A, B, ded, false), 7.7);
});

// ── Task 14: computeShutokoPay ────────────────────────────────────────────────

test('computeShutokoPay: 外側本線経由 → company', () => {
  const ics = loadJson('data/ics.json').ics;
  const entry = ics.find(x => x.id === 'tomei_kawasaki');
  const r = computeShutokoPay({ outerRoute: 'tomei', entryIc: entry, isOuter: true });
  assert.strictEqual(r, 'company');
});

test('computeShutokoPay: 外環直乗り → self', () => {
  const ics = loadJson('data/ics.json').ics;
  const entry = ics.find(x => x.id === 'oizumi') || ics.find(x => x.boundary_tag === 'gaikan');
  assert.ok(entry, 'no gaikan IC available');
  const r = computeShutokoPay({ outerRoute: 'gaikan_direct', entryIc: entry, isOuter: false });
  assert.strictEqual(r, 'self');
});

test('computeShutokoPay: 8入口 → company', () => {
  const ics = loadJson('data/ics.json').ics;
  const entry = ics.find(x => x.id === 'maihama');
  const r = computeShutokoPay({ outerRoute: 'none', entryIc: entry, isOuter: false });
  assert.strictEqual(r, 'company');
});

test('computeShutokoPay: 都心側IC → self', () => {
  const ics = loadJson('data/ics.json').ics;
  const entry = ics.find(x => x.id === 'kasumigaseki');
  const r = computeShutokoPay({ outerRoute: 'none', entryIc: entry, isOuter: false });
  assert.strictEqual(r, 'self');
});

// ── Task 15: judgeRoute golden cases ─────────────────────────────────────────

function buildInputs() {
  return {
    ics: loadJson('data/ics.json').ics,
    deduction: loadJson('data/deduction.json'),
    shutokoDist: loadJson('data/shutoko_distances.json'),
    shutokoRoutes: loadJson('data/shutoko_routes.json'),
    shutokoGraph: loadJson('data/shutoko_graph.json'),
    gaikanDist: loadJson('data/gaikan_distances.json'),
    routes: loadJson('data/routes.json')
  };
}
function findIc(ics, id) {
  const r = ics.find(x => x.id === id);
  if (!r) throw new Error('IC not found: ' + id);
  return r;
}

test('ゴールデン #1: tomei 東名川崎→霞ヶ関 往復', () => {
  const d = buildInputs();
  const r = judgeRoute({ outerRoute: 'tomei', entryIc: findIc(d.ics,'tomei_kawasaki'),
    exitIc: findIc(d.ics,'kasumigaseki'), roundTrip: true }, d);
  assert.strictEqual(r.totals.paySummary, 'all_company');
  assert.strictEqual(r.totals.deductionKmRoundtrip, 15.4);
});

test('ゴールデン #2: kanetsu 所沢→霞ヶ関 往復', () => {
  const d = buildInputs();
  const r = judgeRoute({ outerRoute: 'kanetsu', entryIc: findIc(d.ics,'tokorozawa'),
    exitIc: findIc(d.ics,'kasumigaseki'), roundTrip: true }, d);
  assert.strictEqual(r.totals.paySummary, 'all_company');
  assert.ok(r.totals.deductionKmRoundtrip > 18 && r.totals.deductionKmRoundtrip < 22,
    `got ${r.totals.deductionKmRoundtrip}`);
});

test('ゴールデン #3: joban 柏→霞ヶ関 外環なし 往復', () => {
  const d = buildInputs();
  const entry = findIc(d.ics,'kashiwa'); entry._viaGaikan = false;
  const r = judgeRoute({ outerRoute: 'joban', entryIc: entry,
    exitIc: findIc(d.ics,'kasumigaseki'), roundTrip: true }, d);
  assert.strictEqual(r.totals.paySummary, 'all_company');
});

test('ゴールデン #4: joban 柏→霞ヶ関 外環経由 往復', () => {
  const d = buildInputs();
  const entry = findIc(d.ics,'kashiwa'); entry._viaGaikan = true;
  const r = judgeRoute({ outerRoute: 'joban', entryIc: entry,
    exitIc: findIc(d.ics,'kasumigaseki'), roundTrip: true }, d);
  assert.strictEqual(r.totals.paySummary, 'all_company');
});

test('ゴールデン #5: tohoku 浦和→霞ヶ関 外環経由 往復', () => {
  const d = buildInputs();
  const entry = findIc(d.ics,'urawa'); entry._viaGaikan = true;
  const r = judgeRoute({ outerRoute: 'tohoku', entryIc: entry,
    exitIc: findIc(d.ics,'kasumigaseki'), roundTrip: true }, d);
  assert.strictEqual(r.totals.paySummary, 'all_company');
});

test('ゴールデン #6: kanetsu 所沢→霞ヶ関 外環経由 往復', () => {
  const d = buildInputs();
  const entry = findIc(d.ics,'tokorozawa'); entry._viaGaikan = true;
  const r = judgeRoute({ outerRoute: 'kanetsu', entryIc: entry,
    exitIc: findIc(d.ics,'kasumigaseki'), roundTrip: true }, d);
  assert.strictEqual(r.totals.paySummary, 'all_company');
});

test('ゴールデン #7: gaikan_direct 大泉→霞ヶ関 → 全区間 self', () => {
  const d = buildInputs();
  const r = judgeRoute({ outerRoute: 'gaikan_direct', entryIc: findIc(d.ics,'oizumi'),
    exitIc: findIc(d.ics,'kasumigaseki'), roundTrip: true }, d);
  assert.strictEqual(r.totals.paySummary, 'all_self');
  assert.strictEqual(r.totals.deductionKmRoundtrip, 0);
});

test('ゴールデン #8: none 舞浜→霞ヶ関 → company, 控除0', () => {
  const d = buildInputs();
  const r = judgeRoute({ outerRoute: 'none', entryIc: findIc(d.ics,'maihama'),
    exitIc: findIc(d.ics,'kasumigaseki'), roundTrip: true }, d);
  assert.strictEqual(r.totals.paySummary, 'all_company');
  assert.strictEqual(r.totals.deductionKmRoundtrip, 0);
});

test('ゴールデン #9: none 葛西→霞ヶ関 → self, 控除0', () => {
  const d = buildInputs();
  const r = judgeRoute({ outerRoute: 'none', entryIc: findIc(d.ics,'kasai'),
    exitIc: findIc(d.ics,'kasumigaseki'), roundTrip: true }, d);
  assert.strictEqual(r.totals.paySummary, 'all_self');
  assert.strictEqual(r.totals.deductionKmRoundtrip, 0);
});

test('ゴールデン #10: aqua 木更津金田→湾岸環八 往復', () => {
  const d = buildInputs();
  const r = judgeRoute({ outerRoute: 'aqua', entryIc: findIc(d.ics,'kisarazu_kaneda'),
    exitIc: findIc(d.ics,'wangan_kanpachi'), roundTrip: true }, d);
  assert.strictEqual(r.totals.paySummary, 'all_company');
  assert.ok(r.totals.deductionKmRoundtrip > 0);
});

test('ゴールデン #11: yokohane_route 日野→湾岸環八 往復', () => {
  const d = buildInputs();
  const r = judgeRoute({ outerRoute: 'yokohane_route', entryIc: findIc(d.ics,'hino'),
    exitIc: findIc(d.ics,'wangan_kanpachi'), roundTrip: true }, d);
  assert.strictEqual(r.totals.paySummary, 'all_company');
});

test('ゴールデン #12: tomei 東名川崎→三郷JCT (異方面出口) → 外側本線company, 控除15.4', () => {
  const d = buildInputs();
  const r = judgeRoute({ outerRoute: 'tomei', entryIc: findIc(d.ics,'tomei_kawasaki'),
    exitIc: findIc(d.ics,'misato_jct'), roundTrip: true }, d);
  assert.ok(r.totals.deductionKmRoundtrip >= 15 && r.totals.deductionKmRoundtrip <= 16);
});

test('lookupDeduction: 新空港IC tokan ヒントで 48.8km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'shin_kukou', 'tokan');
  assert.strictEqual(e?.direction, 'tokan');
  assert.strictEqual(e?.km, 48.8);
});

test('lookupDeduction: 新空港IC keiyo ヒントで 51.3km', () => {
  const deduction = loadJson('data/deduction.json');
  const e = lookupDeduction(deduction, 'shin_kukou', 'keiyo');
  assert.strictEqual(e?.direction, 'keiyo');
  assert.strictEqual(e?.km, 51.3);
});
