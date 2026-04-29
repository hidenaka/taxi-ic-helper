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

/**
 * ICが外側高速のentriesにkm>0で存在するかチェック。
 * km=0の場合（首都高内ICとしての登録）は無視する。
 */
function hasRealOuterEntry(ic, deduction) {
  if (!ic) return false;
  if (BASELINE_ROUTE_OPTIONS[ic.id]) return true;
  for (const dir of deduction.directions) {
    const entry = dir.entries.find((e) => e.ic_id === ic.id);
    if (entry && entry.km > 0) return true;
  }
  return false;
}

/**
 * ICが外側高速のbaselineであるかチェック。
 */
function isOuterBaseline(ic, deduction) {
  if (!ic) return false;
  return deduction.directions.some((d) => d.baseline.ic_id === ic.id);
}

/**
 * ICが「純粋な首都高内IC」かどうか。
 * 外側高速のentriesにkm>0で存在せず、baselineでもない。
 */
function isPureShutokoIc(ic, deduction) {
  return !hasRealOuterEntry(ic, deduction) && !isOuterBaseline(ic, deduction);
}

function matchedRoutesForIc(ic, deduction) {
  if (!ic) return null;
  if (BASELINE_ROUTE_OPTIONS[ic.id]) {
    return BASELINE_ROUTE_OPTIONS[ic.id].map((id, index) => ({ id, km: index }));
  }

  const matched = [];
  for (const dir of deduction.directions) {
    const entry = dir.entries.find((e) => e.ic_id === ic.id);
    if (entry && entry.km > 0) matched.push({ id: dir.id, km: entry.km });
  }
  return matched.length > 0 ? matched : null;
}

function getExitRouteIds(exitIc, deduction) {
  if (!exitIc) return new Set();
  const ids = new Set();
  for (const dir of deduction.directions) {
    if (dir.entries.some((e) => e.ic_id === exitIc.id && e.km > 0)) {
      ids.add(dir.id);
    }
  }
  return ids;
}

export function getOuterRouteOptionsForIc({ ic, exitIc = null, deduction }) {
  if (!ic) return ['none'];

  // 入口がBASELINE（外側高速の起点IC）→ そのままBASELINE_ROUTE_OPTIONSを使う
  if (BASELINE_ROUTE_OPTIONS[ic.id]) {
    let matched = BASELINE_ROUTE_OPTIONS[ic.id].map((id, index) => ({ id, km: index }));

    // 出口が首都高内ICで、かつ外側高速のentriesにkm>0で存在する場合、そのdirectionも追加
    if (exitIc && isPureShutokoIc(exitIc, deduction)) {
      for (const dir of deduction.directions) {
        const entry = dir.entries.find((e) => e.ic_id === exitIc.id && e.km > 0);
        if (entry && !matched.some((m) => m.id === dir.id)) {
          matched.push({ id: dir.id, km: entry.km });
        }
      }
    }

    // 出口マッチングの優先順位ソート
    const exitRouteIds = getExitRouteIds(exitIc, deduction);
    const isHanedaBound = HANEDA_EXIT_IDS.has(exitIc?.id);
    const directRoute = ic.route;
    const wanganFirst = new Set(['tokan', 'wangan_route', 'aqua']);

    matched.sort((a, b) => {
      if (isHanedaBound) {
        const ap = priorityIndex(HANEDA_KANAGAWA_PRIORITY, a.id);
        const bp = priorityIndex(HANEDA_KANAGAWA_PRIORITY, b.id);
        if (ap !== bp) return ap - bp;
      } else {
        // 出口ICがentriesに存在するdirectionを最優先
        const aInExit = exitRouteIds.has(a.id);
        const bInExit = exitRouteIds.has(b.id);
        if (aInExit !== bInExit) return aInExit ? -1 : 1;

        const ad = a.id === directRoute, bd = b.id === directRoute;
        if (ad !== bd) return ad ? -1 : 1;
      }
      const aw = wanganFirst.has(a.id), bw = wanganFirst.has(b.id);
      if (aw !== bw) return aw ? -1 : 1;
      return a.km - b.km;
    });
    return matched.map((m) => m.id);
  }

  // 入口が外側高速の途中IC → そのdirectionのみ
  let matched = matchedRoutesForIc(ic, deduction);
  if (matched?.length > 0) {
    const isHanedaBound = HANEDA_EXIT_IDS.has(exitIc?.id);
    const directRoute = ic.route;
    const wanganFirst = new Set(['tokan', 'wangan_route', 'aqua']);
    matched.sort((a, b) => {
      if (isHanedaBound) {
        const ap = priorityIndex(HANEDA_KANAGAWA_PRIORITY, a.id);
        const bp = priorityIndex(HANEDA_KANAGAWA_PRIORITY, b.id);
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

  // 入口が首都高内IC → 出口ICに応じてouterRouteを決定
  if (isPureShutokoIc(ic, deduction)) {
    // 出口も首都高内IC → 首都高内のみ
    if (!exitIc || isPureShutokoIc(exitIc, deduction)) {
      return ['none'];
    }

    // 出口が外側高速のbaseline → そのdirection
    for (const dir of deduction.directions) {
      if (dir.baseline.ic_id === exitIc.id) {
        return [dir.id];
      }
    }

    // 出口が外側高速の途中IC → そのdirection
    for (const dir of deduction.directions) {
      const entry = dir.entries.find((e) => e.ic_id === exitIc.id && e.km > 0);
      if (entry) {
        return [dir.id];
      }
    }

    // 出口が湾岸環八/空港中央など → 複数候補
    if (HANEDA_ENTRY_IDS.has(exitIc.id)) {
      return ['wangan_route', 'yokohane_route', 'kitasen_route'];
    }

    return ['none'];
  }

  if (ic.boundary_tag === 'gaikan') return ['gaikan_direct'];
  return ['none'];
}
