// 乗り場(号)の実績学習 A=便別 / B=パターン別 (2026-08-14 本人要望)。
// 遅延便は通常と違う号に着くことがあり、静的推定(出口番号→号)では追えない。
// 現地掲示で確定した実績を貯め、「この便/この状況ならこの号」を出せるようにする。
import { test } from 'node:test';
import assert from 'node:assert';
import {
  noticeNameToFlightNumber, normalizeFlightNumber, etaToMinutes, timeBand,
  extractLaneActuals, dedupeActuals, learnByFlight, learnByPattern, predictLane,
} from '../scripts/lib/lane-actuals.mjs';

test('noticeNameToFlightNumber: 掲示の表記ゆれをIATA便名に寄せる', () => {
  assert.equal(noticeNameToFlightNumber('ANA84 札幌便'), 'NH84');
  assert.equal(noticeNameToFlightNumber('全日空 966 深圳便'), 'NH966');
  assert.equal(noticeNameToFlightNumber('ソラシド26 沖縄便'), '6J26');
  assert.equal(noticeNameToFlightNumber('エアドゥ38便'), 'HD38');
  assert.equal(noticeNameToFlightNumber('JAL0528'), 'JL528');
  assert.equal(noticeNameToFlightNumber('ANA深圳便'), null, '便番号なしは学習に使わない');
});

test('normalizeFlightNumber: ゼロ詰め・空白を吸収', () => {
  assert.equal(normalizeFlightNumber('NH0084'), 'NH84');
  assert.equal(normalizeFlightNumber(' nh 84 '), 'NH84');
  assert.equal(normalizeFlightNumber(null), null);
});

test('etaToMinutes/timeBand: 深夜は翌日側に送って時間帯を分ける', () => {
  assert.equal(etaToMinutes('23:30'), 23 * 60 + 30);
  assert.equal(etaToMinutes('0:48'), 48 + 1440, '0時台は翌日扱い');
  assert.equal(timeBand('21:00'), 'day');
  assert.equal(timeBand('22:30'), 'late22');
  assert.equal(timeBand('23:40'), 'late23');
  assert.equal(timeBand('0:20'), 'mid00');
  assert.equal(timeBand('1:15'), 'mid01+');
  assert.equal(timeBand(null), 'unknown');
});

test('extractLaneActuals: 便番号と号が揃った掲示だけを実績にする', () => {
  const row = { ts: '2026-08-07T00:56:00+09:00' };
  const parsed = { flights: [
    { name: 'ANA84 札幌便', stall: 4, eta: { text: '0:48' }, pax: 71 },
    { name: 'ANA深圳便', stall: 4, eta: { text: '2:00' }, pax: 200 },  // 便番号なし→除外
    { name: 'JAL920 沖縄便', stall: null, eta: { text: '23:40' } },      // 号なし→除外
  ] };
  const rows = extractLaneActuals(row, parsed);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    date: '2026-08-07', flightNumber: 'NH84', stall: 4, eta: '0:48', pax: 71,
    band: 'mid00', source: 'notice',
  });
});

test('dedupeActuals: 同じ日の同じ便は最後の掲示を採る(掲示は更新される)', () => {
  const rows = [
    { date: '2026-08-07', flightNumber: 'NH84', stall: 3 },
    { date: '2026-08-07', flightNumber: 'NH84', stall: 4 },  // 更新後
    { date: '2026-08-06', flightNumber: 'NH84', stall: 4 },
  ];
  const out = dedupeActuals(rows);
  assert.equal(out.length, 2);
  assert.equal(out.find(r => r.date === '2026-08-07').stall, 4);
});

const mk = (date, fno, stall, eta) => ({ date, flightNumber: fno, stall, eta, band: timeBand(eta) });

test('learnByFlight(A): 便ごとの最多号と割合を出す・1回だけの便は出さない', () => {
  const actuals = [
    mk('2026-08-01', 'BC522', 2, '23:50'), mk('2026-08-02', 'BC522', 2, '23:55'),
    mk('2026-08-03', 'BC522', 2, '0:10'),
    mk('2026-08-01', 'NH84', 3, '23:59'), mk('2026-08-02', 'NH84', 4, '0:48'),
    mk('2026-08-01', 'JL999', 1, '23:00'),  // 1回のみ→除外
  ];
  const m = learnByFlight(actuals);
  assert.equal(m.BC522.n, 3);
  assert.equal(m.BC522.stall, 2);
  assert.equal(m.BC522.share, 1);
  assert.equal(m.NH84.share, 0.5, '割れる便は割合が下がる');
  assert.equal(m.JL999, undefined);
});

test('learnByPattern(B): 時間帯×航空会社で号の傾向を出す', () => {
  const actuals = [
    mk('2026-08-01', 'NH84', 4, '0:10'), mk('2026-08-02', 'NH90', 4, '0:30'),
    mk('2026-08-03', 'NH92', 4, '0:50'),
    mk('2026-08-01', 'NH1096', 3, '1:50'), mk('2026-08-02', 'NH1098', 3, '1:20'),
  ];
  const m = learnByPattern(actuals);
  assert.equal(m['mid00|NH'].stall, 4);
  assert.equal(m['mid00|NH'].n, 3);
  assert.equal(m['mid01+|NH'], undefined, '3件未満は出さない');
});

test('predictLane: 便別(A)を優先し、無ければパターン別(B)にフォールバック', () => {
  const model = {
    byFlight: { NH84: { n: 4, stall: 4, share: 0.75, dist: { 4: 3, 3: 1 }, lastDate: '2026-08-07' } },
    byPattern: { 'mid00|NH': { n: 5, stall: 4, share: 1, dist: { 4: 5 }, lastDate: '2026-08-07' } },
  };
  const a = predictLane({ flightNumber: 'NH084', estimatedTime: '0:48' }, model);
  assert.equal(a.basis, 'flight');
  assert.equal(a.stall, 4);
  const b = predictLane({ flightNumber: 'NH999', estimatedTime: '0:20' }, model);
  assert.equal(b.basis, 'pattern');
  assert.equal(b.key, 'mid00|NH');
  const none = predictLane({ flightNumber: 'JL999', estimatedTime: '15:00' }, model);
  assert.equal(none, null, '実績が無ければ何も言わない');
});
