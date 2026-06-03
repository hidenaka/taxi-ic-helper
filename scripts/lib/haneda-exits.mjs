// 羽田空港公式サイトの非公開 API から到着便ごとの「到着出口番号」を取得し、
// 出口番号 → 北/南ウイングへ変換するためのモジュール。
//
// データ源: POST https://tokyo-haneda.com/app/api/v2/flight/search
//   body 例(国内線・到着・全便): { flightType:1, arrivalType:2, searchDt:"YYYYMMDD",
//                                  airportCodes:[], airlineCodes:[], flightNumber:"", status:[] }
//   レスポンス: { count, flightlists:[ { terminal:{terminal:"T1"},
//                 airlines:[{flightNumber:"JL906"},...],  // コードシェアは複数
//                 options:[{type:"exitGate", items:[{name:"1"},{name:"3"}]}] } ] }
//
// 出口番号→北/南 の対応表は data/haneda-exit-wing.json（座標から導出・T1/T2で向きが逆）。
//
// ODPT 由来の arrivals.json とは便名で突合する。コードシェア便は全便名を同じ wing に紐付ける。

const ENDPOINT = 'https://tokyo-haneda.com/app/api/v2/flight/search';

/**
 * 便名を正規化（突合用）。英大文字+数字のみ、ゼロ詰め差異を吸収。
 * 例: " nh 0066 " -> "NH66"
 */
export function normalizeFlightNumber(fn) {
  if (fn == null) return '';
  const s = String(fn).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = s.match(/^([A-Z]+)0*(\d+)$/);
  return m ? `${m[1]}${m[2]}` : s;
}

/**
 * 単一の出口番号 → 北/南。未知なら null。
 * @param {string} terminal 'T1'|'T2'(|'T3')
 * @param {string|number} exitName 出口番号
 * @param {object} wingTable haneda-exit-wing.json の wing 部分 { T1:{...}, T2:{...} }
 */
export function exitToWing(terminal, exitName, wingTable) {
  if (!terminal || exitName == null || !wingTable) return null;
  const t = wingTable[terminal];
  if (!t) return null;
  const key = String(exitName).trim();
  return t[key] ?? null;
}

/**
 * 1便の出口番号配列 → 北/南。
 * - 出口が無ければ null
 * - 全て同じ wing → その wing
 * - wing がまたがる(北/南混在)場合は最小番号の出口の wing を採用（中央付近の隣接出口想定）
 * - どれも未知なら null
 */
export function flightWing(terminal, exitNames, wingTable) {
  if (!Array.isArray(exitNames) || exitNames.length === 0) return null;
  const sorted = [...exitNames]
    .map(e => ({ raw: e, n: parseInt(String(e), 10) }))
    .filter(e => Number.isFinite(e.n))
    .sort((a, b) => a.n - b.n);
  const wings = sorted.map(e => exitToWing(terminal, e.raw, wingTable)).filter(Boolean);
  if (wings.length === 0) return null;
  if (wings.every(w => w === wings[0])) return wings[0];
  // 混在: 最小番号(=sorted先頭)の wing を優先
  return wings[0];
}

/**
 * Haneda API のレスポンス JSON → 便ごとの { flightNumbers, terminal, exits } 配列。
 */
export function parseHanedaArrivals(apiJson) {
  const lists = apiJson && Array.isArray(apiJson.flightlists) ? apiJson.flightlists : [];
  const out = [];
  for (const f of lists) {
    const terminal = f?.terminal?.terminal ?? null; // "T1"/"T2"/"T3"
    const flightNumbers = Array.isArray(f?.airlines)
      ? f.airlines.map(a => a?.flightNumber).filter(Boolean)
      : [];
    let exits = [];
    const opts = Array.isArray(f?.options) ? f.options : [];
    const eg = opts.find(o => o?.type === 'exitGate');
    if (eg && Array.isArray(eg.items)) {
      exits = eg.items.map(i => i?.name).filter(v => v != null);
    }
    out.push({ flightNumbers, terminal, exits });
  }
  return out;
}

/**
 * Haneda API レスポンス + wingTable → { normalizedFlightNumber: '北'|'南' } のマップ。
 * コードシェア便は全便名を登録。wing が出ない便は登録しない。
 */
export function buildWingMap(apiJson, wingTable) {
  const map = {};
  for (const f of parseHanedaArrivals(apiJson)) {
    const wing = flightWing(f.terminal, f.exits, wingTable);
    if (!wing) continue;
    for (const fn of f.flightNumbers) {
      const key = normalizeFlightNumber(fn);
      if (key) map[key] = wing;
    }
  }
  return map;
}

/**
 * Haneda 公式 API から国内線到着便を取得。
 * @param {string} searchDt 'YYYYMMDD'(JST)
 * @param {function} [fetchImpl] テスト用に注入可能（既定 globalThis.fetch）
 * @returns {Promise<object>} 生の API JSON
 */
export async function fetchHanedaArrivalsRaw(searchDt, fetchImpl = globalThis.fetch) {
  const body = {
    flightType: 1,      // 1=国内線
    arrivalType: 2,     // 2=到着
    searchDt,
    airportCodes: [],
    airlineCodes: [],
    flightNumber: '',
    status: []
  };
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (taxi-ic-helper)' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Haneda API HTTP ${res.status}`);
  return res.json();
}

/**
 * 取得〜マップ構築までの一括ヘルパー（best-effort 呼び出し側で try/catch 推奨）。
 */
export async function fetchWingMap(searchDt, wingTable, fetchImpl = globalThis.fetch) {
  const json = await fetchHanedaArrivalsRaw(searchDt, fetchImpl);
  return buildWingMap(json, wingTable);
}
