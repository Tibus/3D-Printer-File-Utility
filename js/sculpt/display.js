// Mode d'affichage des objets. Le matériau "de base" de chaque objet est mémorisé dans
// mesh.userData.baseMat ; l'affichage en dérive.
//  - Texture : la TEXTURE éclairée par le MATCAP (matcap × map) -> jolies lumières SANS
//    lumière dans la scène (MeshMatcapMaterial multiplie le matcap par la map).
//  - Matcap : matcap seul (juger la forme).
//  - Uni : argile plate.

import * as THREE from 'three';

let _matcapTex = null, _matcapMat = null, _clayMat = null;
const _texCache = new WeakMap(); // baseMat -> son MeshMatcapMaterial texturé (pas dans userData

// Matcap procédural : sphère grise type studio. Plancher assez clair pour que la texture
// reste lisible partout (bords non noircis) tout en gardant un dégradé d'éclairage doux.
function matcapTexture() {
  if (_matcapTex) return _matcapTex;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#2a2c32'; x.fillRect(0, 0, 256, 256);
  const g = x.createRadialGradient(96, 84, 6, 128, 128, 160);
  g.addColorStop(0, '#ffffff');   // point chaud (lumière clé haut-gauche)
  g.addColorStop(0.35, '#e2e5ea');
  g.addColorStop(0.68, '#bcc1c9');
  g.addColorStop(0.9, '#9096a0');
  g.addColorStop(1, '#787d86');    // bord : gris moyen, pas noir -> texture reste visible
  x.fillStyle = g; x.beginPath(); x.arc(128, 128, 127, 0, Math.PI * 2); x.fill();
  _matcapTex = new THREE.CanvasTexture(c);
  _matcapTex.colorSpace = THREE.SRGBColorSpace;
  return _matcapTex;
}

function matcapMat() { if (!_matcapMat) _matcapMat = new THREE.MeshMatcapMaterial({ matcap: matcapTexture(), side: THREE.DoubleSide }); return _matcapMat; }
function clayMat() { if (!_clayMat) _clayMat = new THREE.MeshStandardMaterial({ color: 0xb9c0cc, roughness: 0.7, metalness: 0, flatShading: true, side: THREE.DoubleSide }); return _clayMat; }

// Texture éclairée par le matcap : MeshMatcapMaterial qui reprend la map/couleur/vertexColors
// du matériau réel. Mis en cache sur le baseMat. Le mask (teinte via onBeforeCompile) et les
// couleurs par sommet restent supportés.
function texturedMatcapMat(baseMat) {
  let m = _texCache.get(baseMat);
  if (!m) {
    m = new THREE.MeshMatcapMaterial({
      matcap: matcapTexture(),
      map: baseMat.map || null,
      color: baseMat.color ? baseMat.color.clone() : new THREE.Color(0xffffff),
      vertexColors: !!baseMat.vertexColors,
      flatShading: !!baseMat.flatShading,
      side: baseMat.side !== undefined ? baseMat.side : THREE.FrontSide,
      transparent: !!baseMat.transparent,
      opacity: baseMat.opacity !== undefined ? baseMat.opacity : 1,
    });
    _texCache.set(baseMat, m);
  }
  return m;
}

// Matériau à afficher pour un matériau de base + un mode.
export function displayMaterial(baseMat, mode) {
  if (mode === 'matcap') return matcapMat();
  if (mode === 'clay') return clayMat();
  return texturedMatcapMat(baseMat); // 'texture' = texture éclairée par le matcap
}

// Applique le mode à tous les objets (sauf ceux en vue "épaisseur").
export function applyDisplayMode(objects, mode) {
  for (const m of objects) {
    if (m.userData._wallView) continue;
    if (!m.userData.baseMat) m.userData.baseMat = m.material;
    m.material = displayMaterial(m.userData.baseMat, mode);
  }
}
