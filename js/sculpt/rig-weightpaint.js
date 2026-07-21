// Weight-paint (édition du skinning) — porté du GLB-Bones-editor. Peint le poids de l'os sélectionné sur
// les vertices sous le pinceau (add / retrait), renormalise les 4 slots skinWeight à 1, propage aux
// jumeaux de couture, et affiche une HEATMAP (bleu 0 -> rouge 1) du poids de l'os courant. Peint en pose
// de repos (BVH), réutilise state.rep/groupMembers (coutures) et state.vertexNeighbors (lissage).

import * as THREE from 'three';
import { INTERSECTED, NOT_INTERSECTED } from 'three-mesh-bvh';
import { state } from './state.js';
import { rigOf } from './rig.js';

let _active = false, _rig = null, _bone = null;
const _saved = []; // { mesh, color, material } pour restaurer en sortie

// Proxy de raycast : mesh NON skinné dont la géométrie contient les positions SKINNÉES (monde) du mesh
// actif + un BVH. Permet de raycaster/collecter sur la surface POSÉE sans toucher geometry.position (qui
// doit rester en bind pour le skinning GPU). Rebati à l'entrée du weight paint (= recalcul BVH au switch).
const _proxy = new THREE.Mesh(new THREE.BufferGeometry());
_proxy.matrixAutoUpdate = false; // positions déjà en monde -> matrixWorld = identité
const _ray = new THREE.Raycaster(); _ray.firstHitOnly = true;
const _sphere = new THREE.Sphere(); const _wpSeen = new Set();

export function bakeProxy() {
  const sm = state.targetMesh; if (!sm || !sm.isSkinnedMesh || !sm.geometry.attributes.position) return;
  sm.updateMatrixWorld(true);
  const pos = sm.geometry.attributes.position, n = pos.count, arr = new Float32Array(n * 3), v = new THREE.Vector3();
  for (let i = 0; i < n; i++) { v.fromBufferAttribute(pos, i); sm.applyBoneTransform(i, v); v.applyMatrix4(sm.matrixWorld); arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z; }
  const g = _proxy.geometry;
  if (g.boundsTree) g.disposeBoundsTree();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  // IMPORTANT : cloner l'index — computeBoundsTree RÉORDONNE l'index en place ; partager celui du mesh
  // corromprait l'ordre des triangles vis-à-vis du BVH du mesh (casse draw/sculpt).
  if (sm.geometry.index) g.setIndex(sm.geometry.index.clone());
  else { const seq = new Uint32Array(n); for (let i = 0; i < n; i++) seq[i] = i; g.setIndex(new THREE.BufferAttribute(seq, 1)); }
  g.computeBoundsTree();
}
// Raycast la surface posée -> intersection (avec .point, .face) ou null.
export function pickPoint(mouse) {
  if (!_proxy.geometry.boundsTree) return null;
  _ray.setFromCamera(mouse, state.camera);
  const hits = _ray.intersectObject(_proxy, false);
  return hits.length ? hits[0] : null;
}
// Indices des sommets dont la position skinnée est dans la sphère (via BVH du proxy).
function collectSkinned(worldPoint, radius) {
  _wpSeen.clear();
  const g = _proxy.geometry, bvh = g.boundsTree; if (!bvh) return _wpSeen;
  const idx = g.index.array;
  _sphere.center.copy(worldPoint); _sphere.radius = radius;
  bvh.shapecast({
    intersectsBounds: (box) => (_sphere.intersectsBox(box) ? INTERSECTED : NOT_INTERSECTED),
    intersectsTriangle: (_t, ti) => { const i3 = ti * 3; _wpSeen.add(idx[i3]); _wpSeen.add(idx[i3 + 1]); _wpSeen.add(idx[i3 + 2]); return false; },
  });
  return _wpSeen;
}

export function isWeightPaintActive() { return _active; }

// ---------- Undo : enregistrement des skinIndex/skinWeight touchés d'un coup de pinceau ----------
let _rec = null; // { mesh, seen:Set, idx:[], oldI:[], oldW:[] }
export function beginWeightStroke() {
  const mesh = state.targetMesh; if (!mesh || !mesh.geometry.attributes.skinWeight) { _rec = null; return; }
  _rec = { mesh, seen: new Set(), idx: [], oldI: [], oldW: [] };
}
function recordVertex(geom, v) {
  if (!_rec || _rec.seen.has(v)) return; _rec.seen.add(v);
  const I = geom.attributes.skinIndex.array, W = geom.attributes.skinWeight.array, b = v * 4;
  _rec.idx.push(v);
  for (let k = 0; k < 4; k++) { _rec.oldI.push(I[b + k]); _rec.oldW.push(W[b + k]); }
}
// Renvoie l'enregistrement { mesh, indices, oldI, oldW, newI, newW } ou null (rien changé).
export function endWeightStroke() {
  const r = _rec; _rec = null; if (!r || !r.idx.length) return null;
  const geom = r.mesh.geometry, I = geom.attributes.skinIndex.array, W = geom.attributes.skinWeight.array;
  const n = r.idx.length, indices = Uint32Array.from(r.idx);
  const oldI = Uint16Array.from(r.oldI), oldW = Float32Array.from(r.oldW);
  const newI = new Uint16Array(n * 4), newW = new Float32Array(n * 4);
  for (let j = 0; j < n; j++) { const b = indices[j] * 4, o = j * 4; for (let k = 0; k < 4; k++) { newI[o + k] = I[b + k]; newW[o + k] = W[b + k]; } }
  return { mesh: r.mesh, indices, oldI, oldW, newI, newW };
}
// Applique un enregistrement (undo/redo) et rafraîchit la heatmap.
export function applySkinRecord(rec, useNew) {
  const geom = rec.mesh.geometry, I = geom.attributes.skinIndex, W = geom.attributes.skinWeight;
  if (!I || !W) return;
  const si = I.array, sw = W.array, srcI = useNew ? rec.newI : rec.oldI, srcW = useNew ? rec.newW : rec.oldW;
  for (let j = 0; j < rec.indices.length; j++) { const b = rec.indices[j] * 4, o = j * 4; for (let k = 0; k < 4; k++) { si[b + k] = srcI[o + k]; sw[b + k] = srcW[o + k]; } }
  I.needsUpdate = true; W.needsUpdate = true;
  if (_active) refreshWeights();
}

// Heatmap bleu(0)->cyan->vert->jaune->rouge(1) (identique à l'éditeur).
function heat(w, out) {
  w = w < 0 ? 0 : (w > 1 ? 1 : w);
  if (w < 0.25) { const t = w / 0.25; out[0] = 0; out[1] = t; out[2] = 1; }
  else if (w < 0.5) { const t = (w - 0.25) / 0.25; out[0] = 0; out[1] = 1; out[2] = 1 - t; }
  else if (w < 0.75) { const t = (w - 0.5) / 0.25; out[0] = t; out[1] = 1; out[2] = 0; }
  else { const t = (w - 0.75) / 0.25; out[0] = 1; out[1] = 1 - t; out[2] = 0; }
}

function ensureColorAttr(geom) {
  let c = geom.attributes.color;
  if (!c || c.count !== geom.attributes.position.count) {
    const arr = new Float32Array(geom.attributes.position.count * 3);
    c = new THREE.BufferAttribute(arr, 3); geom.setAttribute('color', c);
  }
  return c;
}

export function enterWeightPaint(obj) {
  exitWeightPaint();
  const rig = rigOf(obj); if (!rig || !rig.skinned.length) return false;
  _rig = rig; _active = true;
  for (const sm of rig.skinned) {
    if (!sm.geometry.attributes.skinWeight || !sm.geometry.attributes.skinIndex) continue;
    _saved.push({ mesh: sm, color: sm.geometry.attributes.color || null, material: sm.material });
    ensureColorAttr(sm.geometry);
    sm.material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  }
  bakeProxy(); // BVH sur la surface POSÉE courante (la pose n'est pas réinitialisée)
  refreshWeights();
  return true;
}

export function exitWeightPaint() {
  _active = false; _bone = null;
  for (const s of _saved) {
    if (s.color) s.mesh.geometry.setAttribute('color', s.color); else s.mesh.geometry.deleteAttribute('color');
    s.mesh.material = s.material;
  }
  _saved.length = 0; _rig = null;
  if (_proxy.geometry.boundsTree) _proxy.geometry.disposeBoundsTree();
}

export function setPaintBone(bone) { _bone = bone; refreshWeights(); }
export function paintBone() { return _bone; }

// Recalcule la heatmap complète (tous les meshes du rig) pour l'os courant.
export function refreshWeights() {
  if (!_rig) return;
  const rgb = [0, 0, 0];
  for (const sm of _rig.skinned) {
    const geom = sm.geometry, I = geom.attributes.skinIndex, W = geom.attributes.skinWeight;
    const color = geom.attributes.color; if (!I || !W || !color) continue;
    const bi = _bone ? sm.skeleton.bones.indexOf(_bone) : -1;
    const N = geom.attributes.position.count;
    for (let i = 0; i < N; i++) {
      let w = 0;
      if (bi >= 0) for (let k = 0; k < 4; k++) if (I.getComponent(i, k) === bi) w += W.getComponent(i, k);
      heat(w, rgb); color.setXYZ(i, rgb[0], rgb[1], rgb[2]);
    }
    color.needsUpdate = true;
  }
}

// Applique un delta de poids au slot de boneIdx pour le vertex v (+ renormalise à 1), puis propage aux
// jumeaux de couture. Porté d'applyWeightDelta.
function applyDelta(geom, v, boneIdx, delta, members) {
  recordVertex(geom, v); if (members) for (let m = 0; m < members.length; m++) recordVertex(geom, members[m]); // undo
  const W = geom.attributes.skinWeight.array, I = geom.attributes.skinIndex.array, base = v * 4;
  let slot = -1;
  for (let k = 0; k < 4; k++) if (I[base + k] === boneIdx && W[base + k] > 0) { slot = k; break; }
  if (slot === -1) {
    if (delta <= 0) return false;
    let minK = 0, minW = W[base];
    for (let k = 1; k < 4; k++) if (W[base + k] < minW) { minW = W[base + k]; minK = k; }
    slot = minK; I[base + slot] = boneIdx; W[base + slot] = 0;
  }
  let nw = W[base + slot] + delta; if (nw < 0) nw = 0; else if (nw > 1) nw = 1;
  W[base + slot] = nw;
  const remaining = 1 - nw; let other = 0;
  for (let k = 0; k < 4; k++) if (k !== slot) other += W[base + k];
  if (other > 1e-6) { const s = remaining / other; for (let k = 0; k < 4; k++) if (k !== slot) W[base + k] *= s; }
  else W[base + slot] = 1;
  // propage aux jumeaux (même position 3D)
  if (members) for (let m = 0; m < members.length; m++) { const o = members[m]; if (o === v) continue; const ob = o * 4; for (let k = 0; k < 4; k++) { I[ob + k] = I[base + k]; W[ob + k] = W[base + k]; } }
  return true;
}

function colorVertex(geom, v, bi, rgb) {
  const I = geom.attributes.skinIndex, W = geom.attributes.skinWeight, color = geom.attributes.color;
  let w = 0; if (bi >= 0) for (let k = 0; k < 4; k++) if (I.getComponent(v, k) === bi) w += W.getComponent(v, k);
  heat(w, rgb); color.setXYZ(v, rgb[0], rgb[1], rgb[2]);
}

// Peint sur le mesh actif sous le pinceau (surface POSÉE via le proxy). subtract=true -> retire du poids.
export function paintAt(worldPoint, radius, strength, subtract) {
  const mesh = state.targetMesh; if (!_active || !mesh || !_bone) return;
  const geom = mesh.geometry;
  if (!geom.attributes.skinWeight || !geom.attributes.skinIndex) return;
  const bi = mesh.skeleton.bones.indexOf(_bone); if (bi < 0) return;
  const set = collectSkinned(worldPoint, radius); if (!set.size) return;
  const ppos = _proxy.geometry.attributes.position.array; // positions skinnées (monde)
  const r2 = radius * radius, sign = subtract ? -1 : 1;
  const rep = state.rep, gm = state.groupMembers, hasSeams = gm && gm.size > 0;
  const rgb = [0, 0, 0];
  const seenRep = hasSeams ? new Set() : null; // 1 apply par groupe de couture (pas de cumul aux seams)
  for (const v of set) {
    const v3 = v * 3;
    const dx = ppos[v3] - worldPoint.x, dy = ppos[v3 + 1] - worldPoint.y, dz = ppos[v3 + 2] - worldPoint.z;
    const d2 = dx * dx + dy * dy + dz * dz; if (d2 > r2) continue;
    if (seenRep) { const r = rep[v]; if (seenRep.has(r)) continue; seenRep.add(r); }
    const f = 1 - Math.sqrt(d2) / radius;
    const members = hasSeams ? gm.get(rep[v]) : null;
    if (applyDelta(geom, v, bi, sign * strength * f, members)) {
      colorVertex(geom, v, bi, rgb);
      if (members) for (let m = 0; m < members.length; m++) colorVertex(geom, members[m], bi, rgb);
    }
  }
  geom.attributes.skinWeight.needsUpdate = true;
  geom.attributes.skinIndex.needsUpdate = true;
  geom.attributes.color.needsUpdate = true;
}

// Lisse les poids de l'os courant sur le mesh actif (moyenne des voisins), renormalise.
export function smooth() {
  const mesh = state.targetMesh; if (!_active || !mesh || !_bone) return;
  const geom = mesh.geometry, I = geom.attributes.skinIndex, W = geom.attributes.skinWeight;
  const bi = mesh.skeleton.bones.indexOf(_bone); if (bi < 0) return;
  const nb = state.vertexNeighbors; if (!nb) return;
  const N = geom.attributes.position.count;
  const wOf = (v) => { let w = 0; for (let k = 0; k < 4; k++) if (I.getComponent(v, k) === bi) w += W.getComponent(v, k); return w; };
  const target = new Float32Array(N);
  for (let v = 0; v < N; v++) {
    const ns = nb[v]; if (!ns || !ns.length) { target[v] = wOf(v); continue; }
    let s = wOf(v), c = 1; for (let j = 0; j < ns.length; j++) { s += wOf(ns[j]); c++; }
    target[v] = s / c;
  }
  const rep = state.rep, gm = state.groupMembers, hasSeams = gm && gm.size > 0;
  const rgb = [0, 0, 0];
  for (let v = 0; v < N; v++) {
    const cur = wOf(v);
    applyDelta(geom, v, bi, target[v] - cur, hasSeams ? gm.get(rep[v]) : null);
    colorVertex(geom, v, bi, rgb);
  }
  W.needsUpdate = true; I.needsUpdate = true; geom.attributes.color.needsUpdate = true;
}
