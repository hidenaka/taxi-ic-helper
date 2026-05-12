// Ray casting algorithm
export function pointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function assignLane(bbox, camera, config) {
  const [x, y, w, h] = bbox;
  // 車の bbox 上辺中央 = 画像奥側 = 羽田カメラではタクシーのフロント。
  // 中心点とフロントどちらかが polygon に入っていれば lane に割当。
  // ユーザー意図: フロントだけ枠に入っている / フロントがはみ出して bbox 全体は中に
  // 入っているなど、両方のパターンに対応する。
  const frontCenter = [x + w / 2, y];
  const bboxCenter = [x + w / 2, y + h / 2];
  for (const lane of config.lanes) {
    if (lane.camera !== camera) continue;
    const inFront = pointInPolygon(frontCenter, lane.polygon);
    const inCenter = pointInPolygon(bboxCenter, lane.polygon);
    if (!inFront && !inCenter) continue;
    const front_row = pointInPolygon(frontCenter, lane.front_row_polygon)
                    || pointInPolygon(bboxCenter, lane.front_row_polygon);
    return { lane: lane.id, front_row };
  }
  return { lane: null, front_row: false };
}

export function terminalForLane(laneId, config) {
  const lane = config.lanes.find(l => l.id === laneId);
  return lane ? lane.terminal : null;
}
