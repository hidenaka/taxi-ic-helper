/**
 * カレンダー文脈 (DOW + 祝日 + 連休) の判定。純関数のみ。
 *
 * dayType 6 カテゴリ:
 *   weekday              平日 (月-金) かつ翌日も平日
 *   saturday             土曜日 (連休/単独問わず、常に saturday カテゴリ)
 *   sunday_holiday       日曜 or 祝日で 2 日以下の休み (= 普通の日曜、土日ペア、単独祝日)
 *   pre_holiday          平日 (月-金) で翌日が休日 (連休初日となる平日)
 *   in_consec_holiday    日曜 or 祝日で「3 日以上の連休」の中の日 (前後とも休日)
 *   last_consec_holiday  日曜 or 祝日で「3 日以上の連休」の最終日 (前日休日、翌日平日)
 *
 * 「3 日以上の連休」= 当該休日と連続する休日 (土日祝) の合計日数が 3 以上。
 * 通常の土日 (= 2 日連休) の日曜は sunday_holiday カテゴリ。
 */

export function formatYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function loadHolidaysSet(json) {
  const set = new Set();
  if (!json || !Array.isArray(json.holidays)) return set;
  for (const h of json.holidays) {
    if (h && typeof h.date === 'string') set.add(h.date);
  }
  return set;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isHolidayOrWeekend(date, holidaysSet) {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return true;
  return holidaysSet.has(formatYmd(date));
}

function countConsecHolidaysBefore(date, holidaysSet) {
  let n = 0;
  let d = addDays(date, -1);
  while (isHolidayOrWeekend(d, holidaysSet)) {
    n++;
    d = addDays(d, -1);
    if (n > 30) break; // 安全弁
  }
  return n;
}

function countConsecHolidaysAfter(date, holidaysSet) {
  let n = 0;
  let d = addDays(date, 1);
  while (isHolidayOrWeekend(d, holidaysSet)) {
    n++;
    d = addDays(d, 1);
    if (n > 30) break;
  }
  return n;
}

export function getDayType(date, holidaysSet) {
  const dow = date.getDay();
  const dateStr = formatYmd(date);
  const isExplicitHoliday = holidaysSet.has(dateStr);

  // 土曜は常に saturday カテゴリ
  if (dow === 6) return 'saturday';

  const isSunday = dow === 0;
  const isHoliday = isSunday || isExplicitHoliday;

  if (isHoliday) {
    const before = countConsecHolidaysBefore(date, holidaysSet);
    const after = countConsecHolidaysAfter(date, holidaysSet);
    const totalConsec = before + 1 + after;
    if (totalConsec >= 3) {
      if (before > 0 && after > 0) return 'in_consec_holiday';
      if (before > 0 && after === 0) return 'last_consec_holiday';
      // before === 0 && after > 0: 連休初日 (日曜祝日が連休の頭になるケース)
      // この場合 sunday_holiday に丸める (pre_holiday は平日のみのため)
    }
    return 'sunday_holiday';
  }

  // 平日 (月-金)
  const tomorrowHoliday = isHolidayOrWeekend(addDays(date, 1), holidaysSet);
  if (tomorrowHoliday) return 'pre_holiday';
  return 'weekday';
}
