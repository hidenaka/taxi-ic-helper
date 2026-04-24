import { haversineKm } from './util.js';
import { buildAdjacency, shortestPath } from './shutoko-graph.js';

let _cachedAdj = null;

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

function resolveShutokoStartIcId({ outerRoute, entryIc, deduction }) {
  // Outer-trunk routes: shutoko segment starts at the direction's baseline IC
  // (that is where the driver physically enters the shutoko network)
  const dir = deduction.directions.find(d => d.id === outerRoute);
  if (dir) return dir.baseline.ic_id;
  // gaikan_direct: v0.1 simplification — use entryIc.id (will produce 0 for unknown pairs)
  // none (首都高内のみ): entryIc IS already the shutoko entry point
  return entryIc.id;
}

const SHUTOKO_DETOUR_FACTOR = 1.3;

function resolveShutokoDistance({ shutokoRoutes, shutokoDist, shutokoGraph, ics, startIcId, exitIcId, shutokoRouteId }) {
  // 1. explicit pair from shutoko_routes.json (user-curated accurate values)
  const pair = shutokoRoutes?.pairs.find(p => p.from === startIcId && p.to === exitIcId);
  if (pair) {
    const opt = shutokoRouteId
      ? pair.options.find(o => o.id === shutokoRouteId)
      : (pair.options.find(o => o.default) || pair.options[0]);
    if (opt) return { km: opt.km, routeId: opt.id, routeLabel: opt.label };
  }

  // 2. graph-based Dijkstra (preferred accurate source)
  if (shutokoGraph) {
    if (!_cachedAdj) _cachedAdj = buildAdjacency(shutokoGraph);
    const sp = shortestPath(_cachedAdj, startIcId, exitIcId);
    if (sp.km !== null) return { km: sp.km, routeId: null, routeLabel: null, path: sp.path };
  }

  // 3. shutoko_distances legacy fallback
  const km = lookupDistance(shutokoDist, startIcId, exitIcId);
  if (km > 0) return { km, routeId: null, routeLabel: null };

  // 4. haversine fallback (last resort)
  const startIc = ics?.find(x => x.id === startIcId);
  const exitIc  = ics?.find(x => x.id === exitIcId);
  if (startIc?.gps && exitIc?.gps) {
    const approx = haversineKm(startIc.gps, exitIc.gps) * SHUTOKO_DETOUR_FACTOR;
    return { km: approx, routeId: null, routeLabel: '概算', approx: true };
  }

  return { km: 0, routeId: null, routeLabel: null };
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

export function judgeRoute({ outerRoute, entryIc, exitIc, roundTrip, shutokoRouteId }, deps) {
  const { deduction, shutokoDist, shutokoRoutes, shutokoGraph, gaikanDist, routes } = deps;
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

  const startIcId = resolveShutokoStartIcId({ outerRoute, entryIc, deduction });
  const shutokoInfo = resolveShutokoDistance({
    shutokoRoutes, shutokoDist, shutokoGraph, ics: deps.ics,
    startIcId, exitIcId: exitIc.id, shutokoRouteId
  });

  segs.push({
    name: shutokoInfo.routeLabel ? `首都高（${shutokoInfo.routeLabel}）` : '首都高',
    route: 'shutoko',
    pay: computeShutokoPay({ outerRoute, entryIc, isOuter }),
    deductionKm: 0,
    distanceKm: shutokoInfo.km,
    path: shutokoInfo.path ?? null
  });

  if (exitIc.id === 'wangan_kanpachi' &&
      ['aqua','tateyama','third_keihin','yokoyoko','yokohane_route','kariba_route','wangan_route'].includes(outerRoute)) {
    segs[segs.length - 1].pay = 'company';
  }

  return { segments: segs, totals: aggregate(segs, roundTrip) };
}
