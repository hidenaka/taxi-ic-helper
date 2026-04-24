#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fetchHndArrivals } from './lib/odpt-client.mjs';
import { transformArrivals } from './lib/arrival-transformer.mjs';

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

const odptData = await fetchHndArrivals(TOKEN);
if (odptData.length === 0) {
  console.error('No arrival data fetched. Skipping write to preserve previous JSON.');
  process.exit(0);
}

const out = transformArrivals(odptData, seatsMaster, factorsMaster);
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
