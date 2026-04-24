import { estimatePax } from './pax-estimator.mjs';

const DOMESTIC_AIRPORTS = {
  // 北海道
  'CTS': '千歳', 'HKD': '函館', 'AKJ': '旭川', 'KUH': '釧路',
  'MMB': '女満別', 'OBO': '帯広', 'WKJ': '稚内', 'SHB': '中標津',
  // 東北
  'AOJ': '青森', 'AXT': '秋田', 'HNA': '花巻', 'SDJ': '仙台',
  'GAJ': '山形', 'FKS': '福島', 'MSJ': '三沢', 'ONJ': '大館能代',
  // 中部
  'NGO': '中部', 'KIJ': '新潟', 'TOY': '富山',
  'KMQ': '小松', 'NTQ': '能登', 'FSZ': '静岡', 'MMJ': '松本',
  // 関西
  'ITM': '伊丹', 'KIX': '関空', 'UKB': '神戸', 'TJH': '但馬',
  'TTJ': '鳥取', 'YGJ': '米子', 'IZO': '出雲',
  // 中国・四国
  'OKJ': '岡山', 'HIJ': '広島', 'IWJ': '岩国', 'TAK': '高松',
  'TKS': '徳島', 'MYJ': '松山', 'KCZ': '高知',
  // 九州
  'FUK': '福岡', 'OIT': '大分', 'KMJ': '熊本', 'NGS': '長崎',
  'KKJ': '北九州', 'KMI': '宮崎', 'KOJ': '鹿児島', 'TSJ': '対馬',
  'IKI': '壱岐',
  // 沖縄
  'OKA': '那覇', 'ISG': '石垣', 'MYE': '宮古', 'MMY': '宮古',
  'AGJ': '粟国', 'KKX': '北大東', 'KTD': '南大東', 'TRA': '多良間',
  'UEO': '上五島', 'HAC': '八丈島'
};

const INTERNATIONAL_AIRPORTS = {
  // アジア
  'ICN': 'ソウル', 'GMP': 'ソウル(金浦)',
  'PEK': '北京', 'PVG': '上海', 'CAN': '広州', 'HKG': '香港',
  'TPE': '台北', 'TSA': '台北(松山)',
  'BKK': 'バンコク', 'SIN': 'シンガポール', 'KUL': 'クアラルンプール',
  'MNL': 'マニラ', 'CGK': 'ジャカルタ', 'DEL': 'デリー',
  // 米州
  'JFK': 'ニューヨーク', 'LAX': 'ロサンゼルス', 'SFO': 'サンフランシスコ',
  'ORD': 'シカゴ', 'BOS': 'ボストン', 'IAH': 'ヒューストン',
  'YVR': 'バンクーバー', 'YYZ': 'トロント',
  // 欧州
  'LHR': 'ロンドン', 'CDG': 'パリ', 'FRA': 'フランクフルト',
  'AMS': 'アムステルダム', 'MUC': 'ミュンヘン', 'HEL': 'ヘルシンキ',
  // 中東
  'IST': 'イスタンブール', 'DOH': 'ドーハ', 'DXB': 'ドバイ',
  // オセアニア
  'SYD': 'シドニー', 'MEL': 'メルボルン',
  // ハワイ・南太平洋
  'HNL': 'ホノルル', 'KOA': 'コナ'
};

const AIRPORT_NAMES = { ...DOMESTIC_AIRPORTS, ...INTERNATIONAL_AIRPORTS };

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

function classifyDomestic(code) {
  if (!code) return null;
  if (code in DOMESTIC_AIRPORTS) return false;
  if (code in INTERNATIONAL_AIRPORTS) return true;
  return true;
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
      isInternational: classifyDomestic(from),
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
      internationalFlights: flights.filter(f => f.isInternational === true).length,
      byTerminal
    }
  };
}
