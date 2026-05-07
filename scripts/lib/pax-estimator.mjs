/**
 * 搭乗者数推定（純関数）
 * @param {{aircraftCode: string|null, from: string}} flight
 * @param {Object} seatsMaster - aircraft-seats.json の中身
 * @param {{default: number, routes: Object}} factorsMaster - load-factors.json の中身
 * @returns {{seatCount, loadFactor, loadFactorSource, estimatedPax}}
 */

// ODPT API の aircraftType (IATA派生コード) → seatsMaster のキー (ICAO風) へのマッピング
// 不明なものは元コードのままで lookup される (seatsMaster 直接ヒットする可能性)
const AIRCRAFT_CODE_ALIASES = {
  // Boeing 777
  '77W': 'B77W',
  '772': 'B772',
  '773': 'B773',
  // Boeing 787
  '789': 'B789',
  '788': 'B788',
  '78P': 'B789',  // ANA 787-9 国内線仕様
  '78G': 'B789',  // ANA 787-9 派生
  '78K': 'B788',  // ANA 787-8 派生
  // Boeing 767
  '763': 'B763',
  '76P': 'B763',  // ANA 767 派生
  '76W': 'B763',  // JAL 767 winglets
  // Boeing 737
  '73H': 'B738',  // 737-800 with winglets
  '73D': 'B738',
  '73L': 'B738',
  '73S': 'B738',
  '738': 'B738',
  // Airbus A350
  '359': 'A359',
  '351': 'A35K',
  // Airbus A320 / A321
  '320': 'A320',
  '321': 'A321',
  '32S': 'A321',
  '32L': 'A321',
  // Embraer
  'E90': 'E90',
  // ANA 内部コード (推定)
  '722': 'B772',  // 短距離仕様の B772 と推定
};

function resolveAircraftKey(rawCode) {
  if (!rawCode) return null;
  return AIRCRAFT_CODE_ALIASES[rawCode] ?? rawCode;
}

export function estimatePax(flight, seatsMaster, factorsMaster) {
  const { aircraftCode, from } = flight;
  const resolvedCode = resolveAircraftKey(aircraftCode);
  if (!resolvedCode || !seatsMaster[resolvedCode]) {
    return { seatCount: null, loadFactor: null, loadFactorSource: null, estimatedPax: null };
  }
  const seats = seatsMaster[resolvedCode].seats;
  const routeFactor = factorsMaster.routes?.[from];
  const factor = routeFactor ?? factorsMaster.default;
  const source = routeFactor !== undefined ? 'route' : 'default';
  return {
    seatCount: seats,
    loadFactor: factor,
    loadFactorSource: source,
    estimatedPax: Math.round(seats * factor)
  };
}
