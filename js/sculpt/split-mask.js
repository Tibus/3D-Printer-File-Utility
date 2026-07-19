// Split par MASQUE : sépare l'objet en deux le long de la frontière du masque (iso mask =
// seuil), comme le lasso mais piloté par la zone peinte. Les triangles à cheval sont
// coupés à l'endroit exact où le masque franchit le seuil (interpolation des attributs).
// Les deux pièces (masquée / non masquée) sont ensuite bouchées (fillHoles) -> fermées.

import * as THREE from 'three';
import { fillLoopsCDT } from './cap-loop.js';

const ATTRS = ['position', 'normal', 'uv', 'color'];
const DIM = { position: 3, normal: 3, uv: 2, color: 3 };

class Part {
  constructor(src, attrs, V, rep) { this.src = src; this.attrs = attrs; this.V = V; this.rep = rep; this.out = {}; for (const a of attrs) this.out[a] = []; this.idx = []; this.vmap = new Map(); this.emap = new Map(); this.n = 0; }
  orig(i) {
    let m = this.vmap.get(i); if (m !== undefined) return m;
    m = this.n++; for (const a of this.attrs) { const d = DIM[a], s = this.src[a]; for (let c = 0; c < d; c++) this.out[a].push(s[i * d + c]); }
    this.vmap.set(i, m); return m;
  }
  cross(i, j, t) {
    // clé par arête CANONIQUE (positions) : là où la coupe croise une couture, les copies
    // coïncidentes doivent partager le MÊME sommet de croisement, sinon la coupe a une fente.
    const ri = this.rep[i], rj = this.rep[j];
    const key = ri < rj ? ri * this.V + rj : rj * this.V + ri;
    let m = this.emap.get(key); if (m !== undefined) return m;
    m = this.n++; for (const a of this.attrs) { const d = DIM[a], s = this.src[a]; for (let c = 0; c < d; c++) this.out[a].push(s[i * d + c] + (s[j * d + c] - s[i * d + c]) * t); }
    this.emap.set(key, m); return m;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  geometry() {
    const g = new THREE.BufferGeometry();
    for (const a of this.attrs) g.setAttribute(a, new THREE.Float32BufferAttribute(this.out[a], DIM[a]));
    g.setIndex(this.idx);
    return g;
  }
}

// Retire les composantes connexes dont le nb de triangles < frac × la plus grosse.
// Élimine les mini-blobs parasites (sommets masqués isolés / mouchetures du masque) qui
// deviendraient de « petits objets invisibles » après bouchage. Préserve tous les attributs.
function keepLargeComponents(geo, frac) {
  const idx = geo.index.array, V = geo.attributes.position.count, nTri = idx.length / 3;
  const pos = geo.attributes.position.array, q = 1e5;
  // Connectivité CONSCIENTE DES POSITIONS : les coutures (sommets dupliqués) ne doivent PAS
  // fragmenter le maillage, sinon on supprime des morceaux légitimes du corps -> trous.
  const posMap = new Map(); const rep = new Int32Array(V);
  for (let v = 0; v < V; v++) { const pk = Math.round(pos[v * 3] * q) + '_' + Math.round(pos[v * 3 + 1] * q) + '_' + Math.round(pos[v * 3 + 2] * q); let r = posMap.get(pk); if (r === undefined) { r = v; posMap.set(pk, r); } rep[v] = r; }
  const parent = new Uint32Array(V); for (let i = 0; i < V; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  for (let v = 0; v < V; v++) if (rep[v] !== v) uni(v, rep[v]); // fusionne les sommets coïncidents
  for (let t = 0; t < nTri; t++) { uni(idx[t * 3], idx[t * 3 + 1]); uni(idx[t * 3 + 1], idx[t * 3 + 2]); }
  const cnt = new Map(); for (let t = 0; t < nTri; t++) { const r = find(idx[t * 3]); cnt.set(r, (cnt.get(r) || 0) + 1); }
  if (cnt.size <= 1) return geo;
  let maxC = 0; for (const c of cnt.values()) if (c > maxC) maxC = c;
  const minKeep = Math.max(4, maxC * frac);
  const attrs = ATTRS.filter((a) => geo.attributes[a]);
  const src = {}; for (const a of attrs) src[a] = geo.attributes[a].array;
  const remap = new Map(); const out = {}; for (const a of attrs) out[a] = []; const outIdx = []; let kept = 0;
  for (let t = 0; t < nTri; t++) {
    if (cnt.get(find(idx[t * 3])) < minKeep) continue;
    kept++;
    for (let k = 0; k < 3; k++) { const v = idx[t * 3 + k]; let nv = remap.get(v); if (nv === undefined) { nv = remap.size; remap.set(v, nv); for (const a of attrs) { const d = DIM[a], s = src[a]; for (let c = 0; c < d; c++) out[a].push(s[v * d + c]); } } outIdx.push(nv); }
  }
  if (kept === nTri) return geo;
  const ng = new THREE.BufferGeometry();
  for (const a of attrs) ng.setAttribute(a, new THREE.Float32BufferAttribute(out[a], DIM[a]));
  ng.setIndex(outIdx);
  return ng;
}

// Retourne { inside, outside } (géométries fermées : masqué / non masqué) ou null si rien
// à séparer (masque vide ou total).
export function splitByMask(geometry, mask, threshold = 0.5, detail = 10) {
  if (!geometry.index || !mask) return null;
  const idx = geometry.index.array, V = geometry.attributes.position.count;
  const attrs = ATTRS.filter((a) => geometry.attributes[a]);
  const src = {}; for (const a of attrs) src[a] = geometry.attributes[a].array;
  // rep par position : les sommets coïncidents (coutures) partagent un canonique -> la coupe
  // reste continue quand elle croise une couture (sinon fentes dans la découpe).
  const pos = src.position, q = 1e5, posMap = new Map(), rep = new Int32Array(V);
  for (let v = 0; v < V; v++) { const pk = Math.round(pos[v * 3] * q) + '_' + Math.round(pos[v * 3 + 1] * q) + '_' + Math.round(pos[v * 3 + 2] * q); let r = posMap.get(pk); if (r === undefined) { r = v; posMap.set(pk, r); } rep[v] = r; }
  const A = new Part(src, attrs, V, rep), B = new Part(src, attrs, V, rep); // A = masqué, B = non masqué
  const inside = (v) => mask[v] >= threshold;
  const tcross = (p, o) => { const d = mask[o] - mask[p]; let t = Math.abs(d) < 1e-9 ? 0.5 : (threshold - mask[p]) / d; return t < 0 ? 0 : t > 1 ? 1 : t; };

  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f], b = idx[f + 1], c = idx[f + 2];
    const cnt = (inside(a) ? 1 : 0) + (inside(b) ? 1 : 0) + (inside(c) ? 1 : 0);
    if (cnt === 3) { A.tri(A.orig(a), A.orig(b), A.orig(c)); continue; }
    if (cnt === 0) { B.tri(B.orig(a), B.orig(b), B.orig(c)); continue; }
    // le sommet isolé (p) est du côté opposé aux deux autres
    let p, q, r;
    if (inside(a) !== inside(b) && inside(a) !== inside(c)) { p = a; q = b; r = c; }
    else if (inside(b) !== inside(a) && inside(b) !== inside(c)) { p = b; q = c; r = a; }
    else { p = c; q = a; r = b; }
    const tpq = tcross(p, q), tpr = tcross(p, r);
    const apex = inside(p) ? A : B, other = inside(p) ? B : A;
    apex.tri(apex.orig(p), apex.cross(p, q, tpq), apex.cross(p, r, tpr));
    const oq = other.cross(p, q, tpq), orr = other.cross(p, r, tpr);
    other.tri(oq, other.orig(q), other.orig(r));
    other.tri(oq, other.orig(r), orr);
  }
  if (A.idx.length === 0 || B.idx.length === 0) return null; // rien à séparer

  // nettoie les mini-composantes parasites PUIS bouche les caps (CDT/éventail), normales
  // recalculées. Le nettoyage évite les « petits objets invisibles » dus au flou du masque.
  const cap = (part) => fillLoopsCDT(keepLargeComponents(part.geometry(), 0.02), detail);
  return { inside: cap(A), outside: cap(B) };
}
