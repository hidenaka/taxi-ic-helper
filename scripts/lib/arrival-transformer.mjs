import { estimatePax } from './pax-estimator.mjs';

const AIRPORT_NAMES = {
  'ITM': '伊丹', 'CTS': '千歳', 'FUK': '福岡', 'OKA': '那覇',
  'KIX': '関空', 'NGO': '中部', 'HIJ': '広島', 'KMJ': '熊本',
  'KOJ': '鹿児島', 'KMI': '宮崎', 'KCZ': '高知', 'AKJ': '旭川',
  'KUH': '釧路', 'MMB': '女満別', 'AOJ': '青森', 'AXT': '秋田',
  'HKD': '函館', 'TOY': '富山', 'KMQ': '小松', 'TAK': '高松',
  'MYJ': '松山', 'OIT': '大分', 'NGS': '長崎', 'ISG': '石垣',
  'MYE': '宮古', 'KKJ': '北九州', 'UKB': '神戸',
  'ICN': 'ソウル', 'PEK': '北京', 'PVG': '上海', 'TPE': '台北',
  'HKG': '香港', 'BKK': 'バンコク', 'SIN': 'シンガポール',
  'JFK': 'ニューヨーク', 'LAX': 'ロサンゼルス', 'LHR': 'ロンドン',
  'CDG': 'パリ', 'FRA': 'フランクフルト', 'SYD': 'シドニー'
};

const STATUS_MAP = {
  'odpt.FlightStatus:OnTime': '定刻',
  'odpt.FlightStatus:Delayed': '遅延',
  'odpt.FlightStatus:Arrived': '到着',
  'odpt.FlightStatus:Cancelled': '欠航'
};

function extractAirportCode(odptValue) {
  if (!odptValue) return null;
  return odptValue.split(':').pop();
}

function extractTerminal(odptValue) {
  if (!odptValue) return null;
  const m = odptValue.match(/HND\.(T\d)/);
  return m ? m[1] : null;
}

function extractAirline(odptValue) {
  if (!odptValue) return null;
  return odptValue.split(':').pop();
}

function nowJstIso() {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

export function transformArrivals(odptResponse, seatsMaster, factorsMaster) {
  const flights = odptResponse.map(item => {
    const flightNumber = Array.isArray(item['odpt:flightNumber'])
      ? item['odpt:flightNumber'][0]
      : item['odpt:flightNumber'];
    const from = extractAirportCode(item['odpt:departureAirport']);
    const terminal = extractTerminal(item['odpt:terminal']);
    const aircraftCode = item['odpt:aircraftModel'] ?? null;
    const status = STATUS_MAP[item['odpt:flightStatus']] ?? '不明';
    const pax = estimatePax({ aircraftCode, from }, seatsMaster, factorsMaster);
    return {
      flightNumber,
      airline: extractAirline(item['odpt:airline']),
      from,
      fromName: AIRPORT_NAMES[from] ?? from,
      terminal,
      scheduledTime: item['odpt:scheduledTime'] ?? null,
      estimatedTime: item['odpt:estimatedTime'] ?? null,
      actualTime: item['odpt:actualTime'] ?? null,
      status,
      aircraftCode,
      ...pax
    };
  });
  const byTerminal = flights.reduce((acc, f) => {
    if (f.terminal) acc[f.terminal] = (acc[f.terminal] ?? 0) + 1;
    return acc;
  }, {});
  return {
    updatedAt: nowJstIso(),
    source: 'ODPT (api.odpt.org)',
    flights,
    stats: {
      totalFlights: flights.length,
      unknownAircraft: flights.filter(f => f.aircraftCode === null).length,
      byTerminal
    }
  };
}
