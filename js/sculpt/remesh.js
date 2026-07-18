// Voxel remesh : reconstruit un maillage propre et uniforme à partir d'un champ de
// distance signé (SDF) évalué via le BVH, transformé en surface watertight par
// Manifold.levelSet (marching tetrahedra). Idéal pour réparer/nettoyer les meshes IA
// (topologie blob, non-manifold, trous). La texture est conservée : les UV et/ou les
// couleurs par sommet sont RÉPROJETÉS sur le nouveau maillage (point le plus proche de
// l'original), et le matériau (donc l'image de texture) est réutilisé tel quel.

import * as THREE from 'three';
import { getManifold } from './split-manifold.js';

const _p = new THREE.Vector3();
const _A = new THREE.Vector3(), _B = new THREE.Vector3(), _C = new THREE.Vector3();
const _ab = new THREE.Vector3(), _ac = new THREE.Vector3(), _n = new THREE.Vector3();

// Coordonnées barycentriques de P dans le triangle ABC.
function bary(P, A, B, C, out) {
  _ab.subVectors(B, A); _ac.subVectors(C, A);
  const v2x = P.x - A.x, v2y = P.y - A.y, v2z = P.z - A.z;
  const d00 = _ab.dot(_ab), d01 = _ab.dot(_ac), d11 = _ac.dot(_ac);
  const d20 = _ab.x * v2x + _ab.y * v2y + _ab.z * v2z;
  const d21 = _ac.x * v2x + _ac.y * v2y + _ac.z * v2z;
  const denom = d00 * d11 - d01 * d01 || 1e-12;
  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  out[0] = 1 - v - w; out[1] = v; out[2] = w;
}

// Réprojette UV et/ou couleurs de srcGeom (via son BVH) sur newGeom (par sommet).
function reprojectAttrs(newGeom, srcGeom) {
  const hasUV = !!srcGeom.attributes.uv, hasColor = !!srcGeom.attributes.color;
  if (!hasUV && !hasColor) return;
  const bvh = srcGeom.boundsTree; if (!bvh) return;
  const sp = srcGeom.attributes.position.array, si = srcGeom.index.array;
  const suv = hasUV ? srcGeom.attributes.uv.array : null;
  const scol = hasColor ? srcGeom.attributes.color.array : null;
  const np = newGeom.attributes.position.array, V = newGeom.attributes.position.count;
  const nuv = hasUV ? new Float32Array(V * 2) : null;
  const ncol = hasColor ? new Float32Array(V * 3) : null;
  const target = {}, b = [0, 0, 0], P = new THREE.Vector3();
  for (let i = 0; i < V; i++) {
    _p.set(np[i * 3], np[i * 3 + 1], np[i * 3 + 2]);
    const hit = bvh.closestPointToPoint(_p, target);
    if (!hit) continue;
    const fi = hit.faceIndex, a = si[fi * 3], c1 = si[fi * 3 + 1], c2 = si[fi * 3 + 2];
    _A.fromArray(sp, a * 3); _B.fromArray(sp, c1 * 3); _C.fromArray(sp, c2 * 3);
    P.copy(hit.point); bary(P, _A, _B, _C, b);
    if (nuv) { nuv[i * 2] = b[0] * suv[a * 2] + b[1] * suv[c1 * 2] + b[2] * suv[c2 * 2]; nuv[i * 2 + 1] = b[0] * suv[a * 2 + 1] + b[1] * suv[c1 * 2 + 1] + b[2] * suv[c2 * 2 + 1]; }
    if (ncol) { for (let k = 0; k < 3; k++) ncol[i * 3 + k] = b[0] * scol[a * 3 + k] + b[1] * scol[c1 * 3 + k] + b[2] * scol[c2 * 3 + k]; }
  }
  if (nuv) newGeom.setAttribute('uv', new THREE.BufferAttribute(nuv, 2));
  if (ncol) newGeom.setAttribute('color', new THREE.BufferAttribute(ncol, 3));
}

// Construit la fonction SDF (distance signée : positif dedans, négatif dehors, via BVH)
// + les bornes et l'edgeLength pour Manifold.levelSet. Partagé remesh / évidement.
export function buildSDF(geometry, resolution) {
  if (!geometry.index) return null;
  if (!geometry.boundsTree) geometry.computeBoundsTree({ setBoundingBox: true });
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const size = new THREE.Vector3(); bb.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const pad = maxDim * 0.06;
  const bounds = { min: [bb.min.x - pad, bb.min.y - pad, bb.min.z - pad], max: [bb.max.x + pad, bb.max.y + pad, bb.max.z + pad] };
  const edgeLength = maxDim / Math.max(8, resolution | 0);
  const pos = geometry.attributes.position.array, index = geometry.index.array;
  const target = {};
  const sdf = (point) => {
    _p.set(point[0], point[1], point[2]);
    const hit = geometry.boundsTree.closestPointToPoint(_p, target);
    if (!hit) return -1e6;
    const fi = hit.faceIndex, a = index[fi * 3], b = index[fi * 3 + 1], c = index[fi * 3 + 2];
    _A.fromArray(pos, a * 3); _B.fromArray(pos, b * 3); _C.fromArray(pos, c * 3);
    _ab.subVectors(_B, _A); _ac.subVectors(_C, _A); _n.crossVectors(_ab, _ac);
    const dot = (_p.x - hit.point.x) * _n.x + (_p.y - hit.point.y) * _n.y + (_p.z - hit.point.z) * _n.z;
    return dot >= 0 ? -hit.distance : hit.distance; // dehors -> négatif, dedans -> positif
  };
  return { sdf, bounds, edgeLength, maxDim };
}

// Construit une géométrie THREE (position + normales) à partir d'un Manifold Mesh.
export function geomFromManifoldMesh(mm) {
  const numProp = mm.numProp, vp = mm.vertProperties, V = vp.length / numProp;
  const outPos = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) { const o = i * numProp; outPos[i * 3] = vp[o]; outPos[i * 3 + 1] = vp[o + 1]; outPos[i * 3 + 2] = vp[o + 2]; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  g.setIndex(new THREE.BufferAttribute(mm.triVerts instanceof Uint32Array ? mm.triVerts.slice() : new Uint32Array(mm.triVerts), 1));
  g.computeVertexNormals();
  return g;
}

// Remaille geometry par voxels. `resolution` = nb approx de cellules sur la plus grande
// dimension. Retourne une NOUVELLE géométrie (indexée, watertight) ou null.
export async function voxelRemesh(geometry, resolution = 64) {
  const wasm = await getManifold();
  const { Manifold } = wasm;
  const built = buildSDF(geometry, resolution);
  if (!built) return null;
  const { sdf, bounds, edgeLength } = built;

  let man = null, mm;
  try {
    man = Manifold.levelSet(sdf, bounds, edgeLength);
    mm = man.getMesh();
  } catch (e) { console.warn('[remesh] levelSet échec', e); if (man) man.delete(); return null; }
  const numProp = mm.numProp, vp = mm.vertProperties, V = vp.length / numProp;
  if (V === 0) { man.delete(); return null; }
  const outPos = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) { const o = i * numProp; outPos[i * 3] = vp[o]; outPos[i * 3 + 1] = vp[o + 1]; outPos[i * 3 + 2] = vp[o + 2]; }
  const outIdx = mm.triVerts instanceof Uint32Array ? mm.triVerts.slice() : new Uint32Array(mm.triVerts);
  man.delete();

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  g.setIndex(new THREE.BufferAttribute(outIdx, 1));
  g.computeVertexNormals();
  reprojectAttrs(g, geometry);
  return g;
}
