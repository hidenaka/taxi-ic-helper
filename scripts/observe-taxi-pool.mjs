#!/usr/bin/env node
/**
 * タクシープール観測パイプライン (schema v3) のオーケストレーター。
 *
 * 1. ttc.taxi-inf.jp から画像 2 枚取得
 * 2. analyzePoolImage で各画像のメタデータ + ROI 解析を抽出（schema v2 互換）
 * 3. YOLOv8m で車両検出 → ByteTrack 簡略版で ID 追跡 → lane-roi で割当 → 出庫イベント検出 (schema v3)
 * 4. data/arrivals.json / weather.json から状態取得 + arrivals_window 集計
 * 5. data/taxi-pool-history.jsonl に schema_version=3 で append
 * 6. data/.tracker-state.json にトラッカー状態を保存（次 tick で利用）
 *
 * YOLO モデル (models/yolov8m.onnx) が無い場合は schema v2 のフィールドだけ記録して継続。
 * Workflow からは git commit & push の race-safe ロジックで呼ばれる。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { analyzePoolImage } from './lib/image-pool-analyzer.mjs';
import { summarizeArrivalsWindow } from './lib/arrivals-window-summary.mjs';
import { detectVehicles, loadModel } from './lib/vehicle-detector.mjs';
import { updateTracker, createEmptyState } from './lib/vehicle-tracker.mjs';
import { assignLane, terminalForLane } from './lib/lane-roi.mjs';
import { detectDepartures } from './lib/departure-detector.mjs';

const REAL01_URL = 'https://ttc.taxi-inf.jp/Real01_line.jpg';
const REAL02_URL = 'https://ttc.taxi-inf.jp/Real02.jpg';
const USER_AGENT = 'taxi-ic-helper observation bot (https://github.com/hidenaka/taxi-ic-helper)';
const HISTORY_PATH = './data/taxi-pool-history.jsonl';
const TRACKER_STATE_PATH = './data/.tracker-state.json';
const ROI_CONFIG_PATH = './scripts/lib/roi-config.json';
const LANE_CONFIG_PATH = './data/lane-roi.json';
const MODEL_PATH = './models/yolov8m.onnx';
const TIMEOUT_MS = 15000;
const SCHEMA_VERSION = 3;

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
    try { return JSON.parse(lines[i]); } catch { continue; }
  }
  return null;
}

function readTrackerState() {
  if (!existsSync(TRACKER_STATE_PATH)) return null;
  try { return JSON.parse(readFileSync(TRACKER_STATE_PATH, 'utf8')); }
  catch { return null; }
}

function writeTrackerState(state) {
  writeFileSync(TRACKER_STATE_PATH, JSON.stringify(state));
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function readArrivalsState(arrivals) {
  if (!arrivals) return null;
  const updatedAt = arrivals.updatedAt ?? null;
  const total = arrivals.stats?.totalEstimatedTaxiPax ?? null;
  const lagSec = updatedAt
    ? Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1000)
    : null;
  return { updated_at: updatedAt, total_estimated_taxi_pax: total, lag_seconds: lagSec };
}

function readWeather(weatherJson) {
  if (!weatherJson) return null;
  return {
    code: weatherJson.current?.weatherCode ?? null,
    lightning_active: !!weatherJson.current?.lightningActive
  };
}

async function runYoloPipeline(buf, camera, prevTracks, trackerState, laneConfig, model, ts) {
  const detections = await detectVehicles(buf, model, { confidenceThreshold: 0.4 });
  const bboxes = detections.map(d => d.bbox);
  const { state: newState, tracked, lost } = updateTracker(trackerState, bboxes);

  const trackedWithLane = tracked.map(t => ({
    ...t,
    ...assignLane(t.bbox, camera, laneConfig)
  }));

  const departures = detectDepartures(prevTracks, trackedWithLane, lost, ts)
    .map(e => ({ ...e, terminal: terminalForLane(e.lane, laneConfig) }));

  return { newState, trackedWithLane, departures };
}

function buildLaneState(laneConfig, vehicles1, vehicles2) {
  const result = {};
  for (const lane of laneConfig.lanes) {
    const cameraVehicles = lane.camera === 'real01_line' ? vehicles1 : vehicles2;
    const inLane = cameraVehicles.filter(v => v.lane === lane.id);
    const frontRow = inLane.some(v => v.front_row);
    result[lane.id] = { queue_count: inLane.length, front_row_occupied: frontRow };
  }
  return result;
}

async function main() {
  const ts = jstNowIso();

  let buf1, buf2;
  try {
    [buf1, buf2] = await Promise.all([fetchImage(REAL01_URL), fetchImage(REAL02_URL)]);
  } catch (e) {
    console.error(`[observe] image fetch failed: ${e.message}`);
    if (e.cause) console.error(`[observe] cause: ${e.cause.code ?? ''} ${e.cause.message ?? e.cause}`);
    console.error('[observe] skipping this tick (no jsonl append)');
    process.exit(0);
  }

  const tsSafe = ts.replace(/[:+]/g, '-');
  writeFileSync(`/tmp/taxi-pool-${tsSafe}-real01.jpg`, buf1);
  writeFileSync(`/tmp/taxi-pool-${tsSafe}-real02.jpg`, buf2);

  const lastTick = readLastTick();
  const prev1Img = lastTick?.img1 ?? null;
  const prev2Img = lastTick?.img2 ?? null;
  const tickSeq = (lastTick?.tick_seq ?? 0) + 1;

  const roiConfig = readJson(ROI_CONFIG_PATH);
  const roi1 = roiConfig?.real01_line ?? null;
  const roi2 = roiConfig?.real02 ?? null;

  let img1, img2;
  try {
    img1 = await analyzePoolImage(buf1, prev1Img, roi1);
    img2 = await analyzePoolImage(buf2, prev2Img, roi2);
  } catch (e) {
    console.error(`[observe] image analyze failed: ${e.message}`);
    process.exit(0);
  }

  const arrivalsJson = readJson('./data/arrivals.json');
  const arrivalsState = readArrivalsState(arrivalsJson);
  const arrivalsWindow = arrivalsJson ? summarizeArrivalsWindow(arrivalsJson, new Date()) : null;
  const weather = readWeather(readJson('./data/weather.json'));

  // schema v3: YOLO + tracker + lane + departure
  let vehicles1 = [], vehicles2 = [], departures = [];
  let laneState = {};
  let yoloOk = false;

  const laneConfig = readJson(LANE_CONFIG_PATH);
  if (!laneConfig) {
    console.error('[observe] lane-roi.json missing, falling back to schema v2 fields only');
  } else if (!existsSync(MODEL_PATH)) {
    console.error(`[observe] ${MODEL_PATH} missing, falling back to schema v2 fields only`);
  } else {
    try {
      const model = await loadModel(MODEL_PATH);
      const savedTracker = readTrackerState();
      const trackerState1 = savedTracker?.real01_line ?? createEmptyState();
      const trackerState2 = savedTracker?.real02 ?? createEmptyState();
      const prevTracks1 = lastTick?.vehicles?.real01_line ?? [];
      const prevTracks2 = lastTick?.vehicles?.real02 ?? [];

      const r1 = await runYoloPipeline(buf1, 'real01_line', prevTracks1, trackerState1, laneConfig, model, ts);
      const r2 = await runYoloPipeline(buf2, 'real02', prevTracks2, trackerState2, laneConfig, model, ts);

      vehicles1 = r1.trackedWithLane;
      vehicles2 = r2.trackedWithLane;
      departures = [...r1.departures, ...r2.departures];
      laneState = buildLaneState(laneConfig, vehicles1, vehicles2);

      writeTrackerState({ real01_line: r1.newState, real02: r2.newState });
      yoloOk = true;
    } catch (e) {
      console.error(`[observe] YOLO/tracker pipeline failed: ${e.message}`);
    }
  }

  const row = {
    schema_version: SCHEMA_VERSION,
    ts,
    tick_seq: tickSeq,
    img1: { name: 'Real01_line', ...img1 },
    img2: { name: 'Real02', ...img2 },
    arrivals_state: arrivalsState,
    arrivals_window: arrivalsWindow,
    weather,
    vehicles: { real01_line: vehicles1, real02: vehicles2 },
    departures,
    lane_state: laneState
  };

  appendFileSync(HISTORY_PATH, JSON.stringify(row) + '\n', 'utf8');
  console.log(`[observe] appended tick_seq=${tickSeq} ts=${ts} (schema_version=${SCHEMA_VERSION}, yolo=${yoloOk ? 'on' : 'off'})`);
  console.log(`[observe] img1 edge=${img1.roi?.edge_density ?? 'n/a'} black=${img1.black_ratio} lum=${img1.roi?.luminance_mean ?? 'n/a'}`);
  console.log(`[observe] img2 edge=${img2.roi?.edge_density ?? 'n/a'} black=${img2.black_ratio} lum=${img2.roi?.luminance_mean ?? 'n/a'}`);
  if (yoloOk) {
    console.log(`[observe] vehicles real01=${vehicles1.length} real02=${vehicles2.length} departures=${departures.length}`);
  }
  if (arrivalsWindow) {
    console.log(`[observe] arrivals_window flights=${arrivalsWindow.flight_count} taxi_pax_sum=${arrivalsWindow.estimated_taxi_pax_sum}`);
  }
}

main().catch(e => {
  console.error(`[observe] unexpected error: ${e.message}`);
  process.exit(1);
});
