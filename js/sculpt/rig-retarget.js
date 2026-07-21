// Retargeting d'animations : joue une animation dont les os ont des NOMS DIFFÉRENTS sur le squelette
// courant, via un mapping de noms + corrections d'axes. Porté fidèlement de l'éditeur bones
// (js/fbx-anim.js), adapté pour stocker son état PAR RIG (rig.retarget) au lieu d'un singleton global.
//
// ⚠️ Le mapping et les corrections sont CALIBRÉS pour le rig maison (Hip/Waist/Spine01/L_Thigh…) et des
// sources Mixamo (FBX) ou le rig « human » (GLB : pelvis/spine_01/thigh_l…). Sur un autre squelette,
// seule la lecture directe (rig.animations) est fiable.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { state } from './state.js';
import { rigOf } from './rig.js';

// Mapping nom d'os source -> nom(s) d'os cible (rig maison). Repris tel quel de l'éditeur bones.
export const boneMapping = {
  Hips: ['Hip', 'Pelvis'], Spine: ['Waist'], Spine1: ['Spine01'], Spine2: ['Spine02'],
  Neck: ['NeckTwist01', 'NeckTwist02'], Head: ['Head'],
  LeftUpLeg: ['L_Thigh'], LeftLeg: ['L_Calf'], LeftToeBase: ['L_Foot'],
  RightUpLeg: ['R_Thigh'], RightLeg: ['R_Calf'], RightToeBase: ['R_Foot'],
  LeftShoulder: ['L_Clavicle'], LeftArm: ['L_Upperarm'], LeftForeArm: ['L_Forearm'], LeftHand: ['L_Hand'],
  RightShoulder: ['R_Clavicle'], RightArm: ['R_Upperarm'], RightForeArm: ['R_Forearm'], RightHand: ['R_Hand'],
  // Source GLB « human »
  pelvis: ['Hip', 'Pelvis', 'Waist'], spine_01: ['Spine01'], spine_02: ['Spine02'],
  neck_01: ['NeckTwist01'], head: ['NeckTwist02'], head_leaf: ['Head'],
  clavicle_l: ['L_Clavicle'], upperarm_l: ['L_Upperarm'], lowerarm_l: ['L_Forearm'], hand_l: ['L_Hand'],
  clavicle_r: ['R_Clavicle'], upperarm_r: ['R_Upperarm'], lowerarm_r: ['R_Forearm'], hand_r: ['R_Hand'],
  thigh_l: ['L_Thigh'], calf_l: ['L_Calf'], foot_l: ['L_Foot'],
  thigh_r: ['R_Thigh'], calf_r: ['R_Calf'], foot_r: ['R_Foot'],
};

// --- helpers purs (copiés de js/bones/utils.js) ---
const _mSourceRot = new THREE.Matrix4(), _mParentInvRot = new THREE.Matrix4(), _mLocalTarget = new THREE.Matrix4();
function alignBones(boneSource, boneCible) {
  _mSourceRot.extractRotation(boneSource.matrixWorld);
  const parentCible = boneCible.parent;
  if (parentCible) {
    _mParentInvRot.extractRotation(parentCible.matrixWorld).invert();
    _mLocalTarget.multiplyMatrices(_mParentInvRot, _mSourceRot);
    boneCible.quaternion.setFromRotationMatrix(_mLocalTarget);
  } else {
    boneCible.quaternion.setFromRotationMatrix(_mSourceRot);
  }
  boneCible.updateMatrixWorld();
}
function rotateOnParent(bone, rx, ry, rz) {
  if (!bone || !bone.parent) return;
  const parent = bone.parent;
  const group = new THREE.Group();
  parent.add(group);
  group.position.copy(bone.position);
  group.updateWorldMatrix(false, false);
  group.attach(bone);
  group.rotateX(rx); group.rotateY(ry); group.rotateZ(rz);
  parent.attach(bone);
  parent.remove(group);
}

// Prépare la cible (squelette courant) : index par nom + snapshots de la pose bind. Mémorisé sur le rig.
function prepareTarget(rig) {
  const bonesByName = new Map(), originalBoneRotations = new Map();
  for (const b of rig.bones) { bonesByName.set(b.name, b); originalBoneRotations.set(b.uuid, b.rotation.clone()); }
  return {
    bonesByName, originalBoneRotations,
    hipsOriginalLocalPosition: bonesByName.get('Hip') ? bonesByName.get('Hip').position.clone() : null,
    rootOriginalLocalPosition: bonesByName.get('Root') ? bonesByName.get('Root').position.clone() : null,
  };
}

// Libère la source de retarget courante d'un rig.
export function disposeRetarget(rig) {
  const rt = rig && rig.retarget; if (!rt) return;
  if (rt.mixer) rt.mixer.stopAllAction();
  if (rt.model) state.scene.remove(rt.model);
  rig.retarget = null; rig.retargeting = false;
}

// Charge une source d'animation (GLB/GLTF/FBX) et configure le retargeting. Renvoie le nb de clips.
export async function loadRetargetSource(obj, file) {
  const rig = rigOf(obj); if (!rig) return 0;
  const ext = file.name.split('.').pop().toLowerCase();
  const url = URL.createObjectURL(file);
  let model, animations, sourceLabel;
  try {
    if (ext === 'fbx') { model = await new FBXLoader().loadAsync(url); animations = model.animations || []; sourceLabel = 'FBX'; }
    else { const g = await new GLTFLoader().loadAsync(url); model = g.scene; animations = g.animations || []; sourceLabel = 'GLB'; }
  } finally { URL.revokeObjectURL(url); }
  if (!animations.length) return 0;
  disposeRetarget(rig);
  // Capture la pose BIND de référence au repos (une anim en cours fausserait la cible).
  if (rig.action) { rig.action.stop(); rig.action = null; rig.playing = false; rig.clipIndex = -1; }
  if (rig.skeleton) rig.skeleton.pose();
  model.visible = false; state.scene.add(model); model.updateWorldMatrix(true, true);
  const fbxBonesByName = new Map();
  model.traverse((c) => { if (c.isBone) { const n = c.name.replace(/^mixamorig[_:1-9]?/i, ''); if (!fbxBonesByName.has(n)) fbxBonesByName.set(n, c); } });
  const rootName = sourceLabel === 'FBX' ? 'Hips' : 'pelvis';
  const hipsBone = fbxBonesByName.get(rootName) || fbxBonesByName.get('Hips') || fbxBonesByName.get('root') || fbxBonesByName.get('pelvis') || null;
  const rootBone = fbxBonesByName.get('root') || null;
  rig.retarget = {
    model, mixer: new THREE.AnimationMixer(model), animations, action: null, clipIndex: -1, sourceLabel,
    fbxBonesByName,
    fbxHipsBone: hipsBone, fbxHipsOriginalLocalPosition: hipsBone ? hipsBone.position.clone() : null,
    fbxRootBone: rootBone, fbxRootOriginalLocalPosition: rootBone ? rootBone.position.clone() : null,
    target: prepareTarget(rig),
  };
  return animations.length;
}

export function playRetargetClip(obj, index) {
  const rig = rigOf(obj); const rt = rig && rig.retarget; if (!rt || !rt.animations[index]) return;
  if (rt.action) rt.action.stop();
  rt.action = rt.mixer.clipAction(rt.animations[index]); rt.action.reset(); rt.action.play();
  rt.clipIndex = index; rig.playing = true; rig.retargeting = true;
}

// Avance la source + applique le mapping sur le squelette courant. Appelé par la boucle (rig.js).
export function updateRetarget(rig, dt) {
  const rt = rig.retarget; if (!rt || !rt.action) return;
  rt.mixer.update(rig.playing ? dt : 0);
  matchToPrincipal(rig);
}

function matchToPrincipal(rig) {
  const rt = rig.retarget, t = rt.target;
  const bonesByName = t.bonesByName, originalBoneRotations = t.originalBoneRotations;
  bonesByName.forEach((bone) => { const r = originalBoneRotations.get(bone.uuid); if (r) bone.rotation.copy(r); });
  rt.fbxBonesByName.forEach((bone, name) => {
    const mapped = boneMapping[name];
    if (mapped) { for (const tn of mapped) { const tb = bonesByName.get(tn); if (tb) alignBones(bone, tb); } }
    else if (bonesByName.get(name)) alignBones(bone, bonesByName.get(name));
  });
  const B = (n) => bonesByName.get(n);
  if (rt.sourceLabel === 'FBX') {
    B('L_Clavicle') && B('L_Clavicle').rotateY(-Math.PI / 2);
    B('R_Clavicle') && B('R_Clavicle').rotateY(Math.PI / 2);
    if (B('R_Upperarm')) rotateOnParent(B('R_Upperarm'), 0, -Math.PI / 2, 0);
    B('R_UpperarmTwist01') && B('R_UpperarmTwist01').rotateY(Math.PI / 2);
    if (B('L_Upperarm')) rotateOnParent(B('L_Upperarm'), 0, Math.PI / 2, 0);
    B('L_UpperarmTwist01') && B('L_UpperarmTwist01').rotateY(-Math.PI / 2);
    B('Pelvis') && B('Pelvis').rotateY(Math.PI);
    if (B('L_Thigh')) rotateOnParent(B('L_Thigh'), 0, Math.PI, 0);
    if (B('R_Thigh')) rotateOnParent(B('R_Thigh'), 0, Math.PI, 0);
    B('Waist') && B('Waist').rotateY(Math.PI);
    if (B('L_Clavicle')) rotateOnParent(B('L_Clavicle'), 0, Math.PI, 0);
    if (B('R_Clavicle')) rotateOnParent(B('R_Clavicle'), 0, Math.PI, 0);
    for (const n of ['Head', 'NeckTwist01', 'NeckTwist02', 'Spine01', 'Spine02']) { const b = B(n); if (b) { b.rotation.x *= -1; b.rotation.z *= -1; } }
  } else {
    B('Pelvis') && B('Pelvis').rotateY(Math.PI);
    for (const n of ['L_Thigh', 'R_Thigh']) { const b = B(n); if (b) { b.rotation.x *= -1; b.rotation.z *= -1; } }
    if (B('Waist')) { B('Waist').rotateY(Math.PI); B('Waist').rotateX(Math.PI / 10); }
    for (const n of ['Spine01', 'Spine02']) { const b = B(n); if (b) { b.rotation.x *= -1; b.rotation.z *= -1; b.rotateX(-Math.PI / 20); } }
    if (B('NeckTwist01')) { const b = B('NeckTwist01'); b.rotation.x *= -1; b.rotation.z *= -1; b.rotateX(Math.PI / 6); }
    if (B('NeckTwist02')) { const b = B('NeckTwist02'); b.rotation.x *= -1; b.rotation.z *= -1; b.rotateX(-Math.PI / 6); }
    if (B('Head')) { const b = B('Head'); b.rotation.x *= -1; b.rotation.z *= -1; }
    if (B('L_Clavicle')) rotateOnParent(B('L_Clavicle'), 0, Math.PI, 0);
    if (B('R_Clavicle')) rotateOnParent(B('R_Clavicle'), 0, Math.PI, 0);
    if (B('R_Clavicle')) { B('R_Clavicle').rotateY(-Math.PI / 2); rotateOnParent(B('R_Upperarm'), 0, Math.PI / 2, 0); B('R_Clavicle').rotateX(Math.PI / 4); rotateOnParent(B('R_Upperarm'), -Math.PI / 4, 0, 0); }
    if (B('L_Clavicle')) { B('L_Clavicle').rotateY(Math.PI / 2); rotateOnParent(B('L_Upperarm'), 0, -Math.PI / 2, 0); B('L_Clavicle').rotateX(Math.PI / 4); rotateOnParent(B('L_Upperarm'), -Math.PI / 4, 0, 0); }
    B('R_Forearm') && B('R_Forearm').rotateY(-Math.PI / 2);
    B('L_Forearm') && B('L_Forearm').rotateY(Math.PI / 2);
    if (B('R_Hand')) { rotateOnParent(B('R_Hand'), 0, Math.PI / 2, 0); B('R_Hand').rotateY(-Math.PI / 2); }
    if (B('L_Hand')) { rotateOnParent(B('L_Hand'), 0, -Math.PI / 2, 0); B('L_Hand').rotateY(Math.PI / 2); }
    for (const n of ['L_Calf', 'R_Calf']) { const b = B(n); if (b) { b.rotation.x *= -1; b.rotation.z *= -1; } }
    for (const n of ['L_Foot', 'R_Foot']) { const b = B(n); if (b) { b.rotation.x *= -1; b.rotation.z *= -1; b.rotation.x += Math.PI / 8; } }
  }

  // Transposition verticale du Hip (compense units cm/m via ratio des magnitudes de bind).
  const fbxHips = rt.fbxHipsBone, fbxHipsBind = rt.fbxHipsOriginalLocalPosition;
  const targetHip = bonesByName.get('Hip'), targetHipBind = t.hipsOriginalLocalPosition;
  if (fbxHips && fbxHipsBind && targetHip && targetHipBind) {
    const fbxBindMag = fbxHipsBind.length();
    const ratio = fbxBindMag > 1e-6 ? targetHipBind.length() / fbxBindMag : 1;
    const dY = fbxHips.position.y - fbxHipsBind.y, dX = fbxHips.position.x - fbxHipsBind.x, dZ = fbxHips.position.z - fbxHipsBind.z;
    if (rt.sourceLabel === 'FBX') { targetHip.position.z = targetHipBind.z + dY * ratio; targetHip.position.x = targetHipBind.x + dX * ratio; targetHip.position.y = targetHipBind.y - dZ * ratio; }
    else { targetHip.position.y = targetHipBind.y + dY * ratio; targetHip.position.x = targetHipBind.x + dX * ratio; targetHip.position.z = targetHipBind.z + dZ * ratio; }
  }
}
