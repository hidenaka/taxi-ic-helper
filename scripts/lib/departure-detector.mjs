/**
 * 出庫イベント検出。
 * - 入力: 前tickの tracked 配列、現tickの tracked 配列、現tickの lost 配列、tick タイムスタンプ
 * - lost 配列の各車両は事前に assignLane で lane / front_row が付与されている前提
 *   (observe-taxi-pool.mjs の runYoloPipeline で行う)
 * - lost 車両のうち front_row=true && lane != null のものが「出庫」イベント
 *
 * 旧実装は previousTracks の front_row を参照していたが、tracker の LOST_THRESHOLD
 * 遅延で previousTracks には乗らないケースがあり取り漏らしていた。
 * lost 側の bbox から最終位置で lane 判定する設計に変更。
 *
 * previousTracks は現状未使用だが、将来「出庫前の連続滞在検証」等で使えるため
 * シグネチャに残す。
 */
export function detectDepartures(previousTracks, currentTracks, lost, ts) {
  const events = [];
  for (const v of lost) {
    if (!v.front_row) continue;
    if (v.lane == null) continue;
    events.push({
      lane: v.lane,
      vehicle_id: v.id,
      ts
    });
  }
  return events;
}
