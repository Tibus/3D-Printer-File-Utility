// Split par lasso via Manifold (moteur CSG C++ compilé en WASM) : booléen du prisme
// du lasso avec le maillage. Beaucoup plus rapide que three-bvh-csg ET sortie garantie
// watertight/manifold. Réutilise le prisme "croisillon" de split-csg.js.
//   inside  = mesh ∩ prisme   ;   outside = mesh − prisme
//
// Manifold EXIGE une entrée manifold (watertight, 2-manifold). Si le maillage ne l'est
// pas, on renvoie { fallback: true } pour que l'appelant retombe sur three-bvh-csg.

import * as THREE from 'three';
import { buildLassoPrism } from './split-csg.js';

let _wasmPromise = null;
export async function getManifold() {
  if (!_wasmPromise) {
    _wasmPromise = (async () => {
      const M = await import('manifold-3d');
      const wasm = await M.default();
      wasm.setup();
      return wasm;
    })();
  }
  return _wasmPromise;
}

// Précharge le WASM au démarrage (mode "précis" par défaut) -> pas de délai à la 1re coupe.
export function warmupManifold() { getManifold().catch(() => { /* fallback CSG au moment venu */ }); }

function numPropOf(hasUV, hasColor) { return 3 + (hasUV ? 2 : 0) + (hasColor ? 3 : 0); }

// THREE.BufferGeometry -> Manifold Mesh. `matrix` (optionnel) bake local->monde.
// Ordre des propriétés : position(3) [+ uv(2)] [+ color(3)].
function toManifoldMesh(Mesh, geom, matrix, hasUV, hasColor) {
  const pos = geom.attributes.position.array;
  const uv = geom.attributes.uv ? geom.attributes.uv.array : null;
  const col = geom.attributes.color ? geom.attributes.color.array : null;
  const V = geom.attributes.position.count;
  const numProp = numPropOf(hasUV, hasColor);
  const vp = new Float32Array(V * numProp);
  const m = matrix ? matrix.elements : null;
  for (let i = 0; i < V; i++) {
    let x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    if (m) {
      const w = (m[3] * x + m[7] * y + m[11] * z + m[15]) || 1;
      const X = m[0] * x + m[4] * y + m[8] * z + m[12];
      const Y = m[1] * x + m[5] * y + m[9] * z + m[13];
      const Z = m[2] * x + m[6] * y + m[10] * z + m[14];
      x = X / w; y = Y / w; z = Z / w;
    }
    let o = i * numProp;
    vp[o] = x; vp[o + 1] = y; vp[o + 2] = z; o += 3;
    if (hasUV) { vp[o] = uv ? uv[i * 2] : 0; vp[o + 1] = uv ? uv[i * 2 + 1] : 0; o += 2; }
    if (hasColor) { vp[o] = col ? col[i * 3] : 0.8; vp[o + 1] = col ? col[i * 3 + 1] : 0.8; vp[o + 2] = col ? col[i * 3 + 2] : 0.8; }
  }
  let tv;
  if (geom.index) tv = geom.index.array instanceof Uint32Array ? geom.index.array.slice() : new Uint32Array(geom.index.array);
  else { tv = new Uint32Array(V); for (let i = 0; i < V; i++) tv[i] = i; }
  return new Mesh({ numProp, vertProperties: vp, triVerts: tv });
}

// Manifold Mesh -> THREE.BufferGeometry (copie hors du heap WASM). Normales recalculées.
function fromManifoldMesh(mm, hasUV, hasColor) {
  const numProp = mm.numProp, vp = mm.vertProperties, V = vp.length / numProp;
  const pos = new Float32Array(V * 3);
  const uv = hasUV ? new Float32Array(V * 2) : null;
  const col = hasColor ? new Float32Array(V * 3) : null;
  for (let i = 0; i < V; i++) {
    let o = i * numProp;
    pos[i * 3] = vp[o]; pos[i * 3 + 1] = vp[o + 1]; pos[i * 3 + 2] = vp[o + 2]; o += 3;
    if (hasUV) { if (uv) { uv[i * 2] = vp[o]; uv[i * 2 + 1] = vp[o + 1]; } o += 2; }
    if (hasColor && col) { col[i * 3] = vp[o]; col[i * 3 + 1] = vp[o + 1]; col[i * 3 + 2] = vp[o + 2]; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (uv) g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(mm.triVerts instanceof Uint32Array ? mm.triVerts.slice() : new Uint32Array(mm.triVerts), 1));
  g.computeVertexNormals();
  return g;
}

export async function lassoSplitManifold(geometry, lassoPx, camera, matrixWorld, vw, vh, detail = 6) {
  if (lassoPx.length < 3) return null;
  const hasUV = !!geometry.attributes.uv;
  const hasColor = !!geometry.attributes.color;

  let wasm;
  try { wasm = await getManifold(); } catch (e) { console.warn('[manifold] chargement échoué -> fallback CSG', e); return { fallback: true }; }
  const { Manifold, Mesh } = wasm;

  const prismGeo = buildLassoPrism(geometry, lassoPx, camera, matrixWorld, vw, vh, detail, hasUV, hasColor);

  let meshMan = null, prismMan = null, inM = null, outM = null, result = null;
  try {
    const meshMesh = toManifoldMesh(Mesh, geometry, matrixWorld, hasUV, hasColor); meshMesh.merge();
    const prismMesh = toManifoldMesh(Mesh, prismGeo, null, hasUV, hasColor); prismMesh.merge();
    meshMan = new Manifold(meshMesh);
    prismMan = new Manifold(prismMesh);
    // Entrée non manifold -> Manifold la rejette (0 triangle) -> fallback three-bvh-csg.
    if (meshMan.numTri() === 0) { console.warn('[manifold] maillage non-manifold -> fallback CSG'); return { fallback: true }; }
    inM = Manifold.intersection(meshMan, prismMan);
    outM = Manifold.difference(meshMan, prismMan);
    const inMesh = inM.getMesh(), outMesh = outM.getMesh();
    if (!inMesh.triVerts.length || !outMesh.triVerts.length) result = null; // rien séparé
    else result = { inside: fromManifoldMesh(inMesh, hasUV, hasColor), outside: fromManifoldMesh(outMesh, hasUV, hasColor), capMode: 'manifold' };
  } catch (e) {
    console.warn('[manifold] booléen échoué -> fallback CSG', e);
    result = { fallback: true };
  } finally {
    for (const m of [meshMan, prismMan, inM, outM]) { try { if (m) m.delete(); } catch (_) { /* noop */ } }
  }
  return result;
}
