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
