// Adjacency map built once from shutoko_graph.json
export function buildAdjacency(graph) {
  const adj = new Map();
  for (const e of graph.edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to))   adj.set(e.to, []);
    adj.get(e.from).push({ to: e.to, km: e.km, route: e.route });
    adj.get(e.to).push({ to: e.from, km: e.km, route: e.route });   // undirected
  }
  return adj;
}

export function shortestPath(adj, fromId, toId) {
  if (fromId === toId) return { km: 0, path: [fromId] };
  const dist = new Map();
  const prev = new Map();
  const visited = new Set();
  dist.set(fromId, 0);

  // Simple priority queue (array scan — graph is small ~300 nodes so O(V^2) is fine)
  while (true) {
    let uId = null, uDist = Infinity;
    for (const [id, d] of dist) {
      if (!visited.has(id) && d < uDist) { uId = id; uDist = d; }
    }
    if (uId === null) break;
    if (uId === toId) break;
    visited.add(uId);
    const neighbors = adj.get(uId) || [];
    for (const n of neighbors) {
      const alt = uDist + n.km;
      if (alt < (dist.get(n.to) ?? Infinity)) {
        dist.set(n.to, alt);
        prev.set(n.to, uId);
      }
    }
  }

  if (!dist.has(toId)) return { km: null, path: null };

  const path = [toId];
  let cur = toId;
  while (prev.has(cur)) {
    cur = prev.get(cur);
    path.unshift(cur);
  }
  return { km: dist.get(toId), path };
}
