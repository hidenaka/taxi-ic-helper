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
      return {
        direction: dir.id,
        name: entry.name,
        km: entry.km,
        physicalKm: entry.physical_km ?? null,
        note: entry.note ?? null,
      };
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

export const OUTER_TRUNK_ROUTES = new Set([
  'tomei','chuo','kanetsu','tohoku','joban',
  'keiyo','tokan','aqua','tateyama',
  'third_keihin','yokoyoko','yokohane_route','kariba_route','wangan_route',
  'hodogaya_route','hokuseisen_route','kitasen_route'
]);

export function needsGaikanTransit(outerRoute, entryIc, routes) {
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

// 外環道セグメントの実走行距離 (距離 / 高速料金用、控除には含めない)
const GAIKAN_TRANSIT_PAIRS = {
  kanetsu: ['oizumi_jct', 'bijogi_jct'],
  joban:   ['misato_jct', 'kawaguchi_jct'],
  tohoku:  ['kawaguchi_jct', 'bijogi_jct'],
};

// gaikan_direct時に首都高に乗り換える接続点 (外環kp ベース)
// 各エントリICの gaikan_kp と 接続点kpの差で外環走行距離を計算
// takaya_jct (35.5kp) は外環の東端で、ここから京葉道路→篠崎(7号小松川線) ルート
// (shutoko_routes の takaya_jct→ ペアに京葉道路区間も含めた距離を登録)
const GAIKAN_SHUTOKO_HUBS = [
  { id: 'bijogi_jct',     kp: 7.8 },  // 5号池袋線接続
  { id: 'kawaguchi_jct',  kp: 14.4 }, // S1川口線接続
  { id: 'misato_jct',     kp: 21.5 }, // 6号三郷線接続
  { id: 'takaya_jct',     kp: 35.5 }, // 京葉道路経由 (高谷JCT→篠崎→7号小松川線)
];

function pickGaikanShutokoHub(entryIc) {
  if (typeof entryIc?.gaikan_kp !== 'number') return null;
  let best = null;
  let bestDist = Infinity;
  for (const hub of GAIKAN_SHUTOKO_HUBS) {
    const d = Math.abs(entryIc.gaikan_kp - hub.kp);
    if (d < bestDist) { bestDist = d; best = hub; }
  }
  return { hubId: best.id, gaikanKm: bestDist };
}

function resolveGaikanDistance(outerRoute, entryIc, gaikanDist) {
  if (outerRoute === 'gaikan_direct') {
    if (entryIc.id === 'bijogi_jct') return 0;
    // gaikan_kp ベースの汎用計算 (新規外環IC対応)
    const hub = pickGaikanShutokoHub(entryIc);
    if (hub) return hub.gaikanKm;
    // legacy fallback (gaikan_kp 未付与の旧IC用)
    if (gaikanDist && (entryIc.id === 'oizumi_jct' || entryIc.id === 'oizumi')) {
      return lookupDistance(gaikanDist, 'oizumi_jct', 'bijogi_jct');
    }
    return 0;
  }
  if (!gaikanDist) return 0;
  const pair = GAIKAN_TRANSIT_PAIRS[outerRoute];
  if (!pair) return 0;
  return lookupDistance(gaikanDist, pair[0], pair[1]);
}

// 外環経由時、本線高速の baseline IC ではなく外環からの首都高接続点を起点にする
// kanetsu/tohoku: 外環→美女木JCT→5号池袋線
// joban:          外環→川口JCT→S1川口線
// gaikan_direct:  外環→美女木JCT→5号池袋線 (default)
const VIA_GAIKAN_SHUTOKO_ENTRY = {
  kanetsu: 'bijogi_jct',
  tohoku: 'bijogi_jct',
  joban: 'kawaguchi_jct',
  gaikan_direct: 'bijogi_jct',
};

export function resolveShutokoStartIcId({ outerRoute, entryIc, deduction, viaGaikan }) {
  if (viaGaikan && outerRoute === 'gaikan_direct') {
    // gaikan_direct: gaikan_kp で最寄りの首都高接続点を選ぶ (新規IC対応)
    const hub = pickGaikanShutokoHub(entryIc);
    if (hub) return hub.hubId;
    return 'bijogi_jct'; // legacy fallback
  }
  if (viaGaikan && VIA_GAIKAN_SHUTOKO_ENTRY[outerRoute]) {
    return VIA_GAIKAN_SHUTOKO_ENTRY[outerRoute];
  }
  // Outer-trunk routes: shutoko segment starts at the direction's baseline IC
  const dir = deduction.directions.find(d => d.id === outerRoute);
  if (dir) return dir.baseline.ic_id;
  // none (首都高内のみ): entryIc IS already the shutoko entry point
  return entryIc.id;
}

const SHUTOKO_DETOUR_FACTOR = 1.3;

function resolveShutokoDistance({ shutokoRoutes, shutokoDist, shutokoGraph, ics, startIcId, exitIcId, shutokoRouteId }) {
  // 1. explicit pair from shutoko_routes.json (user-curated accurate values)
  const pair = shutokoRoutes?.pairs.find(p =>
    (p.from === startIcId && p.to === exitIcId) || (p.from === exitIcId && p.to === startIcId));
  if (pair) {
    const opt = shutokoRouteId
      ? pair.options.find(o => o.id === shutokoRouteId)
      : (pair.options.find(o => o.default) || pair.options[0]);
    if (opt) {
      const reversed = pair.from === exitIcId && pair.to === startIcId;
      const path = reversed && opt.path ? [...opt.path].reverse() : (opt.path ?? null);
      return { km: opt.km, routeId: opt.id, routeLabel: opt.label, path };
    }
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
  const notes = segments.map(s => s.note).filter(Boolean);
  return {
    paySummary,
    deductionKmOneway: totalDed,
    deductionKmRoundtrip: roundTrip ? totalDed * 2 : totalDed,
    distanceKmOneway: totalDist,
    distanceKmRoundtrip: roundTrip ? totalDist * 2 : totalDist,
    notes,
  };
}

export function judgeRoute({ outerRoute, entryIc, exitIc, roundTrip, shutokoRouteId }, deps) {
  const { deduction, shutokoDist, shutokoRoutes, shutokoGraph, gaikanDist, routes } = deps;
  const isOuter = OUTER_TRUNK_ROUTES.has(outerRoute);
  const viaGaikan = outerRoute === 'gaikan_direct'
                 || needsGaikanTransit(outerRoute, entryIc, routes);
  const segs = [];

  // 本線途中下車パターン: entryIc も exitIc も同じ outer 本線の entries に存在する場合
  // 例: 八王子IC→調布IC (両方chuo direction) は abs差分で控除を計算し、首都高経由しない
  if (isOuter) {
    const entryDed = lookupDeduction(deduction, entryIc.id, outerRoute);
    const exitDed = lookupDeduction(deduction, exitIc.id, outerRoute);
    if (entryDed && exitDed) {
      const physA = entryDed.physicalKm ?? entryDed.km;
      const physB = exitDed.physicalKm ?? exitDed.km;
      const round1 = (n) => Math.round(n * 10) / 10;
      segs.push({
        name: routes.labels[outerRoute],
        route: outerRoute,
        pay: 'company',
        deductionKm: round1(Math.abs(entryDed.km - exitDed.km)),
        distanceKm: round1(Math.abs(physA - physB)),
        note: entryDed.note ?? exitDed.note ?? null,
      });
      return { segments: segs, totals: aggregate(segs, roundTrip) };
    }
  }

  const entryOuterDed = isOuter ? lookupDeduction(deduction, entryIc.id, outerRoute) : null;
  const exitOuterDed = isOuter ? lookupDeduction(deduction, exitIc.id, outerRoute) : null;
  const reverseOuter = Boolean(isOuter && !entryOuterDed && exitOuterDed);
  const outerDed = entryOuterDed || exitOuterDed;
  const pushOuterSegment = () => {
    if (!isOuter) return;
    const controlKm = outerDed?.km ?? 0;
    // 物理走行距離 = physical_km があればそれ。なければ控除値にフォールバック。
    // viaGaikan時は本線が外環接続点 (例: 関越→大泉JCT) で分岐するため shorten_km 分を差引く。
    const physicalBase = outerDed?.physicalKm ?? controlKm;
    const shortenKm = viaGaikan ? (routes.via_gaikan_shorten_km?.[outerRoute] ?? 0) : 0;
    segs.push({
      name: routes.labels[outerRoute],
      route: outerRoute,
      pay: 'company',
      deductionKm: controlKm,
      distanceKm: Math.max(0, physicalBase - shortenKm),
      note: outerDed?.note ?? null,
    });
  };

  if (isOuter) {
    if (!reverseOuter) pushOuterSegment();
  }

  if (viaGaikan) {
    const gaikanPay = isOuter ? 'company' : 'self';
    segs.push({
      name: '外環道',
      route: 'gaikan',
      pay: gaikanPay,
      deductionKm: 0,
      distanceKm: resolveGaikanDistance(outerRoute, entryIc, gaikanDist),
      note: gaikanPay === 'self'
        ? '外環道区間は控除対象外。外環道から乗ると外環道の区間は自己負担になります。'
        : null,
    });
  }

  const startIcId = resolveShutokoStartIcId({ outerRoute, entryIc, deduction, viaGaikan });
  const shutokoEndpointIcId = reverseOuter ? entryIc.id : exitIc.id;
  // 出口IC が本線baseline 自身 (= 首都高に乗り換える必要がない、本線で完結) なら shutokoセグ自体を追加しない。
  // 例: 港北IC→玉川IC は第三京浜内で完結、首都高は通らない。
  const skipShutoko = startIcId === shutokoEndpointIcId;
  const shutokoInfo = skipShutoko ? null : resolveShutokoDistance({
    shutokoRoutes, shutokoDist, shutokoGraph, ics: deps.ics,
    startIcId, exitIcId: shutokoEndpointIcId, shutokoRouteId
  });

  if (!skipShutoko) segs.push({
    name: shutokoInfo.routeLabel ? `首都高（${shutokoInfo.routeLabel}）` : '首都高',
    route: 'shutoko',
    pay: computeShutokoPay({ outerRoute, entryIc, isOuter }),
    deductionKm: 0,
    distanceKm: shutokoInfo.km,
    path: shutokoInfo.path ?? null
  });

  if (reverseOuter) pushOuterSegment();

  if (exitIc.id === 'wangan_kanpachi' &&
      ['aqua','tateyama','third_keihin','yokoyoko','yokohane_route','kariba_route','wangan_route','hodogaya_route','hokuseisen_route','kitasen_route'].includes(outerRoute)) {
    segs[segs.length - 1].pay = 'company';
  }

  return { segments: segs, totals: aggregate(segs, roundTrip) };
}
