import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchEntries, buildValueToIcIdMap } from '../js/search.js';

// --- A. IC ↔ 検索値の生成 (buildSearchEntries) ---

test('A1: aliases 無し・1方面 → 単一の "${name}（${label}）" 値', () => {
  const groups = [{
    id: 'tomei', label: '東名',
    ics: [{ ic: { id: 'tokyo_ic', name: '東京IC' } }],
  }];
  const out = buildSearchEntries(groups);
  assert.deepEqual(out, [{ value: '東京IC（東名）', icId: 'tokyo_ic' }]);
});

test('A2: aliases 1件 → 「／alias」インライン挿入', () => {
  const groups = [{
    id: 'tokan', label: '東関東道',
    ics: [{ ic: { id: 'shin_kukou', name: '新空港IC', aliases: ['成田'] } }],
  }];
  const out = buildSearchEntries(groups);
  assert.deepEqual(out, [{ value: '新空港IC／成田（東関東道）', icId: 'shin_kukou' }]);
});

test('A3: aliases 複数 → 「・」区切りで全部インライン', () => {
  const groups = [{
    id: 'tokan', label: '東関東道',
    ics: [{ ic: { id: 'shin_kukou', name: '新空港IC', aliases: ['成田空港', '成田'] } }],
  }];
  const out = buildSearchEntries(groups);
  assert.deepEqual(out, [{ value: '新空港IC／成田空港・成田（東関東道）', icId: 'shin_kukou' }]);
});

test('A4: aliases が空配列 → 「／」が値に現れない', () => {
  const groups = [{
    id: 'tomei', label: '東名',
    ics: [{ ic: { id: 'tokyo_ic', name: '東京IC', aliases: [] } }],
  }];
  const out = buildSearchEntries(groups);
  assert.equal(out.length, 1);
  assert.ok(!out[0].value.includes('／'));
  assert.equal(out[0].value, '東京IC（東名）');
});

test('A5: 同 IC が複数方面 → 方面ごとに entry', () => {
  const groups = [
    { id: 'tokan', label: '東関東道',
      ics: [{ ic: { id: 'narita_kukou', name: '成田空港IC' } }] },
    { id: 'keiyo', label: '京葉道路',
      ics: [{ ic: { id: 'narita_kukou', name: '成田空港IC' } }] },
  ];
  const out = buildSearchEntries(groups);
  assert.equal(out.length, 2);
  const values = out.map(e => e.value);
  assert.ok(values.includes('成田空港IC（東関東道）'));
  assert.ok(values.includes('成田空港IC（京葉道路）'));
  assert.ok(out.every(e => e.icId === 'narita_kukou'));
});

test('A6: 入力 groups が空配列 → 結果も空配列', () => {
  assert.deepEqual(buildSearchEntries([]), []);
});

test('A7: グループ内 ics が空 → そのグループからは entry 出ない', () => {
  const groups = [
    { id: 'empty', label: '空', ics: [] },
    { id: 'tomei', label: '東名',
      ics: [{ ic: { id: 'tokyo_ic', name: '東京IC' } }] },
  ];
  const out = buildSearchEntries(groups);
  assert.deepEqual(out, [{ value: '東京IC（東名）', icId: 'tokyo_ic' }]);
});

// --- B. 値→ic_id 逆引き (buildValueToIcIdMap) ---

test('B8: 全 entry の value → icId が Map で逆引き可能', () => {
  const entries = [
    { value: '東京IC（東名）', icId: 'tokyo_ic' },
    { value: '新空港IC／成田（東関東道）', icId: 'shin_kukou' },
  ];
  const map = buildValueToIcIdMap(entries);
  assert.equal(map.get('東京IC（東名）'), 'tokyo_ic');
  assert.equal(map.get('新空港IC／成田（東関東道）'), 'shin_kukou');
  assert.equal(map.get('存在しない'), undefined);
});

test('B9: 同 ic_id が複数 value から引けても OK', () => {
  const entries = [
    { value: '成田空港IC（東関東道）', icId: 'narita_kukou' },
    { value: '成田空港IC（京葉道路）', icId: 'narita_kukou' },
  ];
  const map = buildValueToIcIdMap(entries);
  assert.equal(map.get('成田空港IC（東関東道）'), 'narita_kukou');
  assert.equal(map.get('成田空港IC（京葉道路）'), 'narita_kukou');
});

// --- C. 統合・実データ整合 ---

test('C10: 検索 value はユニーク制約を満たす（実データの全 entry で衝突なし）', async () => {
  const { loadJson } = await import('./helpers.js');
  const groups = buildGroupsFromRealData(loadJson);
  const entries = buildSearchEntries(groups);
  const values = entries.map(e => e.value);
  assert.equal(new Set(values).size, values.length, '検索 value の重複検出');
});

test('C11: shin_kukou の値は「成田」を含む（alias 検索で hit する）', async () => {
  const { loadJson } = await import('./helpers.js');
  const groups = buildGroupsFromRealData(loadJson);
  const entries = buildSearchEntries(groups);
  const shinkukoEntries = entries.filter(e => e.icId === 'shin_kukou');
  assert.ok(shinkukoEntries.length > 0, '新空港IC の entry が無い');
  assert.ok(
    shinkukoEntries.every(e => e.value.includes('成田')),
    '新空港IC の値に「成田」が含まれていない: ' + JSON.stringify(shinkukoEntries.map(e => e.value)),
  );
});

test('C12: 各 IC は少なくとも 1 entry に登場する', async () => {
  const { loadJson } = await import('./helpers.js');
  const ics = loadJson('data/ics.json').ics;
  const groups = buildGroupsFromRealData(loadJson);
  const entries = buildSearchEntries(groups);
  const seen = new Set(entries.map(e => e.icId));
  const missing = ics.filter(ic => !seen.has(ic.id) && ic.entry_type !== 'jct');
  assert.deepEqual(missing.map(i => i.id), [], '検索 entry に出ない IC: ' + JSON.stringify(missing.map(i => i.id)));
});

// --- helpers ---

const DIRECTION_ORDER = [
  'tomei', 'chuo', 'kanetsu', 'tohoku', 'joban',
  'keiyo', 'tokan', 'aqua', 'tateyama',
  'third_keihin', 'yokoyoko', 'yokohane_route', 'kariba_route', 'wangan_route',
  'gaikan', 'shutoko_inner',
];
const DIRECTION_LABELS = {
  tomei: '東名', chuo: '中央道', kanetsu: '関越道', tohoku: '東北道', joban: '常磐道',
  keiyo: '京葉道', tokan: '東関東道', aqua: 'アクアライン', tateyama: '館山道',
  third_keihin: '第三京浜', yokoyoko: '玉川経由', yokohane_route: '横羽線経由',
  kariba_route: '狩場線経由', wangan_route: '湾岸線経由',
  gaikan: '外環道', shutoko_inner: '首都高都心側',
};

function buildGroupsFromRealData(loadJson) {
  const { ics } = loadJson('data/ics.json');
  const { directions } = loadJson('data/deduction.json');
  const assignment = new Map();
  for (const dir of directions) {
    if (!assignment.has(dir.baseline.ic_id)) {
      assignment.set(dir.baseline.ic_id, [{ groupId: dir.id, sortKey: 0 }]);
    }
    for (const e of dir.entries) {
      const list = assignment.get(e.ic_id) || [];
      list.push({ groupId: dir.id, sortKey: e.km });
      assignment.set(e.ic_id, list);
    }
  }
  for (const ic of ics) {
    if (assignment.has(ic.id)) continue;
    if (ic.entry_type === 'jct') continue;
    if (ic.boundary_tag === 'gaikan') {
      assignment.set(ic.id, [{ groupId: 'gaikan', sortKey: 0 }]);
    } else {
      assignment.set(ic.id, [{ groupId: 'shutoko_inner', sortKey: 0 }]);
    }
  }
  const groups = DIRECTION_ORDER.map(gid => ({
    id: gid, label: DIRECTION_LABELS[gid] || gid, ics: [],
  }));
  const groupMap = new Map(groups.map(g => [g.id, g]));
  for (const ic of ics) {
    const memberships = assignment.get(ic.id) || [];
    for (const m of memberships) {
      const grp = groupMap.get(m.groupId);
      if (grp) grp.ics.push({ ic, sortKey: m.sortKey });
    }
  }
  return groups.filter(g => g.ics.length > 0);
}
