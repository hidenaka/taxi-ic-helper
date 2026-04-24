import { haversineKm } from './util.js';

const DEFAULT_ACCURACY_THRESHOLD_M = 100;
const DEFAULT_FALLBACK_EXIT_ID = 'wangan_kanpachi';
const DEFAULT_WATCH_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 5000,
  timeout: 10000,
};

export function findNearestICs(pos, ics, { n = 5, filter } = {}) {
  if (!pos) return [];
  return ics
    .filter((ic) => ic.gps && (!filter || filter(ic)))
    .map((ic) => ({ ic, distKm: haversineKm(pos, ic.gps) }))
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, n);
}

export function acceptSample(accuracyMeters, thresholdMeters = DEFAULT_ACCURACY_THRESHOLD_M) {
  return typeof accuracyMeters === 'number'
    && Number.isFinite(accuracyMeters)
    && accuracyMeters <= thresholdMeters;
}

export function defaultExitIcId(pos, exitIcs, fallbackId = DEFAULT_FALLBACK_EXIT_ID) {
  if (!pos) return fallbackId;
  const ranked = findNearestICs(pos, exitIcs, { n: 1 });
  return ranked.length > 0 ? ranked[0].ic.id : fallbackId;
}

export function createGeoWatcher({
  geolocation = (typeof navigator !== 'undefined' ? navigator.geolocation : null),
  accuracyThresholdM = DEFAULT_ACCURACY_THRESHOLD_M,
  onUpdate = () => {},
  onState = () => {},
  options = DEFAULT_WATCH_OPTIONS,
} = {}) {
  let state = 'idle';
  let watchId = null;
  let lastPos = null;

  const setState = (s) => {
    if (s === state) return;
    state = s;
    onState(state);
  };

  function start() {
    if (!geolocation) { setState('unsupported'); return; }
    if (watchId !== null) return;
    setState('measuring');
    watchId = geolocation.watchPosition(
      (pos) => {
        const acc = pos.coords.accuracy;
        if (!acceptSample(acc, accuracyThresholdM)) return;
        lastPos = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: acc,
          timestamp: pos.timestamp,
        };
        onUpdate(lastPos);
      },
      (err) => {
        if (watchId !== null && geolocation) geolocation.clearWatch(watchId);
        watchId = null;
        setState(err && err.code === 1 ? 'denied' : 'error');
      },
      options,
    );
  }

  function stop() {
    if (watchId !== null && geolocation) {
      geolocation.clearWatch(watchId);
      watchId = null;
    }
    setState('idle');
    lastPos = null;
  }

  return {
    start,
    stop,
    getState: () => state,
    getLastPos: () => lastPos,
  };
}
