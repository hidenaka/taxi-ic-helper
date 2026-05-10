#!/usr/bin/env node
/**
 * タクシープール観測パイプライン (Phase A) のオーケストレーター。
 * 1. ttc.taxi-inf.jp から画像 2 枚取得
 * 2. analyzePoolImage で各画像のメタデータ抽出
 * 3. data/arrivals.json と data/weather.json から同時刻の状態取得
 * 4. data/taxi-pool-history.jsonl の最終行を読み、前 tick メタを取り出して diff 計算
 * 5. 新しい 1 行を append
 * 6. /tmp に画像を保存 (workflow が Artifact upload する)
 *
 * Workflow からは git commit & push の race-safe ロジックで呼ばれる。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { analyzePoolImage } from './lib/image-pool-analyzer.mjs';

const REAL01_URL = 'https://ttc.taxi-inf.jp/Real01_line.jpg';
const REAL02_URL = 'https://ttc.taxi-inf.jp/Real02.jpg';
const USER_AGENT = 'taxi-ic-helper observation bot (https://github.com/hidenaka/taxi-ic-helper)';
const HISTORY_PATH = './data/taxi-pool-history.jsonl';
const TIMEOUT_MS = 15000;

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

function readArrivalsState() {
  try {
    const j = JSON.parse(readFileSync('./data/arrivals.json', 'utf8'));
    const updatedAt = j.updatedAt ?? null;
    const total = j.stats?.totalEstimatedTaxiPax ?? null;
    let lagSec = null;
    if (updatedAt) {
      lagSec = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1000);
    }
    return { updated_at: updatedAt, total_estimated_taxi_pax: total, lag_seconds: lagSec };
  } catch (e) {
    console.error(`[observe] arrivals.json read failed: ${e.message}`);
    return null;
  }
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

  // /tmp に保存 (workflow が Artifact upload する)
  const tsSafe = ts.replace(/[:+]/g, '-');
  writeFileSync(`/tmp/taxi-pool-${tsSafe}-real01.jpg`, buf1);
  writeFileSync(`/tmp/taxi-pool-${tsSafe}-real02.jpg`, buf2);

  const lastTick = readLastTick();
  const prev1 = lastTick?.img1 ?? null;
  const prev2 = lastTick?.img2 ?? null;
  const tickSeq = (lastTick?.tick_seq ?? 0) + 1;

  let img1, img2;
  try {
    img1 = await analyzePoolImage(buf1, prev1);
    img2 = await analyzePoolImage(buf2, prev2);
  } catch (e) {
    console.error(`[observe] image analyze failed: ${e.message}`);
    process.exit(0);
  }

  const arrivalsState = readArrivalsState();
  const weather = readWeather();

  const row = {
    ts,
    tick_seq: tickSeq,
    img1: { name: 'Real01_line', ...img1 },
    img2: { name: 'Real02', ...img2 },
    arrivals_state: arrivalsState,
    weather
  };

  appendFileSync(HISTORY_PATH, JSON.stringify(row) + '\n', 'utf8');
  console.log(`[observe] appended tick_seq=${tickSeq} ts=${ts}`);
  console.log(`[observe] img1 black_ratio=${img1.black_ratio} diff=${img1.diff_from_prev}`);
  console.log(`[observe] img2 black_ratio=${img2.black_ratio} diff=${img2.diff_from_prev}`);
}

main().catch(e => {
  console.error(`[observe] unexpected error: ${e.message}`);
  process.exit(1);
});
