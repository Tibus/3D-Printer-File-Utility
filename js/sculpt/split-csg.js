// Split par lasso = boolean CSG avec le prisme du lasso extrudé le long de l'axe
// caméra (cookie-cutter à travers la vue). Utilise three-bvh-csg.
//   inside  = mesh ∩ prisme   (partie dans le lasso)
//   outside = mesh − prisme   (le reste)
//
// Mode "précis" : robuste (coupe correcte même sur low-poly/cube) mais LENT et
// bloquant (booléen sur le thread principal). Alternative au mode rapide (CDT).

import * as THREE from 'three';
import { Evaluator, Brush, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';

const _evaluator = new Evaluator();
_evaluator.useGroups = false;

// Ear-clipping (premier ear) d'un polygone CCW (u,v) -> triangles [i,j,k].
function earClip(u, v) {
  const n = u.length;
  const out = [];
  if (n < 3) return out;
  const V = [];
  for (let i = 0; i < n; i++) V.push(i);
  const area2 = (a, b, c) => (u[b] - u[a]) * (v[c] - v[a]) - (v[b] - v[a]) * (u[c] - u[a]);
  const inTri = (p, a, b, c) => {
    const d1 = (u[p] - u[b]) * (v[a] - v[b]) - (u[a] - u[b]) * (v[p] - v[b]);
    const d2 = (u[p] - u[c]) * (v[b] - v[c]) - (u[b] - u[c]) * (v[p] - v[c]);
    const d3 = (u[p] - u[a]) * (v[c] - v[a]) - (u[c] - u[a]) * (v[p] - v[a]);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  let guard = 0;
  while (V.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < V.length; i++) {
      const m = V.length;
      const a = V[(i - 1 + m) % m], b = V[i], c = V[(i + 1) % m];
      if (area2(a, b, c) <= 0) continue;
      let ear = true;
      for (let k = 0; k < m; k++) { const p = V[k]; if (p !== a && p !== b && p !== c && inTri(p, a, b, c)) { ear = false; break; } }
      if (!ear) continue;
      out.push([a, b, c]);
      V.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (V.length === 3) out.push([V[0], V[1], V[2]]);
  return out;
}

// Construit le prisme fermé du lasso : polygone triangulé + extrusion le long des
// rayons caméra. Les `rings` anneaux sont concentrés dans la TRANCHE DE PROFONDEUR
// de l'objet (dRange = {dmin,dmax} en profondeur vue) : les parois de coupe (=le
// grillage/croisillon) sont ainsi finement subdivisées LÀ où l'objet est traversé,
// pas gaspillées sur tout le frustum. Attributs alignés sur ceux du mesh.
function buildPrism(lassoPx, camera, vw, vh, hasUV, hasColor, rings, dRange) {
  const n = lassoPx.length;
  const ndcX = [], ndcY = [];
  for (let i = 0; i < n; i++) { ndcX.push((lassoPx[i].x / vw) * 2 - 1); ndcY.push(-(lassoPx[i].y / vh) * 2 + 1); }

  // CCW dans le plan NDC
  let area = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += ndcX[i] * ndcY[j] - ndcX[j] * ndcY[i]; }
  if (area < 0) { ndcX.reverse(); ndcY.reverse(); }

  const capTris = earClip(ndcX, ndcY);

  const camPos = new THREE.Vector3(); camera.getWorldPosition(camPos);
  const camFwd = new THREE.Vector3(); camera.getWorldDirection(camFwd);

  // Anneaux distribués dans [dmin,dmax] (profondeur vue). Par rayon, on convertit
  // ces profondeurs en param t le long de near→far (perspective-correct).
  const rows = rings + 1;
  const near = new THREE.Vector3(), far = new THREE.Vector3();
  const positions = new Float32Array(rows * n * 3);
  for (let i = 0; i < n; i++) {
    near.set(ndcX[i], ndcY[i], -1).unproject(camera);
    far.set(ndcX[i], ndcY[i], 1).unproject(camera);
    const dNear = (near.x - camPos.x) * camFwd.x + (near.y - camPos.y) * camFwd.y + (near.z - camPos.z) * camFwd.z;
    const dFar = (far.x - camPos.x) * camFwd.x + (far.y - camPos.y) * camFwd.y + (far.z - camPos.z) * camFwd.z;
    const span = (dFar - dNear) || 1e-6;
    const t0 = (dRange.dmin - dNear) / span, t1 = (dRange.dmax - dNear) / span;
    for (let r = 0; r < rows; r++) {
      const t = t0 + (t1 - t0) * (r / rings);
      const o = (r * n + i) * 3;
      positions[o] = near.x + (far.x - near.x) * t;
      positions[o + 1] = near.y + (far.y - near.y) * t;
      positions[o + 2] = near.z + (far.z - near.z) * t;
    }
  }

  const idx = [];
  const farBase = rings * n;
  for (const [a, b, c] of capTris) { idx.push(a, c, b); idx.push(farBase + a, farBase + b, farBase + c); } // caps near (inversé) + far
  for (let r = 0; r < rings; r++) {
    const b0 = r * n, b1 = (r + 1) * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      idx.push(b0 + i, b0 + j, b1 + j);
      idx.push(b0 + i, b1 + j, b1 + i);
    }
  }

  // Orientation cohérente vers l'extérieur : flip global si volume signé < 0.
  let vol = 0;
  const p = positions;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]));
  }
  if (vol < 0) for (let t = 0; t < idx.length; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (hasUV) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(rows * n * 2), 2));
  if (hasColor) { const c = new Float32Array(rows * n * 3); c.fill(0.8); g.setAttribute('color', new THREE.BufferAttribute(c, 3)); }
  return g;
}

// Rééchantillonne le lasso fermé à un pas régulier (px) -> périmètre dense = plus
// de "colonnes" de grille sur les parois de coupe.
function resampleLasso(pts, step) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const segs = Math.max(1, Math.round(Math.hypot(dx, dy) / step));
    for (let s = 0; s < segs; s++) { const t = s / segs; out.push({ x: a.x + dx * t, y: a.y + dy * t }); }
  }
  return out;
}

// Construit le prisme du lasso pour un objet donné : densifie le périmètre + concentre
// les anneaux dans la tranche de profondeur de l'objet (croisillon sur les parois).
// Partagé par les modes CSG et Manifold.
export function buildLassoPrism(geometry, lassoPx, camera, matrixWorld, vw, vh, detail, hasUV, hasColor) {
  const d = Math.max(1, detail | 0);
  camera.updateMatrixWorld();
  const camPos = new THREE.Vector3(); camera.getWorldPosition(camPos);
  const camFwd = new THREE.Vector3(); camera.getWorldDirection(camFwd);
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox, c = new THREE.Vector3();
  let dmin = Infinity, dmax = -Infinity;
  for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) for (let zi = 0; zi < 2; zi++) {
    c.set(xi ? bb.max.x : bb.min.x, yi ? bb.max.y : bb.min.y, zi ? bb.max.z : bb.min.z).applyMatrix4(matrixWorld);
    const dv = (c.x - camPos.x) * camFwd.x + (c.y - camPos.y) * camFwd.y + (c.z - camPos.z) * camFwd.z;
    if (dv < dmin) dmin = dv; if (dv > dmax) dmax = dv;
  }
  const margin = Math.max((dmax - dmin) * 0.04, 1e-3); // caps hors de l'objet
  const dRange = { dmin: dmin - margin, dmax: dmax + margin };
  // Anneaux en PROFONDEUR : les parois du prisme entre 2 anneaux sont plates alors que la vraie
  // paroi du frustum (perspective) est une surface réglée courbe -> peu d'anneaux = parois qui ne
  // suivent pas le frustum -> coupe imprécise/trous sur surfaces courbes en profondeur. Manifold se
  // sert de ces subdivisions : on les rend denses (c'est au prisme de porter la résolution).
  // Anneaux denses en profondeur (parois du prisme fidèles au frustum perspective sur coupe courbe).
  const rings = Math.max(64, d * 8);
  const step = Math.max(4, Math.min(vw, vh) / (d * 12));
  let lasso = resampleLasso(lassoPx, step);
  if (lasso.length > 600) lasso = resampleLasso(lassoPx, step * (lasso.length / 600)); // garde-fou perf
  return buildPrism(lasso, camera, vw, vh, hasUV, hasColor, rings, dRange);
}

export function lassoSplitCSG(geometry, lassoPx, camera, matrixWorld, vw, vh, detail = 6) {
  if (lassoPx.length < 3) return null;
  const hasUV = !!geometry.attributes.uv;
  const hasColor = !!geometry.attributes.color;

  const prismGeo = buildLassoPrism(geometry, lassoPx, camera, matrixWorld, vw, vh, detail, hasUV, hasColor);

  const attrs = ['position', 'normal'];
  if (hasUV) attrs.push('uv');
  if (hasColor) attrs.push('color');
  _evaluator.attributes = attrs;

  const meshBrush = new Brush(geometry);
  meshBrush.matrixWorld.copy(matrixWorld);
  const prismBrush = new Brush(prismGeo);
  prismBrush.updateMatrixWorld();

  let inside, outside;
  try {
    // Les deux booleans en UNE passe (préparation partagée) -> ~2× plus rapide.
    const inB = new Brush(), outB = new Brush();
    _evaluator.evaluate(meshBrush, prismBrush, [INTERSECTION, SUBTRACTION], [inB, outB]);
    // Sortie brute (non indexée) = booléen pristine ; createObject ajoute l'index.
    inside = inB.geometry.clone();
    outside = outB.geometry.clone();
  } catch (e) {
    console.error(e);
    return null;
  }

  const tri = (g) => (g && g.index ? g.index.count / 3 : g ? g.attributes.position.count / 3 : 0);
  if (tri(inside) === 0 || tri(outside) === 0) return null; // rien séparé
  return { inside, outside };
}
