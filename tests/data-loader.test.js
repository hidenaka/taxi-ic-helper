import { test } from 'node:test';
import assert from 'node:assert';
import { loadJson } from './helpers.js';
import { validate } from '../js/data-loader.js';

test('validate: 現行の全JSONで整合性OK', () => {
  const data = {
    ics: loadJson('data/ics.json').ics,
    deduction: loadJson('data/deduction.json'),
    shutokoDist: loadJson('data/shutoko_distances.json'),
    gaikanDist: loadJson('data/gaikan_distances.json'),
    routes: loadJson('data/routes.json'),
    companyPay: loadJson('data/company-pay.json')
  };
  assert.doesNotThrow(() => validate(data));
});

test('validate: 欠落IDを検出してthrowする', () => {
  const data = {
    ics: [{ id: 'kasumigaseki', name: '霞ヶ関', gps: {lat: 0, lng: 0} }],
    deduction: { directions: [
      { id: 'tomei', baseline: { ic_id: 'tokyo_ic' }, entries: [] }
    ]},
    shutokoDist: { entries: [] },
    gaikanDist: { entries: [] },
    routes: { labels: {}, needs_gaikan_transit: {} },
    companyPay: { rules: [] }
  };
  assert.throws(() => validate(data), /deduction baseline missing/);
});
