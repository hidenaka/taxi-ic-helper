/**
 * 搭乗者数推定（純関数）
 * @param {{aircraftCode: string|null, from: string}} flight
 * @param {Object} seatsMaster - aircraft-seats.json の中身
 * @param {{default: number, routes: Object}} factorsMaster - load-factors.json の中身
 * @returns {{seatCount, loadFactor, loadFactorSource, estimatedPax}}
 */
export function estimatePax(flight, seatsMaster, factorsMaster) {
  const { aircraftCode, from } = flight;
  if (!aircraftCode || !seatsMaster[aircraftCode]) {
    return { seatCount: null, loadFactor: null, loadFactorSource: null, estimatedPax: null };
  }
  const seats = seatsMaster[aircraftCode].seats;
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
