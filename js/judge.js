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
