import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { transformArrivals } from '../scripts/lib/arrival-transformer.mjs';

const sample = JSON.parse(readFileSync('./tests/fixtures/odpt-arrival-sample.json', 'utf8'));
const seatsMaster = {
  'B789': { seats: 246 }, 'B772': { seats: 405 },
  'A359': { seats: 369 }, 'B788': { seats: 200 }
};
const factorsMaster = {
  default: 0.70,
  routes: { 'ITM': 0.78, 'CTS': 0.75, 'FUK': 0.75, 'OKA': 0.82 }
};

test('ODPT応答からflights配列を生成', () => {
  const r = transformArrivals(sample, seatsMaster, factorsMaster);
  assert.equal(Array.isArray(r.flights), true);
  assert.equal(r.flights.length, 5);
});

test('便名・出発空港・ターミナルが正しく抽出される', () => {
  const r = transformArrivals(sample, seatsMaster, factorsMaster);
  const f = r.flights[0];
  assert.equal(f.flightNumber, 'JL123');
  assert.equal(f.from, 'ITM');
  assert.equal(f.fromName, '伊丹');
  assert.equal(f.terminal, 'T1');
});

test('機材null便は推定値もnull', () => {
  const r = transformArrivals(sample, seatsMaster, factorsMaster);
  const f = r.flights.find(x => x.flightNumber === 'NH012');
  assert.equal(f.aircraftCode, null);
  assert.equal(f.estimatedPax, null);
});

test('遅延便のステータスとestimatedTimeが正しい', () => {
  const r = transformArrivals(sample, seatsMaster, factorsMaster);
  const f = r.flights.find(x => x.flightNumber === 'JL789');
  assert.equal(f.status, '遅延');
  assert.equal(f.estimatedTime, '15:05');
  assert.equal(f.scheduledTime, '14:55');
});

test('stats が便数集計を返す', () => {
  const r = transformArrivals(sample, seatsMaster, factorsMaster);
  assert.equal(r.stats.totalFlights, 5);
  assert.equal(r.stats.unknownAircraft, 1);
  assert.deepEqual(r.stats.byTerminal, { T1: 2, T2: 2, T3: 1 });
});

test('updatedAt が ISO8601 形式（+09:00）', () => {
  const r = transformArrivals(sample, seatsMaster, factorsMaster);
  assert.match(r.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
});

test('国内空港は isInternational=false', () => {
  const r = transformArrivals(sample, seatsMaster, factorsMaster);
  const itm = r.flights.find(f => f.from === 'ITM');
  assert.equal(itm.isInternational, false);
});

test('国際空港は isInternational=true、stats に internationalFlights を含む', () => {
  const intlSample = [
    {
      "@type": "odpt:FlightInformationArrival",
      "odpt:flightNumber": ["JL027"],
      "odpt:originAirport": "odpt.Airport:JFK",
      "odpt:arrivalAirportTerminal": "odpt.AirportTerminal:HND.Terminal3",
      "odpt:scheduledArrivalTime": "11:00",
      "odpt:flightStatus": "odpt.FlightStatus:OnTime",
      "odpt:aircraftType": "B789"
    },
    {
      "@type": "odpt:FlightInformationArrival",
      "odpt:flightNumber": ["NH001"],
      "odpt:originAirport": "odpt.Airport:OKA",
      "odpt:arrivalAirportTerminal": "odpt.AirportTerminal:HND.Terminal2",
      "odpt:scheduledArrivalTime": "10:00",
      "odpt:flightStatus": "odpt.FlightStatus:OnTime",
      "odpt:aircraftType": "B772"
    }
  ];
  const r = transformArrivals(intlSample, seatsMaster, factorsMaster);
  const intl = r.flights.find(f => f.flightNumber === 'JL027');
  const dom = r.flights.find(f => f.flightNumber === 'NH001');
  assert.equal(intl.isInternational, true);
  assert.equal(dom.isInternational, false);
  assert.equal(r.stats.internationalFlights, 1);
});

import { readFileSync as rfs2 } from 'node:fs';

const transitShareReal = JSON.parse(rfs2('./data/transit-share.json', 'utf8'));
const routesReal = JSON.parse(rfs2('./data/last-mile-routes.json', 'utf8'));
const egressReal = JSON.parse(rfs2('./data/terminal-egress.json', 'utf8'));
const railOk = { Keikyu: { status: 'OnTime', delayMinutes: 0 }, TokyoMonorail: { status: 'OnTime', delayMinutes: 0 } };

test('taxi拡張: 各便に lobbyExitTime / reachRate / reachTier / estimatedTaxiPax フィールドが出る', () => {
  const r = transformArrivals(sample, seatsMaster, factorsMaster, {
    transitShare: transitShareReal,
    routes: routesReal,
    egress: egressReal,
    railStatus: railOk,
    dayType: 'weekday'
  });
  for (const f of r.flights) {
    assert.ok('lobbyExitTime' in f);
    assert.ok('reachRate' in f);
    assert.ok('reachTier' in f);
    assert.ok('estimatedTaxiPax' in f);
  }
});

test('taxi拡張: 機材nullの便は estimatedTaxiPax も null', () => {
  const r = transformArrivals(sample, seatsMaster, factorsMaster, {
    transitShare: transitShareReal,
    routes: routesReal,
    egress: egressReal,
    railStatus: railOk,
    dayType: 'weekday'
  });
  const f = r.flights.find(x => x.flightNumber === 'NH012');
  assert.equal(f.estimatedPax, null);
  assert.equal(f.estimatedTaxiPax, null);
});

test('taxi拡張: stats.totalEstimatedTaxiPax が便ごとの合計', () => {
  const r = transformArrivals(sample, seatsMaster, factorsMaster, {
    transitShare: transitShareReal,
    routes: routesReal,
    egress: egressReal,
    railStatus: railOk,
    dayType: 'weekday'
  });
  const sum = r.flights.reduce((s, f) => s + (f.estimatedTaxiPax ?? 0), 0);
  assert.equal(r.stats.totalEstimatedTaxiPax, sum);
});

test('taxi拡張: 引数 taxiOpts なしでも既存挙動を維持', () => {
  const r = transformArrivals(sample, seatsMaster, factorsMaster);
  assert.equal(r.flights.length, 5);
  for (const f of r.flights) {
    assert.equal(f.lobbyExitTime, null);
    assert.equal(f.reachRate, null);
    assert.equal(f.estimatedTaxiPax, null);
  }
});
