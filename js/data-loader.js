export async function loadAllData() {
  const paths = {
    ics:         './data/ics.json',
    deduction:   './data/deduction.json',
    shutokoDist: './data/shutoko_distances.json',
    gaikanDist:  './data/gaikan_distances.json',
    routes:      './data/routes.json',
    companyPay:  './data/company-pay.json',
    favorites:   './data/favorites.json'
  };
  const entries = await Promise.all(
    Object.entries(paths).map(async ([k, p]) => [k, await (await fetch(p)).json()])
  );
  const data = Object.fromEntries(entries);
  data.ics = data.ics.ics;
  validate(data);
  return data;
}

export function validate(data) {
  const icIds = new Set(data.ics.map(x => x.id));
  const errors = [];

  for (const dir of data.deduction.directions) {
    if (!icIds.has(dir.baseline.ic_id)) {
      errors.push(`deduction baseline missing: ${dir.id}/${dir.baseline.ic_id}`);
    }
    for (const e of dir.entries) {
      if (!icIds.has(e.ic_id)) errors.push(`deduction entry missing: ${e.ic_id}`);
    }
  }
  for (const e of data.shutokoDist.entries) {
    if (!icIds.has(e.from)) errors.push(`shutoko from missing: ${e.from}`);
    if (!icIds.has(e.to))   errors.push(`shutoko to missing: ${e.to}`);
  }
  for (const e of data.gaikanDist.entries) {
    if (!icIds.has(e.from)) errors.push(`gaikan from missing: ${e.from}`);
    if (!icIds.has(e.to))   errors.push(`gaikan to missing: ${e.to}`);
  }

  if (errors.length > 0) {
    throw new Error('Data integrity errors:\n' + errors.join('\n'));
  }
  return true;
}
