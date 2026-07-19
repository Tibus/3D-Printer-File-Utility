// Split par MASQUE : sépare l'objet en deux le long de la frontière du masque (iso mask =
// seuil), comme le lasso mais piloté par la zone peinte. Les triangles à cheval sont
// coupés à l'endroit exact où le masque franchit le seuil (interpolation des attributs).
// Les deux pièces (masquée / non masquée) sont ensuite bouchées (fillHoles) -> fermées.

import * as THREE from 'three';
import { fillLoopsCDT } from './cap-loop.js';

const ATTRS = ['position', 'normal', 'uv', 'color'];
const DIM = { position: 3, normal: 3, uv: 2, color: 3 };

class Part {
  constructor(src, attrs, V) { this.src = src; this.attrs = attrs; this.V = V; this.out = {}; for (const a of attrs) this.out[a] = []; this.idx = []; this.vmap = new Map(); this.emap = new Map(); this.n = 0; }
  orig(i) {
    let m = this.vmap.get(i); if (m !== undefined) return m;
    m = this.n++; for (const a of this.attrs) { const d = DIM[a], s = this.src[a]; for (let c = 0; c < d; c++) this.out[a].push(s[i * d + c]); }
    this.vmap.set(i, m); return m;
  }
  cross(i, j, t) {
    const key = i < j ? i * this.V + j : j * this.V + i;
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

// Retourne { inside, outside } (géométries fermées : masqué / non masqué) ou null si rien
// à séparer (masque vide ou total).
export function splitByMask(geometry, mask, threshold = 0.5, detail = 10) {
  if (!geometry.index || !mask) return null;
  const idx = geometry.index.array, V = geometry.attributes.position.count;
  const attrs = ATTRS.filter((a) => geometry.attributes[a]);
  const src = {}; for (const a of attrs) src[a] = geometry.attributes[a].array;
  const A = new Part(src, attrs, V), B = new Part(src, attrs, V); // A = masqué, B = non masqué
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

  // bouche les caps par CDT + grille interne (sculptable), normales recalculées
  const cap = (part) => fillLoopsCDT(part.geometry(), detail);
  return { inside: cap(A), outside: cap(B) };
}
