// 羽田プール現地案内テキスト(ttc.taxi-inf.jp index.php / no23.php の <td> 掲示)の
// 抽出・除去・判定を行う純関数。fetch-pool-notice.mjs から使う。

// 最初の <td>…</td> をタグ除去・改行保持でプレーン化。
export function extractTdText(html) {
  if (typeof html !== 'string') return '';
  const m = html.match(/<td>([\s\S]*?)<\/td>/i);
  if (!m) return '';
  return m[1]
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 常設お知らせ(【…について】見出し と tokyo-tc.or.jp URL 行)を落として運用テキストだけ残す。
export function stripBoilerplate(text) {
  if (!text) return '';
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (t === '') return true;
      if (/tokyo-tc\.or\.jp/.test(t)) return false;
      if (/^【.*について】$/.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 末尾規制【奇数|偶数】を抽出。
export function parseTailRegulation(text) {
  if (!text) return null;
  const m = text.match(/末尾規制[【\[]?\s*(奇数|偶数)\s*[】\]]?/);
  return m ? m[1] : null;
}

// 便名 + 号/乗り場/待機所 + 時刻/遅延 が揃えば、遅延便の現地案内が出ていると判定。
export function hasFlightNotice(text) {
  if (!text) return false;
  const hasFlight = /[A-Z]{2}\d{2,4}|便|航空/.test(text);
  const hasPool = /第?[1-4１-４]\s*(号|乗り場|乗場|待機所)/.test(text);
  const hasTimeOrDelay = /\d{1,2}:\d{2}|遅延|遅れ/.test(text);
  return hasFlight && hasPool && hasTimeOrDelay;
}

// 取得した各ソースのテキストから pool-notice 本体を組む。
export function buildPoolNotice({ no1Text = '', no34Text = '', updatedAt }) {
  const live1 = stripBoilerplate(no1Text);
  const live34 = stripBoilerplate(no34Text);
  const liveText = [live1, live34].filter(Boolean).join('\n---\n');
  const tailRegulation = parseTailRegulation(no1Text) || parseTailRegulation(no34Text);
  const flagged = hasFlightNotice(liveText);
  return {
    updatedAt,
    tailRegulation,
    liveText,
    hasFlightNotice: flagged,
    flightNoticeText: flagged ? liveText : '',
  };
}
