const ENDPOINT = 'https://api.odpt.org/api/v4/odpt:FlightInformationArrival';
const OPERATORS = ['JAL', 'ANA', 'JJP', 'SKY', 'ADO', 'SNA', 'SFJ'];

/**
 * ODPT API から羽田到着便を取得
 * @param {string} token - acl:consumerKey
 * @returns {Promise<Array>} odpt:FlightInformationArrival の配列
 */
export async function fetchHndArrivals(token) {
  if (!token) throw new Error('ODPT token is required');
  const all = [];
  for (const op of OPERATORS) {
    const url = `${ENDPOINT}?odpt:operator=odpt.Operator:${op}&acl:consumerKey=${encodeURIComponent(token)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        console.error(`[odpt-client] ${op} HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const hndOnly = data.filter(item => {
        const t = item['odpt:arrivalAirportTerminal'];
        return typeof t === 'string' && t.includes('HND');
      });
      all.push(...hndOnly);
    } catch (e) {
      console.error(`[odpt-client] ${op} error: ${e.message}`);
    }
  }
  return all;
}
