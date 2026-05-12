export function detectDepartures(previousTracks, currentTracks, lost, ts) {
  const lostIds = new Set(lost.map(v => v.id));
  const events = [];
  for (const prev of previousTracks) {
    if (!prev.front_row) continue;
    if (prev.lane == null) continue;
    if (!lostIds.has(prev.id)) continue;
    events.push({
      lane: prev.lane,
      vehicle_id: prev.id,
      ts
    });
  }
  return events;
}
