// Structured top-to-bottom layout. size(n) -> { w, h }. Returns { [id]: { x, y } }. Pure (testable outside the app).
//
// Meaning in the layout comes from three optional keys on a node's data:
//   stage   — a row: every node of a stage sits on one row (e.g. "views", "base", "pieces")
//   lane    — a column: nodes with the same lane share x across every stage (e.g. "front", "back")
//   section — a block of rows with its own lanes (e.g. "character", "props"); blocks stack top to bottom
// An Output takes its producing prompt's lane/section, and its stage becomes "<prompt stage>:out" (the row below).
// Nodes without keys fall back to rows by dependency depth, centred under what feeds them.
export function arrange(nodes, edges, size, { rowGap = 90, colGap = 50, sectionGap = 160 } = {}) {
  const ids = new Set(nodes.map((n) => n.id));
  const es = edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const parents = {}, kids = {};
  for (const n of nodes) { parents[n.id] = []; kids[n.id] = []; }
  for (const e of es) { parents[e.target].push(e.source); kids[e.source].push(e.target); }
  const old = Object.fromEntries(nodes.map((n) => [n.id, n.position]));
  const sz = Object.fromEntries(nodes.map((n) => [n.id, size(n)]));
  const oldCx = (id) => old[id].x + sz[id].w / 2;

  // dependency depth (longest chain above), cycle-safe
  const depth = Object.fromEntries(nodes.map((n) => [n.id, 0]));
  for (let it = 0; it < nodes.length; it++) {
    let moved = false;
    for (const e of es) if (depth[e.target] < depth[e.source] + 1 && depth[e.source] + 1 < nodes.length) { depth[e.target] = depth[e.source] + 1; moved = true; }
    if (!moved) break;
  }
  for (const n of nodes) if (!parents[n.id].length && kids[n.id].length) depth[n.id] = Math.min(...kids[n.id].map((k) => depth[k])) - 1;

  // effective keys (Outputs inherit from the prompt that produces them)
  const key = {};
  for (const n of nodes) {
    const d = n.data || {};
    let { stage, lane, section } = d;
    if (n.type === 'imagecard') {
      const prod = parents[n.id].map((p) => byId[p]).find((p) => p.type === 'promptbox');
      const pd = prod?.data || {};
      if (!stage && pd.stage) stage = pd.stage + ':out';
      lane = lane ?? pd.lane; section = section ?? pd.section;
    }
    key[n.id] = { stage: stage || null, lane: lane || null, section: section || '' };
  }

  const linked = nodes.filter((n) => parents[n.id].length || kids[n.id].length);
  const loose = nodes.filter((n) => !parents[n.id].length && !kids[n.id].length);
  const pos = {};

  if (linked.length) {
    // rows: a stage, or (for unkeyed nodes) a dependency depth; rank = deepest member
    const rowKey = (id) => (key[id].stage ? `s:${key[id].section}|${key[id].stage}` : `d:${key[id].section}|${depth[id]}`);
    const rows = new Map();
    for (const n of linked) { const k = rowKey(n.id); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(n.id); }
    const rank = (k) => Math.max(...rows.get(k).map((id) => depth[id]));
    const secRank = {};
    for (const n of linked) { const s = key[n.id].section; secRank[s] = Math.min(secRank[s] ?? Infinity, depth[n.id]); }
    const order = [...rows.keys()].sort((a, b) => {
      const sa = key[rows.get(a)[0]].section, sb = key[rows.get(b)[0]].section;
      return (secRank[sa] - secRank[sb]) || sa.localeCompare(sb) || (rank(a) - rank(b)) || a.localeCompare(b);
    });

    // lanes: one column per lane per section, in order of first appearance; width = widest node in the lane
    const x0 = Math.min(...linked.map((n) => old[n.id].x));
    const laneX = {};
    const sections = [...new Set(order.map((k) => key[rows.get(k)[0]].section))];
    for (const s of sections) {
      const lanes = [];
      for (const k of order) for (const id of rows.get(k)) if (key[id].section === s && key[id].lane && !lanes.includes(key[id].lane)) lanes.push(key[id].lane);
      let x = x0;
      for (const l of lanes) {
        const w = Math.max(...linked.filter((n) => key[n.id].section === s && key[n.id].lane === l).map((n) => sz[n.id].w));
        laneX[`${s}|${l}`] = x + w / 2; x += w + colGap;
      }
    }

    let y = Math.min(...linked.map((n) => old[n.id].y));
    let prevSection = null;
    const cx = {};
    for (const k of order) {
      const sec = key[rows.get(k)[0]].section;
      if (prevSection !== null && sec !== prevSection) y += sectionGap - rowGap;
      prevSection = sec;
      const row = rows.get(k).map((id) => {
        const lx = key[id].lane ? laneX[`${sec}|${key[id].lane}`] : null;
        const ps = parents[id].filter((p) => p in cx);
        const want = lx ?? (ps.length ? ps.reduce((a, p) => a + cx[p], 0) / ps.length
          : kids[id].length ? kids[id].reduce((a, c) => a + oldCx(c), 0) / kids[id].length : oldCx(id));
        return { id, want, w: sz[id].w, fixed: lx != null, old: oldCx(id) };
      }).sort((a, b) => a.want - b.want || a.old - b.old);
      // pack left to right without overlap; lane nodes sit exactly in their column, free nodes slide around them
      let edge = -Infinity;
      for (const it of row) { it.x = Math.max(it.want - it.w / 2, edge); edge = it.x + it.w + colGap; }
      if (!row.some((it) => it.fixed)) { // keyless rows stay centred on where they wanted to be
        const shift = row.reduce((a, it) => a + it.want - (it.x + it.w / 2), 0) / row.length;
        for (const it of row) it.x += shift;
      }
      for (const it of row) { pos[it.id] = { x: Math.round(it.x), y: Math.round(y) }; cx[it.id] = it.x + it.w / 2; }
      y += Math.max(...row.map((it) => sz[it.id].h)) + rowGap;
    }
  }
  // unlinked nodes (notes, stray cards) stack in a column to the left of the graph
  if (loose.length) {
    const placed = Object.values(pos);
    const left = placed.length ? Math.min(...placed.map((p) => p.x)) : Math.min(...loose.map((n) => old[n.id].x));
    let y = placed.length ? Math.min(...placed.map((p) => p.y)) : Math.min(...loose.map((n) => old[n.id].y));
    const w = Math.max(...loose.map((n) => sz[n.id].w));
    for (const n of loose.sort((a, b) => old[a.id].y - old[b.id].y)) {
      pos[n.id] = { x: Math.round(left - (placed.length ? w + colGap * 2 : 0)), y: Math.round(y) };
      y += sz[n.id].h + 40;
    }
  }
  return pos;
}
