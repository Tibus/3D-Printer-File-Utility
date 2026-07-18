// Booléens entre DEUX objets de la scène (union / soustraction / intersection) via
// Manifold (WASM, robuste + watertight). Les deux maillages sont bakés en espace monde
// (ils ont des positions différentes dans la scène multi-objets) ; le résultat est en
// monde. Position seule (les deux objets ont des matériaux/UV différents -> on ne tente
// pas de fusionner les textures) ; le résultat prend le matériau de l'objet A.

import * as THREE from 'three';
import { getManifold } from './split-manifold.js';

// Mesh (monde) -> Manifold, position seule.
function meshToManifold(Manifold, Mesh, mesh) {
  const geom = mesh.geometry;
  const pos = geom.attributes.position.array, V = geom.attributes.position.count;
  mesh.updateMatrixWorld(true);
  const m = mesh.matrixWorld.elements;
  const vp = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const w = (m[3] * x + m[7] * y + m[11] * z + m[15]) || 1;
    vp[i * 3] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    vp[i * 3 + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    vp[i * 3 + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  }
  let tv;
  if (geom.index) tv = geom.index.array instanceof Uint32Array ? geom.index.array.slice() : new Uint32Array(geom.index.array);
  else { tv = new Uint32Array(V); for (let i = 0; i < V; i++) tv[i] = i; }
  const mm = new Mesh({ numProp: 3, vertProperties: vp, triVerts: tv });
  mm.merge();
  return new Manifold(mm);
}

// op : 'union' | 'subtract' | 'intersect'. Retourne { geometry } (monde) ou null (vide)
// ou { fallback:true } si un maillage n'est pas manifold.
export async function booleanObjects(meshA, meshB, op) {
  const wasm = await getManifold();
  const { Manifold, Mesh } = wasm;
  let a = null, b = null, r = null, result = null;
  try {
    a = meshToManifold(Manifold, Mesh, meshA);
    b = meshToManifold(Manifold, Mesh, meshB);
    if (a.numTri() === 0 || b.numTri() === 0) return { fallback: true };
    r = op === 'union' ? Manifold.union(a, b)
      : op === 'subtract' ? Manifold.difference(a, b)
        : Manifold.intersection(a, b);
    const mm = r.getMesh();
    if (!mm.triVerts.length) { result = null; }
    else {
      const V = mm.vertProperties.length / mm.numProp;
      const outPos = new Float32Array(V * 3);
      for (let i = 0; i < V; i++) { const o = i * mm.numProp; outPos[i * 3] = mm.vertProperties[o]; outPos[i * 3 + 1] = mm.vertProperties[o + 1]; outPos[i * 3 + 2] = mm.vertProperties[o + 2]; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
      g.setIndex(new THREE.BufferAttribute(mm.triVerts instanceof Uint32Array ? mm.triVerts.slice() : new Uint32Array(mm.triVerts), 1));
      g.computeVertexNormals();
      result = { geometry: g };
    }
  } catch (e) {
    console.warn('[boolean] échec', e);
    result = { fallback: true };
  } finally {
    for (const x of [a, b, r]) { try { if (x) x.delete(); } catch (_) { /* noop */ } }
  }
  return result;
}
