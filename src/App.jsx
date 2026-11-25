import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, addEdge,
  useNodesState, useEdgesState, useReactFlow,
} from '@xyflow/react';
import { derive, socketNum, socketType, linkOk, linkStale, linkOutputs, TYPE_COLOR } from './derive.js';
import { DerivedCtx, nodeTypes, edgeTypes, PALETTE, copyImage, readTransfer, importTransfer, toast, imageSize, uploadRaw, kindOfUrl, mediaWidth } from './nodes.jsx';
import { STARTER, BLANK } from './starter.js';
import { arrange } from './layout.js';

const LS = 'ai-studio:current';
const uid = () => Math.random().toString(36).slice(2, 10);
const loadLocal = () => { try { return JSON.parse(localStorage.getItem(LS)); } catch { return null; } };
// image cards are width-only (height follows image + details box)
// what gets synced: the graph without per-tab view state (selection, drag, measured sizes)
const strip = (n) => { const { selected, dragging, measured, resizing, ...r } = n; return r; };
const docOf = (name, nodes, edges, globals) => ({ name, nodes: nodes.map(strip), edges: edges.map(({ selected, style, ...e }) => e), globals });
const CLIENT = Math.random().toString(36).slice(2, 10);
const freeCards = (ns) => ns.map((n) => (n.type === 'imagecard' && n.height != null ? (({ height, ...r }) => r)(n) : n));

function Studio() {
  const init = useMemo(() => { const w = loadLocal() || BLANK(); const l = linkOutputs(w.nodes || [], w.edges || []); return { ...w, nodes: l.nodes, edges: l.edges, linked: l.count }; }, []);
  const [nodes, setNodes, onNodesChange] = useNodesState(freeCards(init.nodes));
  const [edges, setEdges, onEdgesChange] = useEdgesState(init.edges);
  const [globals, setGlobals] = useState(init.globals || {});
  const [name, setName] = useState(init.name || 'untitled');
  const [saved, setSaved] = useState([]);
  const [toastMsg, setToast] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const rf = useReactFlow();

  const derived = useMemo(() => ({ ...derive(nodes, edges, globals), globals }), [nodes, edges, globals]);

  // autosave locally
  useEffect(() => {
    const t = setTimeout(() => { try { localStorage.setItem(LS, JSON.stringify({ name, nodes, edges, globals })); } catch {} }, 400);
    return () => clearTimeout(t);
  }, [name, nodes, edges, globals]);

  // ---- live sync: the server owns the open canvas; this tab mirrors it and pushes its own edits ----
  const version = useRef(0);
  const synced = useRef(null); // JSON of the doc last received from / sent to the server
  const ready = useRef(false);
  const [agent, setAgent] = useState(null); // what Ada is doing right now
  const applyDoc = useCallback((doc) => {
    const l = linkOutputs(doc.nodes || [], doc.edges || []);
    synced.current = JSON.stringify(docOf(doc.name || 'untitled', l.nodes, l.edges, doc.globals || {}));
    setNodes((cur) => { const sel = new Set(cur.filter((n) => n.selected).map((n) => n.id)); return freeCards(l.nodes).map((n) => (sel.has(n.id) ? { ...n, selected: true } : n)); });
    setEdges(l.edges); setGlobals(doc.globals || {}); setName(doc.name || 'untitled');
  }, [setNodes, setEdges]);
  useEffect(() => {
    let es;
    fetch('/api/live').then((r) => r.json()).then((l) => {
      version.current = l.version;
      if (l.doc) { applyDoc(l.doc); setTimeout(() => rf.fitView({ padding: 0.12, maxZoom: 1 }), 120); }
      else { // the server has no canvas yet: this tab's becomes the live one
        const doc = docOf(name, rf.getNodes(), rf.getEdges(), globals);
        synced.current = JSON.stringify(doc);
        fetch('/api/live', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc, base: 0, client: CLIENT }) })
          .then((r) => r.json()).then((j) => { version.current = j.version ?? version.current; });
      }
      ready.current = true;
      if (l.status) setAgent(l.status);
      es = new EventSource('/api/live/stream');
      es.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        // (re)connected: if the server moved on while this tab was disconnected (e.g. a server restart), catch up
        if (m.type === 'hello' && m.version !== version.current) fetch('/api/live').then((r) => r.json()).then((l) => { version.current = l.version; if (l.doc) applyDoc(l.doc); if (l.status) setAgent(l.status); });
        if (m.type === 'doc') { version.current = m.version; if (m.client === 'agent') follow.current = true; if (m.client !== CLIENT) applyDoc(m.doc); }
        if (m.type === 'cmd') liveCmd.current?.(m);
      };
    }).catch(() => { ready.current = true; });
    return () => es?.close();
  }, [applyDoc]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ready.current) return;
    const t = setTimeout(async () => {
      const doc = docOf(name, nodes, edges, globals);
      const json = JSON.stringify(doc);
      if (json === synced.current) return;
      synced.current = json;
      const r = await fetch('/api/live', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc, base: version.current, client: CLIENT }) }).catch(() => null);
      if (r?.status === 409) { const l = await r.json(); version.current = l.version; applyDoc(l.doc); }
      else if (r?.ok) version.current = (await r.json()).version;
    }, 300);
    return () => clearTimeout(t);
  }, [name, nodes, edges, globals, applyDoc]);
  const liveCmd = useRef(null);

  // fit once on startup (not via the fitView prop, which also fires when the first node lands on an empty canvas)
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    setTimeout(() => { if (rf.getNodes().length) rf.fitView({ padding: 0.15, maxZoom: 1 }); }, 60);
    if (init.linked) setTimeout(() => toast(`Linked ${init.linked} reference${init.linked > 1 ? 's' : ''} to the Outputs they came from`), 300);
  }, [rf, init]);

  const refreshSaved = () => fetch('/api/workflows').then((r) => r.json()).then(setSaved).catch(() => {});
  useEffect(() => { refreshSaved(); }, []);

  useEffect(() => {
    let t;
    const onToast = (e) => { setToast(e.detail); clearTimeout(t); t = setTimeout(() => setToast(null), 2200); };
    const onLb = (e) => setLightbox(e.detail);
    window.addEventListener('toast', onToast); window.addEventListener('lightbox', onLb);
    return () => { window.removeEventListener('toast', onToast); window.removeEventListener('lightbox', onLb); };
  }, []);

  const save = useCallback(async () => {
    await fetch('/api/workflows/' + encodeURIComponent(name), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, nodes: rf.getNodes(), edges: rf.getEdges(), globals }),
    });
    refreshSaved();
    window.dispatchEvent(new CustomEvent('toast', { detail: `Saved “${name}”` }));
  }, [name, globals, rf]);

  // Arrange: lay the whole graph out top to bottom; one level of undo
  const [undoPos, setUndoPos] = useState(null);
  const arrangeAll = (quiet) => {
    const ns = rf.getNodes();
    const pos = arrange(ns, rf.getEdges(), (n) => ({ w: n.measured?.width ?? n.width ?? 300, h: n.measured?.height ?? n.height ?? 200 }));
    const moved = ns.some((n) => pos[n.id] && (pos[n.id].x !== n.position.x || pos[n.id].y !== n.position.y));
    if (!moved) return false;
    if (!quiet) setUndoPos(Object.fromEntries(ns.map((n) => [n.id, n.position])));
    setNodes((all) => all.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n)));
    if (!quiet) setTimeout(() => rf.fitView({ padding: 0.1, maxZoom: 1, duration: 300 }), 50);
    return true;
  };
  // frame a node plus whatever feeds it, so its card is fully visible
  const lastFocus = useRef(null);
  const frame = useCallback((id, duration = 500) => {
    if (!rf.getNode(id)) return;
    const feeds = rf.getEdges().filter((e) => e.target === id).map((e) => ({ id: e.source }));
    rf.fitView({ nodes: [{ id }, ...feeds], padding: 0.18, maxZoom: 1, duration });
  }, [rf]);

  // follow mode: while an agent is building, the canvas re-arranges itself whenever a card appears or changes size
  // (images load, cards grow), and keeps the node being worked on framed. Dragging a node hands layout back to you.
  const follow = useRef(false);
  const sizeSig = useMemo(() => nodes.map((n) => `${n.id}:${Math.round(n.measured?.width || 0)}x${Math.round(n.measured?.height || 0)}`).join('|') + '#' + edges.length, [nodes, edges]);
  useEffect(() => {
    if (!follow.current) return;
    if (nodes.some((n) => !n.measured?.width)) return; // wait until every card has its real size
    const t = setTimeout(() => { if (arrangeAll(true) && lastFocus.current) setTimeout(() => frame(lastFocus.current, 400), 80); }, 250);
    return () => clearTimeout(t);
  }, [sizeSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const undoArrange = () => {
    setNodes((all) => all.map((n) => (undoPos[n.id] ? { ...n, position: undoPos[n.id] } : n)));
    setUndoPos(null);
    setTimeout(() => rf.fitView({ padding: 0.1, maxZoom: 1, duration: 300 }), 50);
  };

  // commands from an agent: status line, pan to the node being worked on, arrange, fit
  liveCmd.current = (m) => {
    if (m.cmd === 'status') setAgent(m.text ? { text: m.text } : null);
    if (m.cmd === 'arrange') { follow.current = true; setTimeout(() => arrangeAll(true), 150); }
    if (m.cmd === 'fit') rf.fitView({ padding: 0.12, maxZoom: 1, duration: 500 });
    if (m.cmd === 'focus') setTimeout(() => {
      if (!rf.getNode(m.id)) return;
      lastFocus.current = m.id;
      setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === m.id })));
      frame(m.id, 600);
    }, 300);
  };

  const load = (wf) => {
    setUndoPos(null);
    const l = linkOutputs(wf.nodes || [], wf.edges || []);
    setNodes(freeCards(l.nodes)); setEdges(l.edges); setGlobals(wf.globals || {}); setName(wf.name || 'untitled');
    if (l.count) setTimeout(() => toast(`Linked ${l.count} reference${l.count > 1 ? 's' : ''} to the Outputs they came from`), 300);
    if (wf.nodes?.length) setTimeout(() => rf.fitView({ padding: 0.15, maxZoom: 1 }), 50);
  };
  const open = async (n) => { if (n) load(await (await fetch('/api/workflows/' + encodeURIComponent(n))).json()); };

  const addNode = (p) => {
    const c = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    // step diagonally until the spot isn't already taken, so repeated adds don't stack
    const pos = findFree(c.x - 150, c.y - 120, 300, 260); // first free spot at/below the screen centre
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })),
      { id: uid(), type: p.type, position: pos, data: structuredClone(p.data), selected: true,
        ...(p.type === 'imagecard' ? { width: 240 } : {}) }]);
  };

  // Ctrl+D duplicates selected nodes (and edges between them) without results; Ctrl+S saves
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 's') { e.preventDefault(); save(); }
      if (e.key === 'd') {
        e.preventDefault();
        const sel = rf.getNodes().filter((n) => n.selected);
        if (!sel.length) return;
        const map = Object.fromEntries(sel.map((n) => [n.id, uid()]));
        const copies = sel.map((n) => ({
          ...n, id: map[n.id], selected: true, deletable: true, // copies of the permanent prompt are normal nodes position: { x: n.position.x + 60, y: n.position.y + 60 },
          data: { ...structuredClone(n.data), results: n.type === 'prompt' ? {} : n.data.results, stars: {} },
        }));
        const es = rf.getEdges().filter((ed) => map[ed.source] && map[ed.target])
          .map((ed) => ({ ...ed, id: uid(), source: map[ed.source], target: map[ed.target] }));
        setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...copies]);
        setEdges((x) => [...x, ...es]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rf, save, setNodes, setEdges]);

  // ---- Ctrl+drag knife: cut every link the stroke crosses ----
  const [knife, setKnife] = useState(null); // stroke points in screen coords
  const startKnife = useCallback((e) => {
    if (!e.ctrlKey || (e.button !== 0 && e.button !== 2)) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.type !== 'pointerdown') return; // mousedown twin: just swallowed so the canvas doesn't pan/select
    const pts = [{ x: e.clientX, y: e.clientY }];
    setKnife([...pts]);
    const move = (ev) => { pts.push({ x: ev.clientX, y: ev.clientY }); setKnife([...pts]); };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setKnife(null);
      if (pts.length < 2) return;
      const cross = (a, b, c, d) => { // segments ab and cd intersect?
        const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
        return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
      };
      const cut = [];
      document.querySelectorAll('.react-flow__edge').forEach((el) => {
        const path = el.querySelector('path.react-flow__edge-path') || el.querySelector('path');
        if (!path) return;
        const ctm = path.getScreenCTM(); const len = path.getTotalLength();
        const line = [];
        for (let l = 0; l <= len; l += 6) { const q = path.getPointAtLength(l); const t = new DOMPoint(q.x, q.y).matrixTransform(ctm); line.push({ x: t.x, y: t.y }); }
        const hit = line.some((a, i) => i && pts.some((c, j) => j && cross(line[i - 1], a, pts[j - 1], c)));
        if (hit) cut.push(el.getAttribute('data-id'));
      });
      if (cut.length) { setEdges((es) => es.filter((ed) => !cut.includes(ed.id))); toast(`Cut ${cut.length} link${cut.length > 1 ? 's' : ''}`); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }, [setEdges]);

  // ---- placement: step down from a spot until it doesn't overlap any node ----
  const findFree = useCallback((x, y, w, h, extra = [], step = 30) => {
    const rects = [...rf.getNodes(), ...extra].map((n) => ({
      x: n.position.x, y: n.position.y, w: n.measured?.width ?? n.width ?? 260, h: n.measured?.height ?? n.height ?? 200,
    }));
    const hit = (py) => rects.some((r) => x < r.x + r.w + 20 && x + w + 20 > r.x && py < r.y + r.h + 20 && py + h + 20 > r.y);
    let py = y;
    for (let i = 0; i < 80 && hit(py); i++) py += step;
    return { x, y: py };
  }, [rf]);

  // images inserted into a prompt become Reference nodes, stacked on its left and wired into it
  // a Reference node's real footprint: 220px image at native ratio + name row + padding
  const refBoxes = useCallback((imgs) => Promise.all(imgs.map((im) => imageSize(im.url, 220).then((sz) => ({ w: 240, h: sz.height + 46 })))), []);

  const spawnRefs = useCallback(async (targetId, imgs) => {
    const t = rf.getNode(targetId);
    if (!t || !imgs.length) return;
    // an image that is already some Output's file gets wired from that Output instead of copied into a new Reference
    const own = new Set(rf.getEdges().filter((e) => e.source === targetId).map((e) => e.target));
    const outputOf = (url) => rf.getNodes().find((n) => n.type === 'imagecard' && n.data?.url === url && !own.has(n.id));
    const order = imgs.map((im) => ({ im, out: outputOf(im.url) }));
    const fresh = order.filter((o) => !o.out).map((o) => o.im);
    // references sit in a row above the prompt; their bottom output runs straight down into its top sockets
    const boxes = await refBoxes(fresh);
    const made = [], placed = [];
    const rowH = Math.max(0, ...boxes.map((b) => b.h));
    let rx = t.position.x;
    fresh.forEach((im, i) => {
      const pos = findFree(rx, t.position.y - rowH - 90, boxes[i].w, boxes[i].h, placed, -30);
      rx += boxes[i].w + 30;
      placed.push({ position: pos, measured: { width: boxes[i].w, height: boxes[i].h } });
      made.push({ id: uid(), type: 'image', position: pos, data: { label: '', images: [im] } });
    });
    setNodes((ns) => [...ns, ...made]);
    let k = Math.max(0, ...rf.getEdges().filter((e) => e.target === targetId).map((e) => socketNum(e.targetHandle)));
    let f = 0;
    const links = order.map((o) => (o.out
      ? { id: uid(), source: o.out.id, sourceHandle: 'out', target: targetId, targetHandle: `in-${++k}`, data: { snap: o.im.url } }
      : { id: uid(), source: made[f++].id, sourceHandle: 'out', target: targetId, targetHandle: `in-${++k}` }));
    setEdges((es) => [...es, ...links]);
    const wired = order.length - fresh.length;
    toast(wired ? `Linked ${wired} from ${wired > 1 ? 'their Outputs' : 'its Output'}${fresh.length ? `, added ${fresh.length} reference${fresh.length > 1 ? 's' : ''}` : ''}`
      : `Added ${made.length} reference${made.length > 1 ? 's' : ''} to “${t.data.label || 'Prompt'}”`);
  }, [rf, findFree, refBoxes, setNodes, setEdges]);

  useEffect(() => {
    const onSpawnRefs = ({ detail }) => spawnRefs(detail.target, detail.imgs);
    // rename / unlink a linked reference from inside the prompt
    const holder = (imageId) => rf.getNodes().find((n) => n.type === 'image' && n.data.images?.some((im) => im.id === imageId));
    const onRename = ({ detail: { imageId, name } }) => {
      const h = holder(imageId);
      if (h) rf.updateNodeData(h.id, (n) => ({ images: n.data.images.map((im) => (im.id === imageId ? { ...im, name } : im)) }));
    };
    const onUnlink = ({ detail: { target, imageId } }) => {
      const h = holder(imageId);
      if (!h) return;
      const out = rf.getEdges().filter((e) => e.source === h.id);
      if (out.every((e) => e.target === target) && (h.data.images || []).length <= 1) rf.deleteElements({ nodes: [{ id: h.id }] });
      else setEdges((es) => es.filter((e) => !(e.source === h.id && e.target === target)));
    };
    window.addEventListener('spawn-refs', onSpawnRefs); window.addEventListener('rename-ref', onRename); window.addEventListener('unlink-ref', onUnlink);
    return () => { window.removeEventListener('spawn-refs', onSpawnRefs); window.removeEventListener('rename-ref', onRename); window.removeEventListener('unlink-ref', onUnlink); };
  }, [rf, spawnRefs, setEdges]);

  // ---- canvas-level paste & drag-drop of images ----
  const mouse = useRef(null);
  const placeImages = useCallback((imgs, screen, intoId, useSelection) => {
    if (!imgs.length) return;
    const ns = rf.getNodes();
    const sel = ns.filter((n) => n.selected);
    const target = ns.find((n) => n.id === intoId) || (useSelection && sel.length === 1 ? sel[0] : null);
    // into a Prompt: its References
    if (target?.type === 'promptbox') return spawnRefs(target.id, imgs);
    if (target?.type === 'image') {
      rf.updateNodeData(target.id, (n) => ({ images: [...(n.data.images || []), ...imgs] }));
      return;
    }
    // into an Output: becomes its media if empty, otherwise added to its references
    if (target?.type === 'imagecard') {
      let rest = imgs;
      if (!target.data.url && (target.data.kind || 'image') !== 'image') {
        toast(`That Output is set to ${target.data.kind === '3d' ? '3D model' : target.data.kind}; drop images on an Image output or a Prompt`);
        return;
      }
      if (!target.data.url) {
        const [first, ...r] = imgs;
        rf.updateNodeData(target.id, { url: first.url, label: target.data.label || (first.name !== 'pasted' ? first.name : '') });
        rest = r;
      }
      if (rest.length) {
        rf.updateNodeData(target.id, (n) => ({ refs: [...(n.data.refs || []), ...rest], detailsOpen: true }));
        toast(`Added ${rest.length} reference${rest.length > 1 ? 's' : ''} to “${target.data.label || 'Output'}”`);
      }
      return;
    }
    // default: images brought onto empty canvas become Reference nodes, side by side from the cursor
    const pt = screen || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const pos = rf.screenToFlowPosition(pt);
    refBoxes(imgs).then((boxes) => {
      const made = [], placed = [];
      let x = pos.x - boxes[0].w / 2;
      imgs.forEach((im, i) => {
        const at = findFree(x, pos.y - 100, boxes[i].w, boxes[i].h, placed);
        placed.push({ position: at, measured: { width: boxes[i].w, height: boxes[i].h } });
        made.push({ id: uid(), type: 'image', position: at, selected: true, data: { label: '', images: [{ ...im, name: im.name === 'pasted' ? '' : im.name }] } });
        x += boxes[i].w + 40;
      });
      setNodes((all) => [...all.map((n) => ({ ...n, selected: false })), ...made]);
    });
  }, [rf, setNodes, spawnRefs, findFree, refBoxes]);

  // "+" on either side of a card: spawn a node already wired to it
  useEffect(() => {
    const W = { prompt: 360, promptbox: 300, board: 470, image: 170, list: 240, note: 260 };
    const onSpawn = ({ detail: { from, side, kind } }) => {
      const src = rf.getNode(from);
      if (!src) return;
      const sw = src.measured?.width || src.width || 260;
      const nw = W[kind.type] || 260;
      const id = uid();
      const node = {
        id, type: kind.type, selected: true, data: structuredClone(kind.data),
        position: findFree(side === 'right' ? src.position.x + sw + 110 : src.position.x - nw - 110, src.position.y, nw, 200),
        ...(kind.type === 'imagecard' ? { width: 240 } : {}),
      };
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), node]);
      const edge = side === 'right'
        ? kind.port && { id: uid(), source: from, sourceHandle: 'out', target: id, targetHandle: kind.port }
        : kind.out && { id: uid(), source: id, sourceHandle: 'out', target: from, targetHandle: 'in' };
      if (edge) setEdges((es) => [...es, edge]);
    };
    window.addEventListener('spawn-node', onSpawn);
    return () => window.removeEventListener('spawn-node', onSpawn);
  }, [rf, setNodes, setEdges, findFree]);

  useEffect(() => {
    const onPaste = async (e) => {
      if (e.defaultPrevented) return; // a drop zone already took it
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const snap = readTransfer(e.clipboardData);
      if (!snap.files.length && !snap.url) return;
      e.preventDefault();
      placeImages(await importTransfer(snap), mouse.current, null, true);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [placeImages]);

  const onCanvasDragOver = useCallback((e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }, []);
  const onCanvasDrop = useCallback(async (e) => {
    e.preventDefault();
    const snap = readTransfer(e.dataTransfer);
    const others = [...(e.dataTransfer.files || [])].filter((f) => !f.type.startsWith('image/'));
    const pt = { x: e.clientX, y: e.clientY };
    const intoId = e.target.closest?.('.react-flow__node')?.dataset.id;
    if (snap.files.length || snap.url || snap.internal) placeImages(await importTransfer(snap), pt, intoId);
    // video / 3D model / audio files: an Output of that type holding the file
    if (others.length && !intoId) {
      const pos = rf.screenToFlowPosition(pt);
      const made = [];
      for (const f of others) {
        const up = await uploadRaw(f);
        const kind = kindOfUrl(up.url);
        if (!kind) { toast(`Can't place ${f.name}: unknown media type`); continue; }
        made.push({ id: uid(), type: 'imagecard', position: findFree(pos.x - 160 + made.length * 340, pos.y - 60, 320, 380, made), width: 320,
          data: { label: up.name || 'Output', kind, url: up.url } });
      }
      if (made.length) setNodes((all) => [...all, ...made]);
    }
  }, [placeImages, rf, findFree, setNodes]);

  // resizing a card changes its width only
  const onNodesChangeFree = useCallback((changes) => onNodesChange(changes.map((c) => {
    if (c.type === 'position' && c.dragging) follow.current = false; // you moved something: auto-layout stops until an agent edits again
    if (c.type !== 'dimensions' || !c.resizing || !c.dimensions) return c;
    const n = rf.getNode(c.id);
    return n?.type === 'imagecard' ? { ...c, dimensions: { width: c.dimensions.width, height: undefined } } : c;
  })), [onNodesChange, rf]);

  // drag a link out of a Prompt node onto empty canvas → create its output card, already wired
  const onConnectEnd = useCallback((event, st) => {
    if (st.isValid || st.toNode || !st.fromNode || st.fromHandle?.type !== 'source') return;
    if (st.fromNode.type !== 'promptbox') return;
    const { clientX, clientY } = 'changedTouches' in event ? event.changedTouches[0] : event;
    const pos = rf.screenToFlowPosition({ x: clientX, y: clientY });
    const kind = st.fromNode.data?.target || 'image';
    const id = uid();
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })),
      { id, type: 'imagecard', position: { x: pos.x - 150, y: pos.y + 10 }, width: 300, selected: true, data: { label: 'Output', kind } }]);
    setEdges((es) => [...es, { id: uid(), source: st.fromNode.id, sourceHandle: st.fromHandle.id || 'out', target: id, targetHandle: 'in' }]);
  }, [rf, setNodes, setEdges]);

  // media cards aren't manually scalable: each card's width always follows its type + media
  const sized = useRef({}); // node id -> "kind|url" it was last sized for
  useEffect(() => {
    for (const n of nodes) {
      if (n.type !== 'imagecard') continue;
      const kind = n.data.kind || 'image';
      const key = kind + '|' + (n.data.url || '');
      if (sized.current[n.id] === key) continue;
      sized.current[n.id] = key;
      mediaWidth(kind, n.data.url).then((w) => { if (sized.current[n.id] === key) rf.updateNode(n.id, { width: w }); });
    }
  }, [nodes, rf]);

  // only matching socket types may connect
  const isValidConnection = useCallback((c) => linkOk(rf.getNode(c.source), rf.getNode(c.target)), [rf]);

  // a type change can make an existing link mismatched: unlink it and say why
  useEffect(() => {
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const bad = edges.filter((e) => byId[e.source] && byId[e.target] && !linkOk(byId[e.source], byId[e.target]));
    if (!bad.length) return;
    setEdges((es) => es.filter((e) => !bad.some((b) => b.id === e.id)));
    toast(`Unlinked ${bad.length}: types no longer match`);
  }, [nodes, edges, setEdges]);

  // links take the colour of the type they carry
  const shownEdges = useMemo(() => {
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    return edges.map((e) => {
      const t = socketType(byId[e.source], 'source');
      const stale = linkStale(byId[e.source], e); // source Output changed since this link was made: dashed
      return t ? { ...e, style: { ...(e.style || {}), stroke: TYPE_COLOR[t], strokeWidth: 2, ...(stale ? { strokeDasharray: '6 5' } : {}) } } : e;
    });
  }, [nodes, edges]);

  // a link out of an Output freezes on the file it carries the first time that Output has one
  useEffect(() => {
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const unfrozen = edges.filter((e) => byId[e.source]?.type === 'imagecard' && byId[e.source].data?.url && !e.data?.snap);
    if (unfrozen.length) setEdges((es) => es.map((e) => (unfrozen.some((u) => u.id === e.id) ? { ...e, data: { ...(e.data || {}), snap: byId[e.source].data.url } } : e)));
  }, [nodes, edges, setEdges]);

  const onConnect = useCallback((c) => setEdges((es) => {
    // an Output takes exactly one input: a new link replaces the old one
    const t = rf.getNode(c.target)?.type;
    let keep = es;
    if (t === 'imagecard') keep = es.filter((e) => e.target !== c.target);
    // each prompt socket holds one link (dropping onto a filled socket swaps it)
    if (t === 'promptbox' || t === 'step') keep = es.filter((e) => !(e.target === c.target && (e.targetHandle || 'in') === (c.targetHandle || 'in')));
    return addEdge({ ...c, id: uid() }, keep);
  }), [setEdges, rf]);

  const totals = Object.values(derived.info).reduce((a, i) => {
    if (!i.branches) return a;
    a.n += i.branches.length;
    a.d += i.branches.filter((b) => b.result.done || b.result.images?.length || b.result.text).length;
    return a;
  }, { n: 0, d: 0 });

  const gEntries = Object.entries(globals);

  return (
    <DerivedCtx.Provider value={derived}>
      <div className="app">
        <header className="bar">
          <strong className="logo">AI Studio</strong>
          <input className="wf-name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn" onClick={save}>Save</button>
          <select value="" onChange={(e) => open(e.target.value)}>
            <option value="">Open…</option>
            {saved.map((s) => <option key={s}>{s}</option>)}
          </select>
          <button className="btn ghost" onClick={() => load(BLANK())}>New</button>
          <button className="btn ghost" onClick={() => arrangeAll()} title="Lay the canvas out top to bottom, step by step">Arrange</button>
          {undoPos && <button className="btn ghost" onClick={undoArrange}>Undo arrange</button>}
          <button className="btn ghost" onClick={() => load(structuredClone(STARTER))}>3D pipeline starter</button>
          <span className="spacer" />
          <span className="progress"><b>{totals.d}</b> / {totals.n} branches done</span>
        </header>

        <aside className="palette">
          <div className="side-title">Add</div>
          {PALETTE.map((p) => (
            <button key={p.type} className="pal" onClick={() => addNode(p)}>
              <b>{p.name}</b><span>{p.desc}</span>
            </button>
          ))}
          <div className="keys">
            <div><kbd>Ctrl</kbd>+<kbd>D</kbd> duplicate</div>
            <div><kbd>Ctrl</kbd>+<kbd>S</kbd> save</div>
            <div><kbd>Del</kbd> remove</div>
            <div><kbd>Ctrl</kbd>+drag cut links</div>
            <div><kbd>Shift</kbd>+click multi-select</div>
            <div><kbd>Ctrl</kbd>+<kbd>V</kbd> image → new node at cursor</div>
            <div>Drag images onto the canvas</div>
            <div>…or onto a node / its slot</div>
          </div>
        </aside>

        <main className="canvas" onMouseMove={(e) => { mouse.current = { x: e.clientX, y: e.clientY }; }}
          onMouseLeave={() => { mouse.current = null; }}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDownCapture={startKnife} onMouseDownCapture={startKnife}>
          <ReactFlow
            onDragOver={onCanvasDragOver} onDrop={onCanvasDrop}
            selectionOnDrag panOnDrag={[1, 2]} selectionMode="partial" multiSelectionKeyCode={['Shift']}
            nodes={nodes} edges={shownEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onNodesChange={onNodesChangeFree} onEdgesChange={onEdgesChange} onConnect={onConnect} onConnectEnd={onConnectEnd} isValidConnection={isValidConnection}
            deleteKeyCode={['Delete', 'Backspace']}
            minZoom={0.15} maxZoom={2} colorMode="dark" defaultEdgeOptions={{ animated: false }}
          >
            <Background gap={24} size={1} />
            <Controls />
            <MiniMap pannable zoomable nodeStrokeWidth={3} />
          </ReactFlow>
        </main>

        <aside className="vars">
          <div className="side-title">Variables</div>
          <p className="small muted">Used in every prompt as <span className="mono">{'{name}'}</span>. Change once, every branch updates.</p>
          {gEntries.map(([k, v], i) => (
            <div className="var-row" key={i}>
              <input className="mono" value={k} onChange={(e) => {
                const nk = e.target.value.replace(/\W/g, '');
                setGlobals(Object.fromEntries(gEntries.map(([a, b], j) => (j === i ? [nk, b] : [a, b]))));
              }} />
              <textarea rows={2} value={v} onChange={(e) => setGlobals({ ...globals, [k]: e.target.value })} />
              <button className="x" onClick={() => { const g = { ...globals }; delete g[k]; setGlobals(g); }}>✕</button>
            </div>
          ))}
          <button className="btn ghost" onClick={() => setGlobals({ ...globals, ['var' + (gEntries.length + 1)]: '' })}>+ variable</button>
        </aside>

        {knife && (
          <svg className="knife"><polyline points={knife.map((q) => `${q.x},${q.y}`).join(' ')} /></svg>
        )}
        {toastMsg && <div className="toast">{toastMsg}</div>}
        {agent && <div className="agent-pill"><span className="pulse" /><b>Ada</b>{agent.text}</div>}
        {lightbox && (
          <div className="lightbox" onClick={() => setLightbox(null)}>
            <img src={lightbox.value || lightbox.url} onClick={(e) => e.stopPropagation()} />
            <div className="lb-info" onClick={(e) => e.stopPropagation()}>
              {lightbox.trail?.length > 0 && <div className="trail">{lightbox.trail.filter(Boolean).join('  →  ')}</div>}
              {lightbox.vars && Object.keys(lightbox.vars).length > 0 && (
                <div className="mono small">{Object.entries(lightbox.vars).map(([k, v]) => `${k}: ${v}`).join('   ')}</div>
              )}
              <div className="row">
                <button className="btn sm" onClick={() => copyImage(lightbox.value || lightbox.url)}>Copy image</button>
                <a className="btn sm" href={lightbox.value || lightbox.url} download>Download</a>
              </div>
            </div>
          </div>
        )}
      </div>
    </DerivedCtx.Provider>
  );
}

export default function App() {
  return <ReactFlowProvider><Studio /></ReactFlowProvider>;
}
