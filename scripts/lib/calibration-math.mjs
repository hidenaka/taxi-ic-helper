function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function tsToBucketId(ts, buckets) {
  // ts は JST ISO8601 (例: '2026-05-12T08:30:00+09:00') を前提に
  // タイムゾーン変換なしで時刻部分だけを抽出する (jstNowIso で生成された形式と整合)。
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

export function aggregateDepartures(ticks, buckets) {
  const result = {};
  for (const b of buckets) result[b.id] = { T1: 0, T2: 0 };
  for (const tick of ticks) {
    const bucketId = tsToBucketId(tick.ts, buckets);
    if (!bucketId) continue;
    for (const dep of tick.departures ?? []) {
      if (dep.terminal === 'T1') result[bucketId].T1++;
      else if (dep.terminal === 'T2') result[bucketId].T2++;
    }
  }
  return result;
}

const MIN_SAMPLES = 50;
const DRIFT_THRESHOLD = 0.5;
const RATE_MIN = 0.01;
const RATE_MAX = 0.95;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function computeUpdatedRate({ observedDepartures, estimatedPaxTerminal, previousRate, alpha, sampleCount }) {
  if (sampleCount < MIN_SAMPLES) {
    return { newRate: previousRate, skipped: true, reason: 'insufficient_samples' };
  }
  if (estimatedPaxTerminal === 0) {
    return { newRate: previousRate, skipped: true, reason: 'zero_denominator' };
  }
  let observedRate = observedDepartures / estimatedPaxTerminal;
  let warning = null;
  const drift = Math.abs(observedRate - previousRate) / previousRate;
  if (drift > DRIFT_THRESHOLD) {
    observedRate = previousRate + (observedRate - previousRate) * 0.5;
    warning = 'large_drift_clamped';
  }
  const newRate = clamp(alpha * observedRate + (1 - alpha) * previousRate, RATE_MIN, RATE_MAX);
  return { newRate, skipped: false, warning };
}
