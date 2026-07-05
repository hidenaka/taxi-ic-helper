import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { movementShiftHistoryRow } from '../scripts/lib/movement-shift-history-row.mjs';

test('movementShiftHistoryRow: sourceImagesを履歴行に残す', () => {
  const row = movementShiftHistoryRow({
    ts: '2026-07-05T19:49:46+09:00',
    stalls: { stall2: { frontDensity: 37.93 } },
    sourceImages: {
      real01_line: '/Users/nakanohideaki/taxi-image-archive/real01_line/2026-07-05/194928.jpg',
      real02: '/Users/nakanohideaki/taxi-image-archive/real02/2026-07-05/194928.jpg',
    },
  });

  assert.equal(row.schema_version, 3);
  assert.equal(row.ts, '2026-07-05T19:49:46+09:00');
  assert.deepEqual(row.stalls, { stall2: { frontDensity: 37.93 } });
  assert.deepEqual(row.sourceImages, {
    real01_line: '/Users/nakanohideaki/taxi-image-archive/real01_line/2026-07-05/194928.jpg',
    real02: '/Users/nakanohideaki/taxi-image-archive/real02/2026-07-05/194928.jpg',
  });
});
