// 日付の文脈（曜日・祝日・連休位置）を判定する純関数。
// date は Date オブジェクト、holidays は [{date:"YYYY-MM-DD", name:"..."}, ...] 配列。

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** 日付を JST の "YYYY-MM-DD" 文字列に。 */
function toJstDateString(date) {
  const jst = new Date(date.getTime() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** date を1日加算した Date を返す（参照透過）。 */
function addDays(date, n) {
  return new Date(date.getTime() + n * 86400000);
}

/** "YYYY-MM-DD" が祝日リストに含まれるか。 */
function isHolidayDate(dateStr, holidays) {
  return Array.isArray(holidays) && holidays.some(h => h.date === dateStr);
}

/** JST 曜日番号（0=日..6=土）を返す。 */
function jstWeekday(date) {
  const jst = new Date(date.getTime() + 9 * 3600 * 1000);
  return jst.getUTCDay();
}

/** 「休み」= 祝日 or 土日。 */
function isOffDay(date, holidays) {
  const w = jstWeekday(date);
  if (w === 0 || w === 6) return true;
  return isHolidayDate(toJstDateString(date), holidays);
}

/** dayKind を判定する（weekday / weekend / holiday / consecutive-{first,middle,last}）。
 * 連休判定は「祝日の連続」が基準。前後が土日だけの場合は連休カウント外とする。 */
function classifyDayKind(date, holidays) {
  const w = jstWeekday(date);
  const dateStr = toJstDateString(date);
  const isHol = isHolidayDate(dateStr, holidays);
  if (!isHol) {
    if (w === 0 || w === 6) return 'weekend';
    return 'weekday';
  }
  // 祝日: 前日・翌日が「祝日」か「祝日+土日の連続」かで連休判定
  // 連休の境界は「前後に祝日があるか」で判断（土日のみは連休カウント外）
  const prevIsHol = isHolidayDate(toJstDateString(addDays(date, -1)), holidays);
  const nextIsHol = isHolidayDate(toJstDateString(addDays(date, +1)), holidays);
  // 前後の「休日（祝日 or 土日）」チェックは連続祝日グループ探索で行う
  // シンプル実装: 前日が祝日 or (前日が土日かつその前が祝日) → prevOff
  const prevOff = prevIsHol || isOffDay(addDays(date, -1), holidays) && isHolidayDate(toJstDateString(addDays(date, -2)), holidays);
  const nextOff = nextIsHol || isOffDay(addDays(date, +1), holidays) && isHolidayDate(toJstDateString(addDays(date, +2)), holidays);
  if (prevOff && nextOff) return 'consecutive-middle';
  if (!prevOff && nextOff) return 'consecutive-first';
  if (prevOff && !nextOff) return 'consecutive-last';
  return 'holiday'; // 単独祝日
}

const KIND_LABEL = {
  weekday: '平日',
  weekend: '週末',
  holiday: '祝日',
  'consecutive-first': '連休初日',
  'consecutive-middle': '連休中日',
  'consecutive-last': '連休最終日',
};

/** 表示用ラベル "火曜平日" / "土曜・週末" / "水曜・連休最終日" 等。 */
function buildDayLabel(weekday, dayKind) {
  const wj = WEEKDAY_JA[weekday];
  const kj = KIND_LABEL[dayKind];
  if (dayKind === 'weekday') return `${wj}曜${kj}`; // 連結なし: 火曜平日
  return `${wj}曜・${kj}`; // ナカグロ付き: 土曜・週末、水曜・連休最終日
}

/** date の {weekday, dayKind, dayLabel} を返す。 */
export function getDayContext(date, holidays) {
  const weekday = jstWeekday(date);
  const dayKind = classifyDayKind(date, holidays);
  const dayLabel = buildDayLabel(weekday, dayKind);
  return { weekday, dayKind, dayLabel };
}
