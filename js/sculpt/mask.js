// Masque par sommet [0..1] (1 = protégé). Stocké sur la géométrie :
//   userData.maskSharp : masque peint (net)
//   attribut 'mask'    : masque effectif (net ou flouté) utilisé par les outils
//   userData.maskBlur  : nombre d'itérations de flou
//   userData.neighbors : voisinage (posé par setActiveObject) pour le flou
// Visualisé via un patch du matériau (teinte les zones masquées).

import * as THREE from 'three';

const TINT = { r: 0.18, g: 0.32, b: 0.7 }; // teinte du masque (bleu, façon Nomad)

export function ensureMask(geometry, material) {
  if (!geometry.attributes.mask) {
    const n = geometry.attributes.position.count;
    geometry.setAttribute('mask', new THREE.BufferAttribute(new Float32Array(n), 1));
    geometry.userData.maskSharp = new Float32Array(n);
    geometry.userData.maskBlur = geometry.userData.maskBlur || 0;
  }
  if (material) patchMaterial(material);
  return geometry.userData.maskSharp;
}

export function getMask(geometry) { return geometry.attributes.mask ? geometry.attributes.mask.array : null; }

export function hasMask(geometry) {
  const a = geometry.attributes.mask; if (!a) return false;
  const arr = a.array;
  for (let i = 0; i < arr.length; i++) if (arr[i] > 0.001) return true;
  return false;
}

function patchMaterial(material) {
  if (!material || material.userData.maskPatched) return;
  material.userData.maskPatched = true;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute float mask;\nvarying float vMask;\n' +
      shader.vertexShader.replace('void main() {', 'void main() {\n\tvMask = mask;');
    shader.fragmentShader = 'varying float vMask;\n' +
      shader.fragmentShader.replace('#include <dithering_fragment>',
        `#include <dithering_fragment>\n\tgl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(${TINT.r}, ${TINT.g}, ${TINT.b}), vMask * 0.6);`);
  };
  material.needsUpdate = true;
}

// Reconstruit l'attribut 'mask' depuis le masque net + flou (Laplacien N passes).
export function rebuildMask(geometry) {
  const sharp = geometry.userData.maskSharp;
  const attr = geometry.attributes.mask;
  if (!sharp || !attr) return;
  const iters = geometry.userData.maskBlur | 0;
  const neighbors = geometry.userData.neighbors;
  if (iters <= 0 || !neighbors) { attr.array.set(sharp); attr.needsUpdate = true; return; }
  let a = Float32Array.from(sharp), b = new Float32Array(a.length);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < a.length; i++) {
      const nb = neighbors[i];
      if (!nb || !nb.length) { b[i] = a[i]; continue; }
      let s = a[i];
      for (let k = 0; k < nb.length; k++) s += a[nb[k]];
      b[i] = s / (nb.length + 1);
    }
    const t = a; a = b; b = t;
  }
  attr.array.set(a); attr.needsUpdate = true;
}

export function invertMask(geometry) {
  const sharp = geometry.userData.maskSharp; if (!sharp) return;
  for (let i = 0; i < sharp.length; i++) sharp[i] = 1 - sharp[i];
  rebuildMask(geometry);
}

export function clearMask(geometry) {
  const sharp = geometry.userData.maskSharp; if (!sharp) return;
  sharp.fill(0); rebuildMask(geometry);
}

export function setMaskBlur(geometry, iters) {
  if (!geometry.userData || !geometry.userData.maskSharp) return;
  geometry.userData.maskBlur = iters;
  rebuildMask(geometry);
}

// ---------- Enregistrement undo (sommets de masque touchés) ----------
let _recGeom = null, _recStamp = null, _recId = 0;
const _recIdx = [], _recOld = [];
export function maskRecordBegin(geometry) {
  _recGeom = geometry;
  const n = geometry.userData.maskSharp.length;
  if (!_recStamp || _recStamp.length < n) _recStamp = new Uint32Array(n);
  _recId++; _recIdx.length = 0; _recOld.length = 0;
}
export function maskRecordTouch(i) {
  if (!_recGeom || _recStamp[i] === _recId) return;
  _recStamp[i] = _recId; _recIdx.push(i); _recOld.push(_recGeom.userData.maskSharp[i]);
}
export function maskRecordEnd() {
  const geometry = _recGeom; _recGeom = null;
  if (!geometry || _recIdx.length === 0) return null;
  const sharp = geometry.userData.maskSharp;
  const indices = new Uint32Array(_recIdx), old = Float32Array.from(_recOld), neu = new Float32Array(indices.length);
  for (let k = 0; k < indices.length; k++) neu[k] = sharp[indices[k]];
  return { geometry, indices, old, new: neu };
}
