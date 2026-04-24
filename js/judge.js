export function lookupDeduction(deductionData, icId, directionId = null) {
  const directions = directionId
    ? deductionData.directions.filter(d => d.id === directionId)
    : deductionData.directions;

  for (const dir of directions) {
    if (dir.baseline.ic_id === icId) return null;
    const entry = dir.entries.find(e => e.ic_id === icId);
    if (entry) {
      return { direction: dir.id, name: entry.name, km: entry.km };
    }
  }
  return null;
}

export function calcOneWayDeduction(icA, icB, deductionData) {
  const eA = lookupDeduction(deductionData, icA.id);
  const eB = lookupDeduction(deductionData, icB.id);
  if (!eA && !eB) return 0;
  if (eA && !eB) return eA.km;
  if (!eA && eB) return eB.km;
  if (eA.direction !== eB.direction) return 0;
  return Math.abs(eA.km - eB.km);
}

export function judgeDeduction(icA, icB, deductionData, roundTrip) {
  const oneWay = calcOneWayDeduction(icA, icB, deductionData);
  return roundTrip ? oneWay * 2 : oneWay;
}

export function computeShutokoPay({ outerRoute, entryIc, isOuter }) {
  if (isOuter) return 'company';
  if (outerRoute === 'gaikan_direct') return 'self';
  return entryIc.boundary_tag === 'company_pay_entry' ? 'company' : 'self';
}

const OUTER_TRUNK_ROUTES = new Set([
  'tomei','chuo','kanetsu','tohoku','joban',
  'keiyo','tokan','aqua','tateyama',
  'third_keihin','yokoyoko','yokohane_route','kariba_route','wangan_route'
]);

function needsGaikanTransit(outerRoute, entryIc, routes) {
  const conf = routes.needs_gaikan_transit[outerRoute];
  if (conf === true) return true;
  if (conf === false) return false;
  if (conf === 'optional') return entryIc._viaGaikan === true;
  return false;
}

function lookupDistance(distData, fromId, toId) {
  const hit = distData.entries.find(e =>
    (e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId));
  return hit?.km ?? 0;
}

function aggregate(segments, roundTrip) {
  const totalDed = segments.reduce((a, s) => a + s.deductionKm, 0);
  const totalDist = segments.reduce((a, s) => a + s.distanceKm, 0);
  const pays = new Set(segments.map(s => s.pay));
  const paySummary = pays.size === 1
    ? (pays.has('company') ? 'all_company' : 'all_self')
    : 'mixed';
  return {
    paySummary,
    deductionKmOneway: totalDed,
    deductionKmRoundtrip: roundTrip ? totalDed * 2 : totalDed,
    distanceKmOneway: totalDist,
    distanceKmRoundtrip: roundTrip ? totalDist * 2 : totalDist
  };
}

export function judgeRoute({ outerRoute, entryIc, exitIc, roundTrip }, deps) {
  const { deduction, shutokoDist, gaikanDist, routes } = deps;
  const isOuter = OUTER_TRUNK_ROUTES.has(outerRoute);
  const viaGaikan = outerRoute === 'gaikan_direct'
                 || needsGaikanTransit(outerRoute, entryIc, routes);
  const segs = [];

  if (isOuter) {
    const ded = lookupDeduction(deduction, entryIc.id, outerRoute);
    segs.push({
      name: routes.labels[outerRoute],
      route: outerRoute,
      pay: 'company',
      deductionKm: ded?.km ?? 0,
      distanceKm: ded?.km ?? 0
    });
  }

  if (viaGaikan) {
    segs.push({
      name: '外環道',
      route: 'gaikan',
      pay: isOuter ? 'company' : 'self',
      deductionKm: 0,
      distanceKm: 0
    });
  }

  segs.push({
    name: '首都高',
    route: 'shutoko',
    pay: computeShutokoPay({ outerRoute, entryIc, isOuter }),
    deductionKm: 0,
    distanceKm: lookupDistance(shutokoDist, entryIc.id, exitIc.id)
  });

  if (exitIc.id === 'wangan_kanpachi' &&
      ['aqua','tateyama','third_keihin','yokoyoko','yokohane_route','kariba_route','wangan_route'].includes(outerRoute)) {
    segs[segs.length - 1].pay = 'company';
  }

  return { segments: segs, totals: aggregate(segs, roundTrip) };
}
