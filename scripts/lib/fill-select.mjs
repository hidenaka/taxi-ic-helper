// 埋まり率を「どの方式で出すか」を決める純粋関数。
//
// 背景(2026-08-31): 埋まり率は長く「YOLOの台数 ÷ 観測最大」だったが、奥の号は車が小さく
// 重なるため1台ずつ分けられず、満車の1号が 0-12% と出ていた(目視20台以上に対し検出2台)。
// 代わりに「帯の路面がどれだけ車で埋まっているか」を測る方式(surface)を主系にする。
//
// 方式の使い分け:
//   surface        … 昼の1〜3号。密集していても測れる主系
//   count          … 4号。手前の帯は路面ベースだと数字が暴れる(0-47%)ので台数のまま
//   lantern        … 夜。屋根の行灯を数えるのが正規の方式
//   count-fallback … 昼の1〜3号で路面ベースが取れなかった時。これは異常の合図
//
// 容量は昼夜で別に持つ。夜の行灯は密集していても数えられるので値が大きく、
// 同じ容量で昼の台数を割るとどの号も上限に届かない(1号は昼最大13/容量32=41%止まり)。

/**
 * @param {object} p
 * @param {number|undefined} p.surface  路面ベースの値(0-1)。昼のみ存在
 * @param {number|undefined} p.occ      台数
 * @param {number|undefined} p.capacity その方式・その時間帯の容量
 * @param {boolean} p.isNight           行灯が主系の tick か
 * @param {boolean} p.isStall4          4号か(設計上ずっと台数方式)
 * @returns {{fillRate: number|null, fillMethod: string|null}}
 */
export function pickFillRate({ surface, occ, capacity, isNight = false, isStall4 = false }) {
  if (!isStall4 && typeof surface === 'number' && surface >= 0) {
    return { fillRate: Number(Math.min(1, surface).toFixed(4)), fillMethod: 'surface' };
  }
  if (!(capacity > 0) || typeof occ !== 'number') {
    return { fillRate: null, fillMethod: null };
  }
  const fillRate = Number((occ / capacity).toFixed(4));
  const fillMethod = isStall4 ? 'count' : (isNight ? 'lantern' : 'count-fallback');
  return { fillRate, fillMethod };
}

/** 昼夜で容量セットを選ぶ。昼の容量が無い号は夜の容量に落とす。 */
export function capacityFor(cap, key, isNight) {
  if (isNight) return cap?.[key];
  const day = cap?.day?.[key];
  return typeof day === 'number' ? day : cap?.[key];
}
