// Pure derivation: given nodes + edges + global vars, compute what flows out of every node.
// Items: { id, type: 'image'|'text', value, vars, trail: [string] }

export const fill = (tpl, vars) => {
  let s = tpl || '';
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null && vars[k] !== '' ? String(vars[k]) : m));
    if (next === s) break;
    s = next;
  }
  return s;
};

export const unresolved = (s) => [...new Set((s.match(/\{(\w+)\}/g) || []).map((m) => m.slice(1, -1)))];

const cartesian = (lists) => lists.reduce((acc, l) => acc.flatMap((a) => l.map((x) => [...a, x])), [[]]);
const uniq = (a) => [...new Set(a)];
export const labelOf = (n) => n.data?.label || n.type;

function topo(nodes, edges) {
  const indeg = Object.fromEntries(nodes.map((n) => [n.id, 0]));
  for (const e of edges) if (e.target in indeg && e.source in indeg) indeg[e.target]++;
  const q = nodes.filter((n) => !indeg[n.id]);
  const out = [];
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  while (q.length) {
    const n = q.shift();
    out.push(n);
    for (const e of edges) if (e.source === n.id && e.target in indeg && --indeg[e.target] === 0) q.push(byId[e.target]);
  }
  return out; // nodes inside cycles are skipped
}

export const mediaOf = (url = '') => {
  const ext = (url.split('?')[0].match(/\.(\w+)$/) || [])[1]?.toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'bmp'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv'].includes(ext)) return 'video';
  if (['glb', 'gltf'].includes(ext)) return '3d';
  if (['obj', 'fbx', 'stl', 'usdz', 'blend'].includes(ext)) return '3d-other';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio';
  return 'file';
};
const isImageUrl = (u) => mediaOf(u) === 'image';
// ---- typed sockets (Blender-style): colour per type, links only between matching types ----
export const TYPE_COLOR = { image: '#e8c547', video: '#ff8a4c', '3d': '#3fd0b5', audio: '#ff6fae', text: '#a8a2ff' };
export function socketType(node, dir) {
  if (!node) return null;
  const d = node.data || {};
  if (node.type === 'image') return dir === 'source' ? 'image' : null;                       // Reference node
  if (node.type === 'promptbox') return dir === 'source' ? d.target || 'image' : 'image';   // out: its type · in: references
  if (node.type === 'step') return dir === 'source' ? d.target || '3d' : null;               // custom step: any inputs, one typed output
  if (node.type === 'imagecard') return d.kind || 'image';                                   // Output: typed input on top, same-typed output on the right
  return null; // untyped nodes (batch prompt, list, board…) connect to anything
}
export const linkOk = (src, tgt) => {
  if (src?.type === 'imagecard' && tgt?.type === 'imagecard') return false; // an Output's one input belongs to its prompt
  const a = socketType(src, 'source'), b = socketType(tgt, 'target'); return !a || !b || a === b;
};
// a link from an Output is frozen on the file it carried when wired (edge.data.snap); stale = the Output has changed since
export const linkStale = (src, e) => src?.type === 'imagecard' && !!e.data?.snap && !!src.data?.url && src.data.url !== e.data.snap;
export const socketNum = (h) => (!h || h === 'in' ? 0 : Number(String(h).split('-')[1]) || 0);

// Files are content-addressed, so an image sitting in a prompt as a copy (a stored ref, or a Reference node) that is
// byte-identical to an Output's file IS that Output's result: replace the copy with a real link from the Output.
// Idempotent; runs on every load. Socket order follows the old ref order (Hunyuan's front/back/left/right stays put).
export function linkOutputs(ns, es) {
  const own = new Set(es.filter((e) => ns.find((n) => n.id === e.target)?.type === 'imagecard').map((e) => `${e.source}>${e.target}`));
  const outputOf = (url, promptId) => url && ns.find((n) => n.type === 'imagecard' && n.data?.url === url && !own.has(`${promptId}>${n.id}`));
  let edges = [...es], count = 0;
  const nextSock = (pid) => Math.max(0, ...edges.filter((e) => e.target === pid).map((e) => socketNum(e.targetHandle))) + 1;
  // Reference nodes holding one image that an Output already holds: rewire to the Output
  const dropRefs = new Set();
  for (const r of ns.filter((n) => n.type === 'image' && (n.data?.images || []).length === 1)) {
    const outs = edges.filter((e) => e.source === r.id);
    if (!outs.length || outs.some((e) => ns.find((n) => n.id === e.target)?.type !== 'promptbox')) continue;
    const url = r.data.images[0].url;
    if (outs.some((e) => !outputOf(url, e.target))) continue;
    edges = edges.map((e) => (e.source === r.id ? { ...e, source: outputOf(url, e.target).id, sourceHandle: 'out', data: { ...(e.data || {}), snap: url } } : e));
    dropRefs.add(r.id); count += outs.length;
  }
  const nodes = ns.filter((n) => !dropRefs.has(n.id)).map((n) => {
    if (n.type !== 'promptbox' || !(n.data?.refs || []).length) return n;
    const keep = [];
    for (const ref of n.data.refs) {
      const o = outputOf(ref.url, n.id);
      if (!o) { keep.push(ref); continue; }
      edges.push({ id: Math.random().toString(36).slice(2, 10), source: o.id, sourceHandle: 'out', target: n.id, targetHandle: `in-${nextSock(n.id)}`, data: { snap: ref.url } });
      count++;
    }
    return keep.length === n.data.refs.length ? n : { ...n, data: { ...n.data, refs: keep } };
  });
  return { nodes, edges, count };
}
export function derive(nodes, edges, globals) {
  const out = {};
  const info = {};
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  // outdated: a node is out of date when an input it was made from has changed since (a stale link), or anything
  // upstream of it is out of date, or it carries a stored flag (its prompt took a new input but it wasn't re-run)
  const od = {};
  const verOf = (s) => (s?.data?.versions?.length ? ` (now v${s.data.versions.length})` : '');
  for (const n of topo(nodes, edges)) {
    const why = n.data?.outdated ? [n.data.outdated] : [];
    for (const e of edges) {
      if (e.target !== n.id) continue;
      const s = byId[e.source];
      if (!s) continue;
      if (linkStale(s, e)) why.push(`${labelOf(s)} changed${verOf(s)}`);
      else if (od[s.id]) why.push(od[s.id]);
    }
    od[n.id] = why[0] || null;
  }
  for (const n of topo(nodes, edges)) {
    const d = n.data || {};
    const label = labelOf(n);
    const ports = {};
    for (const e of edges) if (e.target === n.id) (ports[e.targetHandle || 'in'] ||= []).push(out[e.source] || []);
    let items = [];

    if (n.type === 'promptbox' || n.type === 'step') {
      const anyType = n.type === 'step'; // a custom step takes anything (3D, images, text…); a prompt takes reference images
      const manual = (d.refs || []).map((r) => ({ id: r.id, type: 'image', value: r.url, name: r.name || '', vars: {}, trail: [r.name || 'ref'], manual: true }));
      const text = fill(d.text || '', globals);
      // one socket per incoming link (in-1, in-2, …; legacy 'in' counts as 0) + one empty socket after them
      const sockets = edges.filter((e) => e.target === n.id).map((e) => {
        const h = e.targetHandle || 'in';
        const sn = byId[e.source];
        let src = (out[e.source] || []).filter((i) => anyType || i.type === 'image');
        const stale = linkStale(sn, e);
        // a link from an Output carries the frozen file, not whatever the Output holds now
        if (sn?.type === 'imagecard' && e.data?.snap) src = [{ ...(src[0] || { id: sn.id, type: sn.data?.kind || 'image', vars: {}, trail: [labelOf(sn)] }), value: e.data.snap }];
        return { handle: h, n: socketNum(h), edge: e.id, stale, current: stale ? sn.data.url : null, items: src,
          name: src[0]?.name || (src[0] && src[0].trail?.[0]) || sn?.data?.label || '' };
      }).sort((a, b) => a.n - b.n);
      const linked = sockets.flatMap((s) => s.items).filter((i) => i.type === 'image');
      const next = 'in-' + (Math.max(0, ...sockets.map((s) => s.n)) + 1);
      info[n.id] = { refs: [...linked, ...manual], text, sockets, next };
      items = [{ id: n.id, type: 'text', value: text, vars: {}, trail: [label], target: d.target || (anyType ? '3d' : 'image') }];
    } else if (n.type === 'imagecard') {
      // a media card: image / video / 3d / audio / text output
      const sources = edges.filter((e) => e.target === n.id).map((e) => byId[e.source]).filter(Boolean);
      const pb = sources.find((s) => s.type === 'promptbox' || s.type === 'step');
      const pbInfo = pb && info[pb.id];
      // refs = images linked into the card's left side + the producing prompt's refs + ones dropped in
      const linked = (ports.in || []).flat().filter((i) => i.type === 'image');
      const manual = (d.refs || []).map((r) => ({ id: r.id, type: 'image', value: r.url, name: r.name || '', vars: {}, trail: [r.name || 'ref'], manual: true }));
      // prompt: typed on the card, else inherited from a linked Prompt (or single-branch batch prompt)
      const fromBatch = sources.map((s) => info[s.id]?.branches).filter((b) => b?.length === 1).map((b) => b[0].prompt)[0];
      const fromPrompt = pbInfo ? pbInfo.text : fromBatch;
      const prompt = d.prompt || fill(fromPrompt || '', globals);
      const kind = d.kind || (pb ? pb.data?.target || (pb.type === 'step' ? '3d' : null) : null) || 'image';
      info[n.id] = { refs: [...linked, ...(pbInfo?.refs || []), ...manual], prompt, inherited: !d.prompt && !!fromPrompt, kind, from: pb ? pb.data?.label || 'Prompt' : null };
      const value = kind === 'text' ? d.textOut : d.url;
      items = value ? [{ id: n.id, type: kind === 'image' || isImageUrl(d.url) ? 'image' : kind, value, vars: {}, trail: [label], prompt }] : [];
    } else if (n.type === 'image') {
      items = (d.images || []).map((im) => ({ id: im.id, type: 'image', value: im.url, name: im.name || '', vars: {}, trail: [im.name || label] }));
    } else if (n.type === 'list') {
      const v = d.varName || 'item';
      items = uniq((d.text || '').split('\n').map((s) => s.trim()).filter(Boolean)).map((line) => ({
        id: `${n.id}:${line}`, type: 'text', value: line, vars: { [v]: line }, trail: [`${label}: ${line}`],
      }));
    } else if (n.type === 'prompt') {
      const groups = (ports.branch || []).filter((g) => g.length);
      const refs = (ports.refs || []).flat().filter((i) => i.type === 'image');
      const refVars = Object.assign({}, ...refs.map((r) => r.vars));
      const branches = cartesian(groups).map((combo) => {
        const key = combo.map((c) => c.id).join('|') || 'main';
        const vars = Object.assign({}, refVars, ...combo.map((c) => c.vars));
        const texts = combo.filter((c) => c.type === 'text').map((c) => c.value);
        const prompt = fill(d.template, { ...globals, ...vars, in: texts.join(', ') });
        const trail = uniq(combo.flatMap((c) => c.trail));
        const tag = Object.values(vars).join(' · ');
        return { key, vars, prompt, trail, tag, inputImages: combo.filter((c) => c.type === 'image'), result: d.results?.[key] || {} };
      });
      for (const b of branches) {
        const r = b.result;
        const trail = [...b.trail, label + (b.tag ? '' : '')];
        (r.images || []).forEach((im, i) =>
          items.push({ id: im.id, type: 'image', value: im.url, vars: { ...b.vars, ...((r.images.length > 1) ? { take: i + 1 } : {}) }, trail, starred: im.starred }));
        if (r.text) {
          const v = d.varName || 'item';
          const lines = d.splitLines ? r.text.split('\n').map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean) : [r.text.trim()];
          uniq(lines).forEach((line) =>
            items.push({ id: `${n.id}:${b.key}:${line}`, type: 'text', value: line, vars: { ...b.vars, [v]: line }, trail: [...trail, `${v}: ${line}`] }));
        }
      }
      const known = new Set(Object.keys(d.results || {}));
      branches.forEach((b) => known.delete(b.key));
      info[n.id] = { branches, refs, orphans: [...known] };
    } else if (n.type === 'board') {
      items = Object.values(ports).flat(2);
      info[n.id] = { items };
    }
    out[n.id] = items;
  }
  for (const id in od) if (od[id]) info[id] = { ...(info[id] || {}), outdated: od[id] };
  return { out, info };
}
