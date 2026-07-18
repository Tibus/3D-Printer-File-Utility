// Décimation (low-poly) par QEM edge-collapse via meshoptimizer (WASM). C'est le cœur
// reproductible de méthodes type TriFlow : QEM garde la fidélité géométrique et un nombre
// de triangles cible. (Le "flow" artiste de TriFlow vient d'un réseau de neurones non
// publié — hors navigateur ; on garde donc la partie QEM.) Préserve position + uv + color
// des sommets survivants ; normales recalculées.

import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';

const ATTRS = ['position', 'uv', 'color'];
const DIM = { position: 3, uv: 2, color: 3 };

// Compacte : ne garde que les sommets référencés, remappe l'index.
function compact(g) {
  const attrs = ATTRS.filter((a) => g.attributes[a]);
  const idx = g.index.array;
  const src = {}; for (const a of attrs) src[a] = g.attributes[a].array;
  const remap = new Map(); const out = {}; for (const a of attrs) out[a] = [];
  const nidx = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i]; let nv = remap.get(v);
    if (nv === undefined) { nv = remap.size; remap.set(v, nv); for (const a of attrs) { const d = DIM[a], s = src[a]; for (let c = 0; c < d; c++) out[a].push(s[v * d + c]); } }
    nidx[i] = nv;
  }
  const ng = new THREE.BufferGeometry();
  for (const a of attrs) ng.setAttribute(a, new THREE.Float32BufferAttribute(out[a], DIM[a]));
  ng.setIndex(new THREE.BufferAttribute(nidx, 1));
  return ng;
}

// ratio : fraction de triangles à GARDER (0.1 = 10%). Retourne { geometry, tris, error }.
export async function decimateMesh(geometry, ratio) {
  await MeshoptSimplifier.ready;
  let g = geometry.clone(); g.deleteAttribute('normal');
  if (!g.index) { const n = g.attributes.position.count; const ix = new Uint32Array(n); for (let i = 0; i < n; i++) ix[i] = i; g.setIndex(new THREE.BufferAttribute(ix, 1)); }
  g = mergeVertices(g, 1e-5); // soude pour permettre les collapses

  const index = g.index.array instanceof Uint32Array ? g.index.array : new Uint32Array(g.index.array);
  const pos = g.attributes.position.array instanceof Float32Array ? g.attributes.position.array : new Float32Array(g.attributes.position.array);
  const triCount = index.length / 3;
  const targetIndexCount = Math.max(1, Math.floor(triCount * ratio)) * 3;
  if (targetIndexCount >= index.length) return { geometry: g, tris: triCount, error: 0 }; // rien à faire

  // targetError élevé -> atteint le ratio demandé ; LockBorder préserve les bords ouverts.
  const [simplified, error] = MeshoptSimplifier.simplify(index, pos, 3, targetIndexCount, 1.0, ['LockBorder']);
  g.setIndex(new THREE.BufferAttribute(simplified, 1));
  const out = compact(g);
  out.computeVertexNormals();
  return { geometry: out, tris: simplified.length / 3, error };
}
