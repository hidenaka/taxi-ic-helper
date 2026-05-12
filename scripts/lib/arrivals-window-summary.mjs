/**
 * arrivals.json から「now - 30 min 〜 now + 60 min」の便を集計する純粋関数。
 *
 * @param {{flights: Array}} arrivals - data/arrivals.json の中身
 * @param {Date} now - 現在時刻
 * @returns {{from: string, to: string, flight_count: number, estimated_taxi_pax_sum: number, estimated_pax_sum: number, reach_none_count: number}}
 */
export function summarizeArrivalsWindow(arrivals, now) {
  const WINDOW_PAST_MIN = 30;
  const WINDOW_FUTURE_MIN = 60;
  const from = new Date(now.getTime() - WINDOW_PAST_MIN * 60 * 1000);
  const to = new Date(now.getTime() + WINDOW_FUTURE_MIN * 60 * 1000);

  // now の JST 日付 (year/month/date) を ts 比較の基準に
  const baseYear = now.getFullYear();
  const baseMonth = now.getMonth();
  const baseDate = now.getDate();

  const flights = (arrivals?.flights ?? []).filter(f => {
    const timeStr = f.estimatedTime ?? f.scheduledTime;
    if (!timeStr) return false;
    const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return false;
    let hours = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    const flightDate = new Date(baseYear, baseMonth, baseDate);
    if (hours >= 24) {
      flightDate.setDate(flightDate.getDate() + 1);
      hours -= 24;
    }
    flightDate.setHours(hours, minutes, 0, 0);
    return flightDate >= from && flightDate <= to;
  });

  const estimated_pax_sum = flights.reduce((s, f) => s + (f.estimatedPax ?? 0), 0);
  const estimated_taxi_pax_sum = flights.reduce((s, f) => s + (f.estimatedTaxiPax ?? 0), 0);
  const reach_none_count = flights.filter(f => f.reachTier === 'none').length;

  return {
    from: toJstIso(from),
    to: toJstIso(to),
    flight_count: flights.length,
    estimated_taxi_pax_sum,
    estimated_pax_sum,
    reach_none_count
  };
}

function toJstIso(d) {
  // d (Date) を JST 表現の ISO 8601 文字列に変換 (+09:00 suffix)
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}
