const HANEDA_EXIT_IDS = new Set(['kukou_chuou', 'wangan_kanpachi']);
const HANEDA_ENTRY_IDS = new Set(['kukou_chuou', 'wangan_kanpachi']);
const HANEDA_KANAGAWA_PRIORITY = [
  'hokuseisen_route',
  'kitasen_route',
  'wangan_route',
  'yokohane_route',
  'hodogaya_route',
  'third_keihin',
  'yokoyoko',
  'tomei',
];
const HANEDA_ORIGIN_PRIORITY = [
  'tomei',
  'chuo',
  'kitasen_route',
  'hokuseisen_route',
  'wangan_route',
  'yokohane_route',
  'hodogaya_route',
  'third_keihin',
  'yokoyoko',
];

const BASELINE_ROUTE_OPTIONS = {
  tokyo_ic: ['tomei', 'kitasen_route'],
  takaido: ['chuo'],
  nerima: ['kanetsu'],
  kawaguchi_jct: ['tohoku'],
  misato_jct: ['joban'],
  shinozaki: ['keiyo'],
  wangan_ichikawa: ['tokan'],
  ukishima_jct: ['aqua'],
  kisarazu_jct: ['tateyama'],
  tamagawa_ic: ['third_keihin', 'yokoyoko'],
  kukou_chuou: ['wangan_route', 'kitasen_route', 'hokuseisen_route', 'yokohane_route', 'hodogaya_route'],
  wangan_kanpachi: ['wangan_route', 'kitasen_route', 'hokuseisen_route', 'yokohane_route', 'hodogaya_route'],
};

function priorityIndex(list, routeId) {
  const idx = list.indexOf(routeId);
  return idx === -1 ? Number.POSITIVE_INFINITY : idx;
}

function matchedRoutesForIc(ic, deduction) {
  if (!ic) return null;
  if (BASELINE_ROUTE_OPTIONS[ic.id]) {
    return BASELINE_ROUTE_OPTIONS[ic.id].map((id, index) => ({ id, km: index }));
  }

  const matched = [];
  for (const dir of deduction.directions) {
    const entry = dir.entries.find((e) => e.ic_id === ic.id);
    if (entry) matched.push({ id: dir.id, km: entry.km });
  }
  return matched.length > 0 ? matched : null;
}

function getExitRouteIds(exitIc, deduction) {
  if (!exitIc) return new Set();
  const ids = new Set();
  for (const dir of deduction.directions) {
    if (dir.entries.some((e) => e.ic_id === exitIc.id)) {
      ids.add(dir.id);
    }
  }
  return ids;
}

export function getOuterRouteOptionsForIc({ ic, exitIc = null, deduction }) {
  if (!ic) return ['none'];

  let matched = matchedRoutesForIc(ic, deduction);
  let routeSourceIc = ic;
  if (!matched && exitIc) {
    matched = matchedRoutesForIc(exitIc, deduction);
    routeSourceIc = exitIc;
  }

  // 入口が首都高内（km=0で登録されている）場合、出口ICが所属するdirectionも候補に追加
  if (matched && exitIc && HANEDA_ENTRY_IDS.has(ic?.id)) {
    for (const dir of deduction.directions) {
      const entry = dir.entries.find((e) => e.ic_id === exitIc.id);
      const alreadyIn = matched.some((m) => m.id === dir.id);
      if (entry && !alreadyIn) {
        matched.push({ id: dir.id, km: entry.km });
      }
    }
  }

  if (matched?.length > 0) {
    const isHanedaBound = HANEDA_EXIT_IDS.has(exitIc?.id);
    const isHanedaOrigin = HANEDA_ENTRY_IDS.has(routeSourceIc?.id) || HANEDA_ENTRY_IDS.has(ic?.id);
    const exitRouteIds = getExitRouteIds(exitIc, deduction);
    const directRoute = routeSourceIc.route;
    const wanganFirst = new Set(['tokan', 'wangan_route', 'aqua']);
    matched.sort((a, b) => {
      if (isHanedaBound) {
        const ap = priorityIndex(HANEDA_KANAGAWA_PRIORITY, a.id);
        const bp = priorityIndex(HANEDA_KANAGAWA_PRIORITY, b.id);
        if (ap !== bp) return ap - bp;
      } else if (isHanedaOrigin) {
        // 出口ICがentriesに存在するdirectionを最優先
        const aInExit = exitRouteIds.has(a.id);
        const bInExit = exitRouteIds.has(b.id);
        if (aInExit !== bInExit) return aInExit ? -1 : 1;

        const ap = priorityIndex(HANEDA_ORIGIN_PRIORITY, a.id);
        const bp = priorityIndex(HANEDA_ORIGIN_PRIORITY, b.id);
        if (ap !== bp) return ap - bp;
      } else {
        const ad = a.id === directRoute, bd = b.id === directRoute;
        if (ad !== bd) return ad ? -1 : 1;
      }
      const aw = wanganFirst.has(a.id), bw = wanganFirst.has(b.id);
      if (aw !== bw) return aw ? -1 : 1;
      return a.km - b.km;
    });
    return matched.map((m) => m.id);
  }

  if (ic.boundary_tag === 'gaikan') return ['gaikan_direct'];
  return ['none'];
}
