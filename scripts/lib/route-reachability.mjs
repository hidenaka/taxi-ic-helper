export function hhmmToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export function minutesToHhmm(min) {
  if (typeof min !== 'number' || isNaN(min)) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function computeLobbyExitTime(estimatedTime, terminal, isInternational, egressMaster) {
  const baseMin = hhmmToMinutes(estimatedTime);
  if (baseMin === null) return null;
  const t = egressMaster?.[terminal] ?? egressMaster?.egress?.[terminal];
  if (!t) return null;
  const add = isInternational ? t.international : t.domestic;
  return minutesToHhmm(baseMin + add);
}

const RAIL_BLOCKED_STATUSES = new Set(['Suspended', 'Cancelled']);
const RAIL_DELAY_THRESHOLD_MIN = 30;

function isRailBlocked(railStatus) {
  if (!railStatus) return false;
  if (RAIL_BLOCKED_STATUSES.has(railStatus.status)) return true;
  if ((railStatus.delayMinutes ?? 0) >= RAIL_DELAY_THRESHOLD_MIN) return true;
  return false;
}

function routeBlockedByRail(route, rail) {
  if (!rail) return false;
  const via = route.via ?? [];
  if (via.some(v => v.includes('京急')) && isRailBlocked(rail.Keikyu)) return true;
  if (via.some(v => v.includes('モノレール')) && isRailBlocked(rail.TokyoMonorail)) return true;
  return false;
}

export function computeReachRate(lobbyExitTime, routesMaster, dayType, railStatus) {
  const exitMin = hhmmToMinutes(lobbyExitTime);
  const routes = routesMaster?.routes ?? [];
  const reachable = [];
  const blocked = [];
  let totalWeight = 0;
  let reachWeight = 0;
  for (const r of routes) {
    totalWeight += r.weight;
    const lastStr = dayType === 'holiday' ? r.holidayLastArrival : r.weekdayLastArrival;
    let lastMin = hhmmToMinutes(lastStr);
    if (lastMin !== null && lastMin < 6 * 60) lastMin += 24 * 60;
    const blockedByRail = routeBlockedByRail(r, railStatus);
    const tooLate = exitMin === null || lastMin === null || exitMin > lastMin;
    if (blockedByRail || tooLate) {
      blocked.push({ id: r.id, reason: blockedByRail ? 'rail' : 'time' });
    } else {
      reachable.push(r);
      reachWeight += r.weight;
    }
  }
  const reachRate = totalWeight > 0 ? reachWeight / totalWeight : 0;
  return { reachRate, reachableRoutes: reachable, blockedRoutes: blocked };
}
