// Édition de POSE d'un modèle riggé — reproduit le comportement du GLB-Bones-editor :
//  - marqueur cliquable par os ; les os « Twist » sont grisés et NON sélectionnables ;
//  - clic sur le mesh : cyclage entre les os empilés au même endroit (reclic = suivant) ;
//  - gizmo de rotation (TransformControls local) sur l'os sélectionné -> déformation live ;
//  - API de sélection (par index) pour la liste d'os + le schéma SVG + les sliders de rotation.
// Le module gère le 3D + la sélection ; main.js construit la liste/schéma/sliders et écoute onSelect.

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { state } from './state.js';
import { rigOf, resetRigPose } from './rig.js';

let _tc = null, _group = null, _markers = [], _pickables = [];
let _rig = null, _obj = null, _bones = [], _selectedIndex = -1, _active = false, _onSelect = null;
let _gizmoMode = 'rotate'; // 'rotate' (pose) | 'translate' (offset de joint)
const _raycaster = new THREE.Raycaster();

// Bascule le gizmo entre rotation (pose) et translation (offset du joint).
export function setGizmoMode(mode) {
  _gizmoMode = mode === 'translate' ? 'translate' : 'rotate';
  if (_tc) { _tc.setMode(_gizmoMode); _tc.setSpace(_gizmoMode === 'rotate' ? 'local' : 'world'); }
}
export function gizmoMode() { return _gizmoMode; }

export function isTwistBone(bone) { return (bone.name || '').toLowerCase().includes('twist'); }
export function isPoseActive() { return _active; }
export function poseBones() { return _bones; }
export function selectedIndex() { return _selectedIndex; }

function ensureTC() {
  if (_tc) return _tc;
  _tc = new TransformControls(state.camera, state.renderer.domElement);
  _tc.setMode('rotate'); _tc.setSpace('local'); _tc.setSize(0.7);
  _tc.addEventListener('dragging-changed', (e) => { state.controls.enabled = !e.value; });
  _tc.addEventListener('mouseDown', () => { if (_gizmoMode === 'translate') beginJointDrag(); });
  _tc.addEventListener('objectChange', () => { if (_gizmoMode === 'translate') applyJointFreeze(); if (_rig) _rig.poseDirty = true; if (_onSelect) _onSelect(_selectedIndex); });
  _tc.addEventListener('mouseUp', () => { _jointSnap = null; });
  state.scene.add(_tc);
  _tc.enabled = false; _tc.visible = false;
  return _tc;
}

// --- Offset de joint : déplacer l'os SANS bouger le skin. On garde S = matrixWorld·boneInverse constant
// (recalcul du boneInverse), et on maintient les enfants à leur position monde (seul le joint bouge). ---
let _jointSnap = null;
const _mInvB = new THREE.Matrix4(), _mLocal = new THREE.Matrix4();
function beginJointDrag() {
  const b = selectedBone(); if (!b || !_rig) return;
  b.updateMatrixWorld(true);
  const S = [];
  for (const sm of _rig.skinned) {
    const idx = sm.skeleton.bones.indexOf(b); if (idx < 0) continue;
    S.push({ sm, idx, snap: new THREE.Matrix4().multiplyMatrices(b.matrixWorld, sm.skeleton.boneInverses[idx]) });
  }
  const children = [];
  for (const c of b.children) if (c.isBone) children.push({ bone: c, world: c.matrixWorld.clone() });
  _jointSnap = { bone: b, S, children };
}
function applyJointFreeze() {
  const s = _jointSnap; if (!s) return;
  const b = s.bone; b.updateMatrixWorld(true);
  _mInvB.copy(b.matrixWorld).invert();
  for (const e of s.S) e.sm.skeleton.boneInverses[e.idx].multiplyMatrices(_mInvB, e.snap); // fige les vertex de B
  for (const c of s.children) { // les enfants gardent leur position monde -> seul le joint B se déplace
    _mLocal.multiplyMatrices(_mInvB, c.world);
    c.bone.position.setFromMatrixPosition(_mLocal);
    c.bone.updateMatrixWorld(true);
  }
}

// Facteur angulaire : rayon monde = distance · facteur -> taille ÉCRAN constante (~2% de la hauteur de vue).
function angularScale() {
  const fov = state.camera && state.camera.isPerspectiveCamera ? state.camera.fov : 50;
  return Math.tan(THREE.MathUtils.degToRad(fov / 2)) * 0.02;
}

// onSelect(index) : appelé à chaque changement de sélection (main.js met à jour l'UI).
// opts.noGizmo : ne pas attacher le gizmo (utilisé par le weight-paint qui réutilise la SÉLECTION d'os).
let _noGizmo = false;
export function enterPose(obj, onSelect, opts) {
  exitPose();
  const rig = rigOf(obj); if (!rig || !rig.bones.length) return false;
  _obj = obj; _rig = rig; _bones = rig.bones; _onSelect = onSelect || null; _active = true; _noGizmo = !!(opts && opts.noGizmo);
  ensureTC();
  _group = new THREE.Group(); _group.name = 'poseMarkers';
  const geo = new THREE.SphereGeometry(1, 12, 12); // sphère unité ; l'échelle par frame donne une taille écran constante
  _bones.forEach((bone, i) => {
    const twist = isTwistBone(bone);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: twist ? 0x666666 : 0x4a9aff, transparent: true, opacity: twist ? 0.35 : 0.85, depthTest: false }));
    m.renderOrder = 999; m.frustumCulled = false;
    m.userData.boneIndex = i; m.userData.twist = twist;
    _group.add(m); _markers.push(m);
    if (!twist) _pickables.push(m); // seuls les non-Twist sont cliquables (comme l'éditeur)
  });
  state.scene.add(_group);
  updatePoseMarkers();
  return true;
}

export function exitPose() {
  _active = false; _selectedIndex = -1;
  if (_tc) { _tc.detach(); _tc.enabled = false; _tc.visible = false; }
  if (_group) { state.scene.remove(_group); _group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } }); _group = null; }
  _markers = []; _pickables = []; _rig = null; _obj = null; _bones = []; _onSelect = null;
}

export function updatePoseMarkers() {
  if (!_active) return;
  const camPos = state.camera.position, k = angularScale();
  for (const m of _markers) {
    _bones[m.userData.boneIndex].getWorldPosition(m.position);
    m.scale.setScalar(Math.max(1e-4, m.position.distanceTo(camPos) * k)); // rayon monde ∝ distance -> taille écran constante
  }
}

// Filtre les markers empilés (à <15% du plus proche) — comme pickStackedBones de l'éditeur.
function stacked(intersects) {
  if (!intersects.length) return [];
  const first = intersects[0].distance, tol = Math.max(0.05, first * 0.15);
  const out = [];
  for (const hit of intersects) { if (hit.distance > first + tol) break; out.push(hit.object); }
  return out;
}
// Choix dans la pile : si l'os courant y est -> le suivant (cyclage, peut inclure un Twist) ; sinon
// première sélection -> le premier NON-Twist (ou le premier à défaut).
function chooseInStack(stk) {
  const cur = _selectedIndex >= 0 ? stk.findIndex((m) => m.userData.boneIndex === _selectedIndex) : -1;
  if (cur !== -1) return stk[(cur + 1) % stk.length];
  return stk.find((m) => !m.userData.twist) || stk[0];
}

// Clic 3D : sélectionne l'os sous la souris avec cyclage sur reclic. includeTwist=true (weight paint)
// -> les Twist entrent dans la pile et sont atteignables par cyclage (mais jamais en 1re sélection).
export function pickBoneAtMouse(includeTwist) {
  if (!_active) return false;
  const targets = includeTwist ? _markers : _pickables;
  if (!targets.length) return false;
  _raycaster.setFromCamera(state.mouse, state.camera);
  const stk = stacked(_raycaster.intersectObjects(targets, false));
  if (!stk.length) return false;
  selectByIndex(chooseInStack(stk).userData.boneIndex);
  return true;
}

// True si un marqueur d'os est sous la souris (sans sélectionner) — pour masquer le cercle d'influence.
export function markerUnderMouse(includeTwist) {
  if (!_active) return false;
  const targets = includeTwist ? _markers : _pickables;
  if (!targets.length) return false;
  _raycaster.setFromCamera(state.mouse, state.camera);
  return _raycaster.intersectObjects(targets, false).length > 0;
}

export function selectByIndex(index) {
  const bone = _bones[index];
  if (!bone) return; // NB : les Twist sont sélectionnables ICI (via la liste) mais pas au clic souris (voir _pickables)
  _selectedIndex = index;
  for (const m of _markers) m.material.color.setHex(m.userData.boneIndex === index ? 0xffff00 : (m.userData.twist ? 0x666666 : 0x4a9aff));
  if (_noGizmo) { if (_tc) { _tc.detach(); _tc.enabled = false; _tc.visible = false; } }
  else {
    const tc = ensureTC();
    tc.setMode(_gizmoMode); tc.setSpace(_gizmoMode === 'rotate' ? 'local' : 'world');
    // Twist en rotation : n'autoriser que l'axe Y (rotation autour de l'axe principal), comme l'éditeur.
    const restrictY = isTwistBone(bone) && _gizmoMode === 'rotate';
    tc.showX = !restrictY; tc.showY = true; tc.showZ = !restrictY;
    tc.attach(bone); tc.enabled = true; tc.visible = true;
  }
  if (_onSelect) _onSelect(index);
}

export function selectedBone() { return _selectedIndex >= 0 ? _bones[_selectedIndex] : null; }

export function resetPose() {
  if (_obj) resetRigPose(_obj); // restaure rotations + positions + boneInverses (annule pose ET offsets)
  _selectedIndex = -1;
  if (_tc) { _tc.detach(); _tc.enabled = false; _tc.visible = false; }
  for (const m of _markers) m.material.color.setHex(m.userData.twist ? 0x666666 : 0x4a9aff);
  updatePoseMarkers();
  if (_onSelect) _onSelect(-1);
}
