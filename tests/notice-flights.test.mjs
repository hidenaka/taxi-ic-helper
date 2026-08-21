// notice-flights のテスト。
// フィクスチャは 2026-06-19〜08-07 に実際に掲示された遅延便テキスト84種
// (tests/fixtures/flight-notice-corpus.json)。代表パターンを個別に固定し、
// 最後に84種全量のスモーク(例外なし+抽出量の下限)を確認する。
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  parseEta, parsePax, parseStallHeader, parseExitAssign, parseStandPax,
  parseFlightNotice, summarizeFlightNotice, normalizeNoticeText,
} from '../scripts/lib/notice-flights.mjs';

const corpus = JSON.parse(readFileSync(new URL('./fixtures/flight-notice-corpus.json', import.meta.url), 'utf8'));

test('parseEta: 時刻表現のゆれを読める', () => {
  assert.deepEqual(parseEta('23:51到着予定').text, '23:51');
  assert.deepEqual(parseEta('0：09 到着予定'.replace(/：/g, ':')).text, '0:09');
  assert.equal(parseEta('23時32分').text, '23:32');
  assert.equal(parseEta('午前0時16分 到着予定').text, '0:16');
  assert.equal(parseEta('午後11時30分頃到着予定').text, '23:30');
  assert.equal(parseEta('午前2時頃').text, '2:00');
  assert.equal(parseEta('午前2時過ぎ').approx, true);
  // 24時台は当日深夜として minutes は 1440+、表示は 0時台
  const h24 = parseEta('24時13分');
  assert.equal(h24.text, '0:13');
  assert.equal(h24.minutes, 24 * 60 + 13);
  // 変更後時刻(→の右)を採る。「翌」付きも読む
  assert.equal(parseEta('22:55→23:47').text, '23:47');
  assert.equal(parseEta('22:40→翌1:35').text, '1:35');
  assert.equal(parseEta('時刻未定').minutes, null);
  assert.equal(parseEta('第1待機所'), null);
});

test('parsePax: 人数だけ拾い運賃や便数は拾わない', () => {
  assert.equal(parsePax('降機客数約100名'), 100);
  assert.equal(parsePax('搭乗人数約230人'), 230);
  assert.equal(parsePax('約1,400名'.replace(/(\d),(?=\d{3})/g, '$1')), 1400);
  assert.equal(parsePax('人数：484人'.replace(/：/g, ':')), 484);
  assert.equal(parsePax('15,000円'), null);
  assert.equal(parsePax('遅延便2便'), null);
  assert.equal(parsePax('搭乗人数不明'), null);
});

test('parseStallHeader: 号ヘッダのゆれを読める', () => {
  assert.equal(parseStallHeader('【1号乗り場】'), 1);
  assert.equal(parseStallHeader('・3号乗り場側・'), 3);
  assert.equal(parseStallHeader('〇3号'), 3);
  assert.equal(parseStallHeader('4号側'), 4);
  assert.equal(parseStallHeader('2号乗り場'), 2);
  assert.equal(parseStallHeader('・4号乗り場側'), 4);
  // 便行・人数行はヘッダではない
  assert.equal(parseStallHeader('1号 約50人'), null);
  assert.equal(parseStallHeader('JAL920 沖縄便 23:40 356人'), null);
});

test('parseExitAssign: 出口指定行のゆれを読める', () => {
  assert.deepEqual(parseExitAssign('到着出口:4号乗り場'), { stall: 4, scope: 'prev' });
  assert.deepEqual(parseExitAssign('出口→3号側(変更の可能性あり)'), { stall: 3, scope: 'prev' });
  assert.deepEqual(parseExitAssign('2号側の予定'), { stall: 2, scope: 'prev' });
  assert.deepEqual(parseExitAssign('両便共に第4乗り場に到着予定です。'), { stall: 4, scope: 'all' });
  assert.deepEqual(parseExitAssign('第4乗り場に到着予定です。'), { stall: 4, scope: 'prev' });
  assert.equal(parseExitAssign('到着出口3号側予定').stall, 3);
});

test('parseStandPax: 客列人数のゆれを読める', () => {
  assert.deepEqual(parseStandPax('第2乗り場・・・約1400名'), { stalls: [2], pax: 1400 });
  assert.deepEqual(parseStandPax('・第2乗り場→約70人'), { stalls: [2], pax: 70 });
  assert.deepEqual(parseStandPax('1号 約50人'), { stalls: [1], pax: 50 });
  assert.deepEqual(parseStandPax('1,3号 約50人'), { stalls: [1, 3], pax: 50 });
  assert.deepEqual(parseStandPax('3号乗り場50人の客列'), { stalls: [3], pax: 50 });
  assert.equal(parseStandPax('第1ターミナル側計750人'), null); // ターミナル合算はgroups
});

// ---- 代表フィクスチャ(実掲示テキスト) ----

function fx(i) { return corpus[i].text; }

test('号ヘッダ型: 1号/3号の便が号付きで取れる (2026-06-19)', () => {
  const p = parseFlightNotice(fx(0));
  assert.equal(p.flights.length, 2);
  assert.deepEqual(p.flights.map((f) => f.stall), [1, 3]);
  assert.equal(p.flights[0].eta.text, '23:51');
  assert.equal(p.flights[0].pax, 100);
  assert.equal(p.flights[1].arrived, false);
});

test('4乗り場フル掲示: 11便が号別に取れる (2026-06-26)', () => {
  const p = parseFlightNotice(fx(23));
  assert.equal(p.flights.length, 11);
  const byStall = {};
  for (const f of p.flights) byStall[f.stall] = (byStall[f.stall] || 0) + 1;
  assert.deepEqual(byStall, { 1: 3, 2: 3, 3: 2, 4: 3 });
  // 運賃(15,000円)を人数と混同しない
  const ana78 = p.flights.find((f) => /ANA78/.test(f.name));
  assert.equal(ana78.pax, 380);
  assert.equal(ana78.eta.text, '0:40');
});

test('複数行ブロック+到着出口: ANA深圳便が4号に割り当たる (2026-07-07)', () => {
  const p = parseFlightNotice(fx(36));
  const f4 = p.flights.find((f) => f.stall === 4);
  assert.ok(f4, '4号の便がある');
  assert.match(f4.name, /ANA深圳便/);
  assert.equal(f4.eta.text, '2:00');
  assert.equal(f4.pax, 200);
});

test('・N号乗り場側・型: 3号/4号の便が取れる (2026-07-12)', () => {
  const p = parseFlightNotice(fx(42));
  assert.equal(p.flights.length, 2);
  assert.deepEqual(p.flights.map((f) => [f.stall, f.eta.text, f.pax]), [
    [3, '0:16', 484],
    [4, '0:02', 394],
  ]);
});

test('出口行だけの匿名グループ: 2便共に第3乗り場 (2026-07-19)', () => {
  const p = parseFlightNotice(fx(48));
  assert.equal(p.flights.length, 0);
  assert.equal(p.groups.length, 1);
  assert.equal(p.groups[0].stall, 3);
  assert.equal(p.groups[0].count, 2);
  assert.equal(p.groups[0].eta.text, '0:00');
});

test('ターミナル型+24時台: T2の便が読める (2026-07-24 台風)', () => {
  const p = parseFlightNotice(fx(53));
  const t2 = p.flights.filter((f) => f.terminal === 2);
  assert.ok(t2.length >= 7, `T2の便が7便以上: ${t2.length}`);
  const ana2400 = t2.find((f) => f.eta?.minutes === 1440);
  assert.ok(ana2400, '24時00分の便が読める(翌0:00扱い)');
  const tbd = t2.find((f) => f.eta?.text === '未定');
  assert.ok(tbd, '時刻未定の便も残る');
});

test('乗り場別見込み人数: 第2乗り場…約1,400名 (2026-07-26 雷雨)', () => {
  const p = parseFlightNotice(fx(62));
  assert.equal(p.flights.length, 0);
  const s = summarizeFlightNotice(p);
  assert.deepEqual(s.queue, { 1: 160, 2: 1400, 3: 1700, 4: 400 });
});

test('人数が単独行+号側の予定: 2号/3号に割り当たる (2026-07-27)', () => {
  const p = parseFlightNotice(fx(65));
  assert.equal(p.flights.length, 3);
  assert.deepEqual(p.flights.map((f) => [f.stall, f.pax]), [
    [2, 320], [2, 98], [3, 306],
  ]);
});

test('合算グループ: 2便ともに0:40頃・500人が1グループに併合 (2026-08-05)', () => {
  const p = parseFlightNotice(fx(77));
  assert.equal(p.groups.length, 2);
  const g3 = p.groups.find((g) => g.stall === 3);
  assert.equal(g3.count, 2);
  assert.equal(g3.pax, 500);
  assert.equal(g3.eta.text, '0:40');
  const g4 = p.groups.find((g) => g.stall === 4);
  assert.equal(g4.pax, 150);
});

test('便リスト+後追い合算人数: 便数を二重に数えない (2026-08-06)', () => {
  const p = parseFlightNotice(fx(78));
  const s = summarizeFlightNotice(p);
  // 3号: 便2(うち1到着済) + 合算500人グループ(coversFlights) → 未着1便 + 500人
  assert.equal(s.byStall[3].pendingFlights, 1);
  assert.equal(s.byStall[3].pendingPax, 500);
  // 0:25「到着。」は済み扱い
  const arrived = p.flights.filter((f) => f.stall === 3 && f.arrived);
  assert.equal(arrived.length, 1);
});

test('両便共に第4乗り場: 全便へ一括割り当て (2026-08-06)', () => {
  const p = parseFlightNotice(fx(79));
  assert.equal(p.flights.length, 2);
  assert.ok(p.flights.every((f) => f.stall === 4));
});

test('全便到着済/まもなく終了の消し込み', () => {
  assert.equal(parseFlightNotice(fx(66)).allClear, true);
  assert.equal(parseFlightNotice(fx(49)).endingSoon, true);
});

test('summarize: 未着だけ集計・nextEtaは最早', () => {
  const p = parseFlightNotice(fx(23));
  const s = summarizeFlightNotice(p);
  assert.equal(s.byStall[1].pendingFlights, 3);
  assert.equal(s.byStall[1].pendingPax, 356 + 145 + 197);
  assert.equal(s.byStall[1].nextEta, '23:40');
  assert.equal(s.byStall[3].pendingPax, 380 + 76);
});

test('コーパス全量スモーク: 84種すべて例外なくパースでき、抽出量が下限を満たす', () => {
  assert.ok(corpus.length >= 80, `コーパス: ${corpus.length}種`);
  let flights = 0; let groups = 0; let standPax = 0; let signals = 0;
  for (const { text } of corpus) {
    const p = parseFlightNotice(text); // 例外を出さない
    flights += p.flights.length;
    groups += p.groups.length;
    standPax += p.standPax.length;
    if (p.flights.length || p.groups.length || p.standPax.length || p.allClear || p.endingSoon) signals += 1;
    // 抽出結果の整合: 号は1-4、便は名前あり
    for (const f of p.flights) {
      assert.ok(f.stall === null || (f.stall >= 1 && f.stall <= 4));
      assert.ok(f.name.length > 0);
    }
  }
  assert.ok(flights >= 250, `便抽出 ${flights} >= 250`);
  assert.ok(groups >= 5, `グループ抽出 ${groups} >= 5`);
  assert.ok(standPax >= 10, `客列抽出 ${standPax} >= 10`);
  assert.ok(signals >= 78, `何かしら読めた掲示 ${signals}/84 >= 78`);
});

test('最終便情報型(2026-08-21): 便名行のインライン号と時刻+人数行を読む', () => {
  const row = corpus.find((c) => c.firstSeen === '2026-08-21T18:52:44+09:00');
  assert.ok(row, 'フィクスチャに2026-08-21掲示がある');
  const p = parseFlightNotice(row.text);
  const byName = Object.fromEntries(p.flights.map((f) => [f.name, f]));
  assert.equal(byName['SKY730札幌'].stall, 2);
  assert.equal(byName['SKY730札幌'].eta.text, '0:48');
  assert.equal(byName['SKY730札幌'].pax, 128);
  assert.equal(byName['ANA78札幌'].stall, 3);
  assert.equal(byName['ANA78札幌'].eta.text, '1:40');
  assert.equal(byName['ANA78札幌'].pax, 380);
  assert.equal(byName['ANA38札幌'].stall, 3);
  assert.equal(byName['ANA38札幌'].eta.text, '0:40');
  assert.equal(byName['ANA38札幌'].pax, 264);
  // 客列状況(1〜4号 各300/300/500/300名)も拾えている
  const sum = summarizeFlightNotice(p);
  assert.equal(sum.queue[3], 500);
  assert.equal(sum.queue[1], 300);
});

test('normalizeNoticeText: 全角と桁区切りの正規化', () => {
  assert.equal(normalizeNoticeText('２３：４５　約１,４００名'), '23:45 約1400名');
});
