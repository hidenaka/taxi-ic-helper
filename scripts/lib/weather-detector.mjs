const LIGHTNING_CODES = new Set([95, 96, 99]);
const LOOKBACK_MINUTES = 120;
const SLOT_MINUTES = 15;

export function isLightningCode(code) {
  return typeof code === 'number' && LIGHTNING_CODES.has(code);
}

function parseIsoLocal(s) {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5]);
}

function formatIsoLocal(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * 直近の雷活動が止んだ時刻を計算。
 * 雷活動中なら null、雷未発生でも null。
 * 雷が直近 LOOKBACK_MINUTES 以内に止んでいれば、最後の活動時刻 + 15分を返す。
 */
export function findLastLightningEndedAt(history, nowIso) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const nowMs = parseIsoLocal(nowIso);
  if (nowMs === null) return null;
  const cutoff = nowMs - LOOKBACK_MINUTES * 60_000;

  // 最新スロットが雷なら活動中 → null
  const last = history[history.length - 1];
  if (isLightningCode(last.weatherCode)) return null;

  // 逆順走査で「最新の雷スロット」を見つける
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (!isLightningCode(h.weatherCode)) continue;
    const ms = parseIsoLocal(h.time);
    if (ms === null) continue;
    if (ms < cutoff) return null;
    return formatIsoLocal(ms + SLOT_MINUTES * 60_000);
  }
  return null;
}

/**
 * Open-Meteo レスポンスをパースして、雷活動状態の要約を返す。
 */
export function parseOpenMeteoResponse(resp) {
  const current = resp?.current ?? {};
  const m15 = resp?.minutely_15 ?? {};
  const times = m15.time ?? [];
  const codes = m15.weather_code ?? [];
  // minutely_15 は当日全体（過去+未来予報）を返すので、current.time 以前の実観測スロットのみ採用。
  const currentMs = parseIsoLocal(current.time ?? '');
  const history15min = times.reduce((acc, t, i) => {
    const ms = parseIsoLocal(t);
    if (ms === null) return acc;
    if (currentMs !== null && ms > currentMs) return acc;
    acc.push({ time: t, weatherCode: codes[i] ?? null, isLightning: isLightningCode(codes[i]) });
    return acc;
  }, []);
  const weatherCode = current.weather_code ?? null;
  const lightningActive = isLightningCode(weatherCode);
  const lastLightningEndedAt = findLastLightningEndedAt(history15min, current.time ?? '');
  return {
    weatherCode,
    lightningActive,
    lastLightningEndedAt,
    history15min
  };
}
