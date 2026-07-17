// Gizmo de transformation (translate / rotate / scale) via TransformControls,
// avec un PIVOT déplaçable : le mesh est enfant d'un groupe-pivot, donc les
// rotations/échelles se font autour du pivot. Alt maintenu = on déplace le
// pivot seul (le mesh ne bouge pas). Transforms annulables (undo/redo).

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { state } from './state.js';
import { pushAction, pushGeom } from './history.js';
import { hasMask, getMask } from './mask.js';

let tc = null;          // TransformControls
let pivot = null;       // groupe-pivot (parent temporaire du mesh)
let currentMesh = null;
let active = false;
let altMode = false;    // déplacement du pivot seul
let before = null;      // TRS monde du mesh avant un drag (pour undo)

function worldTRS(obj) {
  obj.updateMatrixWorld(true);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  obj.matrixWorld.decompose(p, q, s);
  return { p, q, s };
}

// Restaure un TRS monde sur le mesh, quel que soit son parent courant.
function applyWorldTRS(mesh, trs) {
  const hadPivot = mesh.parent === pivot && pivot;
  state.scene.attach(mesh);
  mesh.position.copy(trs.p); mesh.quaternion.copy(trs.q); mesh.scale.copy(trs.s);
  mesh.updateMatrixWorld(true);
  if (hadPivot) pivot.attach(mesh);
}

// Après un drag : cuit la transfo dans le mesh et remet le pivot en repère pur
// (position au point de pivot, rotation/échelle identité) pour le prochain drag.
function normalizePivot() {
  if (!pivot || !currentMesh) return;
  const wp = new THREE.Vector3(); pivot.getWorldPosition(wp);
  state.scene.attach(currentMesh);
  pivot.position.copy(wp); pivot.quaternion.identity(); pivot.scale.set(1, 1, 1);
  pivot.updateMatrixWorld(true);
  pivot.attach(currentMesh);
}

export function initGizmo() {
  tc = new TransformControls(state.camera, state.renderer.domElement);
  tc.setSpace('world');
  tc.setSize(0.9);
  tc.addEventListener('dragging-changed', (e) => { state.controls.enabled = !e.value; });
  tc.addEventListener('mouseDown', () => { before = currentMesh ? worldTRS(currentMesh) : null; });
  tc.addEventListener('mouseUp', () => {
    if (altMode || !currentMesh || !before) return;
    const after = worldTRS(currentMesh);
    if (after.p.equals(before.p) && after.q.equals(before.q) && after.s.equals(before.s)) { normalizePivot(); return; }
    if (hasMask(currentMesh.geometry)) { bakeMaskedTransform(currentMesh, before, after); return; } // déformation pondérée
    const mesh = currentMesh, b = before, a = after;
    normalizePivot();
    pushAction(() => applyWorldTRS(mesh, b), () => applyWorldTRS(mesh, a));
  });
  state.scene.add(tc);
  tc.visible = false; tc.enabled = false;
}

// Avec un masque : au lieu d'un transform matriciel, on DÉFORME chaque sommet
// pondéré par (1-masque) et on le cuit dans la géométrie (les sommets masqués
// restent). Le mesh revient à son repère d'avant-drag. Annulable (geom).
function bakeMaskedTransform(mesh, before, after) {
  const geom = mesh.geometry;
  const mask = getMask(geom);
  const pos = geom.attributes.position.array, nor = geom.attributes.normal.array;
  const beforeM = new THREE.Matrix4().compose(before.p, before.q, before.s);
  const afterM = new THREE.Matrix4().compose(after.p, after.q, after.s);
  const beforeInv = beforeM.clone().invert();
  state.scene.attach(mesh); // world courant = afterM ; géométrie locale = originale

  const wB = new THREE.Vector3(), wF = new THREE.Vector3(), lN = new THREE.Vector3();
  const idxArr = [], oldA = [];
  for (let i = 0; i < mask.length; i++) {
    const w = 1 - mask[i]; if (w <= 0.001) continue;
    const v3 = i * 3, lx = pos[v3], ly = pos[v3 + 1], lz = pos[v3 + 2];
    wB.set(lx, ly, lz).applyMatrix4(beforeM);
    wF.set(lx, ly, lz).applyMatrix4(afterM);
    lN.set(wB.x + (wF.x - wB.x) * w, wB.y + (wF.y - wB.y) * w, wB.z + (wF.z - wB.z) * w).applyMatrix4(beforeInv);
    idxArr.push(i); oldA.push(lx, ly, lz, nor[v3], nor[v3 + 1], nor[v3 + 2]);
    pos[v3] = lN.x; pos[v3 + 1] = lN.y; pos[v3 + 2] = lN.z;
  }
  mesh.position.copy(before.p); mesh.quaternion.copy(before.q); mesh.scale.copy(before.s); mesh.updateMatrixWorld(true);
  geom.attributes.position.needsUpdate = true;
  geom.computeVertexNormals();
  if (geom.boundsTree) geom.boundsTree.refit();

  const indices = new Uint32Array(idxArr), old = Float32Array.from(oldA), neu = new Float32Array(indices.length * 6);
  for (let k = 0; k < indices.length; k++) { const v3 = indices[k] * 3, o = k * 6; neu[o] = pos[v3]; neu[o + 1] = pos[v3 + 1]; neu[o + 2] = pos[v3 + 2]; neu[o + 3] = nor[v3]; neu[o + 4] = nor[v3 + 1]; neu[o + 5] = nor[v3 + 2]; }
  pushGeom({ mesh, indices, old, new: neu });
  activateGizmo(mesh); // pivot frais au nouvel état
}

export function activateGizmo(mesh) {
  deactivateGizmo();
  if (!mesh || !tc) return;
  currentMesh = mesh; active = true;
  pivot = new THREE.Group();
  mesh.geometry.computeBoundingBox();
  const c = new THREE.Vector3(); mesh.geometry.boundingBox.getCenter(c); c.applyMatrix4(mesh.matrixWorld);
  pivot.position.copy(c);
  state.scene.add(pivot); pivot.updateMatrixWorld(true);
  pivot.attach(mesh);
  tc.attach(pivot); tc.visible = true; tc.enabled = true;
}

export function deactivateGizmo() {
  altMode = false;
  if (tc) { tc.detach(); tc.visible = false; tc.enabled = false; }
  if (currentMesh && pivot && currentMesh.parent === pivot) state.scene.attach(currentMesh);
  if (pivot) { state.scene.remove(pivot); pivot = null; }
  currentMesh = null; active = false;
}

export function setGizmoMode(mode) { if (tc && active) tc.setMode(mode); }

// Alt : bascule "déplacer le pivot seul". On détache le mesh (il reste en place)
// -> translater le gizmo déplace le pivot ; au relâcher, on ré-attache le mesh.
export function setAltPivot(on) {
  if (!active || altMode === on) return;
  altMode = on;
  if (on) {
    if (currentMesh.parent === pivot) state.scene.attach(currentMesh);
    tc.setMode('translate');
  } else if (pivot && currentMesh) {
    pivot.attach(currentMesh);
  }
}

export function isGizmoActive() { return active; }
