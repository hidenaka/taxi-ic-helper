const HANEDA_EXIT_IDS = new Set(['kukou_chuou', 'wangan_kanpachi']);
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
 * ICの分類を判定する。
 * - OUTER_BASELINE: いずれかのdirectionのbaseline（外側高速の起点）
 * - OUTER_TRANSIT: 外側高速のentriesにkm>0で存在（外側高速の途中IC）
 * - CONNECTOR: 外側高速のentriesにkm=0のみ存在（首都高内だが外側高速接続点）
 * - PURE_SHUTOKO: 外側高速のentriesに存在せず、baselineでもない（純粋な首都高内IC）
 */
function classifyIc(ic, deduction) {
  if (!ic) return 'PURE_SHUTOKO';

  // 1. OUTER_BASELINE チェック
  for (const dir of deduction.directions) {
    if (dir.baseline.ic_id === ic.id) return 'OUTER_BASELINE';
  }

  // 2. entriesを走査してkm>0かkm=0かを判定
  let hasKmGt0 = false;
  let hasKmZero = false;
  for (const dir of deduction.directions) {
    const entry = dir.entries.find((e) => e.ic_id === ic.id);
    if (entry) {
      if (entry.km > 0) hasKmGt0 = true;
      else if (entry.km === 0) hasKmZero = true;
    }
  }

  if (hasKmGt0) return 'OUTER_TRANSIT';
  if (hasKmZero) return 'CONNECTOR';
  return 'PURE_SHUTOKO';
}

/**
 * 指定ICにマッチするdirectionとkmを返す。
 * OUTER_BASELINEの場合はBASELINE_ROUTE_OPTIONSから、
 * それ以外はdeduction.directions.entriesから取得。
 * CONNECTOR（km=0）も含む。
 */
function matchedRoutesForIc(ic, deduction) {
  if (!ic) return null;

  if (BASELINE_ROUTE_OPTIONS[ic.id]) {
    return BASELINE_ROUTE_OPTIONS[ic.id].map((id, index) => ({ id, km: index }));
  }

  const matched = [];
  for (const dir of deduction.directions) {
    const entry = dir.entries.find((e) => e.ic_id === ic.id);
    if (entry && entry.km >= 0) {
      matched.push({ id: dir.id, km: entry.km });
    }
  }
  return matched.length > 0 ? matched : null;
}

/**
 * 出口ICがentriesにkm>0で存在するdirection IDセットを返す。
 */
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

/**
 * ルート候補をソートして返す共通処理。
 */
function sortAndMapRoutes(matched, { isHanedaBound, directRoute, exitRouteIds, wanganFirst }) {
  matched.sort((a, b) => {
    if (isHanedaBound) {
      const ap = priorityIndex(HANEDA_KANAGAWA_PRIORITY, a.id);
      const bp = priorityIndex(HANEDA_KANAGAWA_PRIORITY, b.id);
      if (ap !== bp) return ap - bp;
    } else if (exitRouteIds) {
      // 出口ICがentriesに存在するdirectionを最優先
      const aInExit = exitRouteIds.has(a.id);
      const bInExit = exitRouteIds.has(b.id);
      if (aInExit !== bInExit) return aInExit ? -1 : 1;
    }

    if (directRoute !== undefined) {
      const ad = a.id === directRoute;
      const bd = b.id === directRoute;
      if (ad !== bd) return ad ? -1 : 1;
    }

    const aw = wanganFirst.has(a.id);
    const bw = wanganFirst.has(b.id);
    if (aw !== bw) return aw ? -1 : 1;

    return a.km - b.km;
  });
  return matched.map((m) => m.id);
}

export function getOuterRouteOptionsForIc({ ic, exitIc = null, deduction }) {
  if (!ic) return ['none'];

  const icClass = classifyIc(ic, deduction);
  const exitClass = classifyIc(exitIc, deduction);

  const wanganFirst = new Set(['tokan', 'wangan_route', 'aqua']);
  const isHanedaBound = HANEDA_EXIT_IDS.has(exitIc?.id);
  const directRoute = ic.route;
  const exitRouteIds = getExitRouteIds(exitIc, deduction);

  // =========================================
  // 入口が外側高速IC（BASELINE または TRANSIT）
  // =========================================
  // 外側高速から首都高へ入る場合も、外側高速区間の控除計算のため
  // 入口ICのdirection候補を返す必要がある。
  if (icClass === 'OUTER_BASELINE' || icClass === 'OUTER_TRANSIT') {
    let matched = matchedRoutesForIc(ic, deduction);
    if (matched?.length > 0) {
      return sortAndMapRoutes(matched, { isHanedaBound, directRoute, exitRouteIds, wanganFirst });
    }

    return ['none'];
  }

  // =========================================
  // 入口が首都高内IC（CONNECTOR または PURE_SHUTOKO）
  // =========================================
  if (icClass === 'CONNECTOR' || icClass === 'PURE_SHUTOKO') {
    // 出口が首都高内（CONNECTOR or PURE_SHUTOKO）→ 首都高内完結
    if (exitClass === 'CONNECTOR' || exitClass === 'PURE_SHUTOKO') {
      return ['none'];
    }

    // 出口が外側高速（BASELINE or TRANSIT）→ 出口ICのdirection候補を返す
    let matched = matchedRoutesForIc(exitIc, deduction);
    if (matched?.length > 0) {
      return sortAndMapRoutes(matched, { isHanedaBound, directRoute, exitRouteIds, wanganFirst });
    }

    return ['none'];
  }

  // フォールバック
  if (ic.boundary_tag === 'gaikan') return ['gaikan_direct'];
  return ['none'];
}
