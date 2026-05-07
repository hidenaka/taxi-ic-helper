#!/usr/bin/env node
/**
 * ODPT_TOKEN 取得前の動作確認用。
 * 現実的な羽田到着便スケジュール（JAL/ANA定期便パターン）の mock を ODPT 形式で生成し、
 * 既存パイプライン（transformArrivals）を通して data/arrivals.json を出力する。
 *
 * 使い方:
 *   node scripts/generate-mock-arrivals.mjs
 *   npm run serve
 *   open http://localhost:8000/arrivals.html
 *
 * トークン取得後は GitHub Actions 側で本物のODPTデータが書き込むため、このスクリプトは不要。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { transformArrivals } from './lib/arrival-transformer.mjs';

const seatsMaster = JSON.parse(readFileSync('./data/aircraft-seats.json', 'utf8'));
const factorsMaster = JSON.parse(readFileSync('./data/load-factors.json', 'utf8'));
const transitShare = JSON.parse(readFileSync('./data/transit-share.json', 'utf8'));
const routes = JSON.parse(readFileSync('./data/last-mile-routes.json', 'utf8'));
const egress = JSON.parse(readFileSync('./data/terminal-egress.json', 'utf8'));

// 環境変数 MOCK_LIGHTNING_RECOVERY_HHMM が指定されていれば雷解除直後シナリオを差し込む
// （未指定なら data/weather.json があれば読む、なければ null）
let weatherContext = null;
const envRecovery = process.env.MOCK_LIGHTNING_RECOVERY_HHMM;
const envActive = process.env.MOCK_LIGHTNING_ACTIVE === '1';
if (envActive) {
  weatherContext = { weatherCode: 95, lightningActive: true, lightningRecoveryStartHHMM: null };
} else if (envRecovery) {
  weatherContext = { weatherCode: 80, lightningActive: false, lightningRecoveryStartHHMM: envRecovery };
} else if (existsSync('./data/weather.json')) {
  try {
    const w = JSON.parse(readFileSync('./data/weather.json', 'utf8'));
    weatherContext = {
      weatherCode: w.current?.weatherCode ?? null,
      lightningActive: !!w.current?.lightningActive,
      lightningRecoveryStartHHMM: w.lightningRecoveryStartHHMM ?? null
    };
  } catch {
    weatherContext = null;
  }
}

const railOk = {
  Keikyu: { status: 'OnTime', delayMinutes: 0 },
  TokyoMonorail: { status: 'OnTime', delayMinutes: 0 }
};

const jstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
const dayOfWeek = jstNow.getDay();
const dayType = (dayOfWeek === 0 || dayOfWeek === 6) ? 'holiday' : 'weekday';

// [flightNo, operator, from, terminal, sched, status, aircraft, estimated?]
// status: 'OnTime' | 'Delayed' | 'Arrived' | 'Cancelled'
const SCHEDULE = [
  // 早朝〜朝（5-9時）— タクシー利用少なめ、出張組
  ['JL101', 'JAL', 'CTS', 'T1', '07:30', 'OnTime', 'B772'],
  ['NH001', 'ANA', 'CTS', 'T2', '07:35', 'OnTime', 'B789'],
  ['JL201', 'JAL', 'ITM', 'T1', '07:55', 'OnTime', 'B738'],
  ['NH011', 'ANA', 'ITM', 'T2', '08:00', 'OnTime', 'A321'],
  ['JL301', 'JAL', 'FUK', 'T1', '08:20', 'OnTime', 'B772'],
  ['NH241', 'ANA', 'FUK', 'T2', '08:30', 'OnTime', 'B788'],
  ['JL901', 'JAL', 'OKA', 'T1', '08:45', 'OnTime', 'B738'],

  // 昼前（9-12時）
  ['NH107', 'ANA', 'PEK', 'T3', '09:30', 'OnTime', 'B789'],
  ['JL113', 'JAL', 'CTS', 'T1', '09:45', 'OnTime', 'B789'],
  ['NH015', 'ANA', 'ITM', 'T2', '10:15', 'OnTime', 'A321'],
  ['JL311', 'JAL', 'FUK', 'T1', '10:30', 'OnTime', 'B738'],
  ['NH243', 'ANA', 'KOJ', 'T2', '11:00', 'OnTime', 'B738'],
  ['JL027', 'JAL', 'JFK', 'T3', '11:25', 'OnTime', 'B789'],
  ['NH105', 'ANA', 'FRA', 'T3', '11:45', 'OnTime', 'B77W'],

  // 昼過ぎ（12-15時）
  ['JL117', 'JAL', 'CTS', 'T1', '12:15', 'OnTime', 'B772'],
  ['NH019', 'ANA', 'ITM', 'T2', '12:35', 'OnTime', 'B789'],
  ['JL317', 'JAL', 'FUK', 'T1', '13:00', 'OnTime', 'B772'],
  ['NH245', 'ANA', 'OKA', 'T2', '13:30', 'OnTime', 'B789'],
  ['JL905', 'JAL', 'OKA', 'T1', '14:00', 'OnTime', 'B789'],
  ['JL015', 'JAL', 'HKG', 'T3', '14:25', 'OnTime', 'B788'],
  ['NH121', 'ANA', 'CTS', 'T2', '14:50', 'OnTime', 'B738'],

  // 夕方（15-17時）
  ['JL225', 'JAL', 'ITM', 'T1', '15:20', 'OnTime', 'B738'],
  ['NH033', 'ANA', 'ITM', 'T2', '15:45', 'OnTime', 'A321'],
  ['JL319', 'JAL', 'FUK', 'T1', '16:10', 'OnTime', 'B772'],
  ['NH257', 'ANA', 'FUK', 'T2', '16:35', 'OnTime', 'B788'],
  ['JL129', 'JAL', 'CTS', 'T1', '16:50', 'OnTime', 'B789'],

  // ピーク帯（17-19時）— 第1ピーク
  ['NH067', 'ANA', 'CTS', 'T2', '17:15', 'OnTime', 'B789'],
  ['JL227', 'JAL', 'ITM', 'T1', '17:30', 'OnTime', 'B738'],
  ['NH035', 'ANA', 'ITM', 'T2', '17:45', 'OnTime', 'A321'],
  ['JL135', 'JAL', 'CTS', 'T1', '18:00', 'OnTime', 'B789'],
  ['NH075', 'ANA', 'CTS', 'T2', '18:20', 'OnTime', 'B772'],
  ['JL321', 'JAL', 'FUK', 'T1', '18:30', 'OnTime', 'B772'],
  ['NH261', 'ANA', 'FUK', 'T2', '18:45', 'OnTime', 'B788'],
  ['JL919', 'JAL', 'OKA', 'T1', '18:55', 'OnTime', 'B789'],
  ['NH010', 'ANA', 'LAX', 'T3', '17:40', 'OnTime', 'B77W'],
  ['JL043', 'JAL', 'CDG', 'T3', '18:50', 'OnTime', 'A359'],

  // 宵（19-21:30）— やや暇帯
  ['NH079', 'ANA', 'CTS', 'T2', '19:30', 'OnTime', 'B789'],
  ['JL237', 'JAL', 'ITM', 'T1', '19:45', 'Delayed', 'B738', '20:15'],
  ['NH041', 'ANA', 'ITM', 'T2', '20:15', 'OnTime', 'A321'],
  ['JL325', 'JAL', 'FUK', 'T1', '20:45', 'OnTime', 'B772'],
  ['NH265', 'ANA', 'FUK', 'T2', '21:00', 'OnTime', 'B788'],

  // 第2ピーク（21:30-24時）
  ['JL145', 'JAL', 'CTS', 'T1', '21:35', 'OnTime', 'B789'],
  ['NH085', 'ANA', 'CTS', 'T2', '22:00', 'OnTime', 'B772'],
  ['JL247', 'JAL', 'ITM', 'T1', '22:20', 'OnTime', 'A359'],
  ['NH047', 'ANA', 'ITM', 'T2', '22:45', 'OnTime', 'A321'],
  ['JL333', 'JAL', 'FUK', 'T1', '23:00', 'OnTime', 'B772'],
  ['NH267', 'ANA', 'FUK', 'T2', '23:25', 'OnTime', 'B788'],
  ['JL923', 'JAL', 'OKA', 'T1', '23:40', 'OnTime', null],

  // T3 国際線深夜便
  ['JL061', 'JAL', 'DEL', 'T3', '22:30', 'OnTime', 'B789'],
  ['NH872', 'ANA', 'ICN', 'T3', '23:15', 'OnTime', 'A321'],
  ['JL706', 'JAL', 'BKK', 'T3', '23:50', 'OnTime', 'B788'],

  // 深夜遅延便（24時以降到着）— delayBoost + reachNone トリガー用
  ['NH199', 'ANA', 'KOJ', 'T2', '22:50', 'Delayed', 'B738', '24:30'],
  ['JL359', 'JAL', 'KMI', 'T1', '23:10', 'Delayed', 'B738', '24:50'],
];

function buildOdptItem([fno, operator, from, terminal, sched, status, aircraft, estimated], idx) {
  const item = {
    '@type': 'odpt:FlightInformationArrival',
    'owl:sameAs': `urn:uuid:mock-${idx}`,
    'dc:date': '2026-04-25T11:30:00+09:00',
    'odpt:operator': `odpt.Operator:${operator}`,
    'odpt:airline': `odpt.Operator:${operator}`,
    'odpt:flightNumber': [fno],
    'odpt:originAirport': `odpt.Airport:${from}`,
    'odpt:arrivalAirport': 'odpt.Airport:HND',
    'odpt:arrivalAirportTerminal': `odpt.AirportTerminal:HND.Terminal${terminal.replace('T', '')}`,
    'odpt:scheduledArrivalTime': sched,
    'odpt:flightStatus': `odpt.FlightStatus:${status}`,
    'odpt:aircraftType': aircraft
  };
  if (estimated) {
    item['odpt:estimatedArrivalTime'] = estimated;
  }
  return item;
}

const odptItems = SCHEDULE.map(buildOdptItem);
const out = transformArrivals(odptItems, seatsMaster, factorsMaster, {
  transitShare,
  routes,
  egress,
  railStatus: railOk,
  dayType,
  weatherContext
});

writeFileSync('./data/arrivals.json', JSON.stringify(out, null, 2), 'utf8');
console.log(`Wrote mock ${out.flights.length} flights to data/arrivals.json`);
console.log(`  totalEstimatedTaxiPax: ${out.stats.totalEstimatedTaxiPax}`);
console.log(`  reachTier breakdown: ${JSON.stringify(
  out.flights.reduce((acc, f) => { acc[f.reachTier ?? 'null'] = (acc[f.reachTier ?? 'null'] ?? 0) + 1; return acc; }, {})
)}`);
const delayBoosted = out.flights.filter(f => f.taxiDelayBoost && f.taxiDelayBoost > 1.0);
console.log(`  delayBoost flights: ${delayBoosted.length} (${delayBoosted.map(f => f.flightNumber).join(', ')})`);
const lightningBoosted = out.flights.filter(f => f.taxiLightningBoost && f.taxiLightningBoost > 1.0);
console.log(`  lightningBoost flights: ${lightningBoosted.length} (${lightningBoosted.map(f => f.flightNumber).join(', ')})`);
if (out.weather) console.log(`  weather: ${JSON.stringify(out.weather)}`);
