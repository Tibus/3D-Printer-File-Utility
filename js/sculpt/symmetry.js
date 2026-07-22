// Système de symétrie multi-axes (X/Y/Z), espace LOCAL (suit la rotation de l'objet) ou WORLD.
// Le miroir se fait autour de l'ORIGINE de l'objet sélectionné. Fournit les points miroir d'un coup de
// brosse (jusqu'à 7 points supplémentaires pour X+Y+Z) et un helper visuel (plans de symétrie).

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { state } from './state.js';

const _p = new THREE.Vector3();
const _ONE = new THREE.Vector3(1, 1, 1);
const _mSym = new THREE.Matrix4(), _mSymInv = new THREE.Matrix4(), _mTmp = new THREE.Matrix4();
const _sTmp = new THREE.Vector3();

// Repère de symétrie LOCAL (position + rotation RELATIVES à l'objet). Par défaut : centre de la bounding
// box d'origine, sans rotation. Éditable via gizmo. Stocké dans mesh.userData.symFrame.
export function storeSymCenter(mesh) {
  if (!mesh || !mesh.geometry) return;
  const g = mesh.geometry; if (!g.boundingBox) g.computeBoundingBox();
  const c = g.boundingBox.getCenter(new THREE.Vector3());
  if (mesh.userData.symFrame) mesh.userData.symFrame.pos.copy(c);
  else mesh.userData.symFrame = { pos: c, quat: new THREE.Quaternion() };
}
function symFrameOf(mesh) {
  if (!mesh.userData.symFrame) storeSymCenter(mesh);
  if (!mesh.userData.symFrame) mesh.userData.symFrame = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  return mesh.userData.symFrame;
}
// Matrice MONDE du repère de symétrie = matrice de l'objet · (translation+rotation du repère, sans échelle).
function symWorldMatrix(mesh, out) {
  const f = symFrameOf(mesh);
  mesh.updateMatrixWorld();
  _mTmp.compose(f.pos, f.quat, _ONE);
  return out.multiplyMatrices(mesh.matrixWorld, _mTmp);
}
const _symQ = new THREE.Quaternion(), _symQi = new THREE.Quaternion();
function symWorldQuat(mesh, out) { mesh.getWorldQuaternion(out); return out.multiply(symFrameOf(mesh).quat); }

function activeAxes() {
  const s = state.params.symmetry; const a = [];
  if (s) { if (s.x) a.push(0); if (s.y) a.push(1); if (s.z) a.push(2); }
  return a;
}
export function symmetryActive() { return activeAxes().length > 0; }

// Renvoie les points MONDE miroir de `worldPoint` (hors point d'origine) selon les axes actifs + l'espace.
export function symmetryPoints(worldPoint) {
  const axes = activeAxes(); const mesh = state.targetMesh;
  if (!axes.length || !mesh) return [];
  const local = state.params.symmetrySpace !== 'world';
  // Local : miroir dans le REPÈRE de symétrie (centre + rotation éditables, suit l'objet).
  // Monde : autour de l'ORIGINE DU MONDE (0,0,0), axes du monde. _p.copy accepte un simple {x,y,z} (le coup _ls).
  if (local) { symWorldMatrix(mesh, _mSym); _mSymInv.copy(_mSym).invert(); }
  const base = (local ? _p.copy(worldPoint).applyMatrix4(_mSymInv) : _p.copy(worldPoint)).clone();
  const out = [];
  const n = axes.length;
  for (let m = 1; m < (1 << n); m++) { // toutes les combinaisons de reflets (2^n - 1)
    const q = base.clone();
    for (let i = 0; i < n; i++) if (m & (1 << i)) q.setComponent(axes[i], -q.getComponent(axes[i]));
    out.push(local ? q.applyMatrix4(_mSym) : q);
  }
  return out;
}

// Comme symmetryPoints mais renvoie aussi la NORMALE réfléchie -> pour orienter les curseurs fantômes.
const _n = new THREE.Vector3();
export function symmetryFrames(worldPoint, worldNormal) {
  const axes = activeAxes(); const mesh = state.targetMesh;
  if (!axes.length || !mesh) return [];
  const local = state.params.symmetrySpace !== 'world';
  mesh.updateMatrixWorld();
  let basePt, baseN;
  if (local) {
    symWorldMatrix(mesh, _mSym); _mSymInv.copy(_mSym).invert();
    symWorldQuat(mesh, _symQ); _symQi.copy(_symQ).invert();
    basePt = _p.copy(worldPoint).applyMatrix4(_mSymInv).clone();
    baseN = _n.copy(worldNormal).applyQuaternion(_symQi).clone(); // normale = direction (repère de symétrie)
  } else { // Monde : autour de l'origine du monde (0,0,0)
    basePt = _p.copy(worldPoint).clone();
    baseN = _n.copy(worldNormal).clone();
  }
  const out = []; const n = axes.length;
  for (let m = 1; m < (1 << n); m++) {
    const pt = basePt.clone(), nn = baseN.clone();
    for (let i = 0; i < n; i++) if (m & (1 << i)) { const a = axes[i]; pt.setComponent(a, -pt.getComponent(a)); nn.setComponent(a, -nn.getComponent(a)); }
    out.push({ point: local ? pt.applyMatrix4(_mSym) : pt, normal: (local ? nn.applyQuaternion(_symQ) : nn).normalize() });
  }
  return out;
}

// ---------- Curseurs fantômes aux points miroir (aperçu de ce qui sera peint/sculpté) ----------
let _ghosts = [];
const _UP = new THREE.Vector3(0, 0, 1), _gp = new THREE.Vector3(), _gn = new THREE.Vector3();
function initGhosts(scene) {
  const ringGeo = new THREE.RingGeometry(0.98, 1, 48), dotGeo = new THREE.SphereGeometry(1, 12, 10);
  for (let i = 0; i < 7; i++) { // X+Y+Z -> jusqu'à 7 miroirs
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, side: THREE.DoubleSide, transparent: true, opacity: 0.5, depthTest: false });
    const ring = new THREE.Mesh(ringGeo, ringMat); ring.renderOrder = 998; ring.frustumCulled = false; ring.visible = false;
    const dot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.6, depthTest: false })); dot.renderOrder = 998; dot.frustumCulled = false; dot.visible = false;
    scene.add(ring); scene.add(dot); _ghosts.push({ ring, dot });
  }
}
export function updateSymmetryCursor(active) {
  const bm = state.brushMesh;
  const on = !!(active && bm && bm.visible && symmetryActive() && state.targetMesh);
  if (!on) { for (const g of _ghosts) { g.ring.visible = false; g.dot.visible = false; } return; }
  // brushMesh est enfant direct de la scène -> position/quaternion locaux = monde (pas de matrixWorld périmée)
  _gp.copy(bm.position); _gn.copy(_UP).applyQuaternion(bm.quaternion); const sc = bm.scale.x;
  const frames = symmetryFrames(_gp, _gn);
  for (let i = 0; i < _ghosts.length; i++) {
    const g = _ghosts[i], f = frames[i];
    g.ring.visible = false; // pas de zone d'influence pour les miroirs, juste le point
    if (!f) { g.dot.visible = false; continue; }
    g.dot.visible = true; g.dot.position.copy(f.point); g.dot.scale.setScalar(Math.max(sc * 0.05, 1e-4));
  }
}

// ---------- Helper visuel : plans de symétrie ----------
let _group = null; const _planes = {};

export function initSymmetryHelper(scene) {
  _group = new THREE.Group(); _group.name = 'symmetryHelper'; _group.visible = false;
  const mk = (color, rotFn) => {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false });
    const m = new THREE.Mesh(geo, mat); m.renderOrder = 900; if (rotFn) rotFn(m); _group.add(m); return m;
  };
  _planes.x = mk(0xff5566, (m) => { m.rotation.y = Math.PI / 2; }); // normale = X -> plan YZ
  _planes.y = mk(0x66dd66, (m) => { m.rotation.x = Math.PI / 2; }); // normale = Y -> plan XZ
  _planes.z = mk(0x5599ff, () => {});                                // normale = Z -> plan XY
  scene.add(_group);
  initGhosts(scene);
  return _group;
}

const _box = new THREE.Box3(), _size = new THREE.Vector3();
export function updateSymmetryHelper(active) {
  if (!_group) return;
  const mesh = state.targetMesh, s = state.params.symmetry;
  const show = !!(active && mesh && s && (s.x || s.y || s.z) && state.params.symmetryShowPlanes);
  _group.visible = show;
  if (!show) return;
  const local = state.params.symmetrySpace !== 'world';
  mesh.updateMatrixWorld();
  _box.setFromObject(mesh);
  if (local) {
    // Repère de symétrie éditable (centre + rotation), transformé par la matrice de l'objet.
    symWorldMatrix(mesh, _mSym); _mSym.decompose(_group.position, _group.quaternion, _sTmp);
    _group.scale.set(1, 1, 1); // taille des plans gérée séparément (d) -> pas d'échelle d'objet
  } else {
    // Miroir autour de l'ORIGINE DU MONDE (0,0,0), axes du monde.
    _group.position.set(0, 0, 0);
    _group.quaternion.identity();
    _group.scale.set(1, 1, 1);
    _box.expandByPoint(_p.set(0, 0, 0)); // les plans doivent atteindre l'objet même s'il est décalé
  }
  _box.getSize(_size);
  const d = Math.max(_size.x, _size.y, _size.z) * 1.4 || 2;
  _planes.x.visible = !!s.x; _planes.y.visible = !!s.y; _planes.z.visible = !!s.z;
  _planes.x.scale.set(d, d, 1); _planes.y.scale.set(d, d, 1); _planes.z.scale.set(d, d, 1);
}

// ---------- Édition du repère de symétrie local (gizmo translate/rotate) ----------
let _tc = null, _proxy = null, _editing = false, _editMesh = null;
const _mEdit = new THREE.Matrix4(), _mEditInv = new THREE.Matrix4();
export function isSymEditing() { return _editing; }
export function symEditMesh() { return _editMesh; }
function ensureTC() {
  if (_tc) return _tc;
  _tc = new TransformControls(state.camera, state.renderer.domElement);
  _tc.setSize(0.8); _tc.setSpace('local');
  _tc.addEventListener('dragging-changed', (e) => { state.controls.enabled = !e.value; });
  _tc.addEventListener('objectChange', () => {
    if (!_editMesh) return;
    _proxy.updateMatrixWorld();
    _editMesh.updateMatrixWorld();
    _mEditInv.copy(_editMesh.matrixWorld).invert();
    _mEdit.multiplyMatrices(_mEditInv, _proxy.matrixWorld); // repère en LOCAL objet
    const f = symFrameOf(_editMesh);
    _mEdit.decompose(f.pos, f.quat, _sTmp);
  });
  state.scene.add(_tc);
  _proxy = new THREE.Object3D(); _proxy.name = 'symProxy'; state.scene.add(_proxy);
  return _tc;
}
export function setSymGizmoMode(mode) { if (_tc) _tc.setMode(mode === 'rotate' ? 'rotate' : 'translate'); }
export function enterSymEdit(mesh) {
  if (!mesh) return false;
  ensureTC();
  _editing = true; _editMesh = mesh;
  symWorldMatrix(mesh, _mSym); _mSym.decompose(_proxy.position, _proxy.quaternion, _proxy.scale);
  _proxy.updateMatrixWorld();
  _tc.attach(_proxy); _tc.enabled = true; _tc.visible = true;
  return true;
}
export function exitSymEdit() {
  _editing = false; _editMesh = null;
  if (_tc) { _tc.detach(); _tc.enabled = false; _tc.visible = false; }
}
// Réinitialise le repère de symétrie de l'objet actif (centre bbox, sans rotation).
export function resetSymFrame(mesh) {
  if (!mesh) return;
  storeSymCenter(mesh);
  if (mesh.userData.symFrame) mesh.userData.symFrame.quat.identity();
  if (_editing && _editMesh === mesh) { symWorldMatrix(mesh, _mSym); _mSym.decompose(_proxy.position, _proxy.quaternion, _proxy.scale); _proxy.updateMatrixWorld(); }
}
