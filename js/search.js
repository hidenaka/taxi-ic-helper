/**
 * Build search entries (value/icId pairs) from grouped IC data.
 * Each entry is one row in the IC search datalist.
 *
 * @param {Array<{id, label, ics: Array<{ic: {id, name, aliases?}}>}>} groups
 * @returns {Array<{value: string, icId: string}>}
 */
export function buildSearchEntries(groups) {
  const entries = [];
  for (const grp of groups) {
    for (const { ic } of grp.ics) {
      const displayName = ic.name.replace(/（[^）]*）/g, '').trim();
      const aliasInline = (ic.aliases && ic.aliases.length)
        ? `／${ic.aliases.join('・')}`
        : '';
      const value = `${displayName}${aliasInline}`;
      entries.push({ value, icId: ic.id, groupLabel: grp.label });
    }
  }
  // 同じ value で異なる icId を指す衝突があれば、方面名を付加して解消
  const valueToIcIds = new Map();
  for (const e of entries) {
    const set = valueToIcIds.get(e.value) || new Set();
    set.add(e.icId);
    valueToIcIds.set(e.value, set);
  }
  for (const e of entries) {
    if (valueToIcIds.get(e.value).size > 1) {
      e.value = `${e.value}（${e.groupLabel}）`;
    }
    delete e.groupLabel;
  }
  return entries;
}

/**
 * Reverse-index search entries: value → icId.
 *
 * @param {Array<{value: string, icId: string}>} entries
 * @returns {Map<string, string>}
 */
export function buildValueToIcIdMap(entries) {
  return new Map(entries.map((e) => [e.value, e.icId]));
}
