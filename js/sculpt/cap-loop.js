// Bouchage de contours (trous / caps de split) par Delaunay CONTRAINT planaire + grille
// interne réglable -> caps propres et SCULPTABLES (comme le cap du lasso), au lieu d'un
// simple éventail. Chaque boucle de bord est projetée sur son plan moyen (Newell), une
// grille de points internes (densité = `detail`) est ajoutée, puis CDT + carve pair-impair.
// Réutilise delaunay/constrainEdges de cap-mesher.js. Partagé par split-mask et repair.

import * as THREE from 'three';
import { delaunay, constrainEdges } from './cap-mesher.js';

const ATTRS = ['position', 'uv', 'color'];
const DIM = { position: 3, uv: 2, color: 3 };

// Boucles de bord (arêtes de bord réelles) -> listes d'indices de sommets.
// CONSCIENT DES POSITIONS : les sommets coïncidents (coutures UV/normales d'un glTF, très
// fréquentes — le maillage est fermé mais stocké avec des sommets dupliqués) sont fusionnés
// pour COMPTER les arêtes. Sinon chaque couture paraît « utilisée une fois » -> des milliers
// de faux trous -> le cap mélange tout. Le comptage se fait par sommet canonique (position),
// mais les boucles renvoyées gardent les sommets RÉELS (pour recoudre exactement le cap).
function boundaryLoops(idx, pos) {
  const V = pos.length / 3, q = 1e5;
  const posMap = new Map(); const rep = new Int32Array(V);
  for (let v = 0; v < V; v++) {
    const pk = Math.round(pos[v * 3] * q) + '_' + Math.round(pos[v * 3 + 1] * q) + '_' + Math.round(pos[v * 3 + 2] * q);
    let r = posMap.get(pk); if (r === undefined) { r = v; posMap.set(pk, r); }
    rep[v] = r;
  }
  const key = (a, b) => (a < b ? a * 1e7 + b : b * 1e7 + a);
  const use = new Map(); // comptage par arête CANONIQUE (positions)
  for (let t = 0; t < idx.length; t += 3) { const A = rep[idx[t]], B = rep[idx[t + 1]], C = rep[idx[t + 2]]; for (const [x, y] of [[A, B], [B, C], [C, A]]) if (x !== y) use.set(key(x, y), (use.get(key(x, y)) || 0) + 1); }
  const nextOf = new Map(); // demi-arêtes de bord réelles (canonique vue une seule fois)
  for (let t = 0; t < idx.length; t += 3) { const a = idx[t], b = idx[t + 1], c = idx[t + 2]; for (const [x, y] of [[a, b], [b, c], [c, a]]) { if (rep[x] === rep[y]) continue; if (use.get(key(rep[x], rep[y])) === 1) { let l = nextOf.get(x); if (!l) { l = []; nextOf.set(x, l); } l.push(y); } } }
  const loops = [], seen = new Set();
  for (const [start] of nextOf) {
    if (seen.has(start)) continue;
    const loop = []; let cur = start, g = 0;
    while (cur !== undefined && !seen.has(cur) && g++ < 1e6) { seen.add(cur); loop.push(cur); const l = nextOf.get(cur); cur = l && l.length ? l[0] : undefined; }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// Le polygone 2D (px,py sur n sommets) est-il simple (aucune paire d'arêtes NON adjacentes
// ne se croise) ? Si oui, le CDT contraint est fiable même si le bord 3D n'est pas plan
// (on obtient juste un cap ~plat). Le CDT ne s'effondre que si la projection s'auto-intersecte.
function isSimplePolygon(px, py, n) {
  if (n < 4) return true;
  const orient = (ax, ay, bx, by, cx, cy) => { const v = (by - ay) * (cx - bx) - (bx - ax) * (cy - by); return v > 1e-12 ? 1 : (v < -1e-12 ? -1 : 0); };
  const cross = (ax, ay, bx, by, cx, cy, dx, dy) => {
    const o1 = orient(ax, ay, bx, by, cx, cy), o2 = orient(ax, ay, bx, by, dx, dy);
    const o3 = orient(cx, cy, dx, dy, ax, ay), o4 = orient(cx, cy, dx, dy, bx, by);
    return o1 !== o2 && o3 !== o4 && o1 && o2 && o3 && o4; // croisement propre (pas simple contact)
  };
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let j = i + 1; j < n; j++) {
      const j2 = (j + 1) % n;
      if (i2 === j || i === j2 || i2 === j2) continue; // arêtes adjacentes -> ignorer
      if (cross(px[i], py[i], px[i2], py[i2], px[j], py[j], px[j2], py[j2])) return false;
    }
  }
  return true;
}

// Bouche toutes les boucles de bord de geometry par CDT + grille interne (densité detail).
// Retourne une NOUVELLE géométrie (normales recalculées), ou geometry si pas de bord.
export function fillLoopsCDT(geometry, detail = 10) {
  const idx0 = geometry.index.array;
  const loops = boundaryLoops(idx0, geometry.attributes.position.array);
  if (!loops.length) return geometry;
  const attrs = ATTRS.filter((a) => geometry.attributes[a]);
  const src = {}; for (const a of attrs) src[a] = geometry.attributes[a].array;
  const out = {}; for (const a of attrs) out[a] = Array.from(src[a]);
  const outIdx = Array.from(idx0);
  const pos = src.position;
  const V0 = geometry.attributes.position.count; // sommets d'origine (corps) : indices [0, V0)
  const srcNormal = geometry.attributes.normal ? geometry.attributes.normal.array : null;
  let V = V0;

  // centre global (pour orienter les caps vers l'extérieur)
  geometry.computeBoundingBox();
  const bc = new THREE.Vector3(); geometry.boundingBox.getCenter(bc);

  let cdtCount = 0, fanCount = 0; // stats (CDT grillé vs éventail concentrique)

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
    // On garde le CDT (grille sculptable) dès que la projection 2D est SIMPLE — même si le
    // bord n'est pas plan (on obtient un cap plat, ce qui convient). Éventail 3D uniquement
    // pour les bords repliés (projection auto-intersectante) ou les boucles très longues.
    if (n > 400 || !isSimplePolygon(px, py, n)) { fanLoop(loop, n, cx, cy, cz, outward); fanCount++; continue; }

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
      cdtCount++;
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
      fanLoop(loop, n, cx, cy, cz, outward); fanCount++; // repli si le CDT a levé une exception
    }
  }

  const g = new THREE.BufferGeometry();
  for (const a of attrs) g.setAttribute(a, new THREE.Float32BufferAttribute(out[a], DIM[a]));
  g.setIndex(outIdx);
  g.computeVertexNormals();
  // Les sommets du bord (partagés corps/cap) sont dans [0, V0) : computeVertexNormals y
  // moyenne faces du corps + faces de la cap -> normales « biseau » bizarres au bord. On
  // restaure les normales d'origine du corps (les nouveaux sommets de cap gardent le recalcul).
  if (srcNormal) { const na = g.attributes.normal.array; const n0 = Math.min(srcNormal.length, V0 * 3); for (let i = 0; i < n0; i++) na[i] = srcNormal[i]; g.attributes.normal.needsUpdate = true; }
  g.userData._filledHoles = loops.length;
  g.userData._capCDT = cdtCount; g.userData._capFan = fanCount;
  return g;
}
