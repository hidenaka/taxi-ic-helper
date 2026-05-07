export async function loadArrivals() {
  const res = await fetch('./data/arrivals.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function filterByTerminals(arrivals, terminals) {
  const set = new Set(terminals);
  return arrivals.flights.filter(f => set.has(f.terminal));
}

export function filterByTimeWindow(flights, nowDate, pastMinutes = 30, futureMinutes = 180) {
  const nowMin = nowDate.getHours() * 60 + nowDate.getMinutes();
  return flights.filter(f => {
    const t = f.estimatedTime ?? f.scheduledTime;
    if (!t) return false;
    const [h, m] = t.split(':').map(Number);
    const fMin = h * 60 + m;
    return fMin >= nowMin - pastMinutes && fMin <= nowMin + futureMinutes;
  });
}

const DENSITY_HIGH = 600;
const DENSITY_MID = 300;
const TAXI_DENSITY_HIGH = 70;
const TAXI_DENSITY_MID = 30;

function classifyDensity(value, mode = 'pax') {
  const high = mode === 'taxi' ? TAXI_DENSITY_HIGH : DENSITY_HIGH;
  const mid = mode === 'taxi' ? TAXI_DENSITY_MID : DENSITY_MID;
  if (value >= high) return 'high';
  if (value >= mid) return 'mid';
  return 'low';
}

export function aggregateHeatmapClient(flights) {
  const bins = new Map();
  for (const f of flights) {
    const t = f.estimatedTime ?? f.scheduledTime;
    if (!t) continue;
    const [h, m] = t.split(':').map(Number);
    const binMin = m < 30 ? '00' : '30';
    const key = `${String(h).padStart(2, '0')}:${binMin}`;
    if (!bins.has(key)) {
      bins.set(key, {
        bin: key, totalPax: 0, internationalPax: 0,
        totalTaxiPax: 0,
        flightCount: 0, unknownCount: 0, delayedCount: 0, internationalCount: 0,
        reachNoneCount: 0
      });
    }
    const b = bins.get(key);
    b.flightCount += 1;
    if (f.estimatedPax === null) b.unknownCount += 1;
    else {
      b.totalPax += f.estimatedPax;
      if (f.isInternational) b.internationalPax += f.estimatedPax;
    }
    if (f.isInternational) b.internationalCount += 1;
    if (f.status === '遅延') b.delayedCount += 1;
    b.totalTaxiPax += f.estimatedTaxiPax ?? 0;
    if (f.reachTier === 'none') b.reachNoneCount += 1;
  }
  const arr = Array.from(bins.values()).sort((a, b) => a.bin.localeCompare(b.bin));
  return arr.map(b => ({
    ...b,
    densityTier: classifyDensity(b.totalPax),
    taxiDensityTier: classifyDensity(b.totalTaxiPax, 'taxi')
  }));
}

export function summarizeFlights(flights, opts = {}) {
  const windowHours = opts.windowHours ?? 3.5;
  const windowLabel = opts.windowLabel ?? '直近3時間';
  const totalPax = flights.reduce((s, f) => s + (f.estimatedPax ?? 0), 0);
  const internationalPax = flights
    .filter(f => f.isInternational)
    .reduce((s, f) => s + (f.estimatedPax ?? 0), 0);
  const totalFlights = flights.length;
  const internationalCount = flights.filter(f => f.isInternational).length;
  const delayedCount = flights.filter(f => f.status === '遅延').length;
  const unknownCount = flights.filter(f => f.estimatedPax === null).length;
  const hourlyAvg = totalFlights > 0 ? Math.round(totalPax / windowHours) : 0;
  const totalTaxiPax = flights.reduce((s, f) => s + (f.estimatedTaxiPax ?? 0), 0);
  const reachNoneCount = flights.filter(f => f.reachTier === 'none').length;
  const peakTaxiBin = computePeakTaxiBin(flights);
  return {
    totalPax, internationalPax,
    totalFlights, internationalCount,
    delayedCount, unknownCount, hourlyAvg,
    windowLabel,
    totalTaxiPax,
    reachNoneCount,
    peakTaxiBin
  };
}

function computePeakTaxiBin(flights) {
  const bins = new Map();
  for (const f of flights) {
    const t = f.estimatedTime ?? f.scheduledTime;
    if (!t) continue;
    const [h, mm] = t.split(':').map(Number);
    const binMin = mm < 30 ? '00' : '30';
    const key = `${String(h).padStart(2, '0')}:${binMin}`;
    bins.set(key, (bins.get(key) ?? 0) + (f.estimatedTaxiPax ?? 0));
  }
  let bestKey = null, best = 0;
  for (const [k, v] of bins) if (v > best) { bestKey = k; best = v; }
  return { bin: bestKey, value: best };
}

function timeToMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function detectTopics(flights) {
  const topics = [];
  for (const f of flights) {
    if (f.status === '到着') continue;
    const reachNone = f.reachTier === 'none';
    const delayBoost = f.taxiDelayBoost && f.taxiDelayBoost > 1.0;
    const lightningBoost = f.taxiLightningBoost && f.taxiLightningBoost > 1.0;
    if (!reachNone && !delayBoost && !lightningBoost) continue;
    const sched = timeToMinutes(f.scheduledTime);
    const est = timeToMinutes(f.estimatedTime ?? f.scheduledTime);
    const delayMin = (sched !== null && est !== null) ? Math.max(0, est - sched) : 0;
    topics.push({
      flightNumber: f.flightNumber,
      fromName: f.fromName,
      terminal: f.terminal,
      scheduledTime: f.scheduledTime,
      estimatedTime: f.estimatedTime ?? f.scheduledTime,
      delayMin,
      reachNone,
      delayBoost: !!delayBoost,
      lightningBoost: !!lightningBoost,
      estimatedPax: f.estimatedPax ?? null,
      estimatedTaxiPax: f.estimatedTaxiPax ?? 0
    });
  }
  topics.sort((a, b) => timeToMinutes(a.estimatedTime) - timeToMinutes(b.estimatedTime));
  return topics;
}

export function minutesSince(isoString) {
  const t = new Date(isoString);
  return Math.floor((Date.now() - t.getTime()) / 60000);
}

const STALENESS_WARN_MIN = 15;
const STALENESS_CRITICAL_MIN = 60;
const SUPPRESS_BEFORE_JST_HOUR = 5;

function jstHour(date) {
  const jstStr = date.toLocaleString('en-US', { timeZone: 'Asia/Tokyo', hour: 'numeric', hour12: false });
  return parseInt(jstStr, 10);
}

export function classifyStaleness(updatedAtIso, now) {
  if (!updatedAtIso) return { level: 'suppressed', ageMinutes: null };
  if (jstHour(now) < SUPPRESS_BEFORE_JST_HOUR) {
    return { level: 'suppressed', ageMinutes: null };
  }
  const ageMinutes = Math.floor((now.getTime() - new Date(updatedAtIso).getTime()) / 60000);
  if (ageMinutes < STALENESS_WARN_MIN) return { level: 'fresh', ageMinutes };
  if (ageMinutes <= STALENESS_CRITICAL_MIN) return { level: 'warn', ageMinutes };
  return { level: 'critical', ageMinutes };
}
