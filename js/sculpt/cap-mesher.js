// Mailleur du cap de découpe — JS PUR (aucune dépendance THREE), pour tourner
// dans un web worker sans geler l'UI. Delaunay + Delaunay contraint (CDT) +
// grille intérieure uniforme, filtré pair-impair. Bord = croisements exacts.

// Triangulation de Delaunay (Bowyer-Watson) -> triangles (indices, flat).
export function delaunay(px, py, n) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < n; i++) { if (px[i] < minx) minx = px[i]; if (px[i] > maxx) maxx = px[i]; if (py[i] < miny) miny = py[i]; if (py[i] > maxy) maxy = py[i]; }
  const dx = maxx - minx || 1, dy = maxy - miny || 1, dmax = Math.max(dx, dy);
  const midx = (minx + maxx) / 2, midy = (miny + maxy) / 2;
  const SX = new Float64Array(n + 3), SY = new Float64Array(n + 3);
  for (let i = 0; i < n; i++) { SX[i] = px[i]; SY[i] = py[i]; }
  SX[n] = midx - 20 * dmax; SY[n] = midy - dmax;
  SX[n + 1] = midx; SY[n + 1] = midy + 20 * dmax;
  SX[n + 2] = midx + 20 * dmax; SY[n + 2] = midy - dmax;
  const circum = (a, b, c) => {
    const ax = SX[a], ay = SY[a], bx = SX[b], by = SY[b], cx = SX[c], cy = SY[c];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-20) return null;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    return { ux, uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  let tris = [[n, n + 1, n + 2, circum(n, n + 1, n + 2)]];
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => px[i] - px[j]);
  const KEY = n + 3; // borne des indices -> clé d'arête dirigée sans collision
  for (const p of order) {
    const bad = [];
    for (let t = 0; t < tris.length; t++) { const c = tris[t][3]; if (c && (SX[p] - c.ux) ** 2 + (SY[p] - c.uy) ** 2 < c.r2 + 1e-9) bad.push(t); }
    // Frontière du trou = arêtes dirigées dont l'inverse n'apparaît pas. Détection par table
    // de hachage O(edges) — l'ancienne version O(edges²) explosait (hang) sur les bords
    // quasi-colinéaires où presque tous les triangles deviennent « mauvais ».
    const edges = [];
    const seen = new Set();
    for (const t of bad) { const [a, b, c] = tris[t]; for (const [x, y] of [[a, b], [b, c], [c, a]]) { edges.push([x, y]); seen.add(x * KEY + y); } }
    const boundary = [];
    for (const [x, y] of edges) { if (!seen.has(y * KEY + x)) boundary.push([x, y]); }
    for (let k = bad.length - 1; k >= 0; k--) { const t = bad[k]; tris[t] = tris[tris.length - 1]; tris.pop(); }
    for (const [a, b] of boundary) tris.push([a, b, p, circum(a, b, p)]);
  }
  const out = [];
  for (const [a, b, c] of tris) if (a < n && b < n && c < n) out.push(a, b, c);
  return out;
}

// Force la présence des arêtes `constraints` (CDT, flips façon Sloan).
// T = liste de triangles [a,b,c] (mutée). Retourne le nombre d'échecs.
export function constrainEdges(T, PX, PY, constraints, stats) {
  stats = stats || {}; stats.fStart = 0; stats.fWalk = 0; stats.fFlip = 0;
  const np = PX.length;
  const orient = (a, b, c) => (PX[b] - PX[a]) * (PY[c] - PY[a]) - (PY[b] - PY[a]) * (PX[c] - PX[a]);
  const cross = (a, b, c, d) => {
    const d1 = orient(c, d, a), d2 = orient(c, d, b), d3 = orient(a, b, c), d4 = orient(a, b, d);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  };
  const key = (a, b) => (a < b ? a * np + b : b * np + a);
  const E = new Map(); const VT = new Map();
  const addTri = (t) => {
    const tr = T[t]; if (!tr) return; const [a, b, c] = tr;
    for (const [x, y] of [[a, b], [b, c], [c, a]]) { const k = key(x, y); let l = E.get(k); if (!l) { l = []; E.set(k, l); } l.push(t); }
    for (const v of [a, b, c]) { let s = VT.get(v); if (!s) { s = new Set(); VT.set(v, s); } s.add(t); }
  };
  const remTri = (t) => {
    const [a, b, c] = T[t];
    for (const [x, y] of [[a, b], [b, c], [c, a]]) { const k = key(x, y); const l = E.get(k); if (l) { const i = l.indexOf(t); if (i >= 0) l.splice(i, 1); if (!l.length) E.delete(k); } }
    for (const v of [a, b, c]) { const s = VT.get(v); if (s) s.delete(t); }
  };
  for (let t = 0; t < T.length; t++) addTri(t);
  const other = (k, t) => { const l = E.get(k); if (!l || l.length < 2) return -1; return l[0] === t ? l[1] : l[0]; };
  const third = (t, a, b) => { const [x, y, z] = T[t]; return (x !== a && x !== b) ? x : (y !== a && y !== b) ? y : z; };

  let failed = 0, work = 0;
  // budget global de flips, échelonné sur le nb de contraintes (les grandes coupes ont
  // beaucoup d'arêtes de bord légitimes). Un bord dégénéré livelock -> dépasse -> throw =>
  // repli éventail dans cap-loop. Borne haute pour ne jamais hang.
  const BUDGET = Math.min(4000000, Math.max(40000, constraints.length * 40));
  for (const [u, v] of constraints) {
    if (u === v || E.has(key(u, v))) continue;
    let start = -1, ex = -1, ey = -1;
    const inc = VT.get(u); if (!inc) { failed++; stats.fStart++; continue; }
    for (const t of inc) { const [a, b, c] = T[t]; const p = a === u ? [b, c] : b === u ? [c, a] : [a, b]; if (cross(u, v, p[0], p[1])) { start = t; ex = p[0]; ey = p[1]; break; } }
    if (start < 0) { failed++; stats.fStart++; continue; }
    const queue = []; let cur = start, g = 0, hitHull = false;
    while (g++ < 100000) {
      if (++work > BUDGET) throw new Error('constrainEdges: budget dépassé (bord dégénéré)');
      queue.push([ex, ey]);
      const nt = other(key(ex, ey), cur); if (nt < 0) { hitHull = true; break; }
      const w = third(nt, ex, ey); if (w === v) break;
      if (cross(u, v, ex, w)) ey = w; else ex = w;
      cur = nt;
    }
    if (hitHull) stats.fWalk++;
    let gg = 0;
    while (queue.length && gg++ < 200000) {
      if (++work > BUDGET) throw new Error('constrainEdges: budget dépassé (bord dégénéré)');
      const e = queue.shift(); const k = key(e[0], e[1]);
      const l = E.get(k); if (!l || l.length < 2) continue;
      const t0 = l[0], t1 = l[1];
      const c0 = third(t0, e[0], e[1]), d0 = third(t1, e[0], e[1]);
      if ((orient(c0, d0, e[0]) > 0) === (orient(c0, d0, e[1]) > 0)) { queue.push(e); continue; }
      remTri(t0); remTri(t1);
      T[t0] = [c0, d0, e[0]]; T[t1] = [c0, d0, e[1]];
      addTri(t0); addTri(t1);
      if (!((c0 === u && d0 === v) || (c0 === v && d0 === u)) && cross(u, v, c0, d0)) queue.push([c0, d0]);
    }
    if (!E.has(key(u, v))) { failed++; if (!hitHull && start >= 0) stats.fFlip++; }
  }
  return failed;
}

// Point (ps,pd) intérieur à la région (pair-impair sur d à s=ps).
export function insideRegion(EA, EB, S, D, L, half, ps, pd) {
  let cnt = 0;
  for (let e = 0; e < EA.length; e++) {
    let a = S[EA[e]], b = S[EB[e]];
    if (b - a > half) b -= L; else if (a - b > half) b += L;
    const lo2 = Math.min(a, b), hi2 = Math.max(a, b);
    let ss = ps; if (ss < lo2) ss += L; else if (ss > hi2) ss -= L;
    if (ss < lo2 || ss >= hi2) continue;
    const t = (ss - a) / (b - a);
    if (D[EA[e]] + (D[EB[e]] - D[EA[e]]) * t < pd) cnt++;
  }
  return (cnt & 1) === 1;
}

// Retopo complet du cap. `a` : { pos, S, D, loops, L, lasso, U, camPos, camFwd,
// vw, vh, detail }. Retourne { position:Float32Array, index:Uint32Array, failed }
// ou null. Positions 3D des croisements + grille intérieure sur le prisme.
export function retopoMesh(a) {
  const { pos, S, D, loops, L, lasso, U, camPos, camFwd, vw, vh, detail } = a;
  const half = L * 0.5;
  const nb = pos.length / 3;
  if (nb < 3) return null;
  const EA = [], EB = [];
  for (const loop of loops) for (let i = 0; i < loop.length; i++) { EA.push(loop[i]); EB.push(loop[(i + 1) % loop.length]); }

  let dMin = Infinity, dMax = -Infinity;
  for (let i = 0; i < nb; i++) { if (D[i] < dMin) dMin = D[i]; if (D[i] > dMax) dMax = D[i]; }
  let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
  for (let i = 0; i < nb; i++) { const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; if (z < bz0) bz0 = z; if (z > bz1) bz1 = z; }
  const worldDiag = Math.hypot(bx1 - bx0, by1 - by0, bz1 - bz0) || 1;
  const cells = Math.max(8, (detail || 10) * 10);
  const h3d = worldDiag / cells;
  if (!(h3d > 0)) return null;
  const sScale = worldDiag / L;
  const stepS = h3d / Math.max(sScale, 1e-6), stepD = h3d;

  const baseS = [], baseD = [], P3 = [];
  for (let i = 0; i < nb; i++) { baseS.push(S[i]); baseD.push(D[i]); P3.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); }

  const cum = new Float32Array(lasso.length + 1);
  for (let i = 0; i < lasso.length; i++) { const p = lasso[i], q = lasso[(i + 1) % lasso.length]; cum[i + 1] = cum[i] + Math.hypot(q.x - p.x, q.y - p.y); }
  const pixAt = (s) => {
    let ss = ((s % L) + L) % L, i = 0;
    while (i < lasso.length && cum[i + 1] < ss) i++;
    const p = lasso[i % lasso.length], q = lasso[(i + 1) % lasso.length];
    const seg = cum[i + 1] - cum[i] || 1, t = (ss - cum[i]) / seg;
    return [p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t];
  };
  const applyU = (nx, ny, nz) => { const e = U; const w = e[3] * nx + e[7] * ny + e[11] * nz + e[15]; return [(e[0] * nx + e[4] * ny + e[8] * nz + e[12]) / w, (e[1] * nx + e[5] * ny + e[9] * nz + e[13]) / w, (e[2] * nx + e[6] * ny + e[10] * nz + e[14]) / w]; };
  const sdTo3D = (s, d) => {
    const [pxp, pyp] = pixAt(s);
    const ndcx = (pxp / vw) * 2 - 1, ndcy = -(pyp / vh) * 2 + 1;
    const n = applyU(ndcx, ndcy, -1), f = applyU(ndcx, ndcy, 1);
    let dx = f[0] - n[0], dy = f[1] - n[1], dz = f[2] - n[2]; const ln = Math.hypot(dx, dy, dz) || 1; dx /= ln; dy /= ln; dz /= ln;
    const denom = dx * camFwd.x + dy * camFwd.y + dz * camFwd.z || 1e-6;
    const k = (d - (n[0] - camPos.x) * camFwd.x - (n[1] - camPos.y) * camFwd.y - (n[2] - camPos.z) * camFwd.z) / denom;
    return [n[0] + dx * k, n[1] + dy * k, n[2] + dz * k];
  };

  const margin = h3d * 0.6;
  for (let s = stepS * 0.5; s < L; s += stepS) {
    for (let d = dMin + stepD * 0.5; d < dMax; d += stepD) {
      if (!insideRegion(EA, EB, S, D, L, half, s, d)) continue;
      if (!insideRegion(EA, EB, S, D, L, half, s, d + margin) || !insideRegion(EA, EB, S, D, L, half, s, d - margin)) continue;
      const p = sdTo3D(s, d);
      baseS.push(s); baseD.push(d); P3.push(p[0], p[1], p[2]);
    }
  }

  // périodicité : fantômes près de la couture (ghostOf : sommet base -> son fantôme)
  const nBase = baseS.length, seamMargin = stepS * 3;
  const DXa = [], DYa = [], origa = [];
  const ghostOf = new Int32Array(nBase).fill(-1);
  for (let i = 0; i < nBase; i++) { DXa.push(baseS[i] * sScale); DYa.push(baseD[i]); origa.push(i); }
  for (let i = 0; i < nBase; i++) {
    if (baseS[i] < seamMargin) { DXa.push((baseS[i] + L) * sScale); DYa.push(baseD[i]); origa.push(i); ghostOf[i] = DXa.length - 1; }
    else if (baseS[i] > L - seamMargin) { DXa.push((baseS[i] - L) * sScale); DYa.push(baseD[i]); origa.push(i); ghostOf[i] = DXa.length - 1; }
  }
  const DX = new Float64Array(DXa), DY = new Float64Array(DYa), orig = Int32Array.from(origa);

  const triFlat = delaunay(DX, DY, DX.length);
  const T = [];
  for (let i = 0; i < triFlat.length; i += 3) T.push([triFlat[i], triFlat[i + 1], triFlat[i + 2]]);
  const cons = [];
  for (const loop of loops) for (let i = 0; i < loop.length; i++) {
    const u = loop[i], v = loop[(i + 1) % loop.length];
    if (Math.abs(baseS[u] - baseS[v]) < half) cons.push([u, v]);       // arête normale
    else { if (ghostOf[u] >= 0) cons.push([ghostOf[u], v]); if (ghostOf[v] >= 0) cons.push([u, ghostOf[v]]); } // couture via fantômes
  }
  const cstats = {};
  let failed = 0;
  try { failed = constrainEdges(T, DX, DY, cons, cstats); }
  catch (_) { failed = cons.length; } // bord dégénéré (budget dépassé) : on garde la triangulation brute

  const spanMax = L * sScale * 0.5;
  const seen = new Set(), out = [];
  for (const tr of T) {
    if (!tr) continue;
    const ta = tr[0], tb = tr[1], tc = tr[2];
    const a2 = orig[ta], b2 = orig[tb], c2 = orig[tc];
    if (a2 === b2 || b2 === c2 || a2 === c2) continue;
    const xa = DX[ta], xb = DX[tb], xc = DX[tc];
    if (Math.max(xa, xb, xc) - Math.min(xa, xb, xc) > spanMax) continue;
    const k1 = Math.min(a2, b2, c2), k3 = Math.max(a2, b2, c2), k2 = a2 + b2 + c2 - k1 - k3;
    const key = k1 * nBase * nBase + k2 * nBase + k3; if (seen.has(key)) continue; seen.add(key);
    const cs = (((xa + xb + xc) / 3 / sScale) % L + L) % L, cd = (DY[ta] + DY[tb] + DY[tc]) / 3;
    if (!insideRegion(EA, EB, S, D, L, half, cs, cd)) continue;
    out.push(a2, b2, c2);
  }
  if (out.length === 0) return null;

  // Réparation garantie : comble toute arête de coupe restée non couverte (échecs
  // CDT aux creux concaves) par un triangle vers un voisin commun intérieur.
  const ek = (a, b) => (a < b ? a * nBase + b : b * nBase + a);
  const euse = new Map(); const nbr = new Map();
  const addN = (a, b) => { let s = nbr.get(a); if (!s) { s = new Set(); nbr.set(a, s); } s.add(b); };
  for (let i = 0; i < out.length; i += 3) {
    const t0 = out[i], t1 = out[i + 1], t2 = out[i + 2];
    for (const [a, b] of [[t0, t1], [t1, t2], [t2, t0]]) { euse.set(ek(a, b), (euse.get(ek(a, b)) || 0) + 1); addN(a, b); addN(b, a); }
  }
  let repaired = 0;
  for (const loop of loops) for (let i = 0; i < loop.length; i++) {
    const u = loop[i], v = loop[(i + 1) % loop.length];
    if ((euse.get(ek(u, v)) || 0) > 0) continue;             // déjà couverte
    const su = nbr.get(u), sv = nbr.get(v); if (!su || !sv) continue;
    let bw = -1, bscore = Infinity;
    for (const w of su) {
      if (!sv.has(w) || w === u || w === v) continue;         // voisin commun
      const cs = (((baseS[u] + baseS[v] + baseS[w]) / 3) % L + L) % L, cd = (baseD[u] + baseD[v] + baseD[w]) / 3;
      if (!insideRegion(EA, EB, S, D, L, half, cs, cd)) continue;
      // privilégie w dont les arêtes (u,w)/(v,w) sont des bords (comble sans en créer)
      const sc = ((euse.get(ek(u, w)) || 0) === 1 ? 0 : 1) + ((euse.get(ek(v, w)) || 0) === 1 ? 0 : 1);
      if (sc < bscore) { bscore = sc; bw = w; if (sc === 0) break; }
    }
    if (bw >= 0) { out.push(u, v, bw); euse.set(ek(u, v), 1); euse.set(ek(u, bw), (euse.get(ek(u, bw)) || 0) + 1); euse.set(ek(v, bw), (euse.get(ek(v, bw)) || 0) + 1); repaired++; }
  }
  return { position: new Float32Array(P3), index: new Uint32Array(out), failed, repaired, capStats: cstats };
}
