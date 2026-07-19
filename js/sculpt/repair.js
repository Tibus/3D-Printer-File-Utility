// Réparation "douce" d'un maillage (garde la topologie, contrairement au voxel remesh) :
//   1. Soudure des sommets coïncidents (répare la triangle-soup des STL).
//   2. Suppression des îlots flottants (petites composantes connexes détachées).
//   3. Bouchage des trous (boucles de bord -> éventail vers le centroïde).
// Conserve position + uv + color. Normales recalculées à la fin.

import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { fillLoopsCDT } from './cap-loop.js';
import { getManifold } from './split-manifold.js';
import { geomFromManifoldMesh, reprojectAttrs } from './remesh.js';

const ATTRS = ['position', 'uv', 'color'];
const DIM = { position: 3, uv: 2, color: 3 };

function attrsOf(g) { return ATTRS.filter((a) => g.attributes[a]); }

// Reconstruit une géométrie à partir d'une liste de triangles (indices), sommets remappés.
function rebuild(g, triList, attrs) {
  const idx = g.index.array;
  const src = {}; for (const a of attrs) src[a] = g.attributes[a].array;
  const remap = new Map(); const out = {}; for (const a of attrs) out[a] = [];
  const outIdx = [];
  for (const t of triList) {
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      let nv = remap.get(v);
      if (nv === undefined) { nv = remap.size; remap.set(v, nv); for (const a of attrs) { const d = DIM[a], s = src[a]; for (let c = 0; c < d; c++) out[a].push(s[v * d + c]); } }
      outIdx.push(nv);
    }
  }
  const ng = new THREE.BufferGeometry();
  for (const a of attrs) ng.setAttribute(a, new THREE.Float32BufferAttribute(out[a], DIM[a]));
  ng.setIndex(outIdx);
  return ng;
}

// Supprime les composantes connexes dont le nb de triangles < frac × la plus grosse.
// CONSCIENT DES POSITIONS : les coutures (sommets dupliqués) ne fragmentent pas le maillage,
// sinon on supprime des morceaux légitimes -> trous.
function removeSmallIslands(g, frac) {
  const idx = g.index.array, V = g.attributes.position.count, nTri = idx.length / 3;
  const pos = g.attributes.position.array, q = 1e5;
  const posMap = new Map(); const rep = new Int32Array(V);
  for (let v = 0; v < V; v++) { const pk = Math.round(pos[v * 3] * q) + '_' + Math.round(pos[v * 3 + 1] * q) + '_' + Math.round(pos[v * 3 + 2] * q); let r = posMap.get(pk); if (r === undefined) { r = v; posMap.set(pk, r); } rep[v] = r; }
  const parent = new Uint32Array(V); for (let i = 0; i < V; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  for (let v = 0; v < V; v++) if (rep[v] !== v) union(v, rep[v]); // fusionne les sommets coïncidents
  for (let t = 0; t < nTri; t++) { union(idx[t * 3], idx[t * 3 + 1]); union(idx[t * 3 + 1], idx[t * 3 + 2]); }
  const triCount = new Map();
  for (let t = 0; t < nTri; t++) { const r = find(idx[t * 3]); triCount.set(r, (triCount.get(r) || 0) + 1); }
  let maxC = 0; for (const c of triCount.values()) if (c > maxC) maxC = c;
  const minKeep = Math.max(1, maxC * frac);
  const keep = []; const keptRoots = new Set();
  for (let t = 0; t < nTri; t++) { const r = find(idx[t * 3]); if (triCount.get(r) >= minKeep) { keep.push(t); keptRoots.add(r); } }
  const removed = triCount.size - keptRoots.size;
  if (keep.length === nTri) return { geom: g, removed: 0 };
  return { geom: rebuild(g, keep, attrsOf(g)), removed };
}

// Bouche les trous : boucles de bord (arêtes utilisées 1×) -> éventail vers le centroïde.
export function fillHoles(g) {
  const idx = g.index.array, nTri = idx.length / 3;
  const attrs = attrsOf(g);
  const src = {}; for (const a of attrs) src[a] = g.attributes[a].array;
  // arêtes dirigées ; bord = arête non-dirigée vue une seule fois
  const key = (a, b) => (a < b ? a * 1e7 + b : b * 1e7 + a);
  const useCount = new Map();
  for (let t = 0; t < nTri; t++) { const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2]; for (const [x, y] of [[a, b], [b, c], [c, a]]) useCount.set(key(x, y), (useCount.get(key(x, y)) || 0) + 1); }
  // arêtes de bord dirigées (a->b telles qu'elles apparaissent dans leur triangle)
  const nextOf = new Map(); // a -> [b...]
  for (let t = 0; t < nTri; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    for (const [x, y] of [[a, b], [b, c], [c, a]]) if (useCount.get(key(x, y)) === 1) { let l = nextOf.get(x); if (!l) { l = []; nextOf.set(x, l); } l.push(y); }
  }
  if (nextOf.size === 0) return { geom: g, holes: 0 };

  const pos = src.position;
  const outPos = Array.from(pos);
  const out = {}; for (const a of attrs) out[a] = a === 'position' ? outPos : Array.from(src[a]);
  const newIdx = Array.from(idx);
  let V = g.attributes.position.count;
  const dim = (a) => DIM[a];

  const visited = new Set();
  let holes = 0;
  for (const [start] of nextOf) {
    if (visited.has(start)) continue;
    // trace la boucle
    const loop = []; let cur = start, guard = 0;
    while (cur !== undefined && !visited.has(cur) && guard++ < 100000) {
      visited.add(cur); loop.push(cur);
      const l = nextOf.get(cur); cur = l && l.length ? l[0] : undefined;
    }
    if (loop.length < 3) continue;
    holes++;
    // centroïde (moyenne des attributs de la boucle)
    const cv = V++;
    for (const a of attrs) { const d = dim(a); for (let c = 0; c < d; c++) { let s = 0; for (const v of loop) s += out[a][v * d + c]; out[a].push(s / loop.length); } }
    // éventail : pour chaque arête (loop[i] -> loop[i+1]) ajoute (b, a, centre) -> normale cohérente
    for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; newIdx.push(b, a, cv); }
  }
  if (holes === 0) return { geom: g, holes: 0 };
  const ng = new THREE.BufferGeometry();
  for (const a of attrs) ng.setAttribute(a, new THREE.Float32BufferAttribute(out[a], DIM[a]));
  ng.setIndex(newIdx);
  return { geom: ng, holes };
}

// Réparation "douce" LEGACY (weld + îlots + bouchage CDT). Repli quand Manifold ne peut
// pas traiter le maillage (ouvert / non-manifold). Peut altérer un maillage déjà propre :
// à n'utiliser QUE si Manifold échoue.
function repairMeshLegacy(geometry, { islandFrac = 0.01, weldTol = 1e-4, detail = 10 } = {}) {
  const before = geometry.attributes.position.count;
  let g = geometry.clone(); g.deleteAttribute('normal');
  if (!g.index) { const n = g.attributes.position.count; const ix = new Uint32Array(n); for (let i = 0; i < n; i++) ix[i] = i; g.setIndex(new THREE.BufferAttribute(ix, 1)); }
  g = mergeVertices(g, weldTol);
  const welded = before - g.attributes.position.count;
  const isl = removeSmallIslands(g, islandFrac); g = isl.geom;
  g = fillLoopsCDT(g, detail); // bouche les trous par CDT + grille interne (sculptable)
  g.computeVertexNormals();
  return { geometry: g, stats: { method: 'legacy', welded, removedIslands: isl.removed, filledHoles: g.userData._filledHoles || 0, verts: g.attributes.position.count } };
}

// Réparation via MANIFOLD : construit un solide 2-manifold propre (soude les sommets,
// répare l'orientation et les arêtes non-manifold) SANS abîmer un maillage déjà correct,
// contrairement à la version legacy. UV/couleur réprojetés depuis l'original (Manifold ne
// travaille que la position). Si Manifold ne peut pas (maillage ouvert / non réparable),
// on retombe sur la réparation legacy (qui, elle, sait boucher les trous).
export async function repairMesh(geometry, opts = {}) {
  const before = geometry.attributes.position.count;
  // source indexée + BVH (pour réprojeter UV/couleur ensuite)
  const src = geometry.clone(); src.deleteAttribute('normal');
  if (!src.index) { const n = src.attributes.position.count; const ix = new Uint32Array(n); for (let i = 0; i < n; i++) ix[i] = i; src.setIndex(new THREE.BufferAttribute(ix, 1)); }
  try {
    const { Manifold, Mesh } = await getManifold();
    const pos = src.attributes.position.array, idx = src.index.array;
    const mm = new Mesh({
      numProp: 3,
      vertProperties: pos instanceof Float32Array ? pos.slice() : Float32Array.from(pos),
      triVerts: idx instanceof Uint32Array ? idx.slice() : new Uint32Array(idx),
    });
    mm.merge(); // soude les sommets coïncidents (rend le maillage manifold-ready)
    const man = new Manifold(mm);
    if (man.numTri() === 0) { man.delete(); throw new Error('non-manifold'); } // -> legacy
    const genus = man.genus();
    const outMesh = man.getMesh();
    man.delete();
    const g = geomFromManifoldMesh(outMesh); // position + normales recalculées
    if (!src.boundsTree) src.computeBoundsTree({ setBoundingBox: true });
    reprojectAttrs(g, src); // restaure UV/couleur depuis l'original
    return { geometry: g, stats: { method: 'manifold', welded: Math.max(0, before - g.attributes.position.count), verts: g.attributes.position.count, genus } };
  } catch (e) {
    console.warn('[repair] Manifold impossible -> legacy', e && e.message);
    return repairMeshLegacy(geometry, opts);
  }
}
