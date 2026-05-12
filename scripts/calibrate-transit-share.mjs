#!/usr/bin/env node
/**
 * 日次キャリブレーション バッチ。
 *
 * 1. data/taxi-pool-history.jsonl から過去 PAST_DAYS 日分を読み込み
 * 2. schema_version=3 の tick のみ採用 (departures フィールドを使う)
 * 3. 時間帯 × ターミナル別に出庫イベント数を集計
 * 4. 同期間の arrivals_window.estimated_taxi_pax_sum で母数を推定
 * 5. T1/T2 を既存rates比率で按分し、EMA + 信頼区間ガードで rate 更新
 * 6. data/transit-share.json を書き換え (T3 は既存値維持)
 *
 * JST 02:00 に launchd / cron から呼び出される想定。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { aggregateDepartures, computeUpdatedRate } from './lib/calibration-math.mjs';

const HISTORY_PATH = './data/taxi-pool-history.jsonl';
const TRANSIT_SHARE_PATH = './data/transit-share.json';
const DEFAULT_ALPHA = 0.2;
const PAST_DAYS = 14;

function jstIsoNow() {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function tsToBucketId(ts, buckets) {
  const m = ts && ts.match(/T(\d{2}):(\d{2}):/);
  if (!m) return null;
  const minutes = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  for (const b of buckets) {
    const from = hhmmToMinutes(b.fromHHMM);
    const to = b.toHHMM === '24:00' ? 1440 : hhmmToMinutes(b.toHHMM);
    if (minutes >= from && minutes < to) return b.id;
  }
  return null;
}

function aggregateEstimatedTaxiPax(ticks, buckets) {
  // arrivals_window.estimated_taxi_pax_sum を bucket 別に集計
  // estimated_taxi_pax_sum は既存 transit-share で計算された「タクシー客見積もり合計」。
  // sampleCount は tick 数 (window が存在する tick の数)。
  const result = {};
  for (const b of buckets) result[b.id] = { taxiPaxSum: 0, sampleCount: 0 };
  for (const tick of ticks) {
    const bucketId = tsToBucketId(tick.ts, buckets);
    if (!bucketId) continue;
    if (tick.arrivals_window?.estimated_taxi_pax_sum != null) {
      result[bucketId].taxiPaxSum += tick.arrivals_window.estimated_taxi_pax_sum;
      result[bucketId].sampleCount += 1;
    }
  }
  return result;
}

export function calibrate(ticks, transitShare, opts = {}) {
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const v3Ticks = ticks.filter(t => t.schema_version === 3);
  const departureAgg = aggregateDepartures(v3Ticks, transitShare.buckets);
  const paxAgg = aggregateEstimatedTaxiPax(v3Ticks, transitShare.buckets);

  const newBuckets = transitShare.buckets.map(b => {
    const t1Dep = departureAgg[b.id]?.T1 ?? 0;
    const t2Dep = departureAgg[b.id]?.T2 ?? 0;
    const taxiPaxSum = paxAgg[b.id]?.taxiPaxSum ?? 0;
    const sampleCount = paxAgg[b.id]?.sampleCount ?? 0;

    // taxiPaxSum を T1/T2 既存rates比率で按分 (T3 は除外)
    const prevT1 = b.rates.T1;
    const prevT2 = b.rates.T2;
    const total = prevT1 + prevT2;
    const t1EstimatedPax = total > 0 ? taxiPaxSum * (prevT1 / total) : 0;
    const t2EstimatedPax = total > 0 ? taxiPaxSum * (prevT2 / total) : 0;

    const t1Update = computeUpdatedRate({
      observedDepartures: t1Dep,
      estimatedPaxTerminal: t1EstimatedPax,
      previousRate: prevT1,
      alpha,
      sampleCount
    });
    const t2Update = computeUpdatedRate({
      observedDepartures: t2Dep,
      estimatedPaxTerminal: t2EstimatedPax,
      previousRate: prevT2,
      alpha,
      sampleCount
    });

    return {
      ...b,
      rates: { T1: t1Update.newRate, T2: t2Update.newRate, T3: b.rates.T3 }
    };
  });

  return {
    ...transitShare,
    _meta: {
      ...transitShare._meta,
      calibratedAt: jstIsoNow(),
      calibrationSampleDays: PAST_DAYS
    },
    buckets: newBuckets
  };
}

// CLI
async function main() {
  const transitShare = JSON.parse(readFileSync(TRANSIT_SHARE_PATH, 'utf8'));
  const historyTxt = readFileSync(HISTORY_PATH, 'utf8');
  const lines = historyTxt.trim().split('\n').filter(l => l.trim());
  const ticks = lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const cutoff = Date.now() - PAST_DAYS * 24 * 3600 * 1000;
  const recent = ticks.filter(t => new Date(t.ts).getTime() >= cutoff);
  console.log(`[calibrate] processing ${recent.length} ticks from past ${PAST_DAYS} days`);

  const updated = calibrate(recent, transitShare);
  writeFileSync(TRANSIT_SHARE_PATH, JSON.stringify(updated, null, 2));
  console.log(`[calibrate] transit-share.json updated. calibratedAt=${updated._meta.calibratedAt}`);
}

// CLI 実行判定: import.meta.url と argv[1] の絶対パス比較 (相対パス渡しでも動く)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}
