// Gizmo de transformation COMBINÉ (translate + rotate + scale simultanés, façon
// Nomad) : trois TransformControls superposés sur un même groupe-pivot, à des
// tailles différentes pour rester lisibles. Pivot déplaçable (Alt). Rotations/
// échelles autour du pivot. Transforms annulables ; respecte le masque (bake).

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { state } from './state.js';
import { pushAction, pushGeom } from './history.js';
import { hasMask, getMask } from './mask.js';

let tcs = [];           // [translate, rotate, scale]
let pivot = null;
let currentMesh = null;
let active = false;
let altMode = false;
let before = null;

function worldTRS(obj) {
  obj.updateMatrixWorld(true);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  obj.matrixWorld.decompose(p, q, s);
  return { p, q, s };
}

function applyWorldTRS(mesh, trs) {
  const hadPivot = mesh.parent === pivot && pivot;
  state.scene.attach(mesh);
  mesh.position.copy(trs.p); mesh.quaternion.copy(trs.q); mesh.scale.copy(trs.s);
  mesh.updateMatrixWorld(true);
  if (hadPivot) pivot.attach(mesh);
}

function normalizePivot() {
  if (!pivot || !currentMesh) return;
  const wp = new THREE.Vector3(); pivot.getWorldPosition(wp);
  state.scene.attach(currentMesh);
  pivot.position.copy(wp); pivot.quaternion.identity(); pivot.scale.set(1, 1, 1);
  pivot.updateMatrixWorld(true);
  pivot.attach(currentMesh);
}

// Enclenche/désenclenche l'état "enabled/visible" des 3 gizmos selon l'état.
function refreshEnabled() {
  for (const tc of tcs) {
    const on = active && (!altMode || tc.mode === 'translate'); // en Alt : translate seul
    tc.enabled = on; tc.visible = on;
  }
}

function onMouseUp() {
  if (altMode || !currentMesh || !before) { normalizePivot(); return; }
  const after = worldTRS(currentMesh);
  if (after.p.equals(before.p) && after.q.equals(before.q) && after.s.equals(before.s)) { normalizePivot(); return; }
  if (hasMask(currentMesh.geometry)) { bakeMaskedTransform(currentMesh, before, after); return; }
  const mesh = currentMesh, b = before, a = after;
  normalizePivot();
  pushAction(() => applyWorldTRS(mesh, b), () => applyWorldTRS(mesh, a));
}

function wireTC(tc) {
  tc.addEventListener('dragging-changed', (e) => {
    state.controls.enabled = !e.value;
    if (e.value) { for (const o of tcs) if (o !== tc) { o.enabled = false; o.visible = false; } } // isole le drag courant
    else { refreshEnabled(); }
  });
  tc.addEventListener('mouseDown', () => { before = currentMesh ? worldTRS(currentMesh) : null; });
  tc.addEventListener('mouseUp', onMouseUp);
}

export function initGizmo() {
  const cam = state.camera, dom = state.renderer.domElement;
  const t = new TransformControls(cam, dom); t.setMode('translate'); t.setSize(0.85);
  const r = new TransformControls(cam, dom); r.setMode('rotate'); r.setSize(0.5);
  const s = new TransformControls(cam, dom); s.setMode('scale'); s.setSize(1.25);
  tcs = [t, r, s];
  for (const tc of tcs) { tc.setSpace('world'); wireTC(tc); state.scene.add(tc); tc.enabled = false; tc.visible = false; }
  customizeGizmos(r, s);
}

const _pq = new THREE.Quaternion();
function gizmoOf(tc) { return tc.children.find((c) => c.gizmo && c.picker); }

// Retire des poignées (nom) des groupes visuel + picker d'un mode.
function removeHandles(tc, mode, names) {
  const gz = gizmoOf(tc); if (!gz) return;
  for (const grp of ['gizmo', 'picker']) {
    const g = gz[grp] && gz[grp][mode]; if (!g) continue;
    for (const child of [...g.children]) if (names.includes(child.name)) g.remove(child);
  }
}

function customizeGizmos(r, s) {
  // rotation : retire l'anneau plan-caméra (E) et le grand cercle libre (XYZE)
  removeHandles(r, 'rotate', ['E', 'XYZE']);

  const gz = gizmoOf(s); if (!gz) return;
  // scale : retire les lignes d'axe (cylindres) ; garde les cubes (BoxGeometry)
  for (const child of [...gz.gizmo.scale.children]) {
    if (['X', 'Y', 'Z'].includes(child.name) && child.geometry && child.geometry.type === 'CylinderGeometry') gz.gizmo.scale.remove(child);
  }

  // scale uniforme : grand anneau face caméra (remplace le rôle de l'ex grand cercle)
  const ringMat = gz.gizmo.scale.children.find((c) => c.name === 'XYZ');
  const col = (ringMat && ringMat.material && ringMat.material.color) ? ringMat.material.color.clone() : new THREE.Color(0xffff00);
  const billboard = (obj) => { obj.onBeforeRender = () => { obj.parent.getWorldQuaternion(_pq).invert(); obj.quaternion.copy(state.camera.quaternion).premultiply(_pq); }; };
  const vis = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.006, 4, 64), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, depthTest: false, toneMapped: false }));
  vis.name = 'XYZ'; vis.renderOrder = Infinity; billboard(vis); gz.gizmo.scale.add(vis);
  const pick = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.08, 4, 48), new THREE.MeshBasicMaterial({ visible: false }));
  pick.name = 'XYZ'; billboard(pick); gz.picker.scale.add(pick);
}

function bakeMaskedTransform(mesh, before, after) {
  const geom = mesh.geometry;
  const mask = getMask(geom);
  const pos = geom.attributes.position.array, nor = geom.attributes.normal.array;
  const beforeM = new THREE.Matrix4().compose(before.p, before.q, before.s);
  const afterM = new THREE.Matrix4().compose(after.p, after.q, after.s);
  const beforeInv = beforeM.clone().invert();
  state.scene.attach(mesh);

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
  activateGizmo(mesh);
}

export function activateGizmo(mesh) {
  deactivateGizmo();
  if (!mesh || !tcs.length) return;
  currentMesh = mesh; active = true;
  pivot = new THREE.Group();
  mesh.geometry.computeBoundingBox();
  const c = new THREE.Vector3(); mesh.geometry.boundingBox.getCenter(c); c.applyMatrix4(mesh.matrixWorld);
  pivot.position.copy(c);
  state.scene.add(pivot); pivot.updateMatrixWorld(true);
  pivot.attach(mesh);
  for (const tc of tcs) tc.attach(pivot);
  refreshEnabled();
}

export function deactivateGizmo() {
  altMode = false;
  for (const tc of tcs) { tc.detach(); tc.enabled = false; tc.visible = false; }
  if (currentMesh && pivot && currentMesh.parent === pivot) state.scene.attach(currentMesh);
  if (pivot) { state.scene.remove(pivot); pivot = null; }
  currentMesh = null; active = false;
}

// Alt : déplacer le pivot seul (mesh détaché, seul le gizmo de translation actif).
export function setAltPivot(on) {
  if (!active || altMode === on) return;
  altMode = on;
  if (on) { if (currentMesh.parent === pivot) state.scene.attach(currentMesh); }
  else if (pivot && currentMesh) pivot.attach(currentMesh);
  refreshEnabled();
}

export function isGizmoActive() { return active; }
