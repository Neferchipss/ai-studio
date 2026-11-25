// Read a GLB's stats straight from the file (no 3D engine needed): triangles, vertices, meshes, materials,
// textures with their pixel size, file size and bounds. Bounds are taken from the meshes' own position ranges
// (node transforms ignored), so they're the model's size in its own units.
export async function glbInfo(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const binStart = 20 + jsonLen + 8; // after the JSON chunk + the BIN chunk header
  const acc = json.accessors || [];

  // how many times each mesh is placed in the scene (instances count toward the totals)
  const uses = {};
  for (const n of json.nodes || []) if (n.mesh != null) uses[n.mesh] = (uses[n.mesh] || 0) + 1;
  let tris = 0, verts = 0, prims = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  (json.meshes || []).forEach((m, i) => {
    const k = uses[i] ?? 1;
    for (const p of m.primitives || []) {
      prims += k;
      const pos = acc[p.attributes?.POSITION];
      if (!pos) continue;
      verts += pos.count * k;
      const mode = p.mode ?? 4;
      const n = p.indices != null ? acc[p.indices].count : pos.count;
      if (mode === 4) tris += Math.floor(n / 3) * k;
      else if (mode === 5 || mode === 6) tris += Math.max(0, n - 2) * k;
      if (pos.min && pos.max) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], pos.min[a]); max[a] = Math.max(max[a], pos.max[a]); }
    }
  });

  // texture sizes, read from the PNG / JPEG headers inside the binary chunk
  const textures = (json.images || []).map((img) => {
    const bv = json.bufferViews?.[img.bufferView];
    if (!bv) return { mime: img.mimeType || img.uri?.split('.').pop() || '?', w: null, h: null };
    const b = new Uint8Array(buf, binStart + (bv.byteOffset || 0), bv.byteLength);
    let w = null, h = null;
    if (b[0] === 0x89 && b[1] === 0x50) { const d = new DataView(b.buffer, b.byteOffset); w = d.getUint32(16); h = d.getUint32(20); }
    else if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i < b.length - 9;) {
        if (b[i] !== 0xff) { i++; continue; }
        const mk = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) { h = (b[i + 5] << 8) | b[i + 6]; w = (b[i + 7] << 8) | b[i + 8]; break; }
        i += 2 + len;
      }
    }
    return { mime: img.mimeType || '?', w, h, bytes: bv.byteLength };
  });

  return {
    bytes: buf.byteLength, tris, verts, meshes: (json.meshes || []).length, prims,
    materials: (json.materials || []).length, textures,
    size: min[0] === Infinity ? null : max.map((v, a) => v - min[a]),
    generator: json.asset?.generator || null,
  };
}

export const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB');
export const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
