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
      entries.push({ value, icId: ic.id });
    }
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
