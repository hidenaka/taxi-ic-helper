export function lookupDeduction(deductionData, icId) {
  for (const dir of deductionData.directions) {
    if (dir.baseline.ic_id === icId) return null;
    const entry = dir.entries.find(e => e.ic_id === icId);
    if (entry) {
      return { direction: dir.id, name: entry.name, km: entry.km };
    }
  }
  return null;
}
