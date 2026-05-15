/**
 * カレンダー文脈 (DOW + 祝日 + 連休) の判定。純関数のみ。
 *
 * dayType 7 カテゴリ:
 *   weekday              平日 (月-金) で前日も翌日も平日
 *   post_holiday         平日 (月-金) で前日が休日 (土日明け or 連休明けの月曜 等)
 *   saturday             土曜日 (連休/単独問わず、常に saturday カテゴリ)
 *   sunday_holiday       日曜 or 祝日で 2 日以下の休み (= 普通の日曜、土日ペア、単独祝日)
 *   pre_holiday          平日 (月-金) で翌日が休日 (連休初日となる平日)
 *   in_consec_holiday    日曜 or 祝日で「3 日以上の連休」の中の日 (前後とも休日)
 *   last_consec_holiday  日曜 or 祝日で「3 日以上の連休」の最終日 (前日休日、翌日平日)
 *
 * 「3 日以上の連休」= 当該休日と連続する休日 (土日祝) の合計日数が 3 以上。
 * 通常の土日 (= 2 日連休) の日曜は sunday_holiday カテゴリ。
 *
 * getDayContext は consec 情報も含めて返す (パターンマッチングの consecLength フィルタ用)。
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
  return getDayContext(date, holidaysSet).dayType;
}

/**
 * getDayContext: dayType + consec 情報を返す。
 *
 * @returns {{
 *   dayType: string,
 *   consecLength: number,        // 当該日が休日なら属する連休の総日数、平日なら 1
 *   prevConsecLength: number,    // 前の連続休日の日数 (0 if none)
 *   nextConsecLength: number,    // 後の連続休日の日数 (0 if none)
 * }}
 */
export function getDayContext(date, holidaysSet) {
  const dow = date.getDay();
  const dateStr = formatYmd(date);
  const isExplicitHoliday = holidaysSet.has(dateStr);
  const isSaturday = dow === 6;
  const isSunday = dow === 0;
  const isHolidayItself = isSaturday || isSunday || isExplicitHoliday;

  const before = countConsecHolidaysBefore(date, holidaysSet);
  const after = countConsecHolidaysAfter(date, holidaysSet);
  const consecLength = isHolidayItself ? (before + 1 + after) : 1;
  const prevConsecLength = isHolidayItself ? before : before;
  const nextConsecLength = isHolidayItself ? after : after;

  // 土曜は常に saturday カテゴリ
  if (isSaturday) {
    return { dayType: 'saturday', consecLength, prevConsecLength, nextConsecLength };
  }

  const isSundayOrHoliday = isSunday || isExplicitHoliday;
  if (isSundayOrHoliday) {
    let dayType = 'sunday_holiday';
    if (consecLength >= 3) {
      if (before > 0 && after > 0) dayType = 'in_consec_holiday';
      else if (before > 0 && after === 0) dayType = 'last_consec_holiday';
      // before === 0 && after > 0: 連休初日 (日曜祝日が頭になるケース) → sunday_holiday に丸める
    }
    return { dayType, consecLength, prevConsecLength, nextConsecLength };
  }

  // 平日 (月-金)
  const yesterdayHoliday = isHolidayOrWeekend(addDays(date, -1), holidaysSet);
  const tomorrowHoliday = isHolidayOrWeekend(addDays(date, 1), holidaysSet);
  // pre_holiday と post_holiday が両方該当する場合 (孤立平日)、pre_holiday を優先
  // 例: 月曜が祝日に挟まれた火曜 → 翌日休日が次の連休と判断されるべき
  if (tomorrowHoliday) {
    return { dayType: 'pre_holiday', consecLength: 1, prevConsecLength, nextConsecLength };
  }
  if (yesterdayHoliday) {
    return { dayType: 'post_holiday', consecLength: 1, prevConsecLength, nextConsecLength };
  }
  return { dayType: 'weekday', consecLength: 1, prevConsecLength: 0, nextConsecLength: 0 };
}
