// Mode "Joints" : déplacer le pivot d'un bone sans bouger les vertex.
//
// Principe :
// - La matrice de skinning S = bone.matrixWorld · boneInverse doit rester constante
//   pour que les vertex skinnés ne bougent pas.
//   À chaque frame du drag : boneInverse_new = matrixWorld_new⁻¹ · S_snapshot
// - Les enfants directs (hors followSet) sont "pinés" à leur position monde initiale
//   en recalculant leur position locale (Blender Edit-mode behaviour).
// - Les bones listés dans linkedJoints suivent le même delta monde que le bone draggé,
//   utile pour les bones twist non sélectionnables.

import * as THREE from 'three';
import { state } from './state.js';
import { isDescendantOf, depthFromRoot } from './utils.js';
import { updateInfo } from './ui.js';
import { exitWeightPaintMode } from './weight-paint.js';
import { pickStackedBones, pickNextInStack, attachGizmoTo } from './bones.js';
import { pushUndo } from './history.js';

// ============================================================
// BONES ROTATABLES EN MODE JOINTS — à remplir par toi
// ============================================================
// Ces bones reçoivent un gizmo de rotation en mode joints (en plus
// du drag-translation classique). La rotation modifie la BIND POSE
// du bone : un boneInverse mis à jour ⇒ vertex figés, et les enfants
// directs gardent leur position+rotation monde inchangées.
// Utile pour corriger l'orientation de référence (mains, pieds).
// Map "BoneName" → { axis } : axe local affiché par la flèche helper
// pour visualiser le sens du bone (mains : axe Z+ = doigts, pieds : axe X+ = pointe).
export const rotatableInJointMode = new Map([
  ["L_Hand", { axis: 'z' }],
  ["R_Hand", { axis: 'z' }],
  ["L_Foot", { axis: 'y' }],
  ["R_Foot", { axis: 'y' }],
  ["Head",   { axis: 'z', sign: -1 }],
]);
window.rotatableInJointMode = rotatableInJointMode;

export function isBoneRotatableInJointMode(bone) {
  if (!bone) return false;
  return rotatableInJointMode.has(bone.name);
}

// Renvoie l'axe local ('x'|'y'|'z') à afficher par la flèche helper.
export function getJointAxisForBone(bone) {
  if (!bone) return 'z';
  const cfg = rotatableInJointMode.get(bone.name);
  return cfg?.axis || 'z';
}

// Signe à appliquer sur l'axe (+1 par défaut, -1 pour inverser le sens d'affichage).
export function getJointAxisSignForBone(bone) {
  if (!bone) return 1;
  const cfg = rotatableInJointMode.get(bone.name);
  return cfg?.sign ?? 1;
}

// ============================================================
// JOINT FOLLOW MAP — à remplir par toi
// ============================================================
// Format : { "BoneSelectionnable": ["BoneLie1", ...] }
// Les noms doivent matcher EXACTEMENT ceux du skeleton.
// Si un bone lié est descendant du bone draggé, il suivra par héritage —
// l'inscrire ici sert juste à mettre à jour son boneInverse pour figer ses vertex.
export const linkedJoints = {
  "L_Calf":   ["L_CalfTwist01", "L_CalfTwist02"],
  "R_Calf":   ["R_CalfTwist01", "R_CalfTwist02"],
  "L_Thigh":  ["L_ThighTwist01", "L_ThighTwist02"],
  "R_Thigh":  ["R_ThighTwist01", "R_ThighTwist02"],
  "L_Upperarm": ["L_UpperarmTwist01", "L_UpperarmTwist02"],
  "R_Upperarm": ["R_UpperarmTwist01", "R_UpperarmTwist02"],
  "L_Forearm":  ["L_ForearmTwist01", "L_ForearmTwist02"],
  "R_Forearm":  ["R_ForearmTwist01", "R_ForearmTwist02"],
};
window.linkedJoints = linkedJoints;

// ---------- Helpers ----------

function getLinkedBones(bone) {
  const names = linkedJoints[bone.name];
  if (!names || !names.length) return [];
  const out = [];
  for (const n of names) {
    const b = state.bonesByName.get(n);
    if (b && b !== bone) out.push(b);
  }
  return out;
}

// ---------- Snapshot et compensation pendant le drag ----------

function snapshotJointDrag(bone) {
  const snap = state.jointDragSnapshot;
  snap.bone = bone;
  snap.followSet.clear();
  snap.worldStart.clear();
  snap.skinningPerMesh.clear();
  snap.childWorldPositions.clear();

  const followSet = snap.followSet;
  followSet.add(bone);
  for (const linked of getLinkedBones(bone)) followSet.add(linked);

  // Multi-sélection : tous les bones secondaires sélectionnés suivent le drag
  // (et leurs propres linkedJoints/twists aussi).
  for (const extra of state.multiSelectedBones) {
    if (extra === bone) continue;
    followSet.add(extra);
    for (const linked of getLinkedBones(extra)) followSet.add(linked);
  }

  for (const X of followSet) X.updateMatrixWorld(true);

  for (const X of followSet) {
    snap.worldStart.set(X, X.getWorldPosition(new THREE.Vector3()));

    const perMesh = new Map();
    for (const sm of state.skinnedMeshes) {
      const idx = sm.skeleton.bones.indexOf(X);
      if (idx < 0) continue;
      const S = new THREE.Matrix4().multiplyMatrices(X.matrixWorld, sm.skeleton.boneInverses[idx]);
      perMesh.set(sm, S);
    }
    snap.skinningPerMesh.set(X, perMesh);
  }

  // Enfants directs hors followSet → à piner
  for (const X of followSet) {
    for (const child of X.children) {
      if (!child.isBone) continue;
      if (followSet.has(child)) continue;
      snap.childWorldPositions.set(child, child.getWorldPosition(new THREE.Vector3()));
    }
  }
}

const _jointInv = new THREE.Matrix4();
const _jointTmpVec = new THREE.Vector3();
const _jointDelta = new THREE.Vector3();

// Helpers pour ré-orienter les twists après un drag de translation.
const _reaimAxis = new THREE.Vector3();
const _reaimDir = new THREE.Vector3();
const _reaimBoneWorld = new THREE.Vector3();
const _reaimTargetWorld = new THREE.Vector3();
const _reaimQ = new THREE.Quaternion();
const _reaimOldWorld = new THREE.Quaternion();
const _reaimNewWorld = new THREE.Quaternion();
const _reaimParentInv = new THREE.Quaternion();

// Aligne l'axe Y local du `bone` vers `targetWorld` (utilisé pour les twists qui
// doivent suivre l'axe parent→main-child quand le pivot du parent a bougé).
function aimYAxisOfBone(bone, targetWorld) {
  bone.updateMatrixWorld(true);
  bone.getWorldPosition(_reaimBoneWorld);
  bone.getWorldQuaternion(_reaimOldWorld);
  _reaimAxis.set(0, 1, 0).applyQuaternion(_reaimOldWorld);
  _reaimDir.copy(targetWorld).sub(_reaimBoneWorld);
  if (_reaimAxis.lengthSq() < 1e-10 || _reaimDir.lengthSq() < 1e-10) return;
  _reaimDir.normalize();
  _reaimQ.setFromUnitVectors(_reaimAxis, _reaimDir);
  _reaimNewWorld.copy(_reaimQ).multiply(_reaimOldWorld);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_reaimParentInv).invert();
    bone.quaternion.copy(_reaimParentInv).multiply(_reaimNewWorld);
  } else {
    bone.quaternion.copy(_reaimNewWorld);
  }
  bone.updateMatrixWorld(true);
}

// Cherche un enfant du `parent` qui n'est PAS dans le followSet
// (= un main child non-twist, typiquement Foot/Hand). Renvoie sa worldPos.
function findMainChildWorld(parent, followSet, out) {
  for (const c of parent.children) {
    if (!c.isBone) continue;
    if (followSet.has(c)) continue;
    c.updateMatrixWorld(true);
    c.getWorldPosition(out);
    return true;
  }
  return false;
}

// Pour chaque twist linké enfant direct de B, ré-oriente son axe Y vers le main
// child de B (le bone non-twist), puis re-update son boneInverse pour préserver S.
function reorientLinkedTwists(B) {
  const snap = state.jointDragSnapshot;
  if (!findMainChildWorld(B, snap.followSet, _reaimTargetWorld)) return;

  for (const X of snap.followSet) {
    if (X === B) continue;
    if (X.parent !== B) continue;

    aimYAxisOfBone(X, _reaimTargetWorld);

    // Re-update boneInverse pour préserver S = matrixWorld * boneInverse = S_snapshot
    const perMesh = snap.skinningPerMesh.get(X);
    if (!perMesh || perMesh.size === 0) continue;
    _jointInv.copy(X.matrixWorld).invert();
    for (const [sm, S_snapshot] of perMesh) {
      const idx = sm.skeleton.bones.indexOf(X);
      if (idx < 0) continue;
      sm.skeleton.boneInverses[idx].multiplyMatrices(_jointInv, S_snapshot);
    }
  }
}

function applyJointDragCompensation() {
  const snap = state.jointDragSnapshot;
  const B = snap.bone;
  if (!B) return;

  // 1. Delta monde appliqué à B
  B.updateMatrixWorld(true);
  B.getWorldPosition(_jointTmpVec);
  _jointDelta.copy(_jointTmpVec).sub(snap.worldStart.get(B));

  // 2. Translater les bones liés non-descendants de B (les descendants suivent par héritage)
  //    Ordre racine→feuilles pour que parent.matrixWorld soit à jour à chaque itération.
  const toTranslate = [];
  for (const X of snap.followSet) {
    if (X === B) continue;
    if (isDescendantOf(X, B)) continue;
    toTranslate.push(X);
  }
  toTranslate.sort((a, b) => depthFromRoot(a) - depthFromRoot(b));

  for (const X of toTranslate) {
    const parent = X.parent;
    if (!parent) continue;
    parent.updateMatrixWorld(true);
    _jointInv.copy(parent.matrixWorld).invert();
    _jointTmpVec.copy(snap.worldStart.get(X)).add(_jointDelta);
    _jointTmpVec.applyMatrix4(_jointInv);
    X.position.copy(_jointTmpVec);
    X.updateMatrixWorld(true);
  }

  // 3. Recalculer les boneInverses pour TOUT le followSet → S reste constant ⇒ vertex figés
  for (const X of snap.followSet) {
    X.updateMatrixWorld(true);
    const perMesh = snap.skinningPerMesh.get(X);
    if (!perMesh || perMesh.size === 0) continue;
    _jointInv.copy(X.matrixWorld).invert();
    for (const [sm, S_snapshot] of perMesh) {
      const idx = sm.skeleton.bones.indexOf(X);
      if (idx < 0) continue;
      sm.skeleton.boneInverses[idx].multiplyMatrices(_jointInv, S_snapshot);
    }
  }

  // 4. Piner les enfants hors followSet à leur position monde initiale
  for (const [child, savedWorldPos] of snap.childWorldPositions) {
    const parent = child.parent;
    if (!parent) continue;
    parent.updateMatrixWorld(true);
    _jointInv.copy(parent.matrixWorld).invert();
    _jointTmpVec.copy(savedWorldPos).applyMatrix4(_jointInv);
    child.position.copy(_jointTmpVec);
    child.updateMatrixWorld(true);
  }

  // 5. Ré-orienter les twists linkés (enfants directs de B) pour qu'ils suivent
  //    l'axe parent → main-child non-twist (sinon leur direction reste fixe alors
  //    que l'axe naturel du parent a changé → animations bizarres ensuite).
  reorientLinkedTwists(B);
}

function clearJointDragSnapshot() {
  const snap = state.jointDragSnapshot;
  snap.bone = null;
  snap.followSet.clear();
  snap.worldStart.clear();
  snap.skinningPerMesh.clear();
  snap.childWorldPositions.clear();
}

// ---------- Rotation en mode joints (mains/pieds) ----------
// Modifie la bind rotation d'un bone : matrixWorld change, on recalcule boneInverse
// pour figer S, et on restaure la matrixWorld complète des enfants directs (ils ne
// suivent pas la rotation, contrairement au comportement par défaut d'inheritance).

function snapshotJointRotation(bone) {
  const snap = state.jointRotateSnapshot;
  snap.bone = bone;
  snap.skinningPerMesh.clear();
  snap.childMatrixWorld.clear();

  bone.updateMatrixWorld(true);

  // S = matrixWorld * boneInverse pour le bone, par mesh
  for (const sm of state.skinnedMeshes) {
    const idx = sm.skeleton.bones.indexOf(bone);
    if (idx < 0) continue;
    const S = new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, sm.skeleton.boneInverses[idx]);
    snap.skinningPerMesh.set(sm, S);
  }

  // matrixWorld complète des enfants directs (à figer)
  for (const child of bone.children) {
    if (!child.isBone) continue;
    child.updateMatrixWorld(true);
    snap.childMatrixWorld.set(child, child.matrixWorld.clone());
  }
}

const _rotInv = new THREE.Matrix4();
const _rotLocal = new THREE.Matrix4();

function applyJointRotationCompensation() {
  const snap = state.jointRotateSnapshot;
  const B = snap.bone;
  if (!B) return;

  B.updateMatrixWorld(true);
  _rotInv.copy(B.matrixWorld).invert();

  // 1. Boneinverse de B : boneInverse_new = matrixWorld⁻¹ · S_snapshot ⇒ vertex figés
  for (const [sm, S_snap] of snap.skinningPerMesh) {
    const idx = sm.skeleton.bones.indexOf(B);
    if (idx < 0) continue;
    sm.skeleton.boneInverses[idx].multiplyMatrices(_rotInv, S_snap);
  }

  // 2. Restaurer la matrixWorld complète des enfants directs (rotation+position)
  //    childLocal_new = parentWorld⁻¹ · childWorld_snapshot
  for (const [child, childWorldSnap] of snap.childMatrixWorld) {
    _rotLocal.multiplyMatrices(_rotInv, childWorldSnap);
    _rotLocal.decompose(child.position, child.quaternion, child.scale);
    child.updateMatrixWorld(true);
  }
}

function clearJointRotationSnapshot() {
  const snap = state.jointRotateSnapshot;
  snap.bone = null;
  snap.skinningPerMesh.clear();
  snap.childMatrixWorld.clear();
}

// Branche les listeners du gizmo TransformControls pour le mode joints :
// - rotation pour les bones rotatables (mains/pieds)
// - translation pour les autres
// À appeler une fois au démarrage.
export function attachJointRotationListeners() {
  const tc = state.transformControls;

  tc.addEventListener('mouseDown', () => {
    if (!state.jointEditMode || !state.selectedBone) return;
    // pushUndo() est déjà fait par le listener générique dans main.js.
    if (isBoneRotatableInJointMode(state.selectedBone)) {
      snapshotJointRotation(state.selectedBone);
    } else {
      snapshotJointDrag(state.selectedBone);
    }
  });

  tc.addEventListener('change', () => {
    if (!state.jointEditMode) return;
    if (state.jointRotateSnapshot.bone) {
      applyJointRotationCompensation();
    } else if (state.jointDragSnapshot.bone) {
      applyJointDragCompensation();
    }
  });

  tc.addEventListener('mouseUp', () => {
    if (!state.jointEditMode) return;
    const rotSnap = state.jointRotateSnapshot;
    if (rotSnap.bone) {
      // Persiste la nouvelle rotation comme nouvelle bind pose
      const newRot = rotSnap.bone.rotation.clone();
      state.originalBoneRotations.set(rotSnap.bone.uuid, newRot);
      if (state.savedRotationsForJointEdit) {
        state.savedRotationsForJointEdit.set(rotSnap.bone.uuid, newRot.clone());
      }
      clearJointRotationSnapshot();
    }
    if (state.jointDragSnapshot.bone) {
      clearJointDragSnapshot();
    }
  });
}

// ---------- Enter / Exit ----------

export function enterJointEditMode() {
  if (!state.skinnedMeshes.length) {
    updateInfo('Aucun mesh skinné — impossible de passer en édition de joints.');
    return;
  }
  if (state.weightPaintMode) exitWeightPaintMode();

  state.jointEditMode = true;

  // Sauver la pose courante puis appliquer la bind pose (rotations d'origine).
  state.savedRotationsForJointEdit = new Map();
  state.bones.forEach((b) => {
    state.savedRotationsForJointEdit.set(b.uuid, b.rotation.clone());
    const bind = state.originalBoneRotations.get(b.uuid);
    if (bind) b.rotation.copy(bind);
  });

  if (state.mixer) state.mixer.timeScale = 0;
  if (state.mixerFbx) state.mixerFbx.timeScale = 0;

  // En mode joints, on attache toujours le gizmo :
  // - rotation pour les bones rotatables (mains/pieds)
  // - translation pour les autres
  if (state.selectedBone) {
    if (isBoneRotatableInJointMode(state.selectedBone)) {
      state.transformControls.setMode('rotate');
      state.transformControls.setSpace('local');
    } else {
      state.transformControls.setMode('translate');
      state.transformControls.setSpace('world');
    }
    attachGizmoTo(state.selectedBone);
  } else {
    state.transformControls.detach();
  }

  document.getElementById('rotation-controls').classList.remove('visible');
  document.getElementById('joint-edit-controls').classList.add('visible');
  document.getElementById('mode-pose-btn').classList.remove('active');
  document.getElementById('mode-paint-btn').classList.remove('active');
  document.getElementById('mode-joints-btn').classList.add('active');

  updateJointBoneName();
}

export function exitJointEditMode() {
  if (!state.jointEditMode) return;
  state.jointEditMode = false;
  state.isDraggingJoint = false;
  state.controls.enabled = true;

  if (state.savedRotationsForJointEdit) {
    state.bones.forEach((b) => {
      const r = state.savedRotationsForJointEdit.get(b.uuid);
      if (r) b.rotation.copy(r);
    });
    state.savedRotationsForJointEdit = null;
  }

  if (state.mixer) state.mixer.timeScale = 1;
  if (state.mixerFbx) state.mixerFbx.timeScale = 1;

  clearJointDragSnapshot();

  document.getElementById('joint-edit-controls').classList.remove('visible');
  document.getElementById('mode-joints-btn').classList.remove('active');
  document.getElementById('mode-pose-btn').classList.add('active');

  if (state.selectedBone) {
    document.getElementById('rotation-controls').classList.add('visible');
    state.transformControls.setMode('rotate');
    state.transformControls.setSpace('local');
    attachGizmoTo(state.selectedBone);
  } else {
    state.transformControls.detach();
  }
}

export function updateJointBoneName() {
  const el = document.getElementById('joint-bone-name');
  if (!el) return;
  el.textContent = state.selectedBone
    ? (state.selectedBone.name || `Bone ${state.selectedBoneIndex + 1}`)
    : 'Aucun bone sélectionné';
}

export function resetAllJoints() {
  pushUndo();
  for (const sm of state.skinnedMeshes) {
    const orig = state.originalBoneInverses.get(sm);
    if (!orig) continue;
    orig.forEach((m, i) => {
      if (sm.skeleton.boneInverses[i]) sm.skeleton.boneInverses[i].copy(m);
    });
  }
  state.bones.forEach((b) => {
    const p = state.originalBonePositions.get(b.uuid);
    if (p) b.position.copy(p);
  });
  updateInfo("Tous les joints ont été remis à leur position d'origine.");
}

// ---------- Drag direct sur le marker (souris) ----------

const _jdPlane = new THREE.Plane();
const _jdGrabOffset = new THREE.Vector3();
const _jdCamDir = new THREE.Vector3();
const _jdTmpVec = new THREE.Vector3();
const _jdParentInv = new THREE.Matrix4();

export function attachJointDragListeners(selectBone) {
  const dom = state.renderer.domElement;

  dom.addEventListener('pointerdown', (e) => {
    if (!state.jointEditMode || e.button !== 0) return;

    const rect = dom.getBoundingClientRect();
    state.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    state.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    state.raycaster.setFromCamera(state.mouse, state.camera);

    const hits = state.raycaster.intersectObjects(state.boneMarkers, false);
    if (hits.length === 0) return;

    // Cycle entre bones empilés (twist sur leur "vrai" bone) si re-clic au même endroit
    const stack = pickStackedBones(hits);
    if (stack.length === 0) return;
    const marker = pickNextInStack(stack);

    selectBone(marker.userData.boneIndex, e.shiftKey);
    if (!state.selectedBone) return;

    // Drag direct du marker : SEULEMENT pour les bones rotatables (mains/pieds).
    // Eux ont le gizmo de rotation attaché, donc le drag direct est leur seul
    // moyen de translater. Pour les autres bones, c'est le gizmo de translation
    // qui prend en charge le déplacement.
    if (!isBoneRotatableInJointMode(state.selectedBone)) return;

    pushUndo();
    snapshotJointDrag(state.selectedBone);

    // Plan parallèle à la caméra, passant par le bone
    state.selectedBone.getWorldPosition(_jdTmpVec);
    state.camera.getWorldDirection(_jdCamDir);
    _jdPlane.setFromNormalAndCoplanarPoint(_jdCamDir, _jdTmpVec);

    const hitOnPlane = new THREE.Vector3();
    if (!state.raycaster.ray.intersectPlane(_jdPlane, hitOnPlane)) {
      clearJointDragSnapshot();
      return;
    }
    state.selectedBone.getWorldPosition(_jdTmpVec);
    _jdGrabOffset.copy(_jdTmpVec).sub(hitOnPlane);

    state.isDraggingJoint = true;
    state.controls.enabled = false;
    e.stopPropagation();
    e.preventDefault();
    try { dom.setPointerCapture(e.pointerId); } catch (_) {}
  }, true);

  dom.addEventListener('pointermove', (e) => {
    if (!state.jointEditMode || !state.isDraggingJoint || !state.selectedBone) return;
    e.stopPropagation();

    const rect = dom.getBoundingClientRect();
    state.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    state.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    state.raycaster.setFromCamera(state.mouse, state.camera);

    const hitOnPlane = _jdTmpVec;
    if (!state.raycaster.ray.intersectPlane(_jdPlane, hitOnPlane)) return;
    hitOnPlane.add(_jdGrabOffset);

    const parent = state.selectedBone.parent;
    if (!parent) return;
    parent.updateMatrixWorld(true);
    _jdParentInv.copy(parent.matrixWorld).invert();
    hitOnPlane.applyMatrix4(_jdParentInv);
    state.selectedBone.position.copy(hitOnPlane);
    state.selectedBone.updateMatrixWorld(true);

    applyJointDragCompensation();
  }, true);

  function endJointDrag(e) {
    if (!state.isDraggingJoint) return;
    state.isDraggingJoint = false;
    state.controls.enabled = true;
    clearJointDragSnapshot();
    if (e && e.pointerId !== undefined) {
      try { dom.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  }
  dom.addEventListener('pointerup', endJointDrag, true);
  dom.addEventListener('pointercancel', endJointDrag, true);
  dom.addEventListener('pointerleave', endJointDrag, true);
}
