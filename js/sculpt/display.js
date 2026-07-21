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

// Matcap × vertex color À PLAT (pour le Vertex Paint FDM). Couleur constante PAR FACE (pas de fade) :
//  - normale par face via dérivées d'écran (dFdx/dFdy) -> éclairage matcap uniforme sur la face ;
//  - couleur `flat` (pas d'interpolation Gouraud entre sommets) -> frontières nettes sur maillage indexé.
// RawShaderMaterial GLSL3 : Three fournit position/color/modelViewMatrix/projectionMatrix.
let _vcFlatMat = null;
function vcFlatMat() {
  if (_vcFlatMat) return _vcFlatMat;
  _vcFlatMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    side: THREE.DoubleSide,
    uniforms: { matcap: { value: matcapTexture() } },
    vertexShader: `
      precision highp float;
      in vec3 position; in vec3 color;
      uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;
      out vec3 vView; flat out vec3 vColor;
      void main() { vColor = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D matcap;
      in vec3 vView; flat in vec3 vColor;
      out vec4 fragColor;
      void main() {
        vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));   // normale de face (espace vue)
        if (dot(n, vView) > 0.0) n = -n;                       // orientée vers la caméra
        vec3 e = normalize(vView);
        vec3 r = reflect(e, n);
        float m = 2.0 * sqrt(r.x * r.x + r.y * r.y + (r.z + 1.0) * (r.z + 1.0));
        vec2 uv = r.xy / m + 0.5;
        fragColor = vec4(texture(matcap, uv).rgb * vColor, 1.0);
      }
    `,
  });
  return _vcFlatMat;
}

// Matériau à afficher pour un matériau de base + un mode.
export function displayMaterial(baseMat, mode) {
  if (mode === 'matcap') return matcapMat();
  if (mode === 'clay') return clayMat();
  if (mode === 'vcflat') return vcFlatMat(); // matcap × couleur par sommet, à plat (Vertex Paint)
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
