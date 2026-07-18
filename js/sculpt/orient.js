// Auto-orientation pour l'impression : cherche l'orientation qui minimise les
// surplombs (supports) tout en maximisant le contact avec le plateau. On teste des
// directions "bas" candidates = normales des faces de l'enveloppe convexe (l'objet
// repose sur une face de son hull) + les 6 axes. Pour chacune, on score l'aire de
// surplomb (faces trop inclinées vers le bas) moins l'aire de base au sol. La meilleure
// est appliquée : rotation pour que "bas" -> -Y, puis pose au sol (min.y = 0).

import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';

const DOWN = new THREE.Vector3(0, -1, 0);

// Directions candidates : normales du hull (dédupliquées) + 6 axes.
function candidateDirs(points) {
  const dirs = [];
  const seen = new Set();
  const add = (x, y, z) => {
    const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
    const k = `${Math.round(x * 24)},${Math.round(y * 24)},${Math.round(z * 24)}`;
    if (seen.has(k)) return; seen.add(k);
    dirs.push(new THREE.Vector3(x, y, z));
  };
  try {
    const hull = new ConvexGeometry(points);
    const hp = hull.attributes.position.array;
    for (let i = 0; i < hp.length; i += 9) {
      const ax = hp[i], ay = hp[i + 1], az = hp[i + 2];
      const bx = hp[i + 3], by = hp[i + 4], bz = hp[i + 5];
      const cx = hp[i + 6], cy = hp[i + 7], cz = hp[i + 8];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      add(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); // normale sortante du hull
    }
  } catch (_) { /* hull peut échouer sur mesh dégénéré */ }
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) add(d[0], d[1], d[2]);
  return dirs;
}

// Retourne une NOUVELLE géométrie ré-orientée + posée au sol, ou null.
export function autoOrient(geometry, { overhangDeg = 45 } = {}) {
  const pos = geometry.attributes.position.array;
  const V = geometry.attributes.position.count;
  if (!geometry.index) return null;
  const idx = geometry.index.array, nTri = idx.length / 3;

  // échantillon de points pour le hull (les extrêmes suffisent)
  const step = Math.max(1, Math.floor(V / 4000));
  const pts = [];
  for (let i = 0; i < V; i += step) pts.push(new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
  const dirs = candidateDirs(pts);
  if (!dirs.length) return null;

  // pré-calc par triangle : normale (aire pondérée) + centroïde
  const tnx = new Float32Array(nTri), tny = new Float32Array(nTri), tnz = new Float32Array(nTri), tar = new Float32Array(nTri);
  const tcx = new Float32Array(nTri), tcy = new Float32Array(nTri), tcz = new Float32Array(nTri);
  for (let t = 0; t < nTri; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    tar[t] = len * 0.5;
    if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
    tnx[t] = nx; tny[t] = ny; tnz[t] = nz;
    tcx[t] = (pos[a] + pos[b] + pos[c]) / 3; tcy[t] = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3; tcz[t] = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
  }

  const supportThr = Math.sin(overhangDeg * Math.PI / 180); // n·down au-delà -> support
  let best = null, bestScore = Infinity;
  for (const d of dirs) {
    // extent le long de d + min (le sol)
    let dmin = Infinity, dmax = -Infinity;
    for (let i = 0; i < V; i++) { const p = pos[i * 3] * d.x + pos[i * 3 + 1] * d.y + pos[i * 3 + 2] * d.z; if (p < dmin) dmin = p; if (p > dmax) dmax = p; }
    const band = (dmax - dmin) * 0.02 + 1e-6;
    let support = 0, base = 0;
    for (let t = 0; t < nTri; t++) {
      const nd = tnx[t] * d.x + tny[t] * d.y + tnz[t] * d.z; // >0 : face tournée vers le bas
      if (nd <= supportThr) continue;
      // la face d'appui (normale = d) est à l'extrême dmax le long de d (elle devient le
      // sol après rotation d -> -Y). Contact plateau = proche de dmax ET quasi horizontale.
      const cp = tcx[t] * d.x + tcy[t] * d.y + tcz[t] * d.z;
      if (dmax - cp < band && nd > 0.9) base += tar[t]; // contact plateau
      else support += tar[t];
    }
    const score = support - base; // minimise le support, favorise la base
    if (score < bestScore) { bestScore = score; best = d; }
  }
  if (!best) return null;

  const g = geometry.clone();
  if (g.boundsTree) delete g.boundsTree;
  const q = new THREE.Quaternion().setFromUnitVectors(best, DOWN);
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox.min.y, 0); // pose au sol
  g.computeVertexNormals();
  return g;
}
