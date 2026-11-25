// Local-only server: serves the canvas, stores dropped/pasted images and saved workflows on disk.
// No external API calls.
import express from 'express';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer as createVite } from 'vite';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const FILES = path.join(DATA, 'files');
const FLOWS = path.join(DATA, 'workflows');
const EXPORTS = path.join(DATA, 'exports');
for (const d of [FILES, FLOWS, EXPORTS]) await fs.mkdir(d, { recursive: true });

const PORT = Number(process.env.PORT) || 5180;
const app = express();
// ChatGPT's page may hand its generated images straight to the local store (CORS + Chrome's private-network preflight)
app.use(['/api/upload-file', '/files'], (req, res, next) => {
  const o = req.get('origin');
  if (o === 'https://chatgpt.com') res.set({ 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'content-type, x-filename', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Private-Network': 'true' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use((req, res, next) => (req.path === '/api/upload-file' ? next() : express.json({ limit: '80mb' })(req, res, next)));
app.use('/files', express.static(FILES));

const safe = (s) => String(s || '').replace(/[^\w\- .]+/g, '_').trim().slice(0, 80) || 'untitled';

// content-addressed image store
async function store(buf, mime) {
  const ext = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' }[mime] || mime.split('/')[1].split(/[;+]/)[0];
  const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '.' + ext;
  const p = path.join(FILES, name);
  if (!fss.existsSync(p)) await fs.writeFile(p, buf);
  return '/files/' + name;
}
const parseDataUrl = (s) => { const m = /^data:(image\/[\w+.-]+);base64,(.+)$/s.exec(s || ''); return m && { mime: m[1], buf: Buffer.from(m[2], 'base64') }; };

// image upload as data URL
app.post('/api/upload', async (req, res) => {
  const d = parseDataUrl(req.body.dataUrl);
  if (!d) return res.status(400).json({ error: 'expected an image data URL' });
  res.json({ url: await store(d.buf, d.mime) });
});

// any file (video, 3D model, audio, image) as a raw body; original extension kept
app.post('/api/upload-file', express.raw({ type: () => true, limit: '2gb' }), async (req, res) => {
  const name = decodeURIComponent(req.get('x-filename') || 'file');
  const ext = (path.extname(name).toLowerCase() || '.bin').replace(/[^.\w]/g, '');
  const buf = req.body;
  if (!buf?.length) return res.status(400).json({ error: 'empty upload' });
  const file = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + ext;
  const p = path.join(FILES, file);
  if (!fss.existsSync(p)) await fs.writeFile(p, buf);
  res.json({ url: '/files/' + file, name: name.replace(/\.\w+$/, '') });
});

// image dragged from a web page: download it locally
app.post('/api/fetch-image', async (req, res) => {
  try {
    const u = String(req.body.url || '');
    const d = parseDataUrl(u);
    if (d) return res.json({ url: await store(d.buf, d.mime) });
    if (!/^https?:\/\//.test(u)) throw new Error('not an http(s) URL');
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const mime = (r.headers.get('content-type') || '').split(';')[0];
    if (!r.ok || !mime.startsWith('image/')) throw new Error(`got ${r.status} ${mime || 'no content-type'}`);
    const name = decodeURIComponent(new URL(u).pathname.split('/').pop() || 'web').replace(/\.\w+$/, '').slice(0, 40);
    res.json({ url: await store(Buffer.from(await r.arrayBuffer()), mime), name });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// workflows
app.get('/api/workflows', async (_req, res) => {
  const names = (await fs.readdir(FLOWS)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  res.json(names.sort());
});
app.get('/api/workflows/:name', async (req, res) => {
  try { res.type('json').send(await fs.readFile(path.join(FLOWS, safe(req.params.name) + '.json'), 'utf8')); }
  catch { res.status(404).json({ error: 'not found' }); }
});
app.post('/api/workflows/:name', async (req, res) => {
  await fs.writeFile(path.join(FLOWS, safe(req.params.name) + '.json'), JSON.stringify(req.body, null, 1));
  res.json({ ok: true });
});

// ---- live canvas: the server owns the open canvas; every tab (and any agent) sees changes as they happen ----
// tabs: GET /api/live, PUT /api/live {doc, base, client}, SSE /api/live/stream
// agents: POST /api/live/ops {ops:[…]} (edits applied server-side), POST /api/live/cmd {cmd: status|focus|arrange|fit}
const LIVE = path.join(DATA, 'live.json');
let live = { version: 0, doc: null, status: null };
try { live = { ...live, ...JSON.parse(await fs.readFile(LIVE, 'utf8')), status: null }; } catch {}
const subs = new Set();
const send = (msg) => { const s = `data: ${JSON.stringify(msg)}\n\n`; for (const r of subs) r.write(s); };
let saveT;
const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(LIVE, JSON.stringify({ version: live.version, doc: live.doc })), 300); };
const commit = (client) => { live.version++; persist(); send({ type: 'doc', version: live.version, doc: live.doc, client }); };

app.get('/api/live', (_req, res) => res.json(live));
app.get('/api/live/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ type: 'hello', version: live.version, status: live.status })}\n\n`);
  subs.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); subs.delete(res); });
});
app.put('/api/live', (req, res) => {
  const { doc, base, client } = req.body || {};
  if (!doc) return res.status(400).json({ error: 'doc required' });
  // a tab writing over a version it never saw would wipe someone else's edit: make it re-sync instead
  if (live.doc && base !== live.version) return res.status(409).json(live);
  live.doc = doc; commit(client);
  res.json({ version: live.version });
});

const nextSocket = (doc, target) => 'in-' + (Math.max(0, ...doc.edges.filter((e) => e.target === target).map((e) => Number(String(e.targetHandle || '').split('-')[1]) || 0)) + 1);
const rid = () => Math.random().toString(36).slice(2, 10);
function applyOp(doc, op) {
  const node = (id) => { const n = doc.nodes.find((x) => x.id === id); if (!n) throw new Error(`no node ${id}`); return n; };
  switch (op.op) {
    case 'add-node': if (doc.nodes.some((n) => n.id === op.node.id)) throw new Error(`node ${op.node.id} exists`); doc.nodes.push({ position: { x: 0, y: 0 }, ...op.node }); break;
    case 'update-node': { const n = node(op.id); if (op.data) n.data = { ...n.data, ...op.data }; if (op.data?.url) { delete n.data.busy; delete n.data.outdated; } // a new result ends 'generating' and is current again
      if (op.position) n.position = op.position; break; }
    case 'remove-node': doc.nodes = doc.nodes.filter((n) => n.id !== op.id); doc.edges = doc.edges.filter((e) => e.source !== op.id && e.target !== op.id); break;
    case 'link': { // from → to: prompt targets get the next numbered Reference socket, Outputs their single input
      const src = node(op.from), tgt = node(op.to);
      const targetHandle = op.handle || ((tgt.type === 'promptbox' || tgt.type === 'step') ? nextSocket(doc, tgt.id) : 'in');
      if (tgt.type === 'imagecard') doc.edges = doc.edges.filter((e) => e.target !== tgt.id);
      const data = src.type === 'imagecard' && src.data?.url ? { snap: src.data.url } : undefined;
      doc.edges.push({ id: op.id || rid(), source: src.id, sourceHandle: 'out', target: tgt.id, targetHandle, ...(data ? { data } : {}) });
      break;
    }
    case 'add-version': { // a new take of an Output: the old file becomes v1 (keeping its issue), the new one is latest
      const n = node(op.id);
      const vs = n.data.versions?.length ? n.data.versions : (n.data.url ? [{ url: n.data.url, issue: n.data.issue ?? null, at: null }] : []);
      vs.push({ url: op.url, prompt: op.prompt ?? null, from: op.from ?? (vs.length ? vs.length - 1 : null), note: op.note ?? null, issue: null, at: Date.now(), ...(op.gen ? { gen: op.gen } : {}) });
      n.data = { ...n.data, versions: vs, url: op.url, issue: null, outdated: null };
      delete n.data.busy;
      break;
    }
    case 'set-version': { const n = node(op.id); n.data.versions = n.data.versions.map((v, i) => (i === op.index ? { ...v, ...op.data } : v)); break; }
    case 'unlink': doc.edges = doc.edges.filter((e) => !(e.id === op.id || (e.source === op.from && e.target === op.to))); break;
    case 'set': if (op.name != null) doc.name = op.name; if (op.globals) doc.globals = op.globals; break;
    case 'replace': Object.assign(doc, { nodes: [], edges: [], globals: {} }, op.doc); break;
    default: throw new Error(`unknown op ${op.op}`);
  }
}
app.post('/api/live/ops', (req, res) => {
  const doc = structuredClone(live.doc || { name: 'untitled', nodes: [], edges: [], globals: {} });
  try { for (const op of req.body.ops || []) applyOp(doc, op); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  live.doc = doc; commit('agent');
  res.json({ version: live.version });
});
app.post('/api/live/cmd', (req, res) => {
  const m = req.body || {};
  if (m.cmd === 'status') live.status = m.text ? { text: m.text, at: Date.now() } : null;
  send({ type: 'cmd', ...m });
  res.json({ ok: true, tabs: subs.size });
});

// export a board's images into data/exports/<board>/ with readable names
app.post('/api/export', async (req, res) => {
  const dir = path.join(EXPORTS, safe(req.body.name));
  await fs.mkdir(dir, { recursive: true });
  let n = 0;
  for (const it of req.body.items || []) {
    if (!it.url?.startsWith('/files/')) continue;
    const src = path.join(FILES, path.basename(it.url));
    const ext = path.extname(src);
    await fs.copyFile(src, path.join(dir, `${String(++n).padStart(2, '0')}_${safe(it.name)}${ext}`));
  }
  res.json({ ok: true, count: n, dir });
});

const vite = await createVite({ server: { middlewareMode: true }, appType: 'spa' });
app.use(vite.middlewares);
app.listen(PORT, '127.0.0.1', () => console.log(`AI Studio canvas → http://localhost:${PORT}`));
