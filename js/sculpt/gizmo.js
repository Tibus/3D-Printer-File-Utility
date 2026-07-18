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

// Déformation live pondérée par le masque (les vertex masqués ne bougent jamais,
// dès le début du drag — pas de baking en fin de geste).
let live = null; // { mask, origPos, origNor, meshWorld, meshWorldInv, pivotStartInv }

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

// Démarre la déformation live : détache le mesh du pivot (il reste fixe dans la
// scène), mémorise positions/normales d'origine + les matrices de départ.
function startLiveDeform() {
  const mesh = currentMesh, geom = mesh.geometry;
  state.scene.attach(mesh); mesh.updateMatrixWorld(true);
  pivot.updateMatrixWorld(true);
  live = {
    mask: getMask(geom),
    origPos: Float32Array.from(geom.attributes.position.array),
    origNor: Float32Array.from(geom.attributes.normal.array),
    meshWorld: mesh.matrixWorld.clone(),
    meshWorldInv: mesh.matrixWorld.clone().invert(),
    pivotStartInv: pivot.matrixWorld.clone().invert(),
  };
}

const _delta = new THREE.Matrix4(), _local = new THREE.Matrix4();
// À chaque frame de drag : recompose les positions depuis l'origine, pondérées
// par (1 - masque). localDelta = meshWorldInv · (pivotNow · pivotStartInv) · meshWorld.
function applyLiveDeform() {
  if (!live || !currentMesh) return;
  const geom = currentMesh.geometry, pos = geom.attributes.position.array;
  const { mask, origPos, meshWorld, meshWorldInv, pivotStartInv } = live;
  pivot.updateMatrixWorld(true);
  _delta.multiplyMatrices(pivot.matrixWorld, pivotStartInv);
  _local.multiplyMatrices(_delta, meshWorld).premultiply(meshWorldInv);
  const e = _local.elements;
  for (let i = 0; i < mask.length; i++) {
    const v3 = i * 3, ox = origPos[v3], oy = origPos[v3 + 1], oz = origPos[v3 + 2];
    const w = 1 - mask[i];
    if (w <= 0) { pos[v3] = ox; pos[v3 + 1] = oy; pos[v3 + 2] = oz; continue; }
    const tx = e[0] * ox + e[4] * oy + e[8] * oz + e[12];
    const ty = e[1] * ox + e[5] * oy + e[9] * oz + e[13];
    const tz = e[2] * ox + e[6] * oy + e[10] * oz + e[14];
    pos[v3] = ox + (tx - ox) * w; pos[v3 + 1] = oy + (ty - oy) * w; pos[v3 + 2] = oz + (tz - oz) * w;
  }
  geom.attributes.position.needsUpdate = true;
  // Ombrage live via flatShading (dérivées de position) ; normales de sommets + BVH au relâchement.
}

// Relâchement : normales + BVH + entrée d'annulation (vertex non totalement masqués).
function endLiveDeform() {
  const mesh = currentMesh, geom = mesh.geometry;
  const pos = geom.attributes.position.array, nor = geom.attributes.normal.array;
  const { mask, origPos, origNor } = live;
  geom.computeVertexNormals();
  if (geom.boundsTree) geom.boundsTree.refit();
  const idx = [];
  for (let i = 0; i < mask.length; i++) if (mask[i] < 0.999) idx.push(i);
  const indices = new Uint32Array(idx), old = new Float32Array(idx.length * 6), neu = new Float32Array(idx.length * 6);
  for (let k = 0; k < indices.length; k++) {
    const v3 = indices[k] * 3, o = k * 6;
    old[o] = origPos[v3]; old[o + 1] = origPos[v3 + 1]; old[o + 2] = origPos[v3 + 2];
    old[o + 3] = origNor[v3]; old[o + 4] = origNor[v3 + 1]; old[o + 5] = origNor[v3 + 2];
    neu[o] = pos[v3]; neu[o + 1] = pos[v3 + 1]; neu[o + 2] = pos[v3 + 2];
    neu[o + 3] = nor[v3]; neu[o + 4] = nor[v3 + 1]; neu[o + 5] = nor[v3 + 2];
  }
  live = null;
  pushGeom({ mesh, indices, old, new: neu });
  activateGizmo(mesh); // pivot frais recentré, mesh ré-attaché
}

function onMouseUp() {
  if (live) { endLiveDeform(); return; }
  if (altMode || !currentMesh || !before) { normalizePivot(); return; }
  const after = worldTRS(currentMesh);
  if (after.p.equals(before.p) && after.q.equals(before.q) && after.s.equals(before.s)) { normalizePivot(); return; }
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
  tc.addEventListener('mouseDown', () => {
    before = currentMesh ? worldTRS(currentMesh) : null;
    if (currentMesh && !altMode && hasMask(currentMesh.geometry)) startLiveDeform();
  });
  tc.addEventListener('objectChange', () => { if (live) applyLiveDeform(); });
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
  const billboard = (obj) => {
    obj.onBeforeRender = () => {
      obj.parent.getWorldQuaternion(_pq).invert();
      obj.quaternion.copy(state.camera.quaternion).premultiply(_pq);
      obj.updateMatrixWorld(true); // recalcule la matrice pour CE rendu (sinon billboard sans effet)
    };
  };
  const vis = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.006, 4, 64), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, depthTest: false, toneMapped: false }));
  vis.name = 'XYZ'; vis.renderOrder = Infinity; billboard(vis); gz.gizmo.scale.add(vis);
  const pick = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.08, 4, 48), new THREE.MeshBasicMaterial({ visible: false }));
  pick.name = 'XYZ'; billboard(pick); gz.picker.scale.add(pick);
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
