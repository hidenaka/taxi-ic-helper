/**
 * フライト配列を30分ビンで集計
 * @param {Array} flights - { terminal, estimatedTime "HH:MM", estimatedPax }
 * @param {string} terminal - 'T1' | 'T2' | 'T3'
 * @returns {Array<{bin, totalPax, flightCount, unknownCount, isPeak}>}
 */
export function aggregateHeatmap(flights, terminal) {
  const filtered = flights.filter(f => f.terminal === terminal && f.estimatedTime);
  const bins = new Map();
  for (const f of filtered) {
    const [h, m] = f.estimatedTime.split(':').map(Number);
    const binMin = m < 30 ? '00' : '30';
    const key = `${String(h).padStart(2, '0')}:${binMin}`;
    if (!bins.has(key)) bins.set(key, { bin: key, totalPax: 0, flightCount: 0, unknownCount: 0 });
    const b = bins.get(key);
    b.flightCount += 1;
    if (f.estimatedPax === null) b.unknownCount += 1;
    else b.totalPax += f.estimatedPax;
  }
  const arr = Array.from(bins.values()).sort((a, b) => a.bin.localeCompare(b.bin));
  const max = Math.max(0, ...arr.map(b => b.totalPax));
  return arr.map(b => ({ ...b, isPeak: max > 0 && b.totalPax >= max * 0.8 }));
}
