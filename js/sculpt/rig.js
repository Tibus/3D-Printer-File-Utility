// Support des modèles RIGGÉS (squelette + animations) dans le sculpt.
// Fondation du mode « Bones » : contrairement au chargement normal (qui aplatit la géométrie et
// détruirait skinIndex/skinWeight), on préserve le graphe Three natif (SkinnedMesh + bones + clips).
// Un objet riggé est enregistré dans state.objects comme le ROOT (Object3D/Group) marqué
// userData.isRig, avec userData.rig = { skinned, bones, skeleton, mixer, helper, animations, action,
// playing, clipIndex }. Les animations sont jouées via un AnimationMixer mis à jour dans la boucle.
//
// Limite connue : le retargeting FBX (js/bones/fbx-anim.js) est spécifique à un rig maison -> ici on
// ne fait que jouer les clips dont les noms de pistes correspondent aux os du squelette chargé.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { state } from './state.js';
import { updateRetarget, applyRetargetPose } from './rig-retarget.js';

const _clock = new THREE.Clock();

// Détecte un squelette dans un objet chargé. Renvoie { skinned:[], bones:[], skeleton } ou null.
export function extractRig(root) {
  const skinned = []; const boneSet = new Set();
  root.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); if (o.isBone) boneSet.add(o); });
  if (!skinned.length && !boneSet.size) return null;
  const skeleton = skinned.length && skinned[0].skeleton ? skinned[0].skeleton : null;
  const bones = skeleton ? skeleton.bones.slice() : Array.from(boneSet);
  return { skinned, bones, skeleton };
}

export function isRig(obj) { return !!(obj && obj.userData && obj.userData.isRig); }
export function rigOf(obj) { return obj && obj.userData ? obj.userData.rig : null; }

// Centre + met à l'échelle le ROOT (au niveau de l'Object3D, jamais les buffers -> skin intact) pour
// tenir dans la vue, comme les meshes sculpt normalisés (~2 unités).
function fitToView(root) {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const s = 2 / maxDim;
  root.scale.multiplyScalar(s);
  root.position.sub(center.multiplyScalar(s));
  root.updateWorldMatrix(true, true);
}

// Ajoute un modèle riggé : le ROOT (bones + skinned meshes) est ajouté à la scène, et CHAQUE SkinnedMesh
// est enregistré comme objet SCULPTABLE dans state.objects (il a une géométrie -> BVH/topologie/retexture
// fonctionnent normalement). Un objet `rig` partagé (root, skeleton, bones, mixer, helper, animations) est
// posé sur chaque SkinnedMesh.userData.rig. `animations` = clips embarqués. Renvoie le SkinnedMesh principal.
export function addRiggedObject(root, name, animations, buildObject, opts = {}) {
  root.name = name || root.name || `Rig ${++state.objectSeq}`;
  if (opts.fit !== false) fitToView(root); // restauration autosave : transform déjà sauvegardé -> ne PAS re-normaliser
  const info = extractRig(root) || { skinned: [], bones: [], skeleton: null };
  const mixer = new THREE.AnimationMixer(root);
  const helper = new THREE.SkeletonHelper(root);
  helper.name = 'skeletonHelper';
  if (helper.material) { helper.material.transparent = true; helper.material.opacity = 0.9; helper.material.depthTest = false; }
  helper.renderOrder = 999;
  state.scene.add(root);
  state.scene.add(helper);
  const rig = {
    root, skinned: info.skinned, bones: info.bones, skeleton: info.skeleton,
    mixer, helper, animations: (animations || []).slice(), action: null, playing: false, clipIndex: -1,
    // Snapshots BIND pour un reset complet (rotations, positions ET boneInverses -> annule aussi les offsets de joint).
    bindLocal: info.bones.map((b) => ({ b, p: b.position.clone(), q: b.quaternion.clone() })),
    bindInverses: info.skinned.map((sm) => ({ sm, inv: sm.skeleton.boneInverses.map((m) => m.clone()) })),
  };
  const meshes = info.skinned.length ? info.skinned : [];
  meshes.forEach((sm, k) => {
    sm.userData.isRig = true;
    sm.userData.rig = rig;
    sm.frustumCulled = false;
    if (!sm.name || sm.name === '') sm.name = (name || 'Rig') + (meshes.length > 1 ? ` ${k + 1}` : '');
    if (buildObject) buildObject(sm); // BVH + matériau d'affichage (fourni par le loader du sculpt)
    state.objects.push(sm);
  });
  return meshes[0] || root;
}

// Libère un rig ENTIER (toutes ses skinned meshes + bones + helper). Appelé quand on supprime un des
// objets riggés partageant le même squelette : la suppression retire le rig complet.
export function disposeRig(obj) {
  const rig = rigOf(obj); if (!rig) return;
  if (rig.helper) { state.scene.remove(rig.helper); if (rig.helper.dispose) rig.helper.dispose(); }
  if (rig.mixer) rig.mixer.stopAllAction();
  // retire toutes les skinned meshes de ce rig de state.objects
  for (let i = state.objects.length - 1; i >= 0; i--) { if (rigOf(state.objects[i]) === rig) state.objects.splice(i, 1); }
  if (rig.root) {
    rig.root.traverse((o) => { if (o.isMesh) { if (o.geometry) { if (o.geometry.disposeBoundsTree) o.geometry.disposeBoundsTree(); o.geometry.dispose(); } const m = o.material; (Array.isArray(m) ? m : [m]).forEach((x) => x && x.dispose && x.dispose()); } });
    state.scene.remove(rig.root);
  }
}

export function isPoseDirty(obj) { const r = rigOf(obj); return !!(r && r.poseDirty); }
export function markPoseDirty(obj) { const r = rigOf(obj); if (r) r.poseDirty = true; }

// Bake la pose COURANTE dans la géométrie comme NOUVEAU bind : on écrit les positions skinnées dans
// geometry.position et on pose boneInverse = bone.matrixWorld⁻¹ (skinning = identité à cette pose ->
// le rendu ne change pas). La forme posée devient la géométrie => BVH/topologie cohérents pour sculpter,
// pose conservée, rig toujours re-posable. Recalcule normales + BVH. À appeler avant de sculpter un rig posé.
const _bV = new THREE.Vector3();
export function bakePose(obj) {
  const rig = rigOf(obj); if (!rig || !rig.skinned.length) return;
  if (rig.root) rig.root.updateWorldMatrix(true, true);
  // 1) positions posées LOCALES (via le skinning courant) pour chaque mesh.
  const baked = [];
  for (const sm of rig.skinned) {
    sm.updateMatrixWorld(true);
    const pos = sm.geometry.attributes.position, n = pos.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { _bV.fromBufferAttribute(pos, i); sm.applyBoneTransform(i, _bV); arr[i * 3] = _bV.x; arr[i * 3 + 1] = _bV.y; arr[i * 3 + 2] = _bV.z; }
    baked.push({ sm, arr });
  }
  // 2) écrit la géométrie posée (setXYZ -> correct même si position ENTRELACÉE) + normales + BVH.
  for (const b of baked) {
    const g = b.sm.geometry, pa = g.attributes.position;
    for (let i = 0; i < pa.count; i++) pa.setXYZ(i, b.arr[i * 3], b.arr[i * 3 + 1], b.arr[i * 3 + 2]);
    pa.needsUpdate = true;
    g.computeVertexNormals();
    if (g.boundsTree) g.disposeBoundsTree();
    g.computeBoundsTree({ setBoundingBox: false });
  }
  // 3) RE-BIND à la pose courante via l'API officielle : sm.bind(skeleton, matrixWorld) recalcule
  //    boneInverses = bone.matrixWorld⁻¹ (pose actuelle) ET met à jour bindMatrix/bindMatrixInverse
  //    (c'est ce qui manquait quand j'inversais les matrices à la main). Les os NE bougent PAS ->
  //    le squelette RESTE POSÉ, et boneMatrix = matrixWorld·boneInverse = I -> skinning identité sur
  //    la nouvelle géométrie (qui est déjà la pose). Rendu inchangé, squelette conservé ET posé.
  for (const sm of rig.skinned) { sm.updateMatrixWorld(true); sm.bind(sm.skeleton); } // SANS bindMatrix -> calculateInverses() recalcule les boneInverses à la pose courante (sinon pose appliquée en double)
  // le nouveau « repos » (pour Reset) devient la pose courante des os
  rig.bindLocal = rig.bones.map((bn) => ({ b: bn, p: bn.position.clone(), q: bn.quaternion.clone() }));
  rig.bindInverses = rig.skinned.map((sm) => ({ sm, inv: sm.skeleton.boneInverses.map((m) => m.clone()) }));
  rig.poseDirty = false;
}

// Reset COMPLET du rig : restaure rotations + positions des os ET les boneInverses (annule pose ET
// offsets de joint). Utilisé par le bouton « Reset pose ».
export function resetRigPose(obj) {
  const rig = rigOf(obj); if (!rig) return;
  if (rig.action) { rig.action.stop(); rig.action = null; rig.playing = false; rig.clipIndex = -1; }
  if (rig.bindInverses) for (const e of rig.bindInverses) e.inv.forEach((m, i) => { if (e.sm.skeleton.boneInverses[i]) e.sm.skeleton.boneInverses[i].copy(m); });
  if (rig.bindLocal) for (const e of rig.bindLocal) { e.b.position.copy(e.p); e.b.quaternion.copy(e.q); }
  for (const e of (rig.bindLocal || [])) e.b.updateMatrixWorld(true);
}

// Met le squelette en pose de REPOS (bind) et arrête l'animation — requis avant de sculpter (le BVH/la
// géométrie sont en pose bind ; en pose animée le rendu ne correspond plus au raycast).
export function restPose(obj) {
  const rig = rigOf(obj); if (!rig) return;
  if (rig.action) { rig.action.stop(); rig.action = null; }
  rig.playing = false; rig.clipIndex = -1;
  if (rig.skeleton) rig.skeleton.pose();
}

// ---------- Lecture d'animations ----------
export function playClip(obj, index) {
  const rig = rigOf(obj); if (!rig || !rig.mixer || !rig.animations[index]) return;
  if (rig.action) rig.action.stop();
  rig.action = rig.mixer.clipAction(rig.animations[index]);
  rig.action.reset(); rig.action.play();
  rig.playing = true; rig.clipIndex = index;
}
// Action courante d'un rig (retargetée si active, sinon embarquée).
function activeAction(rig) { return rig.retargeting && rig.retarget ? rig.retarget.action : rig.action; }
export function setPlaying(obj, on) {
  const rig = rigOf(obj); if (!rig) return; const act = activeAction(rig); if (!act) return;
  rig.playing = on; act.paused = !on;
}
export function stopClip(obj) {
  const rig = rigOf(obj); if (!rig) return;
  if (rig.action) { rig.action.stop(); rig.action = null; }
  if (rig.retarget && rig.retarget.action) { rig.retarget.action.stop(); rig.retarget.action = null; rig.retarget.clipIndex = -1; }
  rig.playing = false; rig.retargeting = false; rig.clipIndex = -1;
  if (rig.skeleton) rig.skeleton.pose(); // retour bind pose
}
export function seekClip(obj, t) {
  const rig = rigOf(obj); if (!rig) return; const act = activeAction(rig); if (!act) return;
  act.time = Math.max(0, Math.min(t, act.getClip().duration));
  if (rig.retargeting && rig.retarget) { rig.retarget.mixer.update(0); applyRetargetPose(rig); } else rig.mixer.update(0);
}
export function clipInfo(obj) {
  const rig = rigOf(obj); if (!rig) return null; const act = activeAction(rig); if (!act) return null;
  return { time: act.time, duration: act.getClip().duration, playing: rig.playing, index: rig.retargeting ? rig.retarget.clipIndex : rig.clipIndex };
}

// Import de clips d'animation externes (GLB/GLTF/FBX). Ajoutés à rig.animations ; jouables si les noms
// de pistes correspondent aux os du squelette (pas de retargeting générique). Renvoie le nb de clips.
export async function importAnimations(obj, file) {
  const rig = rigOf(obj); if (!rig) return 0;
  const ext = file.name.split('.').pop().toLowerCase();
  const url = URL.createObjectURL(file);
  try {
    let clips = [];
    if (ext === 'fbx') clips = (await new FBXLoader().loadAsync(url)).animations || [];
    else clips = (await new GLTFLoader().loadAsync(url)).animations || [];
    for (const c of clips) { if (!c.name) c.name = 'clip'; rig.animations.push(c); }
    return clips.length;
  } finally { URL.revokeObjectURL(url); }
}

// Met la lecture (anim/retarget) en PAUSE en gardant la pose courante (les os ne sont plus réécrits par le
// mixer) -> permet de modifier la rotation d'un os après avoir lancé une animation.
export function pauseRigPlayback(obj) {
  const rig = rigOf(obj); if (!rig) return;
  const act = rig.retargeting && rig.retarget ? rig.retarget.action : rig.action;
  if (act) act.paused = true; // fige l'action (sinon le binding du mixer garde la main sur les os)
  rig.playing = false; // NE PAS toucher rig.retargeting : on reste en mode retarget mais en pause
  // (updateRetarget saute la ré-évaluation quand !playing -> les os ne sont plus réécrits, resume OK).
}

// Force la répercussion d'une pose éditée à la main : matrices monde des os -> skinning (skeleton.update)
// -> helper. Nécessaire après une rotation d'os au gizmo/slider quand une anim a tourné (le mixer ne
// rafraîchit plus le squelette).
export function refreshSkeleton(obj) {
  const rig = rigOf(obj); if (!rig) return;
  if (rig.root) rig.root.updateWorldMatrix(true, true);
  for (const sm of rig.skinned) if (sm.skeleton) sm.skeleton.update();
  if (rig.helper && rig.helper.updateMatrixWorld) rig.helper.updateMatrixWorld(true);
}

// Affiche/masque le helper de squelette.
export function toggleSkeleton(obj, on) { const rig = rigOf(obj); if (rig && rig.helper) rig.helper.visible = on !== undefined ? on : !rig.helper.visible; return rig && rig.helper ? rig.helper.visible : false; }

// Boucle de rendu : met à jour l'animation des rigs (delta commun). Déduplique les rigs (plusieurs
// SkinnedMesh partagent le même rig -> un seul update). Retargeting prioritaire sur la lecture directe.
const _seenRigs = new Set();
export function updateRigs() {
  const dt = _clock.getDelta();
  _seenRigs.clear();
  for (const o of state.objects) {
    const rig = o.userData && o.userData.rig;
    if (!rig || _seenRigs.has(rig)) continue;
    _seenRigs.add(rig);
    if (rig.retargeting && rig.retarget) { updateRetarget(rig, dt); rig.poseDirty = true; }
    else if (rig.playing && rig.mixer) { rig.mixer.update(dt); rig.poseDirty = true; }
  }
}
