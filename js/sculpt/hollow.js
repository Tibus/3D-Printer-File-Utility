// Évidement (coque creuse) : shell = solide − solide inset. Via Manifold.levelSet à
// deux niveaux du même SDF : niveau 0 = surface extérieure, niveau = épaisseur =>
// surface intérieure décalée vers l'intérieur. La différence donne une paroi d'épaisseur
// constante. Résultat watertight (fermé). thicknessFrac = épaisseur en fraction de la
// plus grande dimension de l'objet.

import { getManifold } from './split-manifold.js';
import { buildSDF, geomFromManifoldMesh } from './remesh.js';

export async function hollowMesh(geometry, thicknessFrac, resolution = 96) {
  const wasm = await getManifold();
  const { Manifold } = wasm;
  const built = buildSDF(geometry, resolution);
  if (!built) return null;
  const { sdf, bounds, edgeLength, maxDim } = built;
  const thickness = Math.max(edgeLength * 1.5, thicknessFrac * maxDim); // >= ~1.5 cellule

  let outer = null, inner = null, shell = null, result = null;
  try {
    outer = Manifold.levelSet(sdf, bounds, edgeLength, 0);
    inner = Manifold.levelSet(sdf, bounds, edgeLength, thickness);
    if (inner.numTri() === 0) return { tooThick: true }; // paroi trop épaisse : pas d'intérieur
    shell = Manifold.difference(outer, inner);
    const mm = shell.getMesh();
    if (!mm.triVerts.length) result = null;
    else result = { geometry: geomFromManifoldMesh(mm), thickness };
  } catch (e) {
    console.warn('[hollow] échec', e);
    result = null;
  } finally {
    for (const x of [outer, inner, shell]) { try { if (x) x.delete(); } catch (_) { /* noop */ } }
  }
  return result;
}
