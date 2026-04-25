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

function classifyDensity(totalPax) {
  if (totalPax >= DENSITY_HIGH) return 'high';
  if (totalPax >= DENSITY_MID) return 'mid';
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
        flightCount: 0, unknownCount: 0, delayedCount: 0, internationalCount: 0
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
  }
  const arr = Array.from(bins.values()).sort((a, b) => a.bin.localeCompare(b.bin));
  return arr.map(b => ({ ...b, densityTier: classifyDensity(b.totalPax) }));
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
  return {
    totalPax, internationalPax,
    totalFlights, internationalCount,
    delayedCount, unknownCount, hourlyAvg,
    windowLabel
  };
}

const MAJOR_DELAY_MINUTES = 30;
const LATE_NIGHT_HHMM = '23:30';

function timeToMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function detectTopics(flights) {
  const lateMin = timeToMinutes(LATE_NIGHT_HHMM);
  const topics = [];
  for (const f of flights) {
    if (f.status === '到着') continue;
    const sched = timeToMinutes(f.scheduledTime);
    const est = timeToMinutes(f.estimatedTime ?? f.scheduledTime);
    if (sched === null || est === null) continue;
    const delayMin = est - sched;
    const isMajorDelay = delayMin >= MAJOR_DELAY_MINUTES;
    const isLateNight = est >= lateMin;
    if (isMajorDelay || isLateNight) {
      topics.push({
        flightNumber: f.flightNumber,
        fromName: f.fromName,
        terminal: f.terminal,
        scheduledTime: f.scheduledTime,
        estimatedTime: f.estimatedTime ?? f.scheduledTime,
        delayMin,
        isMajorDelay,
        isLateNight
      });
    }
  }
  topics.sort((a, b) => timeToMinutes(a.estimatedTime) - timeToMinutes(b.estimatedTime));
  return topics;
}

export function minutesSince(isoString) {
  const t = new Date(isoString);
  return Math.floor((Date.now() - t.getTime()) / 60000);
}
