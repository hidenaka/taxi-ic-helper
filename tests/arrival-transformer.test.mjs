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
      "odpt:departureAirport": "odpt.Airport:JFK",
      "odpt:terminal": "odpt.AirportTerminal:HND.T3",
      "odpt:scheduledTime": "11:00",
      "odpt:flightStatus": "odpt.FlightStatus:OnTime",
      "odpt:aircraftModel": "B789"
    },
    {
      "@type": "odpt:FlightInformationArrival",
      "odpt:flightNumber": ["NH001"],
      "odpt:departureAirport": "odpt.Airport:OKA",
      "odpt:terminal": "odpt.AirportTerminal:HND.T2",
      "odpt:scheduledTime": "10:00",
      "odpt:flightStatus": "odpt.FlightStatus:OnTime",
      "odpt:aircraftModel": "B772"
    }
  ];
  const r = transformArrivals(intlSample, seatsMaster, factorsMaster);
  const intl = r.flights.find(f => f.flightNumber === 'JL027');
  const dom = r.flights.find(f => f.flightNumber === 'NH001');
  assert.equal(intl.isInternational, true);
  assert.equal(dom.isInternational, false);
  assert.equal(r.stats.internationalFlights, 1);
});
