// Découpe LOCALISÉE : le booléen ne traite que les triangles proches du lasso (à
// l'écran), et le reste du maillage est recollé par simple copie. Énorme gain sur les
// gros maillages : le coût du booléen (construction + extraction) est proportionnel à
// la petite zone coupée, pas à tout l'objet.
//
// Principe : les triangles "loin" (bbox écran ne chevauchant pas le lasso) sont
// forcément HORS du prisme -> ils vont tous dans la pièce "outside", inchangés. Seuls
// les triangles "proches" passent par le booléen (three-bvh-csg, qui tolère un patch
// ouvert). Leurs arêtes au bord proche/loin sont hors prisme -> inchangées -> se
// recollent exactement (sommets coïncidents) avec la partie "loin".

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lassoSplitCSG } from './split-csg.js';

const ATTRS = ['position', 'normal', 'uv', 'color'];
const DIM = { position: 3, normal: 3, uv: 2, color: 3 };

function presentAttrs(geometry) { return ATTRS.filter((a) => geometry.attributes[a]); }

// Sous-géométrie indexée à partir d'une liste d'indices de triangles (sommets remappés).
function subGeometryIndexed(geometry, triList, attrs) {
  const idx = geometry.index.array;
  const src = {}; for (const a of attrs) src[a] = geometry.attributes[a].array;
  const remap = new Map();
  const out = {}; for (const a of attrs) out[a] = [];
  const outIdx = [];
  for (let ti = 0; ti < triList.length; ti++) {
    const t = triList[ti] * 3;
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k];
      let nv = remap.get(v);
      if (nv === undefined) {
        nv = remap.size; remap.set(v, nv);
        for (const a of attrs) { const d = DIM[a], s = src[a]; for (let c = 0; c < d; c++) out[a].push(s[v * d + c]); }
      }
      outIdx.push(nv);
    }
  }
  const g = new THREE.BufferGeometry();
  for (const a of attrs) g.setAttribute(a, new THREE.Float32BufferAttribute(out[a], DIM[a]));
  g.setIndex(outIdx);
  return g;
}

// Sous-géométrie NON indexée (triangles dépliés) — pour concaténer avec la sortie CSG.
function subGeometryExpanded(geometry, triList, attrs) {
  const idx = geometry.index.array;
  const src = {}; for (const a of attrs) src[a] = geometry.attributes[a].array;
  const n = triList.length * 3;
  const out = {}; for (const a of attrs) out[a] = new Float32Array(n * DIM[a]);
  let o = 0;
  for (let ti = 0; ti < triList.length; ti++) {
    const t = triList[ti] * 3;
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k];
      for (const a of attrs) { const d = DIM[a], s = src[a]; for (let c = 0; c < d; c++) out[a][o * d + c] = s[v * d + c]; }
      o++;
    }
  }
  const g = new THREE.BufferGeometry();
  for (const a of attrs) g.setAttribute(a, new THREE.BufferAttribute(out[a], DIM[a]));
  return g;
}

// Découpe localisée. `engineFn(nearGeom, lassoPx, camera, matrixWorld, vw, vh, detail)`
// doit renvoyer { inside, outside } (booléen). Retourne { inside, outside, capMode } ou
// null (rien séparé) ou { fallback:true } si la localisation ne s'applique pas.
export function lassoSplitLocalized(geometry, lassoPx, camera, matrixWorld, vw, vh, detail, engineFn = lassoSplitCSG) {
  if (lassoPx.length < 3 || !geometry.index) return { fallback: true };
  const attrs = presentAttrs(geometry);
  if (!geometry.attributes.normal) attrs.push('normal'); // three-bvh-csg sort des normales

  // projection écran de tous les sommets
  camera.updateMatrixWorld();
  const M = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(matrixWorld);
  const e = M.elements;
  const pos = geometry.attributes.position.array, V = geometry.attributes.position.count;
  const sx = new Float32Array(V), sy = new Float32Array(V);
  for (let i = 0; i < V; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const w = e[3] * x + e[7] * y + e[11] * z + e[15] || 1e-6;
    sx[i] = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 + 0.5) * vw;
    sy[i] = (-(e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5 + 0.5) * vh;
  }
  // bbox lasso + marge
  let lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity;
  for (const p of lassoPx) { if (p.x < lx0) lx0 = p.x; if (p.x > lx1) lx1 = p.x; if (p.y < ly0) ly0 = p.y; if (p.y > ly1) ly1 = p.y; }
  const mg = Math.max(4, (lx1 - lx0 + ly1 - ly0) * 0.02);
  lx0 -= mg; ly0 -= mg; lx1 += mg; ly1 += mg;

  // partition triangles (bbox écran du triangle vs bbox lasso)
  const idx = geometry.index.array, nTri = idx.length / 3;
  const near = [], far = [];
  for (let t = 0; t < nTri; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const tx0 = Math.min(sx[a], sx[b], sx[c]), tx1 = Math.max(sx[a], sx[b], sx[c]);
    const ty0 = Math.min(sy[a], sy[b], sy[c]), ty1 = Math.max(sy[a], sy[b], sy[c]);
    if (tx1 < lx0 || tx0 > lx1 || ty1 < ly0 || ty0 > ly1) far.push(t); else near.push(t);
  }
  // pas de gain si presque tout est proche
  if (near.length > nTri * 0.6 || far.length === 0) return { fallback: true };

  const nearGeom = subGeometryIndexed(geometry, near, attrs);
  const res = engineFn(nearGeom, lassoPx, camera, matrixWorld, vw, vh, detail);
  if (!res || res.fallback) return res || null;

  // recolle la partie "loin" à la pièce "outside" (copie, pas de booléen)
  const farGeom = subGeometryExpanded(geometry, far, attrs);
  const outside = mergeGeometries([res.outside, farGeom], false) || res.outside;
  return { inside: res.inside, outside, capMode: 'local' };
}
