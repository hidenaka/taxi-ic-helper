export function hhmmToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export function minutesToHhmm(min) {
  if (typeof min !== 'number' || isNaN(min)) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function computeLobbyExitTime(estimatedTime, terminal, isInternational, egressMaster) {
  const baseMin = hhmmToMinutes(estimatedTime);
  if (baseMin === null) return null;
  const t = egressMaster?.[terminal] ?? egressMaster?.egress?.[terminal];
  if (!t) return null;
  const add = isInternational ? t.international : t.domestic;
  return minutesToHhmm(baseMin + add);
}
