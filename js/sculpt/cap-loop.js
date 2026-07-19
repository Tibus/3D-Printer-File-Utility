// Bouchage de contours (trous / caps de split) par Delaunay CONTRAINT planaire + grille
// interne réglable -> caps propres et SCULPTABLES (comme le cap du lasso), au lieu d'un
// simple éventail. Chaque boucle de bord est projetée sur son plan moyen (Newell), une
// grille de points internes (densité = `detail`) est ajoutée, puis CDT + carve pair-impair.
// Réutilise delaunay/constrainEdges de cap-mesher.js. Partagé par split-mask et repair.

import * as THREE from 'three';
import { delaunay, constrainEdges } from './cap-mesher.js';

const ATTRS = ['position', 'uv', 'color'];
const DIM = { position: 3, uv: 2, color: 3 };

// Boucles de bord (arêtes utilisées une seule fois) -> listes d'indices de sommets.
function boundaryLoops(idx) {
  const key = (a, b) => (a < b ? a * 1e7 + b : b * 1e7 + a);
  const use = new Map();
  for (let t = 0; t < idx.length; t += 3) { const a = idx[t], b = idx[t + 1], c = idx[t + 2]; for (const [x, y] of [[a, b], [b, c], [c, a]]) use.set(key(x, y), (use.get(key(x, y)) || 0) + 1); }
  const nextOf = new Map();
  for (let t = 0; t < idx.length; t += 3) { const a = idx[t], b = idx[t + 1], c = idx[t + 2]; for (const [x, y] of [[a, b], [b, c], [c, a]]) if (use.get(key(x, y)) === 1) { let l = nextOf.get(x); if (!l) { l = []; nextOf.set(x, l); } l.push(y); } }
  const loops = [], seen = new Set();
  for (const [start] of nextOf) {
    if (seen.has(start)) continue;
    const loop = []; let cur = start, g = 0;
    while (cur !== undefined && !seen.has(cur) && g++ < 1e6) { seen.add(cur); loop.push(cur); const l = nextOf.get(cur); cur = l && l.length ? l[0] : undefined; }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// Bouche toutes les boucles de bord de geometry par CDT + grille interne (densité detail).
// Retourne une NOUVELLE géométrie (normales recalculées), ou geometry si pas de bord.
export function fillLoopsCDT(geometry, detail = 10) {
  const idx0 = geometry.index.array;
  const loops = boundaryLoops(idx0);
  if (!loops.length) return geometry;
  const attrs = ATTRS.filter((a) => geometry.attributes[a]);
  const src = {}; for (const a of attrs) src[a] = geometry.attributes[a].array;
  const out = {}; for (const a of attrs) out[a] = Array.from(src[a]);
  const outIdx = Array.from(idx0);
  const pos = src.position;
  let V = geometry.attributes.position.count;

  // centre global (pour orienter les caps vers l'extérieur)
  geometry.computeBoundingBox();
  const bc = new THREE.Vector3(); geometry.boundingBox.getCenter(bc);

  // Nombre d'anneaux radiaux du cap éventail (densité SCULPTABLE réglée par detail).
  const capRings = Math.max(1, Math.min(20, Math.round(detail / 2)));

  // Éventail 3D CONCENTRIQUE vers le centroïde : anneaux internes interpolés en 3D entre
  // le contour et le centre -> cap sculptable (grille radiale), O(n×rings), toujours
  // étanche, et gère les bords non plans (là où le CDT planaire s'effondre).
  const fanLoop = (loop, n, cx, cy, cz, outward) => {
    // attributs du centroïde (moyenne du contour) ; position centroïde = (cx,cy,cz)
    const cAttr = {}; for (const a of attrs) { const d = DIM[a]; const v = new Array(d).fill(0); for (const li of loop) for (let c = 0; c < d; c++) v[c] += src[a][li * d + c]; for (let c = 0; c < d; c++) v[c] /= n; cAttr[a] = v; }
    if (cAttr.position) { cAttr.position[0] = cx; cAttr.position[1] = cy; cAttr.position[2] = cz; }
    // rows[0] = contour (globals existants) ; rows[1..R-1] = anneaux internes ; rows[R] = centre
    const rows = [loop.slice()];
    for (let r = 1; r < capRings; r++) {
      const t = r / capRings, row = [];
      for (let i = 0; i < n; i++) {
        const li = loop[i];
        for (const a of attrs) { const d = DIM[a], s = src[a]; for (let c = 0; c < d; c++) out[a].push(s[li * d + c] * (1 - t) + cAttr[a][c] * t); }
        row.push(V++);
      }
      rows.push(row);
    }
    const cv = V++; for (const a of attrs) { const d = DIM[a]; for (let c = 0; c < d; c++) out[a].push(cAttr[a][c]); }
    rows.push(new Array(n).fill(cv)); // anneau central (sommet unique)
    // couture anneau par anneau (quads -> 2 triangles), winding cohérent avec outward
    const push3 = (A, B, C) => { if (A === B || B === C || A === C) return; if (outward) outIdx.push(A, B, C); else outIdx.push(A, C, B); };
    for (let r = 0; r < capRings; r++) {
      const outer = rows[r], inner = rows[r + 1];
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; push3(outer[j], outer[i], inner[i]); push3(outer[j], inner[i], inner[j]); }
    }
  };

  for (const loop of loops) {
    const n = loop.length;
    // centroïde + normale de Newell
    let cx = 0, cy = 0, cz = 0; for (const v of loop) { cx += pos[v * 3]; cy += pos[v * 3 + 1]; cz += pos[v * 3 + 2]; } cx /= n; cy /= n; cz /= n;
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < n; i++) { const a = loop[i], b = loop[(i + 1) % n]; const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2], bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2]; nx += (ay - by) * (az + bz); ny += (az - bz) * (ax + bx); nz += (ax - bx) * (ay + by); }
    let nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    // base (U,V) du plan
    let ax = 1, ay = 0, az = 0; if (Math.abs(nx) > 0.9) { ax = 0; ay = 1; az = 0; }
    let Ux = ay * nz - az * ny, Uy = az * nx - ax * nz, Uz = ax * ny - ay * nx; const Ul = Math.hypot(Ux, Uy, Uz) || 1; Ux /= Ul; Uy /= Ul; Uz /= Ul;
    const Vx = ny * Uz - nz * Uy, Vy = nz * Ux - nx * Uz, Vz = nx * Uy - ny * Ux;
    // projection 2D du contour
    const px = [], py = [];
    for (const v of loop) { const dx = pos[v * 3] - cx, dy = pos[v * 3 + 1] - cy, dz = pos[v * 3 + 2] - cz; px.push(dx * Ux + dy * Uy + dz * Uz); py.push(dx * Vx + dy * Vy + dz * Vz); }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) { if (px[i] < x0) x0 = px[i]; if (px[i] > x1) x1 = px[i]; if (py[i] < y0) y0 = py[i]; if (py[i] > y1) y1 = py[i]; }
    const inPoly = (qx, qy) => { let ins = false; for (let i = 0, j = n - 1; i < n; j = i++) { const xi = px[i], yi = py[i], xj = px[j], yj = py[j]; if (((yi > qy) !== (yj > qy)) && (qx < ((xj - xi) * (qy - yi)) / (yj - yi) + xi)) ins = !ins; } return ins; };

    // orientation : normale du cap doit pointer vers l'extérieur (loin du centre global)
    const outward = ((cx - bc.x) * nx + (cy - bc.y) * ny + (cz - bc.z) * nz) >= 0;
    // Planarité : le CDT planaire est lent et produit un cap en miettes quand le bord n'est
    // pas ~plan (ex. coupe courbe d'un masque sur une sphère -> polygone 2D auto-intersectant).
    // Dans ce cas (ou boucle très longue) -> éventail 3D rapide et robuste.
    let maxDev = 0;
    for (const v of loop) { const dx = pos[v * 3] - cx, dy = pos[v * 3 + 1] - cy, dz = pos[v * 3 + 2] - cz; const d = Math.abs(dx * nx + dy * ny + dz * nz); if (d > maxDev) maxDev = d; }
    const extent = Math.max(x1 - x0, y1 - y0) || 1;
    if (maxDev > 0.18 * extent || n > 300) { fanLoop(loop, n, cx, cy, cz, outward); continue; }

    const localGlobal = loop.slice(); // local < n -> global existant ; interne -> nouveau
    const step = (Math.max(x1 - x0, y1 - y0) || 1) / Math.max(2, detail | 0);
    for (let gy = y0 + step * 0.5; gy < y1; gy += step) for (let gx = x0 + step * 0.5; gx < x1; gx += step) {
      if (!inPoly(gx, gy)) continue;
      px.push(gx); py.push(gy);
      const wx = cx + gx * Ux + gy * Vx, wy = cy + gx * Uy + gy * Vy, wz = cz + gx * Uz + gy * Vz;
      for (const a of attrs) {
        if (a === 'position') out.position.push(wx, wy, wz);
        else { const d = DIM[a]; for (let c = 0; c < d; c++) { let s = 0; for (const v of loop) s += src[a][v * d + c]; out[a].push(s / n); } } // attr interne = moyenne du contour
      }
      localGlobal.push(V++);
    }

    const np = px.length; const DX = new Float64Array(px), DY = new Float64Array(py);
    let tris;
    try {
      const flat = delaunay(DX, DY, np); tris = []; for (let i = 0; i < flat.length; i += 3) tris.push([flat[i], flat[i + 1], flat[i + 2]]);
      const cons = []; for (let i = 0; i < n; i++) cons.push([i, (i + 1) % n]);
      constrainEdges(tris, DX, DY, cons, {});
    } catch (_) { tris = null; }

    if (tris) {
      // suivi de couverture des arêtes de bord (local i -> i+1) : chaque arête du contour
      // doit être portée par exactement un triangle du cap, sinon -> trou.
      const ekey = (x, y) => (x < y ? x * 1e7 + y : y * 1e7 + x);
      const loopEdge = new Set(); for (let i = 0; i < n; i++) loopEdge.add(ekey(i, (i + 1) % n));
      const cover = new Map();
      const bump = (x, y) => { const k = ekey(x, y); if (loopEdge.has(k)) cover.set(k, (cover.get(k) || 0) + 1); };
      for (const tr of tris) {
        if (!tr) continue; const [a, b, c] = tr; if (a === b || b === c || a === c) continue;
        const mx = (DX[a] + DX[b] + DX[c]) / 3, my = (DY[a] + DY[b] + DY[c]) / 3;
        if (!inPoly(mx, my)) continue;
        // aire 2D signée -> winding cohérent, puis orientation extérieure
        const area = (DX[b] - DX[a]) * (DY[c] - DY[a]) - (DY[b] - DY[a]) * (DX[c] - DX[a]);
        const ccw = area > 0;
        const ga = localGlobal[a], gb = localGlobal[b], gc = localGlobal[c];
        if (ccw === outward) outIdx.push(ga, gb, gc); else outIdx.push(ga, gc, gb);
        bump(a, b); bump(b, c); bump(c, a);
      }
      // réparation : le CDT contraint échoue parfois à récupérer certaines arêtes de bord
      // (carve -> trou). Chaque arête non couverte -> éventail vers le centroïde => cap fermé.
      let cvIdx = -1;
      for (let i = 0; i < n; i++) {
        const p = i, q = (i + 1) % n;
        if ((cover.get(ekey(p, q)) || 0) > 0) continue;
        if (cvIdx < 0) {
          cvIdx = V++;
          for (const a of attrs) { if (a === 'position') out.position.push(cx, cy, cz); else { const d = DIM[a]; for (let c = 0; c < d; c++) { let s = 0; for (const v of loop) s += src[a][v * d + c]; out[a].push(s / n); } } }
        }
        const gp = localGlobal[p], gq = localGlobal[q];
        if (outward) outIdx.push(gq, gp, cvIdx); else outIdx.push(gp, gq, cvIdx);
      }
    } else {
      fanLoop(loop, n, cx, cy, cz, outward); // repli si le CDT a levé une exception
    }
  }

  const g = new THREE.BufferGeometry();
  for (const a of attrs) g.setAttribute(a, new THREE.Float32BufferAttribute(out[a], DIM[a]));
  g.setIndex(outIdx);
  g.computeVertexNormals();
  g.userData._filledHoles = loops.length;
  return g;
}
