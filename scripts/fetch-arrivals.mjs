#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fetchHndArrivals } from './lib/odpt-client.mjs';
import { transformArrivals } from './lib/arrival-transformer.mjs';
import { buildEffectiveTransitShare } from './lib/correction-engine.mjs';
import { fetchWingMap, normalizeFlightNumber, poolLane } from './lib/haneda-exits.mjs';

const TOKEN = process.env.ODPT_TOKEN;
if (!TOKEN) {
  console.error('ERROR: ODPT_TOKEN env var is required');
  process.exit(1);
}

// JST 5:00 前は到着便がほぼないのでスキップ
const jstHour = parseInt(
  new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour: 'numeric', hour12: false }),
  10
);
if (jstHour < 5) {
  console.log(`JST ${jstHour}:00 - skipping (before 05:00)`);
  process.exit(0);
}

const seatsMaster = JSON.parse(readFileSync('./data/aircraft-seats.json', 'utf8'));
const factorsMaster = JSON.parse(readFileSync('./data/load-factors.json', 'utf8'));
const transitShareMaster = JSON.parse(readFileSync('./data/transit-share.json', 'utf8'));
let coefficientCorrections = null;
try {
  coefficientCorrections = JSON.parse(readFileSync('./data/coefficient-corrections.json', 'utf8'));
} catch {
  coefficientCorrections = null; // 欠損・不正時は補正なし (係数 1.0)
}
const effectiveTransitShare = buildEffectiveTransitShare(transitShareMaster, coefficientCorrections);
const routesMaster = JSON.parse(readFileSync('./data/last-mile-routes.json', 'utf8'));
const egressMaster = JSON.parse(readFileSync('./data/terminal-egress.json', 'utf8'));

let railStatusOperators = null;
try {
  railStatusOperators = JSON.parse(readFileSync('./data/rail-status.json', 'utf8')).operators;
} catch {
  railStatusOperators = { Keikyu: { status: 'OnTime', delayMinutes: 0 }, TokyoMonorail: { status: 'OnTime', delayMinutes: 0 } };
}

let aircraftFallbackMaster = null;
try {
  const byFn = JSON.parse(readFileSync('./data/aircraft-by-flight-number.json', 'utf8'));
  const byRt = JSON.parse(readFileSync('./data/aircraft-by-route.json', 'utf8'));
  aircraftFallbackMaster = {
    byFlightNumber: byFn.flights ?? {},
    byRoute: byRt.routes ?? {}
  };
} catch (e) {
  console.error(`[fetch-arrivals] aircraft fallback masters not loaded: ${e.message}`);
  aircraftFallbackMaster = null;
}

let weatherContext = null;
try {
  const w = JSON.parse(readFileSync('./data/weather.json', 'utf8'));
  weatherContext = {
    weatherCode: w.current?.weatherCode ?? null,
    lightningActive: !!w.current?.lightningActive,
    lightningRecoveryStartHHMM: w.lightningRecoveryStartHHMM ?? null,
    temperature: w.current?.temperature ?? null,
    precipitation: w.current?.precipitation ?? null,
    cloudCover: w.current?.cloudCover ?? null
  };
} catch {
  weatherContext = null;
}

const jstNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
const dayOfWeek = jstNow.getDay();
const dayType = (dayOfWeek === 0 || dayOfWeek === 6) ? 'holiday' : 'weekday';

const odptData = await fetchHndArrivals(TOKEN);
if (odptData.length === 0) {
  console.error('No arrival data fetched. Skipping write to preserve previous JSON.');
  process.exit(0);
}

const out = transformArrivals(
  odptData,
  seatsMaster,
  factorsMaster,
  {
    transitShare: effectiveTransitShare,
    routes: routesMaster,
    egress: egressMaster,
    railStatus: railStatusOperators,
    dayType,
    weatherContext
  },
  aircraftFallbackMaster
);

// 到着出口 → 北/南ウイング を best-effort で付与する。
// 羽田公式サイトの非公開 API（国内線 T1/T2 のみ）。取得失敗しても arrivals.json は壊さない。
// 各便に wing: '北'|'南'|null を必ず付ける（表示側は wing があれば併記する）。
for (const f of out.flights) f.wing = null;
try {
  const wingTableFull = JSON.parse(readFileSync('./data/haneda-exit-wing.json', 'utf8'));
  const searchDt = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/-/g, '');
  const wingMap = await fetchWingMap(searchDt, wingTableFull.wing);
  let matched = 0;
  for (const f of out.flights) {
    const w = wingMap[normalizeFlightNumber(f.flightNumber)];
    if (w) { f.wing = w; matched++; }
  }
  out.stats.wingMatched = matched;
  console.log(`[fetch-arrivals] wing matched ${matched}/${out.flights.length} flights`);
} catch (e) {
  console.error(`[fetch-arrivals] wing enrichment skipped: ${e.message}`);
}

// タクシープール乗り場番号(号)。terminal+wing ベース(T3=国際=4号)。
// 国内 T1/T2 は wing が決まり次第 1〜4号、未確定は null。
for (const f of out.flights) {
  f.poolLane = poolLane(f.terminal, f.wing);
}

const outPath = './data/arrivals.json';
const newJson = JSON.stringify(out, null, 2);

if (existsSync(outPath)) {
  const prev = readFileSync(outPath, 'utf8');
  const stripUpdatedAt = s => s.replace(/"updatedAt":\s*"[^"]+",?/, '');
  if (stripUpdatedAt(prev) === stripUpdatedAt(newJson)) {
    console.log('No content change. Skipping write.');
    process.exit(0);
  }
}

writeFileSync(outPath, newJson, 'utf8');
console.log(`Wrote ${out.flights.length} flights to ${outPath}`);
