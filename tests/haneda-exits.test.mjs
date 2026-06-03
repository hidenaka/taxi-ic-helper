import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  normalizeFlightNumber,
  exitToWing,
  flightWing,
  poolLane,
  parseHanedaArrivals,
  buildWingMap,
  fetchHanedaArrivalsRaw,
  fetchWingMap
} from '../scripts/lib/haneda-exits.mjs';

const wingTable = JSON.parse(readFileSync('./data/haneda-exit-wing.json', 'utf8')).wing;

test('normalizeFlightNumber: 大文字化・記号除去・ゼロ詰め吸収', () => {
  assert.equal(normalizeFlightNumber(' nh 0066 '), 'NH66');
  assert.equal(normalizeFlightNumber('JL906'), 'JL906');
  assert.equal(normalizeFlightNumber('7G40'), '7G40'); // 数字始まりの航空会社コードはそのまま
  assert.equal(normalizeFlightNumber(null), '');
});

test('exitToWing: T1とT2で向きが逆', () => {
  // T1: 低番号=南
  assert.equal(exitToWing('T1', '1', wingTable), '南');
  assert.equal(exitToWing('T1', '8', wingTable), '北');
  // T2: 低番号=北
  assert.equal(exitToWing('T2', '1', wingTable), '北');
  assert.equal(exitToWing('T2', '8', wingTable), '南');
  // 未知
  assert.equal(exitToWing('T3', '1', wingTable), null);
  assert.equal(exitToWing('T1', '99', wingTable), null);
});

test('flightWing: 同一wingの隣接出口', () => {
  assert.equal(flightWing('T1', ['1', '3'], wingTable), '南'); // 両方南
  assert.equal(flightWing('T1', ['6', '8'], wingTable), '北'); // 両方北
  assert.equal(flightWing('T2', ['1', '2'], wingTable), '北');
  assert.equal(flightWing('T2', ['5', '6'], wingTable), '南');
});

test('flightWing: 出口なし→null', () => {
  assert.equal(flightWing('T1', [], wingTable), null);
  assert.equal(flightWing('T1', null, wingTable), null);
});

test('flightWing: 北南混在は最小番号の出口を優先', () => {
  // T1 出口4(南)と5(北) → 最小=4=南
  assert.equal(flightWing('T1', ['4', '5'], wingTable), '南');
  // T2 出口4(北)と5(南) → 最小=4=北
  assert.equal(flightWing('T2', ['5', '4'], wingTable), '北');
});

test('poolLane: 号乗り場マッピング(terminal+wingベース)', () => {
  assert.equal(poolLane('T1', '南'), 1);
  assert.equal(poolLane('T1', '北'), 2);
  assert.equal(poolLane('T2', '北'), 3);
  assert.equal(poolLane('T2', '南'), 4);
  // T3 = 国際線 → 4号
  assert.equal(poolLane('T3', null), 4);
  // wing 未確定の国内便は null
  assert.equal(poolLane('T1', null), null);
  assert.equal(poolLane('T2', null), null);
  // T1 は国内専用: 誤った国際判定があっても 4号 にしない(UBJ等の回帰防止)
  assert.equal(poolLane('T1', '南'), 1);
});

test('parseHanedaArrivals: terminal/便名/出口を抽出', () => {
  const sample = {
    flightlists: [
      {
        terminal: { terminal: 'T1' },
        airlines: [{ flightNumber: '7G40' }, { flightNumber: 'NH3840' }],
        options: [{ type: 'exitGate', title: '出口', items: [{ name: '1' }, { name: '2' }] }]
      },
      {
        terminal: { terminal: 'T2' },
        airlines: [{ flightNumber: 'NH262' }],
        options: [{ type: 'exitGate', items: [] }] // 欠航等で出口なし
      }
    ]
  };
  const r = parseHanedaArrivals(sample);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0].flightNumbers, ['7G40', 'NH3840']);
  assert.equal(r[0].terminal, 'T1');
  assert.deepEqual(r[0].exits, ['1', '2']);
  assert.deepEqual(r[1].exits, []);
});

test('parseHanedaArrivals: 不正入力に強い', () => {
  assert.deepEqual(parseHanedaArrivals(null), []);
  assert.deepEqual(parseHanedaArrivals({}), []);
  assert.deepEqual(parseHanedaArrivals({ flightlists: 'x' }), []);
});

test('buildWingMap: コードシェア両便名を同wingに、出口なしは除外', () => {
  const sample = {
    flightlists: [
      {
        terminal: { terminal: 'T1' },
        airlines: [{ flightNumber: '7G40' }, { flightNumber: 'NH3840' }],
        options: [{ type: 'exitGate', items: [{ name: '1' }, { name: '2' }] }]
      },
      {
        terminal: { terminal: 'T2' },
        airlines: [{ flightNumber: 'NH262' }],
        options: []
      }
    ]
  };
  const m = buildWingMap(sample, wingTable);
  assert.equal(m['7G40'], '南');
  assert.equal(m['NH3840'], '南'); // コードシェア相方も登録
  assert.equal(m['NH262'], undefined); // 出口なしは登録しない
});

test('fetchHanedaArrivalsRaw: 注入fetchで正しいbodyをPOST', async () => {
  let captured = null;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, json: async () => ({ count: 0, flightlists: [] }) };
  };
  const j = await fetchHanedaArrivalsRaw('20260603', fakeFetch);
  assert.equal(captured.url, 'https://tokyo-haneda.com/app/api/v2/flight/search');
  assert.equal(captured.opts.method, 'POST');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.flightType, 1);
  assert.equal(body.arrivalType, 2);
  assert.equal(body.searchDt, '20260603');
  assert.deepEqual(body.airportCodes, []);
  assert.deepEqual(j.flightlists, []);
});

test('fetchHanedaArrivalsRaw: HTTPエラーで例外', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => fetchHanedaArrivalsRaw('20260603', fakeFetch), /HTTP 503/);
});

test('fetchWingMap: 取得→マップ構築の一括', async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      flightlists: [{
        terminal: { terminal: 'T2' },
        airlines: [{ flightNumber: 'NH266' }],
        options: [{ type: 'exitGate', items: [{ name: '1' }, { name: '2' }] }]
      }]
    })
  });
  const m = await fetchWingMap('20260603', wingTable, fakeFetch);
  assert.equal(m['NH266'], '北');
});
