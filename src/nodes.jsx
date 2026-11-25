import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Handle, Position, useReactFlow, useUpdateNodeInternals, NodeResizer, BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react';
import { unresolved, mediaOf, TYPE_COLOR } from './derive.js';
import { glbInfo, fmtBytes, fmtNum } from './glbinfo.js';

export const DerivedCtx = createContext({ out: {}, info: {}, globals: {} });
const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- helpers ----------
const toDataUrl = (file) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(file); });
export async function uploadFiles(files) {
  const imgs = [...files].filter((f) => f.type.startsWith('image/'));
  return Promise.all(imgs.map(async (f) => {
    const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: await toDataUrl(f) }) });
    const { url } = await res.json();
    return { id: uid(), url, name: f.name?.replace(/\.\w+$/, '') || 'pasted' };
  }));
}
// Snapshot a DataTransfer synchronously (it's emptied once the event handler yields).
export const IMG_MIME = 'application/x-aistudio-image';
export const startImageDrag = (e, img) => {
  e.stopPropagation();
  e.dataTransfer.setData(IMG_MIME, JSON.stringify({ url: img.url, name: img.name || '' }));
  e.dataTransfer.effectAllowed = 'copy';
};
export function readTransfer(dt) {
  let internal = null;
  try { const raw = dt?.getData?.(IMG_MIME); if (raw) internal = JSON.parse(raw); } catch {}
  if (internal?.url) return { files: [], url: null, internal, text: '' };
  const files = [...(dt?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) for (const it of dt?.items || []) {
    if (it.kind === 'file' && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) files.push(f); }
  }
  let url = null;
  if (!files.length && dt) {
    const m = /<img[^>]+src="([^"]+)"/i.exec(dt.getData('text/html') || '');
    url = m?.[1]?.replace(/&amp;/g, '&')
      || (dt.getData('text/uri-list') || '').split('\n').map((l) => l.trim()).find((l) => /^(https?:|data:image\/)/.test(l))
      || null;
  }
  return { files, url, text: dt?.getData('text/plain') || '' };
}
// Turn a snapshot into stored images (uploads files, or downloads an image dragged from a web page).
export async function importTransfer(snap) {
  if (snap.internal) return [{ id: uid(), url: snap.internal.url, name: snap.internal.name || '' }];
  if (snap.files.length) return uploadFiles(snap.files);
  if (!snap.url) return [];
  const r = await fetch('/api/fetch-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: snap.url }) });
  const j = await r.json();
  if (!r.ok) { toast(`Couldn't grab that image: ${j.error}`); return []; }
  return [{ id: uid(), url: j.url, name: j.name || 'web' }];
}
export async function copyImage(url) {
  const blob = await (await fetch(url)).blob();
  let png = blob;
  if (blob.type !== 'image/png') {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    png = await new Promise((ok) => c.toBlob(ok, 'image/png'));
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  toast('Image copied, paste it into ChatGPT / Higgsfield');
}
export const copyText = async (t) => { await navigator.clipboard.writeText(t); toast('Prompt copied'); };
export const toast = (msg) => window.dispatchEvent(new CustomEvent('toast', { detail: msg }));
export const openLightbox = (item) => window.dispatchEvent(new CustomEvent('lightbox', { detail: item }));

function useData(id) {
  const { updateNodeData } = useReactFlow();
  return (patch) => updateNodeData(id, patch);
}

// ---------- sockets ----------
// Input = a hollow ring (it gets plugged into); output = a solid diamond (the plug). Each socket sits on any side of
// its node: drag it with Alt held to move it along the border; where you leave it is saved on the node (data.socks).
const SIDE = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };
export function Sock({ nodeId, id, type, side = 'top', t = 0.5, color, connected, label, title }) {
  const { getNode, updateNodeData } = useReactFlow();
  const updateInternals = useUpdateNodeInternals();
  const saved = getNode(nodeId)?.data?.socks?.[id];
  const sd = saved?.side || side, at = saved?.t ?? t;
  useEffect(() => { updateInternals(nodeId); }, [sd, at, nodeId, updateInternals]);
  const move = (e) => {
    if (!e.altKey) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget.closest('.react-flow__node');
    const go = (ev) => {
      const r = el.getBoundingClientRect();
      const fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height;
      const d = { top: fy, bottom: 1 - fy, left: fx, right: 1 - fx };
      const nside = Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b));
      const nt = Math.min(0.97, Math.max(0.03, nside === 'top' || nside === 'bottom' ? fx : fy));
      updateNodeData(nodeId, (n) => ({ socks: { ...(n.data.socks || {}), [id]: { side: nside, t: Math.round(nt * 1000) / 1000 } } }));
    };
    const up = () => { window.removeEventListener('pointermove', go); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', go); window.addEventListener('pointerup', up);
  };
  const along = sd === 'top' || sd === 'bottom' ? { left: `${at * 100}%` } : { top: `${at * 100}%` };
  return (
    <Handle type={type} position={SIDE[sd]} id={id} title={(title ? title + ' · ' : '') + 'Alt+drag to move'}
      className={`sk ${type === 'source' ? 'sk-out' : 'sk-in'} ${connected ? 'on' : ''}`}
      style={{ ...along, '--c': color }} onPointerDownCapture={move} onMouseDownCapture={(e) => { if (e.altKey) { e.preventDefault(); e.stopPropagation(); } }}>
      {label != null && <span className="sk-label">{label}</span>}
    </Handle>
  );
}

// drop / paste / click-to-browse zone
function DropZone({ onFiles, onText, children, className = '' }) {
  const input = useRef();
  const [over, setOver] = useState(false);
  const handle = async (dt) => {
    const snap = readTransfer(dt);
    const imgs = await importTransfer(snap);
    if (imgs.length) onFiles(imgs);
    else if (onText && snap.text) onText(snap.text);
  };
  return (
    <div
      tabIndex={0}
      className={`drop nodrag ${over ? 'over' : ''} ${className}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); handle(e.dataTransfer); }}
      onPaste={(e) => {
        const typing = /^(TEXTAREA|INPUT)$/.test(e.target.tagName);
        const snap = readTransfer(e.clipboardData);
        if (typing && !snap.files.length) return; // plain text pasted into a text box: let it through
        e.preventDefault(); e.stopPropagation();
        importTransfer(snap).then((imgs) => { if (imgs.length) onFiles(imgs); else if (onText && snap.text) onText(snap.text); });
      }}
      onDoubleClick={(e) => { if (!/^(TEXTAREA|INPUT)$/.test(e.target.tagName)) input.current.click(); }}
    >
      {children}
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={async (e) => { onFiles(await uploadFiles(e.target.files)); e.target.value = ''; }} />
    </div>
  );
}

function Thumb({ item, onRemove, size = 64, onStar, starred }) {
  return (
    <div className="thumb" style={{ width: size, height: size }}>
      <img src={item.value || item.url} onClick={() => openLightbox(item)} draggable={false} />
      <div className="thumb-actions">
        <button title="Copy image" onClick={() => copyImage(item.value || item.url)}>⧉</button>
        {onStar && <button title="Star" className={starred ? 'on' : ''} onClick={onStar}>★</button>}
        {onRemove && <button title="Remove" onClick={onRemove}>✕</button>}
      </div>
    </div>
  );
}

function Frame({ id, data, selected, kind, color, inputs = [], output = true, children, right }) {
  const set = useData(id);
  return (
    <div className={`node ${kind} ${selected ? 'sel' : ''}`} style={{ '--accent': color }}>
      <div className="node-head">
        <span className="dot" />
        <input className="title nodrag" value={data.label || ''} placeholder={kind} onChange={(e) => set({ label: e.target.value })} />
        {right}
      </div>
      {inputs.map((p) => (
        <div className="port-row" key={p.id}>
          <Handle type="target" position={Position.Left} id={p.id} className={`h-${p.type}`} />
          <span>{p.label}</span>
        </div>
      ))}
      <div className="node-body">{children}</div>
      {output && <Handle type="source" position={Position.Bottom} id="out" className="h-out" />}
    </div>
  );
}

// ---------- node types ----------
// Reference node: a simple input entry, normally one image, wired into a prompt
function ImageNode({ id, data, selected }) {
  const set = useData(id);
  const imgs = data.images || [];
  return (
    <div className={`refnode ${selected ? 'sel' : ''}`}>
      <DropZone className="refs-grid refnode-body" onFiles={(more) => set((n) => ({ images: [...(n.data.images || []), ...more] }))}>
        {imgs.map((im) => (
          <ImageComp key={im.id} img={im} big
            onRename={(v) => set((n) => ({ images: n.data.images.map((x) => (x.id === im.id ? { ...x, name: v } : x)) }))}
            onRemove={() => set((n) => ({ images: n.data.images.filter((x) => x.id !== im.id) }))} />
        ))}
        {!imgs.length && <RefsAdd empty />}
      </DropZone>
      <Sock nodeId={id} id="out" type="source" side="bottom" color={TYPE_COLOR.image} title="Reference image" />
    </div>
  );
}
function RefsAdd({ empty }) {
  return <div className={`refs-add ${empty ? 'wide' : ''}`}>{empty ? '+ drop · paste · double-click images' : '+'}</div>;
}

function ListNode({ id, data, selected }) {
  const set = useData(id);
  const n = (useContext(DerivedCtx).out[id] || []).length;
  return (
    <Frame id={id} data={data} selected={selected} kind="list" color="#e6b450"
      right={<span className="badge">{n}</span>}>
      <label className="row">variable <span className="mono">{'{'}</span>
        <input className="nodrag var" value={data.varName || ''} onChange={(e) => set({ varName: e.target.value.replace(/\W/g, '') })} />
        <span className="mono">{'}'}</span></label>
      <textarea className="nodrag nowheel" rows={Math.min(8, Math.max(3, (data.text || '').split('\n').length))}
        placeholder="one value per line → one branch each" value={data.text || ''} onChange={(e) => set({ text: e.target.value })} />
    </Frame>
  );
}

const TOOLS = ['ChatGPT', 'Higgsfield', 'Tripo', 'Meshy', 'Other'];

function Branch({ nodeId, data, b }) {
  const set = useData(nodeId);
  const [open, setOpen] = useState(false);
  const r = b.result;
  const has = (r.images?.length || 0) > 0 || !!r.text;
  const done = r.done || has;
  const missing = unresolved(b.prompt);
  const patch = (fn) => set((n) => {
    const results = { ...(n.data.results || {}) };
    results[b.key] = fn({ ...(results[b.key] || {}) });
    return { results };
  });
  return (
    <div className={`branch ${done ? 'done' : ''}`}>
      <div className="branch-head">
        <input type="checkbox" className="nodrag" checked={done} title="Mark done"
          onChange={(e) => patch((x) => ({ ...x, done: e.target.checked }))} />
        <span className="tag">{b.tag || 'single'}</span>
        <button className="btn sm" onClick={() => copyText(b.prompt)}>Copy prompt</button>
      </div>
      {b.inputImages.length > 0 && (
        <div className="grid tight">{b.inputImages.map((im) => <Thumb key={im.id} item={im} size={44} />)}</div>
      )}
      <div className={`ptext nodrag nowheel ${open ? 'open' : ''}`} onClick={() => setOpen(!open)}>{b.prompt || <i>empty prompt</i>}</div>
      {missing.length > 0 && <div className="warn">unfilled: {missing.map((m) => `{${m}}`).join(' ')}</div>}
      {data.resultType === 'text' ? (
        <textarea className="nodrag nowheel result-text" rows={3} placeholder="paste the answer here"
          value={r.text || ''} onChange={(e) => patch((x) => ({ ...x, text: e.target.value }))} />
      ) : (
        <DropZone className="grid result" onFiles={(imgs) => patch((x) => ({ ...x, images: [...(x.images || []), ...imgs] }))}>
          {(r.images || []).map((im) => (
            <Thumb key={im.id} size={56} item={{ ...im, value: im.url, trail: [...b.trail, data.label], vars: b.vars }}
              onRemove={() => patch((x) => ({ ...x, images: x.images.filter((y) => y.id !== im.id) }))} />
          ))}
          <div className="hint">{r.images?.length ? '+ paste more' : 'paste / drop result'}</div>
        </DropZone>
      )}
    </div>
  );
}

function PromptNode({ id, data, selected }) {
  const set = useData(id);
  const { info } = useContext(DerivedCtx);
  const inf = info[id] || { branches: [], refs: [], orphans: [] };
  const doneN = inf.branches.filter((b) => b.result.done || b.result.images?.length || b.result.text).length;
  return (
    <Frame id={id} data={data} selected={selected} kind="prompt" color={data.tool === 'ChatGPT' ? '#5ec4a0' : '#c58bff'}
      inputs={[{ id: 'branch', label: 'branch over (lists / results)', type: 'any' }, { id: 'refs', label: 'references', type: 'image' }]}
      right={<span className={`badge ${doneN === inf.branches.length && doneN ? 'ok' : ''}`}>{doneN}/{inf.branches.length}</span>}>
      <div className="row">
        <select className="nodrag" value={data.tool || 'Higgsfield'} onChange={(e) => set({ tool: e.target.value })}>
          {TOOLS.map((t) => <option key={t}>{t}</option>)}
        </select>
        <input className="nodrag grow" placeholder="model / preset" value={data.model || ''} onChange={(e) => set({ model: e.target.value })} />
      </div>
      <textarea className="nodrag nowheel" rows={4} placeholder="Prompt template, use {variables}" value={data.template || ''}
        onChange={(e) => set({ template: e.target.value })} />
      <div className="row small">
        result:
        <select className="nodrag" value={data.resultType || 'images'} onChange={(e) => set({ resultType: e.target.value })}>
          <option value="images">images</option><option value="text">text</option>
        </select>
        {data.resultType === 'text' && (<>
          <label><input type="checkbox" className="nodrag" checked={!!data.splitLines} onChange={(e) => set({ splitLines: e.target.checked })} /> lines → branches as</label>
          <span className="mono">{'{'}</span><input className="nodrag var" value={data.varName || ''} onChange={(e) => set({ varName: e.target.value.replace(/\W/g, '') })} /><span className="mono">{'}'}</span>
        </>)}
      </div>
      {inf.refs.length > 0 && (
        <div className="refs"><span className="small">refs</span><div className="grid tight">{inf.refs.map((r) => <Thumb key={r.id} item={r} size={40} />)}</div></div>
      )}
      <div className="branches nowheel">
        {inf.branches.map((b) => <Branch key={b.key} nodeId={id} data={data} b={b} />)}
      </div>
      {inf.orphans.length > 0 && (
        <div className="warn">{inf.orphans.length} result(s) from removed branches kept.{' '}
          <button className="btn sm" onClick={() => set((n) => { const r = { ...n.data.results }; inf.orphans.forEach((k) => delete r[k]); return { results: r }; })}>discard</button>
        </div>
      )}
    </Frame>
  );
}

function BoardNode({ id, data, selected }) {
  const set = useData(id);
  const { info } = useContext(DerivedCtx);
  const items = info[id]?.items || [];
  const stars = data.stars || {};
  const shown = data.starredOnly ? items.filter((i) => stars[i.id]) : items;
  const imgs = shown.filter((i) => i.type === 'image');
  const texts = shown.filter((i) => i.type === 'text');
  const exportAll = async () => {
    const list = imgs.map((i) => ({ url: i.value, name: Object.values(i.vars).join('_') || 'image' }));
    const r = await (await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: data.label || 'board', items: list }) })).json();
    toast(`Exported ${r.count} → ${r.dir}`);
  };
  return (
    <Frame id={id} data={data} selected={selected} kind="board" color="#ff8a65" output={false}
      inputs={[{ id: 'in', label: 'collect', type: 'any' }]}
      right={<span className="badge">{Object.values(stars).filter(Boolean).length}★ / {items.length}</span>}>
      <div className="row small">
        <label><input type="checkbox" className="nodrag" checked={!!data.starredOnly} onChange={(e) => set({ starredOnly: e.target.checked })} /> starred only</label>
        <button className="btn sm" onClick={exportAll} disabled={!imgs.length}>Export {imgs.length}</button>
      </div>
      <div className="grid board-grid nowheel">
        {imgs.map((it) => (
          <div key={it.id} className="board-cell">
            <Thumb item={it} size={96} starred={!!stars[it.id]} onStar={() => set((n) => ({ stars: { ...(n.data.stars || {}), [it.id]: !(n.data.stars || {})[it.id] } }))} />
            <div className="cap">{Object.values(it.vars).join(' · ')}</div>
          </div>
        ))}
      </div>
      {texts.length > 0 && <ul className="texts">{texts.map((t) => <li key={t.id}>{t.value}</li>)}</ul>}
      {!items.length && <div className="hint">connect results here</div>}
    </Frame>
  );
}

function NoteNode({ id, data, selected }) {
  const set = useData(id);
  return (
    <div className={`node note ${selected ? 'sel' : ''}`}>
      <textarea className="nodrag nowheel" rows={5} value={data.text || ''} placeholder="note…" onChange={(e) => set({ text: e.target.value })} />
    </div>
  );
}

// ---------- image card: the default for anything imported ----------
export const imageSize = (url, w = 260) => new Promise((ok) => {
  const im = new Image();
  im.onload = () => ok({ width: w, height: Math.round(w * (im.naturalHeight / im.naturalWidth || 1)) });
  im.onerror = () => ok({ width: w, height: w });
  im.src = url;
});

function SideAdd({ id, side, kinds: only }) {
  const [open, setOpen] = useState(false);
  const kinds = only || (side === 'right' ? RIGHT_KINDS : LEFT_KINDS);
  return (
    <div className={`side-add ${side} nodrag nopan`} onMouseLeave={() => setOpen(false)}>
      <button className="plus" title={side === 'right' ? 'Add a node fed by this image' : 'Add a node feeding this image'}
        onClick={() => setOpen(!open)}>+</button>
      {open && (
        <div className="side-menu">
          {kinds.map((k) => (
            <button key={k.name} onClick={() => {
              setOpen(false);
              window.dispatchEvent(new CustomEvent('spawn-node', { detail: { from: id, side, kind: k } }));
            }}>{k.name}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- image component: lives inside nodes, can be dragged from one node into another ----------
function ImageComp({ img, onRename, onRemove, trail, big }) {
  return (
    <div className={`imgc nodrag ${big ? 'big' : ''}`} draggable onDragStart={(e) => startImageDrag(e, img)} title="Drag into another node">
      <div className="imgc-frame">
        <img src={img.url} draggable={false} onDoubleClick={() => openLightbox({ value: img.url, trail: trail || [img.name] })} />
        <div className="thumb-actions">
          <button title="Copy image" onClick={() => copyImage(img.url)}>⧉</button>
          {onRemove && <button title="Remove" onClick={onRemove}>✕</button>}
        </div>
      </div>
      <input className="imgc-name" value={img.name || ''} placeholder="untitled" readOnly={!onRename}
        draggable onDragStart={(e) => e.preventDefault()} onChange={(e) => onRename?.(e.target.value)} />
    </div>
  );
}

// grid of image components; refs added by hand can be renamed/removed, linked ones follow their link
const emit = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }));
function RefGrid({ refs, set, nodeId }) {
  return refs.map((r) => (
    <ImageComp key={r.id} img={{ url: r.value, name: r.name ?? r.trail?.[0] }} trail={r.trail}
      onRename={r.manual ? (v) => set((n) => ({ refs: n.data.refs.map((x) => (x.id === r.id ? { ...x, name: v } : x)) }))
        : nodeId ? (v) => emit('rename-ref', { imageId: r.id, name: v }) : undefined}
      onRemove={r.manual ? () => set((n) => ({ refs: n.data.refs.filter((x) => x.id !== r.id) }))
        : nodeId ? () => emit('unlink-ref', { target: nodeId, imageId: r.id }) : undefined} />
  ));
}
const addRefs = (set) => (imgs) => set((n) => ({ refs: [...(n.data.refs || []), ...imgs] }));

// ---------- media card sizing: one rule for every Output, however it was made ----------
export const MIN_OUTPUT_W = 440;
// 3D needs room to read the model
export const minWidthFor = (kind) => (kind === '3d' ? 600 : MIN_OUTPUT_W);
const naturalAspect = (url) => new Promise((ok) => {
  const im = new Image();
  im.onload = () => ok(im.naturalWidth / im.naturalHeight || 1);
  im.onerror = () => ok(1);
  im.src = url;
});
// every media card is the same size: 540px wide with a square viewing area
export const MEDIA_CARD_W = 540;
export async function mediaWidth() { return MEDIA_CARD_W; }

// ---------- media card (image / video / 3D / audio / text) ----------
export const KINDS = [
  { id: 'image', name: 'Image', accept: 'image/*', test: (f) => f.type.startsWith('image/') },
  { id: 'video', name: 'Video', accept: 'video/*', test: (f) => f.type.startsWith('video/') },
  { id: '3d', name: '3D model', accept: '.glb,.gltf,.obj,.fbx,.stl,.usdz', test: (f) => /\.(glb|gltf|obj|fbx|stl|usdz)$/i.test(f.name) },
  { id: 'audio', name: 'Audio', accept: 'audio/*', test: (f) => f.type.startsWith('audio/') },
  { id: 'text', name: 'Text' },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k]));
const ARTICLE = { image: 'an image', video: 'a video', '3d': 'a 3D model', audio: 'audio', text: 'text' };
// the output type a stored file belongs to (OBJ/FBX/STL count as 3D even though only GLB/GLTF preview)
export const kindOfUrl = (url) => ({ image: 'image', video: 'video', '3d': '3d', '3d-other': '3d', audio: 'audio' }[mediaOf(url)] || null);
const EXPECT = { image: 'an image', video: 'a video', '3d': 'a 3D model (.glb / .gltf)', audio: 'an audio file' };

export async function uploadRaw(file) {
  const r = await fetch('/api/upload-file', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name || 'pasted.png') }, body: file,
  });
  const j = await r.json();
  return { id: uid(), url: j.url, name: j.name };
}

// drop / paste / double-click zone that accepts one file of the card's kind
function MediaZone({ kind, onFile, children }) {
  const input = useRef();
  const [over, setOver] = useState(false);
  const k = KIND[kind] || KIND.image;
  const take = async (files, url) => {
    const all = [...(files || [])];
    const f = all.find((x) => k.test(x));
    if (f) return onFile(await uploadRaw(f));
    if (all.length) return toast(`This Output expects ${EXPECT[kind]}. Change its Type to use that file.`);
    if (url && kind === 'image') { const [im] = await importTransfer({ files: [], url }); if (im) onFile(im); }
  };
  return (
    <div tabIndex={0} className={`drop card-drop nodrag ${over ? 'over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); const s = readTransfer(e.dataTransfer);
        if (s.internal) return kind === 'image' ? onFile({ id: uid(), url: s.internal.url, name: s.internal.name }) : toast(`This Output expects ${EXPECT[kind]}.`); take(e.dataTransfer.files?.length ? e.dataTransfer.files : s.files, s.url); }}
      onPaste={(e) => { e.preventDefault(); e.stopPropagation(); const s = readTransfer(e.clipboardData); take(e.clipboardData.files?.length ? e.clipboardData.files : s.files, s.url); }}
      onDoubleClick={() => input.current.click()}>
      {children}
      <input ref={input} type="file" accept={k.accept} hidden onChange={(e) => { take(e.target.files); e.target.value = ''; }} />
    </div>
  );
}

function Viewer({ url, label }) {
  const m = mediaOf(url);
  if (m === 'image') return <img src={url} draggable={false} onDoubleClick={() => openLightbox({ value: url, trail: [label] })} />;
  if (m === 'video') return <video className="nodrag" src={url} controls loop playsInline preload="metadata" />;
  if (m === 'audio') return <div className="audio-wrap nodrag"><div className="audio-icon">♪</div><audio src={url} controls /></div>;
  if (m === '3d') return <Viewer3D url={url} />;
  return (
    <div className="file-box">
      <div className="file-ext">{(url.match(/\.(\w+)$/) || [])[1]?.toUpperCase() || 'FILE'}</div>
      <div className="small muted">{m === '3d-other' ? 'Preview supports .glb / .gltf. Export as GLB to see it here.' : 'No preview for this type'}</div>
      <a className="btn sm" href={url} download>Download</a>
    </div>
  );
}

// ---------- 3D: viewer with Shaded / Clay / Wire, and a details panel ----------
// model-viewer has no wireframe/clay switch, so this reaches its three.js scene (internal 'scene' symbol)
// and flips the materials in place, keeping the originals to switch back.
const MODES = [{ id: 'shaded', name: 'Shaded' }, { id: 'clay', name: 'Clay' }, { id: 'wire', name: 'Wire' }];
function applyMode(mv, mode) {
  const sym = mv && Object.getOwnPropertySymbols(mv).find((s) => s.description === 'scene');
  const scene = sym && mv[sym];
  if (!scene?.traverse) return false;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      if (!m.userData.__orig) m.userData.__orig = { map: m.map, color: m.color?.clone(), metalness: m.metalness, roughness: m.roughness, emissiveMap: m.emissiveMap, wireframe: m.wireframe };
      const o0 = m.userData.__orig;
      const plain = mode !== 'shaded';
      m.map = plain ? null : o0.map;
      m.emissiveMap = plain ? null : o0.emissiveMap;
      if (m.color) plain ? m.color.setRGB(0.42, 0.42, 0.44) : m.color.copy(o0.color);
      if ('metalness' in m) m.metalness = plain ? 0 : o0.metalness;
      if ('roughness' in m) m.roughness = plain ? 0.85 : o0.roughness;
      m.wireframe = mode === 'wire';
      m.needsUpdate = true;
    }
  });
  scene.queueRender?.();
  return true;
}
function Viewer3D({ url }) {
  const ref = useRef();
  const [mode, setMode] = useState('shaded');
  useEffect(() => {
    const mv = ref.current; if (!mv) return;
    const go = () => applyMode(mv, mode);
    if (!go()) mv.addEventListener('load', go, { once: true });
    mv.addEventListener('load', go);
    return () => mv.removeEventListener('load', go);
  }, [mode, url]);
  return (
    <>
      <model-viewer ref={ref} class="mv nodrag nowheel" src={url} camera-controls auto-rotate shadow-intensity="0.8"
        exposure="1" environment-image="neutral" interaction-prompt="none" />
      <div className="mv-modes nodrag">
        {MODES.map((x) => <button key={x.id} className={mode === x.id ? 'on' : ''} onClick={() => setMode(x.id)}>{x.name}</button>)}
      </div>
    </>
  );
}
// generation facts (from data.gen, filled by whoever generated it) + stats read from the GLB itself
function ModelDetails({ url, gen }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(true);
  useEffect(() => { setInfo(null); setErr(null); if (/\.glb$/i.test(url)) glbInfo(url).then(setInfo, (e) => setErr(e.message)); }, [url]);
  const tex = info?.textures || [];
  const rows = [
    gen?.tool && ['Generated', [gen.tool, gen.model].filter(Boolean).join(' · ')],
    gen?.params && ['Settings', Object.entries(gen.params).map(([k, v]) => `${k}: ${v}`).join(' · ')],
    gen?.job && ['Job', gen.job],
    gen?.at && ['When', new Date(gen.at).toLocaleString()],
    info && ['Triangles', fmtNum(info.tris)],
    info && ['Vertices', fmtNum(info.verts)],
    info && ['Meshes', `${info.meshes} mesh${info.meshes === 1 ? '' : 'es'} · ${info.prims} part${info.prims === 1 ? '' : 's'}`],
    info && ['Materials', String(info.materials)],
    info && ['Textures', tex.length ? tex.map((t) => (t.w ? `${t.w}×${t.h}` : '?') + ' ' + (t.mime || '').replace('image/', '')).join(', ') : 'none (untextured)'],
    info?.size && ['Bounds', info.size.map((v) => v.toFixed(2)).join(' × ') + ' units'],
    info && ['File', fmtBytes(info.bytes) + (info.generator ? ` · ${info.generator}` : '')],
  ].filter(Boolean);
  return (
    <div className={`card-details model-details nodrag nowheel ${open ? 'open' : ''}`}>
      <div className="cd-toggle" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? '▾' : '▸'}</span><span className="cd-label">Details</span>
        {!open && info && <span className="cd-preview">{fmtNum(info.tris)} tris · {tex.length} tex · {fmtBytes(info.bytes)}</span>}
      </div>
      {open && (
        <div className="md-grid">
          {rows.flatMap(([k, v]) => [<span className="md-k" key={k + 'k'}>{k}</span>, <span className="md-v" key={k + 'v'}>{v}</span>])}
          {!info && !err && <span className="muted small">reading model…</span>}
          {err && <span className="muted small">{err}</span>}
        </div>
      )}
    </div>
  );
}

// which model made this result, as a short coloured badge (full tool/model/job in the tooltip)
const MODEL_NAMES = [
  [/gpt|chatgpt|openai|dall/i, 'GPT', 'gpt'],
  [/soul_?2|soul_v2|soul 2/i, 'Soul 2', 'soul'],
  [/soul_cinematic|soul cinema/i, 'Soul Cinema', 'soul'],
  [/soul/i, 'Soul', 'soul'],
  [/seedream[_ ]?5[_.]5/i, 'Seedream 5.5', 'seedream'],
  [/seedream[_ ]?v?5[_ ]?(pro)/i, 'Seedream 5 Pro', 'seedream'],
  [/seedream[_ ]?v?4[_.]5/i, 'Seedream 4.5', 'seedream'],
  [/seedream/i, 'Seedream', 'seedream'],
  [/nano[_ ]?banana/i, 'Nano Banana', 'other'],
  [/hunyuan/i, 'Hunyuan3D', 'other'],
  [/sam_3_3d_body|3d body/i, 'SAM 3D Body', 'other'],
  [/sam_3_3d|sam 3/i, 'SAM 3D', 'other'],
  [/flux/i, 'Flux', 'other'],
];
function modelLabel(gen) {
  if (!gen) return null;
  const raw = [gen.model, gen.tool].filter(Boolean).join(' ');
  for (const [re, name, fam] of MODEL_NAMES) if (re.test(raw)) return { name, fam };
  return { name: gen.model || gen.tool, fam: 'other' };
}
function ModelBadge({ gen }) {
  const m = modelLabel(gen);
  if (!m) return null;
  const tip = [gen.tool, gen.model, gen.job && 'job ' + gen.job].filter(Boolean).join(' · ');
  return <span className={`model-badge fam-${m.fam}`} title={tip}>{m.name}</span>;
}

// Output node: one typed input on top, one output of the same type on the bottom (wire it into the next prompt);
// you pick the type of what you received, the visualiser sits at the bottom
function ImageCardNode({ id, data, selected }) {
  const set = useData(id);
  const { updateNode } = useReactFlow();
  const inf = useContext(DerivedCtx).info[id] || {};
  const kind = inf.kind || data.kind || 'image';
  const fillWith = async (f) => {
    if (!f) return;
    if (kindOfUrl(f.url) !== kind) return toast(`This Output expects ${EXPECT[kind]}.`);
    set({ url: f.url, outdated: null }); // a new result is current again; the canvas re-sizes the card to the new media
  };
  const [dragOut, setDragOut] = useState(false); // keep the grip mounted while its drag is in flight
  // versions: every take of this result lives in the card (v1, v2 …); the latest is shown by default and is what
  // flows out of the card. Each version can carry its own prompt (e.g. the fix instruction) and its own issue.
  const versions = data.versions?.length ? data.versions : null;
  const [vsel, setVsel] = useState(null);
  useEffect(() => { setVsel(null); }, [versions?.length]);
  const vIdx = versions ? (vsel != null && vsel < versions.length ? vsel : versions.length - 1) : 0;
  const cur = versions ? versions[vIdx] : null;
  const latest = !versions || vIdx === versions.length - 1;
  const url = cur ? cur.url : data.url;
  const issue = cur ? cur.issue : data.issue;
  const setIssue = (v) => (versions ? set((n) => ({ versions: n.data.versions.map((x, i) => (i === vIdx ? { ...x, issue: v } : x)) })) : set({ issue: v }));
  const media = url ? mediaOf(url) : null;
  return (
    <div className={`onode ${selected ? "sel" : ""} ${issue != null ? "flagged" : ""} ${inf.outdated && latest ? "outdated" : ""}`}>
      {/* no manual scaling: the card's size follows its type and media */}
      <input className="card-title nodrag" value={data.label ?? 'Output'} placeholder="Output"
        onChange={(e) => set({ label: e.target.value })} />
      <Sock nodeId={id} id="in" type="target" side="top" color={TYPE_COLOR[kind]} connected={!!inf.from} title="Input: what made this" />
      <Sock nodeId={id} id="out" type="source" side="bottom" color={TYPE_COLOR[kind]} title="Output: drag into a prompt's Reference socket" />
      <div className="cd-row">
        <span className="cd-label">Type</span>
        <select className="nodrag target-sel" value={kind} onChange={(e) => set({ kind: e.target.value })}>
          {KINDS.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
        <span className="spacer" />
        <ModelBadge gen={cur?.gen || data.gen} />
        {inf.from && <span className="muted small">from {inf.from}</span>}
      </div>
      {versions && versions.length > 1 && (
        <div className="ver-tabs nodrag">
          {versions.map((v, i) => (
            <button key={i} className={`${i === vIdx ? 'on' : ''} ${v.issue != null ? 'bad' : ''}`} onClick={() => setVsel(i)}
              title={v.issue != null ? 'Issue: ' + v.issue : v.note || ''}>
              v{i + 1}{v.issue != null ? ' ⚠' : ''}{i === versions.length - 1 ? ' · latest' : ''}
            </button>
          ))}
        </div>
      )}
      <CardDetails id={id} data={data} ver={cur} vIdx={vIdx} />
      {inf.outdated && latest && (
        <div className="outdated-bar nodrag"><span className="od-tag">Outdated</span><span>{inf.outdated}</span>
          {data.outdated && <button title="Mark as up to date" onClick={() => set({ outdated: null })}>✕</button>}</div>
      )}
      {/* what's wrong with the version on show; a newer version is the fix */}
      {issue != null && (
        <div className="issue-bar nodrag">
          <span className="issue-tag">Issue{versions ? ` · v${vIdx + 1}` : ''}</span>
          <input value={issue} placeholder="what's wrong with this result" onChange={(e) => setIssue(e.target.value)} />
          <button title="Clear the issue" onClick={() => setIssue(null)}>✕</button>
        </div>
      )}
      {/* photos & videos show at their native ratio; everything else uses the square viewer */}
      <div className={`card-frame kind-${kind} ${dragOut ? 'dragging' : ''} ${url && kind !== 'text' && kindOfUrl(url) === kind && (kind === 'image' || kind === 'video') ? 'native' : ''}`}>
        {kind === 'text' ? (
          <AutoTextarea className="nodrag nowheel text-out" placeholder="paste the text output here"
            value={data.textOut || ''} onChange={(e) => set({ textOut: e.target.value })} />
        ) : url && kindOfUrl(url) !== kind ? (
          <div className="mismatch nodrag">
            <div>This file is <b>{ARTICLE[kindOfUrl(url)] || 'another type'}</b>, but Type is <b>{KIND[kind].name}</b>.</div>
            <div className="row">
              {kindOfUrl(url) && <button className="btn sm" onClick={() => set({ kind: kindOfUrl(url) })}>Set Type to {KIND[kindOfUrl(url)].name}</button>}
              <button className="btn sm ghost" onClick={() => set({ url: null })}>Remove file</button>
            </div>
          </div>
        ) : url ? (
          <>
            <Viewer url={url} label={data.label} />
            {data.busy && latest && <div className="busy-badge"><span className="pulse" />generating v{(versions?.length || 1) + 1} in {data.busy}</div>}
            <div className="card-actions nodrag">
              {media === 'image' && <span title="Drag into a node" role="button" className="grip" draggable
                onDragStart={(e) => { startImageDrag(e, { url, name: data.label }); setDragOut(true); }}
                onDragEnd={() => setDragOut(false)}>⠿</span>}
              {media === 'image' && <button title="Copy image" onClick={() => copyImage(url)}>⧉</button>}
              {media === 'image' && <button title="Open" onClick={() => openLightbox({ value: url, trail: [data.label] })}>⤢</button>}
              <a title="Download" href={url} download><button>⇩</button></a>
              {!versions && <button title="Remove file" onClick={() => set({ url: null })}>✕</button>}
            </div>
          </>
        ) : data.failed ? (
          /* the generation failed: say where and why, keep the slot droppable via the ✕ */
          <div className="failed-kind nodrag"><b>Failed</b><span className="hint">{data.failed}</span>
            <button className="btn sm ghost" onClick={() => set({ failed: null })}>Clear</button></div>
        ) : data.busy ? (
          /* an agent (or you) is generating this right now */
          <div className="busy-kind"><span className="pulse" /><b>Generating</b><span className="hint">in {data.busy}</span></div>
        ) : (
          <MediaZone kind={kind} onFile={fillWith}>
            <div className="empty-kind">
              <b>{KIND[kind].name}</b>
              <div className="hint">drop · paste · double-click to upload</div>
            </div>
          </MediaZone>
        )}
      </div>
      {kind === '3d' && url && kindOfUrl(url) === '3d' && <ModelDetails url={url} gen={cur?.gen || data.gen} />}
    </div>
  );
}

// box under the card: the reference images and the prompt behind this image
// textarea that grows to show all of its text
function AutoTextarea(props) {
  const r = useRef();
  useLayoutEffect(() => {
    const t = r.current; if (!t) return;
    t.style.height = 'auto'; t.style.height = t.scrollHeight + 2 + 'px';
  }, [props.value]);
  return <textarea ref={r} rows={2} {...props} />;
}

// collapsible "Prompt" section under a card: one-line preview closed, everything shown open
function CardDetails({ id, data, ver, vIdx }) {
  const set = useData(id);
  const inf0 = useContext(DerivedCtx).info[id] || { refs: [], prompt: '' };
  const open = !!data.detailsOpen;
  // a version with its own prompt (a fix / refinement) shows that prompt and the earlier version it was made from
  const own = ver?.prompt != null;
  const inf = own ? { ...inf0, prompt: ver.prompt, inherited: false,
    refs: ver.from != null && data.versions?.[ver.from] ? [{ id: 'v' + ver.from, type: 'image', value: data.versions[ver.from].url, name: `v${ver.from + 1}`, vars: {}, trail: [`v${ver.from + 1}`] }] : [] } : inf0;
  // before you type, the box shows the prompt inherited from a linked Prompt node; typing makes it this card's own
  const value = own ? ver.prompt : data.prompt ?? (inf.inherited ? inf.prompt : '');
  return (
    <div className={`card-details nodrag nowheel ${open ? 'open' : ''}`} onDoubleClick={(e) => e.stopPropagation()}>
      <div className="cd-toggle" onClick={() => set({ detailsOpen: !open })} title={open ? 'Collapse' : 'Show full prompt'}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="cd-label">Prompt</span>
        {!open && <span className="cd-preview">{inf.prompt || <i>empty</i>}</span>}
        {open && inf.inherited && <span className="muted small">from {inf.from || 'linked prompt'}</span>}
        {own && <span className="muted small">v{vIdx + 1}{ver.from != null ? ` · edit of v${ver.from + 1}` : ''}</span>}
        {open && <span className="spacer" />}
        {inf.refs.length > 0 && !open && <span className="badge">{inf.refs.length} ref{inf.refs.length > 1 ? 's' : ''}</span>}
        {inf.prompt && <button className="btn sm" onClick={(e) => { e.stopPropagation(); copyText(inf.prompt); }}>Copy</button>}
      </div>
      {open && (
        /* one box: reference images on top, prompt text below; drop/paste images anywhere in it */
        <DropZone className="cd-compose" onFiles={addRefs(set)}>
          {inf.refs.length > 0 && <div className="refs-grid"><RefGrid refs={inf.refs} set={own ? () => {} : set} /></div>}
          <AutoTextarea value={value} placeholder="prompt used for this image · drop reference images here"
            onChange={(e) => (own ? set((n) => ({ versions: n.data.versions.map((x, i) => (i === vIdx ? { ...x, prompt: e.target.value } : x)) })) : set({ prompt: e.target.value }))} />
        </DropZone>
      )}
    </div>
  );
}

// ---------- edges with editable names ----------
function LabeledEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd, style }) {
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const { updateEdgeData } = useReactFlow();
  const [editing, setEditing] = useState(false);
  const cancel = useRef(false);
  const label = data?.label || '';
  const commit = (v) => { if (!cancel.current) updateEdgeData(id, { label: v.trim() }); cancel.current = false; setEditing(false); };
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={22} />
      {(label || selected || editing) && (
        <EdgeLabelRenderer>
          <div className={`edge-label nodrag nopan ${selected ? 'sel' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
            onClick={() => setEditing(true)}>
            {editing ? (
              <input autoFocus defaultValue={label} placeholder="name this link"
                onBlur={(e) => commit(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { cancel.current = true; e.target.blur(); } }} />
            ) : (label || <span className="muted">+ name</span>)}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
export const edgeTypes = { default: LabeledEdge };

// ---------- simple prompt: text + references + where it's going ----------
function PromptBoxNode({ id, data, selected }) {
  const set = useData(id);
  const inf = useContext(DerivedCtx).info[id] || { refs: [], text: '', sockets: [], next: 'in-1' };
  // sockets come and go with links: tell the canvas to re-measure them
  const updateInternals = useUpdateNodeInternals();
  const sockKey = (inf.sockets || []).map((x) => x.handle).join(',') + '|' + inf.next;
  useEffect(() => { updateInternals(id); }, [sockKey, id, updateInternals]);
  const target = data.target || 'image';
  const { updateEdgeData, getEdges, updateNodeData: updND } = useReactFlow();
  // taking a changed input: the prompt is current again, but what it already produced was made from the old input
  const useNewInput = (sk) => {
    updateEdgeData(sk.edge, { snap: sk.current });
    const reason = `made from an older ${sk.name || 'input'}; re-run ${data.label || 'the prompt'}`;
    for (const e of getEdges()) if (e.source === id) updND(e.target, (n) => (n.type === 'imagecard' && n.data.url ? { outdated: reason } : {}));
  };
  return (
    <div className={`pbox ${selected ? 'sel' : ''} ${inf.outdated ? 'outdated' : ''}`}>
      <input className="card-title nodrag" value={data.label || ''} placeholder="Untitled prompt"
        onChange={(e) => set({ label: e.target.value })} />
      {inf.outdated && <div className="outdated-bar"><span className="od-tag">Input changed</span><span>{inf.outdated}</span></div>}
      {/* top edge: one numbered Reference socket per link (order matters), plus one empty socket; flow runs top to bottom */}
      <div className="sock-top">
        {(inf.sockets || []).map((sk, i) => (
          <div className={`tsock ${sk.stale ? 'stale' : ''}`} key={sk.handle} title={sk.stale ? 'Its Output has a newer file than the one this prompt used' : sk.name}>
            <span className="sock-n">{i + 1}</span>
            <span className="sock-name">{sk.name || 'Reference'}</span>
            {sk.stale && (
              <button className="stale-btn nodrag" title="Use the Output's new file" onClick={() => useNewInput(sk)}>use new</button>
            )}
          </div>
        ))}
        <div className="tsock empty" key={inf.next || 'in-1'} title="Drop a link on the empty socket to add a reference">
          <span className="sock-name muted">{(inf.sockets || []).length ? '+' : 'Reference'}</span>
        </div>
      </div>
      {/* the reference sockets themselves: numbered rings, spread along the top edge by default, movable with Alt+drag */}
      {[...(inf.sockets || []).map((sk, i) => ({ h: sk.handle, label: i + 1, on: true, name: sk.name })), { h: inf.next || 'in-1', label: '+', on: false, name: 'empty' }]
        .map((s, i, all) => (
          <Sock key={s.h} nodeId={id} id={s.h} type="target" side="top" t={(i + 1) / (all.length + 1)} color={TYPE_COLOR.image}
            connected={s.on} label={s.label} title={`Reference ${s.label}${s.name && s.on ? ': ' + s.name : ''}`} />
        ))}
      {/* linked references are shown by their wires; only refs stored inside older prompts still need showing here */}
      {inf.refs.some((r) => r.manual) && (
        <div className="refs-grid refs-box"><RefGrid refs={inf.refs.filter((r) => r.manual)} set={set} nodeId={id} /></div>
      )}
      <div className="cd-row">
        <span className="cd-label">Prompt</span>
        <span className="muted small">for</span>
        <select className="nodrag target-sel" value={target} onChange={(e) => set({ target: e.target.value })}>
          {KINDS.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
        <span className="spacer" />
        {inf.text && <button className="btn sm" onClick={() => copyText(inf.text)}>Copy</button>}
      </div>
      <DropZone className="cd-compose nodrag" onFiles={(imgs) => emit('spawn-refs', { target: id, imgs })}>
        <AutoTextarea className="nowheel" style={{ minHeight: 90 }} value={data.text || ''} placeholder="write the prompt · {variables} work"
          onChange={(e) => set({ text: e.target.value })} />
      </DropZone>
      {/* output socket on the bottom edge: results flow down into the Output */}
      <div className="out-label" style={{ color: TYPE_COLOR[target] }}>{KIND[target].name}</div>
      <Sock nodeId={id} id="out" type="source" side="bottom" color={TYPE_COLOR[target]}
        title={'Output: drag onto empty canvas to create the ' + KIND[target].name.toLowerCase() + ' output'} />
    </div>
  );
}

// ---------- custom step: any manual / tool step (Blender lineup, quad remesh, retopo, a bake…) ----------
// any number of inputs of any type, the tool and its steps in words, attached files, one typed output into an Output card
const STATUS = [{ id: 'todo', name: 'To do' }, { id: 'doing', name: 'In progress' }, { id: 'done', name: 'Done' }];
function StepNode({ id, data, selected }) {
  const set = useData(id);
  const inf = useContext(DerivedCtx).info[id] || { sockets: [], next: 'in-1' };
  const target = data.target || '3d';
  const { updateEdgeData } = useReactFlow();
  const status = data.status || 'todo';
  return (
    <div className={`pbox step ${selected ? 'sel' : ''} ${inf.outdated ? 'outdated' : ''}`}>
      <input className="card-title nodrag" value={data.label || ''} placeholder="Custom step" onChange={(e) => set({ label: e.target.value })} />
      {inf.outdated && <div className="outdated-bar"><span className="od-tag">Input changed</span><span>{inf.outdated}</span></div>}
      <div className="sock-top">
        {(inf.sockets || []).map((sk, i) => (
          <div className={`tsock ${sk.stale ? 'stale' : ''}`} key={sk.handle} title={sk.name}>
            <span className="sock-n">{i + 1}</span><span className="sock-name">{sk.name || 'Input'}</span>
            {sk.stale && <button className="stale-btn nodrag" onClick={() => updateEdgeData(sk.edge, { snap: sk.current })}>use new</button>}
          </div>
        ))}
        <div className="tsock empty"><span className="sock-name muted">{(inf.sockets || []).length ? '+' : 'Input (any type)'}</span></div>
      </div>
      {[...(inf.sockets || []).map((sk, i) => ({ h: sk.handle, label: i + 1, on: true, name: sk.name })), { h: inf.next || 'in-1', label: '+', on: false, name: 'any input' }]
        .map((s2, i, all) => (
          <Sock key={s2.h} nodeId={id} id={s2.h} type="target" side="top" t={(i + 1) / (all.length + 1)} color="#9aa3b2"
            connected={s2.on} label={s2.label} title={`Input ${s2.label}${s2.name && s2.on ? ': ' + s2.name : ''}`} />
        ))}
      <div className="cd-row step-head">
        <span className="cd-label">Tool</span>
        <input className="nodrag step-tool" value={data.tool || ''} placeholder="Blender, ZBrush, by hand…" onChange={(e) => set({ tool: e.target.value })} />
        <select className={`nodrag step-status s-${status}`} value={status} onChange={(e) => set({ status: e.target.value })}>
          {STATUS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </div>
      <div className="cd-row"><span className="cd-label">Steps</span><span className="spacer" />
        {data.text && <button className="btn sm" onClick={() => copyText(data.text)}>Copy</button>}</div>
      <AutoTextarea className="nodrag nowheel step-text" value={data.text || ''} placeholder="what is done here, in plain words"
        onChange={(e) => set({ text: e.target.value })} />
      {(data.files || []).length > 0 && (
        <div className="step-files nodrag">
          {data.files.map((f, i) => <a key={i} href={f.url} download={f.name} title={f.note || f.url}>{f.name}</a>)}
        </div>
      )}
      <div className="cd-row"><span className="cd-label">Output</span><span className="spacer" />
        <select className="nodrag target-sel" value={target} onChange={(e) => set({ target: e.target.value })}>
          {KINDS.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
      </div>
      <Sock nodeId={id} id="out" type="source" side="bottom" color={TYPE_COLOR[target]} title={'Output: ' + KIND[target].name} />
    </div>
  );
}

export const nodeTypes = { step: StepNode, promptbox: PromptBoxNode, imagecard: ImageCardNode, image: ImageNode, list: ListNode, prompt: PromptNode, board: BoardNode, note: NoteNode };

export const PALETTE = [
  { type: 'promptbox', name: 'Prompt', desc: 'Text + refs, for image / video / 3D…', data: { label: '', target: 'image', text: '' } },
  { type: 'image', name: 'Reference', desc: 'Images that feed a prompt', data: { label: '', images: [] } },
  { type: 'imagecard', name: 'Output', desc: 'What you got back: image, video, 3D, audio or text', data: { label: 'Output', kind: 'image' } },
  { type: 'list', name: 'List', desc: 'Values that branch the flow', data: { label: 'List', varName: 'item', text: '' } },
  { type: 'prompt', name: 'Batch prompt', desc: 'Template + one result slot per branch', data: { label: 'Prompt', tool: 'Higgsfield', template: '', resultType: 'images', results: {} } },
  { type: 'board', name: 'Board', desc: 'Collect, star, export', data: { label: 'Board', stars: {} } },
  { type: 'step', name: 'Custom step', desc: 'Any manual / tool step: Blender lineup, remesh…', data: { label: '', tool: '', status: 'todo', text: '', target: '3d' } },
  { type: 'note', name: 'Note', desc: 'Sticky note', data: { text: '' } },
];
const P = Object.fromEntries(PALETTE.map((p) => [p.type, p]));
// right of a card: nodes that take the image in (port = which input it plugs into)
const RIGHT_KINDS = [
  { ...P.promptbox, port: 'in' }, { ...P.prompt, name: 'Batch prompt', port: 'refs' }, { ...P.prompt, name: 'Batch prompt (branch per image)', port: 'branch' },
  { ...P.board, port: 'in' }, { ...P.imagecard, name: 'Output / media', port: 'in' }, { ...P.note },
];
// left of a card: nodes that lead into it
const PROMPT_LEFT_KINDS = [{ ...P.image, name: 'Reference', out: true }, { ...P.imagecard, name: 'Output / media (as reference)', out: true }];
const LEFT_KINDS = [
  { ...P.promptbox, out: true }, { ...P.prompt, name: 'Batch prompt', out: true }, { ...P.list, out: true }, { ...P.image, name: 'Reference', out: true },
  { ...P.imagecard, name: 'Output / media', out: true }, { ...P.note },
];
