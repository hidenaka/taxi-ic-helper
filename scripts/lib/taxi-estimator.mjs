import { hhmmToMinutes } from './route-reachability.mjs';

export function pickBucket(lobbyExitTime, transitShare) {
  const m = hhmmToMinutes(lobbyExitTime);
  if (m === null) return null;
  for (const b of transitShare.buckets) {
    const from = hhmmToMinutes(b.fromHHMM);
    const to = hhmmToMinutes(b.toHHMM);
    if (m >= from && m < to) return b;
  }
  return null;
}

export function pickBoost(reachRate, transitShare) {
  const sorted = [...transitShare.reachBoost].sort((a, b) => b.minRate - a.minRate);
  for (const r of sorted) {
    if (reachRate >= r.minRate) return r.boost;
  }
  return sorted[sorted.length - 1].boost;
}

function shouldApplyDelayBoost(lobbyExitTime, delayMinutes, transitShare) {
  const cfg = transitShare.delayBoost;
  if (!cfg) return false;
  if ((delayMinutes ?? 0) < cfg.minDelayMinutes) return false;
  const exitMin = hhmmToMinutes(lobbyExitTime);
  const minMin = hhmmToMinutes(cfg.minLobbyExitTime);
  if (exitMin === null || minMin === null) return false;
  return exitMin >= minMin;
}

export function estimateTaxiPax(flight, transitShare, reachRate) {
  if (flight.estimatedPax === null || flight.estimatedPax === undefined) {
    return { estimatedTaxiPax: null, baseRate: null, appliedBoost: null, appliedDelayBoost: null, clamped: false, bucket: null };
  }
  const bucket = pickBucket(flight.lobbyExitTime, transitShare);
  let baseRate;
  let bucketId;
  if (bucket) {
    baseRate = bucket.rates[flight.terminal];
    bucketId = bucket.id;
  } else {
    baseRate = transitShare.fallbackRate;
    bucketId = 'fallback';
  }
  if (typeof baseRate !== 'number') {
    return { estimatedTaxiPax: null, baseRate: null, appliedBoost: null, appliedDelayBoost: null, clamped: false, bucket: bucketId };
  }
  const boost = pickBoost(reachRate, transitShare);
  const delayBoost = shouldApplyDelayBoost(flight.lobbyExitTime, flight.delayMinutes, transitShare)
    ? transitShare.delayBoost.boost
    : 1.0;
  let ratio = baseRate * boost * delayBoost;
  let clamped = false;
  if (ratio > transitShare.maxRatio) {
    ratio = transitShare.maxRatio;
    clamped = true;
  }
  return {
    estimatedTaxiPax: Math.round(flight.estimatedPax * ratio),
    baseRate,
    appliedBoost: boost,
    appliedDelayBoost: delayBoost,
    clamped,
    bucket: bucketId
  };
}
