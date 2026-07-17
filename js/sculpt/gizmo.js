// Gizmo de transformation (translate / rotate / scale) via TransformControls,
// avec un PIVOT déplaçable : le mesh est enfant d'un groupe-pivot, donc les
// rotations/échelles se font autour du pivot. Alt maintenu = on déplace le
// pivot seul (le mesh ne bouge pas). Transforms annulables (undo/redo).

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { state } from './state.js';
import { pushAction } from './history.js';

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
    const mesh = currentMesh, b = before, a = after;
    normalizePivot();
    pushAction(() => applyWorldTRS(mesh, b), () => applyWorldTRS(mesh, a));
  });
  state.scene.add(tc);
  tc.visible = false; tc.enabled = false;
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
