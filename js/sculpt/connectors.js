// Connecteurs (tenons/mortaises) sur un split : après une découpe en 2 pièces, on détecte l'interface
// de coupe, on y place des tenons cylindriques -> UNION sur une pièce (le tenon dépasse), SOUSTRACTION
// (avec jeu) sur l'autre (la mortaise). Les deux pièces s'emboîtent pour l'impression multi-parties.
// Booléens via Manifold (watertight). Fallback : renvoie null (on garde les pièces sans connecteurs).

import * as THREE from 'three';
import { getManifold } from './split-manifold.js'; // three-mesh-bvh est déjà patché sur BufferGeometry.prototype (loader.js)

// Géométrie (index/positions locales) -> Manifold Mesh (position seule).
function geomToManifold(Mesh, geom) {
  const pos = geom.attributes.position.array, V = geom.attributes.position.count;
  const vp = pos instanceof Float32Array ? pos.slice() : new Float32Array(pos);
  let tv;
  if (geom.index) tv = geom.index.array instanceof Uint32Array ? geom.index.array.slice() : new Uint32Array(geom.index.array);
  else { tv = new Uint32Array(V); for (let i = 0; i < V; i++) tv[i] = i; }
  const mm = new Mesh({ numProp: 3, vertProperties: vp, triVerts: tv }); mm.merge();
  return mm;
}
function manifoldToGeom(mm) {
  const V = mm.vertProperties.length / mm.numProp, outPos = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) { const o = i * mm.numProp; outPos[i * 3] = mm.vertProperties[o]; outPos[i * 3 + 1] = mm.vertProperties[o + 1]; outPos[i * 3 + 2] = mm.vertProperties[o + 2]; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  g.setIndex(new THREE.BufferAttribute(mm.triVerts instanceof Uint32Array ? mm.triVerts.slice() : new Uint32Array(mm.triVerts), 1));
  g.computeVertexNormals();
  return g;
}

// Vecteur propre de plus petite valeur propre d'une matrice sym 3x3 (Jacobi) -> normale du plan.
function smallestEigenvector(c) {
  // c = [cxx,cyy,czz,cxy,cxz,cyz]
  let a = [[c[0], c[3], c[4]], [c[3], c[1], c[5]], [c[4], c[5], c[2]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let iter = 0; iter < 24; iter++) {
    // plus grand off-diagonal
    let p = 0, q = 1, max = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > max) { max = Math.abs(a[0][2]); p = 0; q = 2; }
    if (Math.abs(a[1][2]) > max) { max = Math.abs(a[1][2]); p = 1; q = 2; }
    if (max < 1e-12) break;
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app), cs = Math.cos(phi), sn = Math.sin(phi);
    for (let k = 0; k < 3; k++) {
      const akp = a[k][p], akq = a[k][q];
      a[k][p] = cs * akp - sn * akq; a[k][q] = sn * akp + cs * akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = a[p][k], aqk = a[q][k];
      a[p][k] = cs * apk - sn * aqk; a[q][k] = sn * apk + cs * aqk;
    }
    for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = cs * vkp - sn * vkq; v[k][q] = sn * vkp + cs * vkq; }
  }
  const d = [a[0][0], a[1][1], a[2][2]];
  let mi = 0; if (d[1] < d[mi]) mi = 1; if (d[2] < d[mi]) mi = 2;
  return new THREE.Vector3(v[0][mi], v[1][mi], v[2][mi]).normalize();
}

// Cylindre (Manifold) le long de l'axe N, centré en C, rayon r, hauteur h.
function cylinderManifold(Manifold, C, N, r, h, seg = 24) {
  let cyl = Manifold.cylinder(h, r, r, seg, true); // le long de +Z, centré
  // oriente Z -> N
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), N);
  const m = new THREE.Matrix4().compose(C, q, new THREE.Vector3(1, 1, 1));
  const e = m.elements; // 4x4 colonne-major -> transform Manifold attend une matrice 3x4 (colonnes)
  const t = cyl.transform([e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]]);
  cyl.delete();
  return t;
}

// insideGeom / outsideGeom : géométries LOCALES dans le même repère (résultat du split).
// opts.size : taille caractéristique (unités monde locales). Renvoie { inside, outside } ou null.
export async function addConnectors(insideGeom, outsideGeom, opts = {}) {
  const size = opts.size || 2;
  // 1) points de contact : sommets de `inside` proches de la surface de `outside`.
  const bvhGeom = outsideGeom;
  const hadTree = !!bvhGeom.boundsTree;
  if (!hadTree) bvhGeom.computeBoundsTree({ setBoundingBox: false });
  const tree = bvhGeom.boundsTree;
  const ipos = insideGeom.attributes.position.array, IV = insideGeom.attributes.position.count;
  const thr = size * 0.004, thr2 = thr * thr;
  const pts = [];
  const target = {};
  const v = new THREE.Vector3();
  for (let i = 0; i < IV; i++) {
    v.set(ipos[i * 3], ipos[i * 3 + 1], ipos[i * 3 + 2]);
    const hit = tree.closestPointToPoint(v, target);
    if (hit && hit.distance * hit.distance <= thr2 * 25) pts.push(v.x, v.y, v.z); // tolérance large
  }
  if (!hadTree) bvhGeom.disposeBoundsTree();
  const nP = pts.length / 3;
  if (nP < 8) return null; // interface trop petite / introuvable

  // 2) plan : centroïde + normale (PCA).
  const ctr = new THREE.Vector3();
  for (let i = 0; i < nP; i++) ctr.set(ctr.x + pts[i * 3], ctr.y + pts[i * 3 + 1], ctr.z + pts[i * 3 + 2]);
  ctr.multiplyScalar(1 / nP);
  let cxx = 0, cyy = 0, czz = 0, cxy = 0, cxz = 0, cyz = 0;
  for (let i = 0; i < nP; i++) { const dx = pts[i * 3] - ctr.x, dy = pts[i * 3 + 1] - ctr.y, dz = pts[i * 3 + 2] - ctr.z; cxx += dx * dx; cyy += dy * dy; czz += dz * dz; cxy += dx * dy; cxz += dx * dz; cyz += dy * dz; }
  const N = smallestEigenvector([cxx, cyy, czz, cxy, cxz, cyz]);

  // 3) base dans le plan + étendue.
  const helper = new THREE.Vector3(Math.abs(N.x) < 0.9 ? 1 : 0, Math.abs(N.x) < 0.9 ? 0 : 1, 0);
  const T = new THREE.Vector3().crossVectors(helper, N).normalize();
  const Bv = new THREE.Vector3().crossVectors(N, T).normalize();
  let minU = Infinity, maxU = -Infinity, minW = Infinity, maxW = -Infinity;
  const d = new THREE.Vector3();
  for (let i = 0; i < nP; i++) { d.set(pts[i * 3] - ctr.x, pts[i * 3 + 1] - ctr.y, pts[i * 3 + 2] - ctr.z); const u = d.dot(T), w = d.dot(Bv); if (u < minU) minU = u; if (u > maxU) maxU = u; if (w < minW) minW = w; if (w > maxW) maxW = w; }
  const spanU = maxU - minU, spanW = maxW - minW;
  const rMax = Math.min(spanU, spanW) * 0.28;
  const r = Math.min(Math.max(rMax, size * 0.012), size * 0.12);
  if (r < size * 0.006) return null;
  const h = size * 0.35; // le cylindre traverse la coupe (moitié de chaque côté)
  const clear = Math.max(size * 0.004, r * 0.06);

  // 4) positions des tenons : le long de l'axe le plus long, centrés, en restant dans l'interface.
  const longU = spanU >= spanW;
  const span = longU ? spanU : spanW;
  const axis = longU ? T : Bv;
  const usableHalf = Math.max(0, span * 0.5 - r * 1.6);
  const k = usableHalf > r * 2.5 ? 3 : (usableHalf > r * 0.5 ? 2 : 1);
  const centers = [];
  for (let i = 0; i < k; i++) {
    const t = k === 1 ? 0 : (i / (k - 1) * 2 - 1) * usableHalf; // -usableHalf..+usableHalf
    centers.push(ctr.clone().addScaledVector(axis, t));
  }

  // 5) booléens Manifold.
  let wasm; try { wasm = await getManifold(); } catch (_) { return null; }
  const { Manifold, Mesh } = wasm;
  const created = [];
  let inMan = null, outMan = null, pegUnion = null, holeUnion = null, resIn = null, resOut = null;
  try {
    inMan = new Manifold(geomToManifold(Mesh, insideGeom)); created.push(inMan);
    outMan = new Manifold(geomToManifold(Mesh, outsideGeom)); created.push(outMan);
    if (inMan.numTri() === 0 || outMan.numTri() === 0) return null; // pièces non manifold -> abandon
    for (const C of centers) {
      const peg = cylinderManifold(Manifold, C, N, r, h); const hole = cylinderManifold(Manifold, C, N, r + clear, h); created.push(peg, hole);
      pegUnion = pegUnion ? (created.push(Manifold.union(pegUnion, peg)), created[created.length - 1]) : peg;
      holeUnion = holeUnion ? (created.push(Manifold.union(holeUnion, hole)), created[created.length - 1]) : hole;
    }
    resIn = Manifold.union(inMan, pegUnion); created.push(resIn);
    resOut = Manifold.difference(outMan, holeUnion); created.push(resOut);
    const gi = manifoldToGeom(resIn.getMesh()), go = manifoldToGeom(resOut.getMesh());
    return { inside: gi, outside: go, count: centers.length };
  } catch (e) {
    console.warn('[connectors] échec booléen', e && e.message);
    return null;
  } finally {
    for (const m of created) { try { if (m) m.delete(); } catch (_) { /* noop */ } }
  }
}
