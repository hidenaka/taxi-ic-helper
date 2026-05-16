#!/usr/bin/env node
/**
 * タクシープール観測パイプライン (schema v3) のオーケストレーター。
 * 1. ttc.taxi-inf.jp から画像 2 枚取得
 * 2. analyzePoolImage で各画像のメタデータ + ROI 解析を抽出
 * 3. data/arrivals.json と data/weather.json から状態取得
 * 4. summarizeArrivalsWindow で「現在 -30 〜 +60 分」の便集計
 * 5. data/taxi-pool-history.jsonl の最終行を読み、前 tick メタを取り出して diff 計算
 * 6. 新しい 1 行 (schema_version=3) を append
 * 7. /tmp に画像を保存 (workflow が Artifact upload する想定だが、launchd 運用では未使用)
 *
 * Workflow からは git commit & push の race-safe ロジックで呼ばれる。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { Jimp } from 'jimp';
import { analyzePoolImage, analyzeStalls } from './lib/image-pool-analyzer.mjs';
import { summarizeArrivalsWindow } from './lib/arrivals-window-summary.mjs';
import { computeBaseline, computeForecast } from './lib/forecast-engine.mjs';
import { computePatternMatch } from './lib/pattern-matcher.mjs';
import { loadHolidaysSet } from './lib/calendar-context.mjs';
import { buildLogEntry } from './lib/forecast-logger.mjs';
import { buildActualMap, evaluateAccuracy } from './lib/accuracy-evaluator.mjs';
import { computeEnsemble } from './lib/ensemble-engine.mjs';

const REAL01_URL = 'https://ttc.taxi-inf.jp/Real01_line.jpg';
const REAL02_URL = 'https://ttc.taxi-inf.jp/Real02.jpg';
const USER_AGENT = 'taxi-ic-helper observation bot (https://github.com/hidenaka/taxi-ic-helper)';
const HISTORY_PATH = './data/taxi-pool-history.jsonl';
const SNAPSHOTS_DIR = './data/arrivals-snapshots';
const FORECAST_OUTPUT_PATH = './data/stall-forecast.json';
const PATTERN_MATCH_OUTPUT_PATH = './data/stall-pattern-match.json';
const HOLIDAYS_PATH = './data/japan-holidays.json';
const FORECAST_LOG_PATH = './data/forecast-log.jsonl';
const FORECAST_ACCURACY_PATH = './data/forecast-accuracy.json';
const ENSEMBLE_OUTPUT_PATH = './data/stall-ensemble.json';
const ROI_CONFIG_PATH = './scripts/lib/roi-config.json';
const TIMEOUT_MS = 15000;
const STALL_ROIS_PATH = './scripts/lib/stall-rois.json';
const SCHEMA_VERSION = 3;
const IMAGE_DIR = process.env.TAXI_POOL_IMAGE_DIR ?? '/tmp';

function jstNowIso() {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

async function fetchImage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function readLastTick() {
  if (!existsSync(HISTORY_PATH)) return null;
  const txt = readFileSync(HISTORY_PATH, 'utf8').trim();
  if (!txt) return null;
  const lines = txt.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      continue;
    }
  }
  return null;
}

function readArrivalsJson() {
  try {
    return JSON.parse(readFileSync('./data/arrivals.json', 'utf8'));
  } catch (e) {
    console.error(`[observe] arrivals.json read failed: ${e.message}`);
    return null;
  }
}

function readArrivalsState(arrivals) {
  if (!arrivals) return null;
  const updatedAt = arrivals.updatedAt ?? null;
  const total = arrivals.stats?.totalEstimatedTaxiPax ?? null;
  let lagSec = null;
  if (updatedAt) {
    lagSec = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1000);
  }
  return { updated_at: updatedAt, total_estimated_taxi_pax: total, lag_seconds: lagSec };
}

function readWeather() {
  try {
    const j = JSON.parse(readFileSync('./data/weather.json', 'utf8'));
    return {
      code: j.current?.weatherCode ?? null,
      lightning_active: !!j.current?.lightningActive
    };
  } catch (e) {
    console.error(`[observe] weather.json read failed: ${e.message}`);
    return null;
  }
}

function readRoiConfig() {
  try {
    return JSON.parse(readFileSync(ROI_CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error(`[observe] roi-config.json read failed: ${e.message}`);
    return null;
  }
}

function readStallRois() {
  try {
    return JSON.parse(readFileSync(STALL_ROIS_PATH, 'utf8'));
  } catch (e) {
    console.error(`[observe] stall-rois.json read failed: ${e.message}`);
    return null;
  }
}

async function main() {
  const ts = jstNowIso();

  let buf1, buf2;
  try {
    [buf1, buf2] = await Promise.all([
      fetchImage(REAL01_URL),
      fetchImage(REAL02_URL)
    ]);
  } catch (e) {
    console.error(`[observe] image fetch failed: ${e.message}`);
    if (e.cause) {
      console.error(`[observe] cause: ${e.cause.code ?? ''} ${e.cause.message ?? e.cause}`);
    }
    console.error('[observe] skipping this tick (no jsonl append)');
    process.exit(0);
  }

  const tsSafe = ts.replace(/[:+]/g, '-');
  mkdirSync(IMAGE_DIR, { recursive: true });
  writeFileSync(`${IMAGE_DIR}/taxi-pool-${tsSafe}-real01.jpg`, buf1);
  writeFileSync(`${IMAGE_DIR}/taxi-pool-${tsSafe}-real02.jpg`, buf2);

  const lastTick = readLastTick();
  const prev1 = lastTick?.img1 ?? null;
  const prev2 = lastTick?.img2 ?? null;
  const tickSeq = (lastTick?.tick_seq ?? 0) + 1;

  const roiConfig = readRoiConfig();
  const roi1 = roiConfig?.real01_line ?? null;
  const roi2 = roiConfig?.real02 ?? null;

  let img1, img2;
  try {
    img1 = await analyzePoolImage(buf1, prev1, roi1);
    img2 = await analyzePoolImage(buf2, prev2, roi2);
  } catch (e) {
    console.error(`[observe] image analyze failed: ${e.message}`);
    process.exit(0);
  }

  // Stall 別解析 (schema v3)
  const stallRois = readStallRois();
  let stalls = null;
  if (stallRois) {
    try {
      const jimpImg1 = await Jimp.read(buf1);
      const jimpImg2 = await Jimp.read(buf2);
      stalls = await analyzeStalls(
        { real01_line: jimpImg1, real02: jimpImg2 },
        stallRois,
        lastTick?.stalls ?? null
      );
    } catch (e) {
      console.error(`[observe] analyzeStalls failed: ${e.message}`);
      stalls = null;
    }
  }

  const arrivalsJson = readArrivalsJson();
  const arrivalsState = readArrivalsState(arrivalsJson);
  const arrivalsWindow = arrivalsJson
    ? summarizeArrivalsWindow(arrivalsJson, new Date())
    : null;
  const weather = readWeather();

  // Phase B 準備: arrivals.json の便単位スナップショットを日別 jsonl に追記
  // (各 tick で「その時点で予測されていた便リスト」を保存することで、
  //  後から「便→出庫」の直接対応を取れるようにする)
  if (arrivalsJson && Array.isArray(arrivalsJson.flights)) {
    try {
      mkdirSync(SNAPSHOTS_DIR, { recursive: true });
      const dateStr = ts.slice(0, 10); // YYYY-MM-DD
      const snapshotPath = `${SNAPSHOTS_DIR}/arrivals-${dateStr}.jsonl`;
      const flightsLite = arrivalsJson.flights.map(f => ({
        flightNumber: f.flightNumber,
        airline: f.airline,
        from: f.from,
        terminal: f.terminal,
        isInternational: f.isInternational,
        scheduledTime: f.scheduledTime,
        estimatedTime: f.estimatedTime,
        actualTime: f.actualTime,
        status: f.status,
        aircraftCode: f.aircraftCode,
        seatCount: f.seatCount,
        estimatedPax: f.estimatedPax,
        estimatedTaxiPax: f.estimatedTaxiPax,
        lobbyExitTime: f.lobbyExitTime,
        reachTier: f.reachTier,
      }));
      const snapshotRow = {
        ts,
        tick_seq: tickSeq,
        arrivals_updated_at: arrivalsJson.updatedAt,
        flights: flightsLite,
      };
      appendFileSync(snapshotPath, JSON.stringify(snapshotRow) + '\n', 'utf8');
    } catch (e) {
      console.error(`[observe] arrivals snapshot write failed: ${e.message}`);
    }
  }

  const row = {
    schema_version: SCHEMA_VERSION,
    ts,
    tick_seq: tickSeq,
    img1: { name: 'Real01_line', ...img1 },
    img2: { name: 'Real02', ...img2, analysis_disabled: true },
    stalls,
    arrivals_state: arrivalsState,
    arrivals_window: arrivalsWindow,
    weather
  };

  appendFileSync(HISTORY_PATH, JSON.stringify(row) + '\n', 'utf8');
  console.log(`[observe] appended tick_seq=${tickSeq} ts=${ts} (schema_version=${SCHEMA_VERSION})`);

  // forecast / pattern-match の結果を Phase D-1 ログ記録で参照するため外側で保持
  let forecastResult = null;
  let patternMatchResult = null;

  // Phase C-1 MVP: stall 短期需要予測の生成
  // 失敗しても本観測には影響させない (try/catch で握る)
  try {
    const allHistoryLines = readFileSync(HISTORY_PATH, 'utf8').trim().split('\n');
    const allHistory = [];
    for (const line of allHistoryLines) {
      if (!line.trim()) continue;
      try { allHistory.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    const baseline = computeBaseline(allHistory);

    // 直近 12 tick (60 分) の total_outflow を計算
    const recent = allHistory.slice(-12).map(r => {
      const stalls = r.stalls || {};
      let totalOutflow = 0;
      for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
        const d = stalls[name]?.diff_occupied_from_prev;
        if (typeof d === 'number' && d < 0) totalOutflow += -d;
      }
      return { ts: r.ts, total_outflow: totalOutflow };
    });

    forecastResult = computeForecast(baseline, recent, arrivalsJson, new Date());
    writeFileSync(FORECAST_OUTPUT_PATH, JSON.stringify(forecastResult, null, 2) + '\n', 'utf8');
    console.log(`[observe] forecast ok: trendFactor=${forecastResult.trendFactor.toFixed(2)} baselineSamples=${forecastResult.baselineSampleCount}`);
  } catch (e) {
    console.error(`[observe] forecast generation failed: ${e.message}`);
  }

  // Phase C-2 MVP: パターンマッチング予測の生成
  try {
    const allHistoryLines = readFileSync(HISTORY_PATH, 'utf8').trim().split('\n');
    const allHistory = [];
    for (const line of allHistoryLines) {
      if (!line.trim()) continue;
      try { allHistory.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    let holidaysSet;
    try {
      const holidaysJson = JSON.parse(readFileSync(HOLIDAYS_PATH, 'utf8'));
      holidaysSet = loadHolidaysSet(holidaysJson);
    } catch {
      holidaysSet = loadHolidaysSet({ holidays: [] });
    }
    patternMatchResult = computePatternMatch(allHistory, holidaysSet, new Date());
    writeFileSync(PATTERN_MATCH_OUTPUT_PATH, JSON.stringify(patternMatchResult, null, 2) + '\n', 'utf8');
    console.log(`[observe] pattern-match ok: today=${patternMatchResult.today.dayType} tier=${patternMatchResult.today.filterTier} similar=${patternMatchResult.similarDays.length}`);
  } catch (e) {
    console.error(`[observe] pattern-match generation failed: ${e.message}`);
  }

  // Phase D-1: 予測ログ記録 + 精度評価
  let accuracyResult = null;
  try {
    const logEntry = buildLogEntry(
      forecastResult,
      patternMatchResult ? { historicalCurve: patternMatchResult.historicalCurve } : null,
      tickSeq,
      ts
    );
    if (logEntry) {
      appendFileSync(FORECAST_LOG_PATH, JSON.stringify(logEntry) + '\n', 'utf8');
    }
    let logEntries = [];
    if (existsSync(FORECAST_LOG_PATH)) {
      const logLines = readFileSync(FORECAST_LOG_PATH, 'utf8').trim().split('\n');
      for (const line of logLines) {
        if (!line.trim()) continue;
        try { logEntries.push(JSON.parse(line)); } catch { /* skip bad line */ }
      }
    }
    const accHistoryLines = readFileSync(HISTORY_PATH, 'utf8').trim().split('\n');
    const accHistory = [];
    for (const line of accHistoryLines) {
      if (!line.trim()) continue;
      try { accHistory.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    const actualMap = buildActualMap(accHistory);
    accuracyResult = evaluateAccuracy(logEntries, actualMap, new Date());
    writeFileSync(FORECAST_ACCURACY_PATH, JSON.stringify(accuracyResult, null, 2) + '\n', 'utf8');
    console.log(`[observe] accuracy ok: logEntries=${accuracyResult.logEntryCount} recent24h winner lead30=${accuracyResult.recent24h.winner.lead30}`);
  } catch (e) {
    console.error(`[observe] accuracy evaluation failed: ${e.message}`);
  }

  // Phase D-2: アンサンブル統合予測
  try {
    const ensemble = computeEnsemble(
      forecastResult,
      patternMatchResult ? { historicalCurve: patternMatchResult.historicalCurve } : null,
      accuracyResult,
      new Date()
    );
    writeFileSync(ENSEMBLE_OUTPUT_PATH, JSON.stringify(ensemble, null, 2) + '\n', 'utf8');
    console.log(`[observe] ensemble ok: slots=${ensemble.slots.length} lead30 weight fc=${ensemble.weights.lead30.w_fc}`);
  } catch (e) {
    console.error(`[observe] ensemble generation failed: ${e.message}`);
  }

  console.log(`[observe] img1 edge=${img1.roi?.edge_density ?? 'n/a'} black=${img1.black_ratio} lum=${img1.roi?.luminance_mean ?? 'n/a'}`);
  console.log(`[observe] img2 edge=${img2.roi?.edge_density ?? 'n/a'} black=${img2.black_ratio} lum=${img2.roi?.luminance_mean ?? 'n/a'}`);
  if (arrivalsWindow) {
    console.log(`[observe] arrivals_window flights=${arrivalsWindow.flight_count} taxi_pax_sum=${arrivalsWindow.estimated_taxi_pax_sum}`);
  }
  if (stalls) {
    for (const [name, s] of Object.entries(stalls)) {
      if (s) {
        console.log(`[observe] ${name}: occ=${s.occupied_estimate}/${s.capacity} diff=${s.diff_occupied_from_prev}`);
      }
    }
  }
}

main().catch(e => {
  console.error(`[observe] unexpected error: ${e.message}`);
  process.exit(1);
});
