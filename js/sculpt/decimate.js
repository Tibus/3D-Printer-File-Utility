// Décimation (low-poly) par QEM edge-collapse via meshoptimizer (WASM). C'est le cœur
// reproductible de méthodes type TriFlow : QEM garde la fidélité géométrique et un nombre
// de triangles cible. (Le "flow" artiste de TriFlow vient d'un réseau de neurones non
// publié — hors navigateur ; on garde donc la partie QEM.)
//
// WATERTIGHT garanti : on soude par POSITION seule (les coutures UV, sinon non soudées,
// seraient vues comme des bords et perceraient le maillage) -> topologie fermée -> QEM
// préserve la fermeture. Les UV/couleurs sont ensuite RÉPROJETÉS depuis l'original
// (point le plus proche), comme le voxel remesh.

import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { MeshoptSimplifier } from 'meshoptimizer';
import { reprojectAttrs } from './remesh.js';

// Compacte une géométrie POSITION-seule : ne garde que les sommets référencés.
function compactPos(g) {
  const idx = g.index.array, src = g.attributes.position.array;
  const remap = new Map(); const out = []; const nidx = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i]; let nv = remap.get(v);
    if (nv === undefined) { nv = remap.size; remap.set(v, nv); out.push(src[v * 3], src[v * 3 + 1], src[v * 3 + 2]); }
    nidx[i] = nv;
  }
  const ng = new THREE.BufferGeometry();
  ng.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  ng.setIndex(new THREE.BufferAttribute(nidx, 1));
  return ng;
}

// ratio : fraction de triangles à GARDER (0.1 = 10%). Retourne { geometry, tris, error }.
export async function decimateMesh(geometry, ratio) {
  await MeshoptSimplifier.ready;
  const hasUV = !!geometry.attributes.uv, hasColor = !!geometry.attributes.color;

  // 1) topologie watertight : soudure par POSITION seule
  const posGeom = new THREE.BufferGeometry();
  posGeom.setAttribute('position', geometry.attributes.position.clone());
  if (geometry.index) posGeom.setIndex(geometry.index.clone());
  else { const n = geometry.attributes.position.count; const ix = new Uint32Array(n); for (let i = 0; i < n; i++) ix[i] = i; posGeom.setIndex(new THREE.BufferAttribute(ix, 1)); }
  const welded = mergeVertices(posGeom, 1e-5);

  const index = welded.index.array instanceof Uint32Array ? welded.index.array : new Uint32Array(welded.index.array);
  const pos = welded.attributes.position.array instanceof Float32Array ? welded.attributes.position.array : new Float32Array(welded.attributes.position.array);
  const triCount = index.length / 3;
  const targetIndexCount = Math.max(1, Math.floor(triCount * ratio)) * 3;
  if (targetIndexCount >= index.length) { const out = compactPos(welded); if (hasUV || hasColor) reproject(out, geometry); out.computeVertexNormals(); return { geometry: out, tris: triCount, error: 0 }; }

  // 2) simplification QEM (mesh fermé -> sortie watertight ; LockBorder protège les bords éventuels)
  const [simplified, error] = MeshoptSimplifier.simplify(index, pos, 3, targetIndexCount, 1.0, ['LockBorder']);
  welded.setIndex(new THREE.BufferAttribute(simplified, 1));
  const out = compactPos(welded);

  // 3) réprojection UV/couleurs depuis l'original
  if (hasUV || hasColor) reproject(out, geometry);
  out.computeVertexNormals();
  return { geometry: out, tris: simplified.length / 3, error };
}

function reproject(out, srcGeom) {
  if (!srcGeom.index) return; // reprojectAttrs a besoin d'un index sur la source
  if (!srcGeom.boundsTree) srcGeom.boundsTree = new MeshBVH(srcGeom);
  reprojectAttrs(out, srcGeom);
}
