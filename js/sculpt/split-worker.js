// Worker de split. Trois messages :
//  - 'classify' : projette + classe une PLAGE de vertices dans des tableaux
//    partagés (SharedArrayBuffer) — parallélisable sur N workers.
//  - 'patches'  : construit les patches (inside/outside) pour une PLAGE de
//    triangles à partir des tableaux partagés -> partiel {A,B}.
//  - 'full'     : fallback sans SAB (un seul worker) : classe tout + patches.
// Le mailleur du cap (Delaunay + CDT) tourne aussi ici via 'retopo' pour ne pas
// geler l'UI. JS pur : aucune dépendance THREE.

import { retopoMesh } from './cap-mesher.js';

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Projette + classe les vertices [start,end) via la matrice M (local->NDC).
function classifyRange(posArr, M, lasso, vw, vh, inside, sx, sy, start, end) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of lasso) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  for (let i = start; i < end; i++) {
    const x = posArr[i * 3], y = posArr[i * 3 + 1], z = posArr[i * 3 + 2];
    const w = M[3] * x + M[7] * y + M[11] * z + M[15];
    const ndcx = (M[0] * x + M[4] * y + M[8] * z + M[12]) / w;
    const ndcy = (M[1] * x + M[5] * y + M[9] * z + M[13]) / w;
    const px = (ndcx * 0.5 + 0.5) * vw, py = (-ndcy * 0.5 + 0.5) * vh;
    sx[i] = px; sy[i] = py;
    inside[i] = (px >= minX && px <= maxX && py >= minY && py <= maxY && pointInPolygon(px, py, lasso)) ? 1 : 0;
  }
}

// Accumulateur de patch sur tableaux bruts.
class PartBuilder {
  constructor(pos, nor, uv, col, vCount) {
    this.p = pos; this.n = nor; this.u = uv; this.c = col; this.vCount = vCount;
    this.pos = []; this.nor = nor ? [] : null; this.uv = uv ? [] : null; this.col = col ? [] : null;
    this.idx = [];
    this.vmap = new Map(); this.emap = new Map(); this.count = 0;
  }
  orig(i) {
    const m = this.vmap.get(i);
    if (m !== undefined) return m;
    const ni = this.count++;
    this.pos.push(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]);
    if (this.nor) this.nor.push(this.n[i * 3], this.n[i * 3 + 1], this.n[i * 3 + 2]);
    if (this.uv) this.uv.push(this.u[i * 2], this.u[i * 2 + 1]);
    if (this.col) this.col.push(this.c[i * 3], this.c[i * 3 + 1], this.c[i * 3 + 2]);
    this.vmap.set(i, ni);
    return ni;
  }
  cross(i, j, t) {
    const key = i < j ? i * this.vCount + j : j * this.vCount + i;
    const m = this.emap.get(key);
    if (m !== undefined) return m;
    const ni = this.count++;
    const L = (a, s) => a[i * s] + (a[j * s] - a[i * s]) * t;
    const L2 = (a, s, o) => a[i * s + o] + (a[j * s + o] - a[i * s + o]) * t;
    this.pos.push(L(this.p, 3), L2(this.p, 3, 1), L2(this.p, 3, 2));
    if (this.nor) this.nor.push(L(this.n, 3), L2(this.n, 3, 1), L2(this.n, 3, 2));
    if (this.uv) this.uv.push(L(this.u, 2), L2(this.u, 2, 1));
    if (this.col) this.col.push(L(this.c, 3), L2(this.c, 3, 1), L2(this.c, 3, 2));
    this.emap.set(key, ni);
    return ni;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  result() {
    if (this.idx.length === 0) return { position: new Float32Array(0), normal: this.nor ? new Float32Array(0) : null, uv: this.uv ? new Float32Array(0) : null, color: this.col ? new Float32Array(0) : null, index: new Uint32Array(0) };
    return {
      position: new Float32Array(this.pos),
      normal: this.nor ? new Float32Array(this.nor) : null,
      uv: this.uv ? new Float32Array(this.uv) : null,
      color: this.col ? new Float32Array(this.col) : null,
      index: new Uint32Array(this.idx),
    };
  }
}

// Construit les patches pour les triangles [start,end). Collecte aussi les
// ARÊTES DE COUPE (une par triangle chevauchant) : clé d'arête maillage + position
// des 2 points de croisement -> permet de reconstruire les boucles frontière
// exactes côté main pour des parois étanches (mêmes sommets que la surface).
function buildPatches(pos, nor, uv, col, idx, inside, sx, sy, lasso, vCount, start, end) {
  const A = new PartBuilder(pos, nor, uv, col, vCount);
  const B = new PartBuilder(pos, nor, uv, col, vCount);
  const cutKA = [], cutKB = [], cutPos = [];
  const ekey = (i, j) => (i < j ? i * vCount + j : j * vCount + i);
  const cpos = (i, j, t, o) => pos[i * 3 + o] + (pos[j * 3 + o] - pos[i * 3 + o]) * t;
  const crossT = (i, j) => {
    let lo = 0, hi = 1; const ii = inside[i];
    for (let k = 0; k < 18; k++) {
      const mid = (lo + hi) * 0.5;
      const mx = sx[i] + (sx[j] - sx[i]) * mid, my = sy[i] + (sy[j] - sy[i]) * mid;
      if ((pointInPolygon(mx, my, lasso) ? 1 : 0) === ii) lo = mid; else hi = mid;
    }
    return (lo + hi) * 0.5;
  };
  for (let f = start; f < end; f += 3) {
    const a = idx[f], b = idx[f + 1], c = idx[f + 2];
    const cnt = inside[a] + inside[b] + inside[c];
    if (cnt === 3) { A.tri(A.orig(a), A.orig(b), A.orig(c)); }
    else if (cnt === 0) { B.tri(B.orig(a), B.orig(b), B.orig(c)); }
    else {
      let p, q, r;
      if (inside[a] !== inside[b] && inside[a] !== inside[c]) { p = a; q = b; r = c; }
      else if (inside[b] !== inside[a] && inside[b] !== inside[c]) { p = b; q = c; r = a; }
      else { p = c; q = a; r = b; }
      const tPQ = crossT(p, q), tPR = crossT(p, r);
      const apex = inside[p] ? A : B, other = inside[p] ? B : A;
      apex.tri(apex.orig(p), apex.cross(p, q, tPQ), apex.cross(p, r, tPR));
      const oPQ = other.cross(p, q, tPQ), oPR = other.cross(p, r, tPR);
      other.tri(oPQ, other.orig(q), other.orig(r));
      other.tri(oPQ, other.orig(r), oPR);
      cutKA.push(ekey(p, q)); cutKB.push(ekey(p, r));
      cutPos.push(cpos(p, q, tPQ, 0), cpos(p, q, tPQ, 1), cpos(p, q, tPQ, 2),
        cpos(p, r, tPR, 0), cpos(p, r, tPR, 1), cpos(p, r, tPR, 2));
    }
  }
  return {
    A: A.result(), B: B.result(),
    cutKA: new Float64Array(cutKA), cutKB: new Float64Array(cutKB), cutPos: new Float32Array(cutPos),
  };
}

function transferables(part) {
  const t = [];
  for (const k of ['position', 'normal', 'uv', 'color', 'index']) if (part[k]) t.push(part[k].buffer);
  return t;
}

self.onmessage = (e) => {
  const d = e.data;
  try {
    if (d.type === 'retopo') {
      const loops = []; let off = 0;
      for (const len of d.loopLens) { loops.push(Array.from(d.loopsFlat.subarray(off, off + len))); off += len; }
      const lasso = []; for (let i = 0; i < d.lassoXY.length; i += 2) lasso.push({ x: d.lassoXY[i], y: d.lassoXY[i + 1] });
      const r = retopoMesh({ pos: d.pos, S: d.S, D: d.D, loops, L: d.L, lasso, U: d.U, camPos: d.camPos, camFwd: d.camFwd, vw: d.vw, vh: d.vh, detail: d.detail });
      if (r) self.postMessage({ type: 'retopoDone', position: r.position, index: r.index, failed: r.failed, repaired: r.repaired, capStats: r.capStats }, [r.position.buffer, r.index.buffer]);
      else self.postMessage({ type: 'retopoDone', position: null });
      return;
    }
    if (d.type === 'classify') {
      const pos = new Float32Array(d.posSAB);
      const inside = new Uint8Array(d.insideSAB);
      const sx = new Float32Array(d.sxSAB);
      const sy = new Float32Array(d.sySAB);
      classifyRange(pos, d.M, d.lasso, d.vw, d.vh, inside, sx, sy, d.start, d.end);
      self.postMessage({ type: 'classifyDone' });
      return;
    }
    if (d.type === 'patches') {
      const pos = new Float32Array(d.posSAB);
      const nor = d.norSAB ? new Float32Array(d.norSAB) : null;
      const uv = d.uvSAB ? new Float32Array(d.uvSAB) : null;
      const col = d.colSAB ? new Float32Array(d.colSAB) : null;
      const idx = d.idx32 ? new Uint32Array(d.idxSAB) : new Uint16Array(d.idxSAB);
      const inside = new Uint8Array(d.insideSAB);
      const sx = new Float32Array(d.sxSAB);
      const sy = new Float32Array(d.sySAB);
      const { A, B, cutKA, cutKB, cutPos } = buildPatches(pos, nor, uv, col, idx, inside, sx, sy, d.lasso, d.vCount, d.start, d.end);
      self.postMessage({ type: 'patchesDone', A, B, cutKA, cutKB, cutPos },
        [...transferables(A), ...transferables(B), cutKA.buffer, cutKB.buffer, cutPos.buffer]);
      return;
    }
    if (d.type === 'full') {
      const vCount = d.position.length / 3;
      const inside = new Uint8Array(vCount);
      const sx = new Float32Array(vCount), sy = new Float32Array(vCount);
      classifyRange(d.position, d.M, d.lasso, d.vw, d.vh, inside, sx, sy, 0, vCount);
      const { A, B, cutKA, cutKB, cutPos } = buildPatches(d.position, d.normal, d.uv, d.color, d.index, inside, sx, sy, d.lasso, vCount, 0, d.index.length);
      self.postMessage({ type: 'patchesDone', A, B, cutKA, cutKB, cutPos },
        [...transferables(A), ...transferables(B), cutKA.buffer, cutKB.buffer, cutPos.buffer]);
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
