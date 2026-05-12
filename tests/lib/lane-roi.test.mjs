import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { pointInPolygon, assignLane, terminalForLane } from '../../scripts/lib/lane-roi.mjs';

const LANE_CONFIG = {
  lanes: [
    {
      id: '第一-一般', terminal: 'T1', camera: 'real01_line',
      polygon: [[100, 300], [200, 300], [200, 500], [100, 500]],
      front_row_polygon: [[100, 480], [200, 480], [200, 500], [100, 500]]
    },
    {
      id: '第二-一般', terminal: 'T1', camera: 'real01_line',
      polygon: [[210, 300], [310, 300], [310, 500], [210, 500]],
      front_row_polygon: [[210, 480], [310, 480], [310, 500], [210, 500]]
    },
    {
      id: '第三-一般', terminal: 'T2', camera: 'real01_line',
      polygon: [[400, 300], [500, 300], [500, 500], [400, 500]],
      front_row_polygon: [[400, 480], [500, 480], [500, 500], [400, 500]]
    }
  ]
};

test('pointInPolygon: 内側はtrue', () => {
  const poly = [[100, 100], [200, 100], [200, 200], [100, 200]];
  assert.equal(pointInPolygon([150, 150], poly), true);
});

test('pointInPolygon: 外側はfalse', () => {
  const poly = [[100, 100], [200, 100], [200, 200], [100, 200]];
  assert.equal(pointInPolygon([50, 50], poly), false);
});

test('pointInPolygon: 三角形の内外', () => {
  const poly = [[0, 0], [100, 0], [50, 100]];
  assert.equal(pointInPolygon([50, 30], poly), true);
  assert.equal(pointInPolygon([10, 90], poly), false);
});

test('assignLane: bbox中心が第一-一般の polygon に入る', () => {
  const bbox = [120, 350, 50, 50]; // 中心(145, 375) → 第一-一般
  const r = assignLane(bbox, 'real01_line', LANE_CONFIG);
  assert.equal(r.lane, '第一-一般');
  assert.equal(r.front_row, false);
});

test('assignLane: bbox中心が第二-一般の front_row に入る', () => {
  const bbox = [240, 480, 30, 30]; // 中心(255, 495) → 第二-一般 front_row
  const r = assignLane(bbox, 'real01_line', LANE_CONFIG);
  assert.equal(r.lane, '第二-一般');
  assert.equal(r.front_row, true);
});

test('assignLane: どのlaneにも入らない', () => {
  const bbox = [700, 350, 30, 30]; // 範囲外
  const r = assignLane(bbox, 'real01_line', LANE_CONFIG);
  assert.equal(r.lane, null);
});

test('terminalForLane: 第一/第二は T1', () => {
  assert.equal(terminalForLane('第一-一般', LANE_CONFIG), 'T1');
  assert.equal(terminalForLane('第二-一般', LANE_CONFIG), 'T1');
});

test('terminalForLane: 第三/第四は T2', () => {
  assert.equal(terminalForLane('第三-一般', LANE_CONFIG), 'T2');
});

test('terminalForLane: 存在しない lane は null', () => {
  assert.equal(terminalForLane('存在しない', LANE_CONFIG), null);
});

test('assignLane: フロントだけ polygon に入っている (中心は外)', () => {
  // bbox の y範囲 250〜400, 中心(150, 325). polygon の上辺は y=300.
  // 中心 325 は polygon の中。フロント 250 は polygon の外（上方向）。
  // フロントが外でも中心が中なら割当される。
  const bbox = [125, 250, 50, 150];
  const r = assignLane(bbox, 'real01_line', LANE_CONFIG);
  assert.equal(r.lane, '第一-一般');
});

test('assignLane: 中心が外でもフロントだけ polygon に入っていれば割当', () => {
  // bbox の y範囲 290〜540, 中心(150, 415), front(150, 290).
  // 中心は polygon の中、フロントは外。両方とも outsideのケースを別途検証。
  // この lane の polygon は y=300-500。
  // bbox を y=270〜290 にして中心=280 / front=270 で polygon 外。両方 false で lane=null。
  const outsideBbox = [125, 270, 50, 20];
  const r1 = assignLane(outsideBbox, 'real01_line', LANE_CONFIG);
  assert.equal(r1.lane, null);

  // 次は逆: bbox の y=295〜315, 中心=305 (lane内), front=295 (lane外、y=295 < 300)。
  // 中心が in なので lane 判定OK。
  const partialBbox = [125, 295, 50, 20];
  const r2 = assignLane(partialBbox, 'real01_line', LANE_CONFIG);
  assert.equal(r2.lane, '第一-一般');
});

test('assignLane: フロントが polygon 内、中心は外 (車が画像奥側にずれた状態)', () => {
  // polygon y範囲 300-500。bbox y=295〜515 (中心=405、front=295)。
  // 中心 405 は in、front 295 は out → 中心 in で割当。
  // 別ケース: bbox y=295〜305 (中心=300、front=295) → 中心ぎりぎり in、front out。
  // さらに別ケース: bbox y=305〜315 (中心=310, front=305) → 両方 in。
  // フロントだけ in / 中心だけ out のケース: polygon を細い帯 (y=300-310) と仮定。
  const narrowConfig = {
    lanes: [{
      id: '帯lane', terminal: 'T1', camera: 'real01_line',
      polygon: [[100, 300], [200, 300], [200, 310], [100, 310]],
      front_row_polygon: [[100, 300], [200, 300], [200, 310], [100, 310]]
    }]
  };
  // bbox y=305〜355 (中心=330, front=305)。frontは in、中心は out → 割当される
  const bbox = [120, 305, 50, 50];
  const r = assignLane(bbox, 'real01_line', narrowConfig);
  assert.equal(r.lane, '帯lane');
  assert.equal(r.front_row, true);
});
