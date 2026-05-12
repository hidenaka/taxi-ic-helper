export function toJstYmd(date) {
  const d = date instanceof Date ? date : new Date(date);
  const jst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, '0');
  const day = String(jst.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function jstWeekday(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })).getDay();
}

export function buildHolidaySet(holidaysJson) {
  const dates = Array.isArray(holidaysJson?.dates) ? holidaysJson.dates : [];
  return new Set(dates);
}

export function getDayType(date, holidaySet) {
  const ymd = toJstYmd(date);
  if (holidaySet && holidaySet.has(ymd)) return 'holiday';
  const wd = jstWeekday(date);
  return (wd === 0 || wd === 6) ? 'holiday' : 'weekday';
}
