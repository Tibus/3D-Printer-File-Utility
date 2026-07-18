// Vérification d'épaisseur de paroi : pour chaque sommet, on lance un rayon vers
// l'INTÉRIEUR (le long de -normale) et on mesure la distance à la paroi opposée. Les
// zones dont l'épaisseur locale est < seuil sont colorées en ROUGE (trop fines pour
// l'impression). Retourne un attribut couleur par sommet + la fraction trop fine.

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const _o = new THREE.Vector3(), _d = new THREE.Vector3();
const _ray = new THREE.Ray();

export function checkThickness(geometry, threshold) {
  if (!geometry.boundsTree) geometry.boundsTree = new MeshBVH(geometry);
  const pos = geometry.attributes.position.array;
  const nor = geometry.attributes.normal.array;
  const V = geometry.attributes.position.count;
  const colors = new Float32Array(V * 3);
  const eps = Math.max(threshold * 0.02, 1e-6);
  let thin = 0;
  for (let i = 0; i < V; i++) {
    _d.set(-nor[i * 3], -nor[i * 3 + 1], -nor[i * 3 + 2]);
    if (_d.lengthSq() < 1e-12) { colors[i * 3] = 0.8; colors[i * 3 + 1] = 0.8; colors[i * 3 + 2] = 0.82; continue; }
    _d.normalize();
    _o.set(pos[i * 3] + _d.x * eps, pos[i * 3 + 1] + _d.y * eps, pos[i * 3 + 2] + _d.z * eps);
    _ray.origin.copy(_o); _ray.direction.copy(_d);
    const hit = geometry.boundsTree.raycastFirst(_ray, THREE.DoubleSide);
    const t = hit ? hit.distance + eps : Infinity;
    if (t < threshold) {
      thin++;
      const f = Math.max(0, Math.min(1, t / threshold)); // 0 (très fin) -> 1 (au seuil)
      colors[i * 3] = 1; colors[i * 3 + 1] = 0.1 + 0.5 * f; colors[i * 3 + 2] = 0.1 + 0.3 * f; // rouge -> orange
    } else {
      colors[i * 3] = 0.78; colors[i * 3 + 1] = 0.80; colors[i * 3 + 2] = 0.84; // gris clair (OK)
    }
  }
  return { colors, thinFrac: thin / V };
}
