#!/usr/bin/env node
/**
 * Open-Meteo API から羽田空港の現在天候・15分単位の遷移を取得し、
 * data/weather.json に書き出す。
 *
 * 雷活動の検出と「雷終了タイミング」を判定して、UI / 推定式が利用する
 * lightningRecoveryStartHHMM を露出する。
 *
 * 認証不要・無料・APIキー不要。
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { parseOpenMeteoResponse } from './lib/weather-detector.mjs';

const HND_LAT = 35.5494;
const HND_LON = 139.7798;
const ENDPOINT = `https://api.open-meteo.com/v1/forecast?latitude=${HND_LAT}&longitude=${HND_LON}&current=temperature_2m,weather_code,precipitation,cloud_cover&minutely_15=weather_code,precipitation&timezone=Asia%2FTokyo&forecast_days=1`;

function nowJstIso() {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

function isoLocalToHHMM(s) {
  if (!s) return null;
  const m = s.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(15000) });
if (!res.ok) {
  console.error(`ERROR: Open-Meteo HTTP ${res.status}`);
  process.exit(1);
}
const data = await res.json();
const detected = parseOpenMeteoResponse(data);
const lightningRecoveryStartHHMM = isoLocalToHHMM(detected.lastLightningEndedAt);

const out = {
  updatedAt: nowJstIso(),
  source: 'Open-Meteo (api.open-meteo.com)',
  current: {
    weatherCode: detected.weatherCode,
    lightningActive: detected.lightningActive,
    temperature: data.current?.temperature_2m ?? null,
    precipitation: data.current?.precipitation ?? null,
    cloudCover: data.current?.cloud_cover ?? null
  },
  lastLightningEndedAt: detected.lastLightningEndedAt,
  lightningRecoveryStartHHMM,
  history15min: detected.history15min.slice(-12)
};

const outPath = './data/weather.json';
const newJson = JSON.stringify(out, null, 2);
const stripUpdatedAt = s => s.replace(/"updatedAt":\s*"[^"]+",?/, '');

if (existsSync(outPath)) {
  const prev = readFileSync(outPath, 'utf8');
  if (stripUpdatedAt(prev) === stripUpdatedAt(newJson)) {
    console.log('No content change. Skipping write.');
    process.exit(0);
  }
}

writeFileSync(outPath, newJson, 'utf8');
console.log(`Wrote weather.json: code=${out.current.weatherCode} lightningActive=${out.current.lightningActive} recovery=${lightningRecoveryStartHHMM ?? 'none'}`);
