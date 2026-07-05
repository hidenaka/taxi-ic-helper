export function movementShiftHistoryRow({ ts, stalls, sourceImages = {} }) {
  return {
    schema_version: 3,
    ts,
    sourceImages,
    stalls,
  };
}
