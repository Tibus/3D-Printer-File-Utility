// Mode d'affichage des objets : Texture (matériau réel), Matcap (rendu matcap sans
// texture, idéal pour juger la forme) ou Uni (argile plate). Le matériau "de base" de
// chaque objet est mémorisé dans mesh.userData.baseMat ; l'affichage en dérive.

import * as THREE from 'three';

let _matcapTex = null, _matcapMat = null, _clayMat = null;

// Matcap procédural : sphère éclairée grise (aspect argile/perle).
function matcapTexture() {
  if (_matcapTex) return _matcapTex;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#26282e'; x.fillRect(0, 0, 256, 256);
  const g = x.createRadialGradient(94, 88, 8, 128, 128, 150);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, '#c6cbd4');
  g.addColorStop(0.7, '#8a909b');
  g.addColorStop(0.92, '#565b64');
  g.addColorStop(1, '#33363d');
  x.fillStyle = g; x.beginPath(); x.arc(128, 128, 127, 0, Math.PI * 2); x.fill();
  _matcapTex = new THREE.CanvasTexture(c);
  _matcapTex.colorSpace = THREE.SRGBColorSpace;
  return _matcapTex;
}

function matcapMat() { if (!_matcapMat) _matcapMat = new THREE.MeshMatcapMaterial({ matcap: matcapTexture(), side: THREE.DoubleSide }); return _matcapMat; }
function clayMat() { if (!_clayMat) _clayMat = new THREE.MeshStandardMaterial({ color: 0xb9c0cc, roughness: 0.7, metalness: 0, flatShading: true, side: THREE.DoubleSide }); return _clayMat; }

// Matériau à afficher pour un matériau de base + un mode.
export function displayMaterial(baseMat, mode) {
  if (mode === 'matcap') return matcapMat();
  if (mode === 'clay') return clayMat();
  return baseMat; // 'texture'
}

// Applique le mode à tous les objets (sauf ceux en vue "épaisseur").
export function applyDisplayMode(objects, mode) {
  for (const m of objects) {
    if (m.userData._wallView) continue;
    if (!m.userData.baseMat) m.userData.baseMat = m.material;
    m.material = displayMaterial(m.userData.baseMat, mode);
  }
}
