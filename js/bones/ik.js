// Système d'IK (Inverse Kinematics) 2-bones — pour bras et jambes.
//
// Principe :
// - Chaque chaîne IK est définie par 3 bones : root (épaule/hanche), mid (coude/genou),
//   end (poignet/cheville).
// - Pendant le drag, on utilise un solveur analytique (loi des cosinus) pour calculer
//   la position du coude qui amène le poignet à la cible.
// - Le "pole" (direction de pliage du coude) est inféré dynamiquement de la position
//   actuelle du coude, ce qui préserve l'orientation choisie par l'utilisateur.
// - Les rotations modifiées sont persistantes (pas de save/restore — c'est un outil de posing).

import * as THREE from 'three';
import { state } from './state.js';
import { updateInfo } from './ui.js';
import { exitWeightPaintMode } from './weight-paint.js';
import { exitJointEditMode } from './joint-edit.js';
import { attachGizmoTo } from './bones.js';
import { clampChain, clampBoneRotation } from './ik-constraints.js';
import { pushUndo } from './history.js';

// ============================================================
// IK CHAINS — à remplir / ajuster selon ton rig
// ============================================================
// Trois types de contrôleurs supportés :
//
// type: '2bone' (par défaut) — chaîne classique racine→milieu→effecteur
//   { type: '2bone', root, mid, end, extension?: [...] }
//   pole marker : direction du coude/genou
//
// type: 'ccd' — chaîne plus longue qui plie progressivement (CCD)
//   { type: 'ccd', bones: [...], end }
//   bones : du plus proche de la racine au plus proche de l'effecteur.
//   Pas de pole marker.
//
// type: 'translate' — déplacement direct d'un bone (descendants suivent par héritage)
//   { type: 'translate', bone }
//   Pas de pole. Combine bien avec "Lock feet" pour bouger le pelvis.
export const ikChains = {
  "L_Arm": {
    type: '2bone',
    root: "L_Upperarm", mid: "L_Forearm", end: "L_Hand",
    extension: ["L_Clavicle", "Spine02", "Spine01"],
    poleOffsetMultiplier: 1.5,
    orientationPole: { axis: 'z', distance: 0.15 }, // direction des doigts
  },
  "R_Arm": {
    type: '2bone',
    root: "R_Upperarm", mid: "R_Forearm", end: "R_Hand",
    extension: ["R_Clavicle", "Spine02", "Spine01"],
    poleOffsetMultiplier: 1.5,
    orientationPole: { axis: 'z', distance: 0.15 },
  },
  "L_Leg": {
    type: '2bone', root: "L_Thigh", mid: "L_Calf", end: "L_Foot",
    poleOffsetMultiplier: 1.2,
    orientationPole: { axis: 'z', distance: 0.15 }, // direction de la pointe du pied
  },
  "R_Leg": {
    type: '2bone', root: "R_Thigh", mid: "R_Calf", end: "R_Foot",
    poleOffsetMultiplier: 1.2,
    orientationPole: { axis: 'z', distance: 0.15 },
  },

  "Head": {
    type: 'ccd',
    bones: ["Spine02", "NeckTwist01", "NeckTwist02"],
    end: "Head",
    pole: true,                                       // pole cyan : axe Y (sommet de tête, incliner)
    orientationPole: { axis: 'z', distance: 0.3 },    // pole magenta : axe Z (direction du regard)
  },
  "Pelvis": {
    type: 'translate', bone: "Hip",
  },
};
window.ikChains = ikChains;

// ---------- Algorithme 2-bones IK ----------

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _vToTarget = new THREE.Vector3();
const _vToMid = new THREE.Vector3();
const _vPole = new THREE.Vector3();
const _vElbow = new THREE.Vector3();
const _vEffTarget = new THREE.Vector3();
const _qWorldRot = new THREE.Quaternion();
const _qOldWorld = new THREE.Quaternion();
const _qParentWorld = new THREE.Quaternion();
const _qNewWorld = new THREE.Quaternion();

// Oriente le bone tel que (childBone - bone) pointe vers targetWorld.
// Applique une rotation world-space, puis convertit en local par rapport au parent.
function aimBoneAt(bone, childBone, targetWorld) {
  bone.updateMatrixWorld(true);
  childBone.updateMatrixWorld(true);

  bone.getWorldPosition(_v0);
  childBone.getWorldPosition(_v1);

  _v1.sub(_v0).normalize();                  // direction actuelle (root → child)
  _vToTarget.copy(targetWorld).sub(_v0).normalize(); // direction désirée

  if (_v1.lengthSq() < 1e-10 || _vToTarget.lengthSq() < 1e-10) return;
  _qWorldRot.setFromUnitVectors(_v1, _vToTarget);

  // newWorldQuat = qWorldRot · oldWorldQuat
  bone.getWorldQuaternion(_qOldWorld);
  _qNewWorld.copy(_qWorldRot).multiply(_qOldWorld);

  // localQuat = parentWorldQuat⁻¹ · newWorldQuat
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_qParentWorld);
    _qParentWorld.invert();
    bone.quaternion.copy(_qParentWorld).multiply(_qNewWorld);
  } else {
    bone.quaternion.copy(_qNewWorld);
  }
  bone.updateMatrixWorld(true);
}

// ---------- CCD pré-pass : plie les bones d'extension vers la cible ----------
// Distribue la déformation entre clavicule / colonne pour que le corps "suive"
// quand la cible est loin (effet façon Cascadeur, version simplifiée).

const _ccdQ = new THREE.Quaternion();
const _ccdQBlend = new THREE.Quaternion();
const _ccdQIdent = new THREE.Quaternion();
const _ccdOldWorld = new THREE.Quaternion();
const _ccdParentWorldInv = new THREE.Quaternion();
const _ccdNewWorld = new THREE.Quaternion();
const _ccdBoneWorld = new THREE.Vector3();
const _ccdEndWorld = new THREE.Vector3();
const _ccdToEnd = new THREE.Vector3();
const _ccdToTarget = new THREE.Vector3();

function applyWorldRotationToBone(bone, qWorld) {
  bone.getWorldQuaternion(_ccdOldWorld);
  _ccdNewWorld.copy(qWorld).multiply(_ccdOldWorld);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_ccdParentWorldInv).invert();
    bone.quaternion.copy(_ccdParentWorldInv).multiply(_ccdNewWorld);
  } else {
    bone.quaternion.copy(_ccdNewWorld);
  }
  bone.updateMatrixWorld(true);
}

function ccdReachExtension(extensionBones, endBone, targetWorld, iterations, blend) {
  for (let iter = 0; iter < iterations; iter++) {
    for (const bone of extensionBones) {
      bone.updateMatrixWorld(true);
      bone.getWorldPosition(_ccdBoneWorld);
      endBone.updateMatrixWorld(true);
      endBone.getWorldPosition(_ccdEndWorld);

      _ccdToEnd.copy(_ccdEndWorld).sub(_ccdBoneWorld);
      _ccdToTarget.copy(targetWorld).sub(_ccdBoneWorld);
      if (_ccdToEnd.lengthSq() < 1e-10 || _ccdToTarget.lengthSq() < 1e-10) continue;
      _ccdToEnd.normalize();
      _ccdToTarget.normalize();

      _ccdQ.setFromUnitVectors(_ccdToEnd, _ccdToTarget);
      // Blend : on n'applique qu'une fraction → distribue entre les bones
      _ccdQBlend.copy(_ccdQIdent.identity()).slerp(_ccdQ, blend);
      applyWorldRotationToBone(bone, _ccdQBlend);
    }
  }
}

// Solveur étendu : si fullBody est on, applique un CCD pré-pass sur les
// extension bones avant la résolution 2-bones classique. Clamp les rotations
// finales selon les contraintes anatomiques.
// `lockEndRotation` : si true, on conserve la worldQuat du end bone (pieds plats au sol).
const _lockEndQ = new THREE.Quaternion();
const _lockParentInv = new THREE.Quaternion();
const _lockNewLocal = new THREE.Quaternion();

export function solveExtendedIK(
  rootBone, midBone, endBone,
  targetWorld, poleWorld, extensionBones,
  lockEndRotation = false,
  orientationPole = null,        // { axis: 'x'|'y'|'z' } if applied
  orientationPoleWorld = null,   // Vector3 world position
) {
  // Snapshot worldQuat du end avant que la chaîne tourne (à restaurer après)
  if (lockEndRotation) endBone.getWorldQuaternion(_lockEndQ);

  if (extensionBones && extensionBones.length > 0) {
    ccdReachExtension(extensionBones, endBone, targetWorld, 3, 0.4);
    if (state.ikConstraintsEnabled) clampChain(rootBone, midBone, endBone, extensionBones);
  }
  solve2BoneIK(rootBone, midBone, endBone, targetWorld, poleWorld);
  if (state.ikConstraintsEnabled) clampChain(rootBone, midBone, endBone, extensionBones);

  // Lock : restaure la worldQuat du end (sa local quat = parentWorldQuat⁻¹ · oldWorldQuat)
  if (lockEndRotation) {
    if (endBone.parent) {
      endBone.parent.updateMatrixWorld(true);
      endBone.parent.getWorldQuaternion(_lockParentInv).invert();
      _lockNewLocal.copy(_lockParentInv).multiply(_lockEndQ);
      endBone.quaternion.copy(_lockNewLocal);
    } else {
      endBone.quaternion.copy(_lockEndQ);
    }
    endBone.updateMatrixWorld(true);
  }

  // Orientation pole : aim un axe local du end vers le pole (override le lock)
  if (orientationPole && orientationPoleWorld) {
    aimBoneAxisAt(endBone, orientationPole.axis || 'z', orientationPoleWorld);
  }
}

// Look-at avec up-vector : oriente le bone tel que son axe Z+ local pointe
// vers `forwardTarget` ET son axe Y+ local soit aussi proche que possible
// de la direction `upTarget` — sans conflit entre les deux poles (contrairement
// à des aimAxisAt séquentiels qui s'annulent).
const _lookFwd = new THREE.Vector3();
const _lookUp = new THREE.Vector3();
const _lookRight = new THREE.Vector3();
const _lookUpFinal = new THREE.Vector3();
const _lookMat = new THREE.Matrix4();
const _lookQ = new THREE.Quaternion();
const _lookParentInv = new THREE.Quaternion();
function lookAtWithUp(bone, forwardTarget, upTarget) {
  bone.updateMatrixWorld(true);
  bone.getWorldPosition(_ccdBoneWorld);

  _lookFwd.copy(forwardTarget).sub(_ccdBoneWorld);
  if (_lookFwd.lengthSq() < 1e-10) return;
  _lookFwd.normalize();

  _lookUp.copy(upTarget).sub(_ccdBoneWorld);
  if (_lookUp.lengthSq() < 1e-10) return;
  _lookUp.normalize();

  // Pour un repère orthonormé droit (det = +1) avec Z = forward et Y ≈ up :
  //   X = up × forward,  Y = forward × X
  // (l'ordre des cross matters — l'inverse donne une réflexion qui skew le bone)
  _lookRight.crossVectors(_lookUp, _lookFwd);
  if (_lookRight.lengthSq() < 1e-8) {
    _lookUp.set(0, 1, 0);
    _lookRight.crossVectors(_lookUp, _lookFwd);
    if (_lookRight.lengthSq() < 1e-8) return;
  }
  _lookRight.normalize();

  // Up perpendiculaire à forward et right (forward × right = up corrigé)
  _lookUpFinal.crossVectors(_lookFwd, _lookRight);

  // Colonnes de la matrice de rotation : X, Y, Z = right, upCorrected, forward
  _lookMat.makeBasis(_lookRight, _lookUpFinal, _lookFwd);
  _lookQ.setFromRotationMatrix(_lookMat);

  if (bone.parent) {
    bone.parent.getWorldQuaternion(_lookParentInv).invert();
    bone.quaternion.copy(_lookParentInv).multiply(_lookQ);
  } else {
    bone.quaternion.copy(_lookQ);
  }
  bone.updateMatrixWorld(true);
}

// CCD chain solver : plie progressivement une chaîne de bones pour amener
// `endBone` à la cible (utilisé pour la tête).
// - `poleWorld` (axe Y) et `orientationPoleWorld` (axe Z) ensemble → look-at-with-up
// - sinon, aim sur l'axe disponible.
export function solveCCDChain(
  bones, endBone, targetWorld,
  poleWorld = null, orientationPoleWorld = null,
  iterations = 5, blend = 0.6,
) {
  for (let iter = 0; iter < iterations; iter++) {
    // De l'effecteur vers la racine (CCD classique)
    for (let i = bones.length - 1; i >= 0; i--) {
      const bone = bones[i];
      bone.updateMatrixWorld(true);
      bone.getWorldPosition(_ccdBoneWorld);
      endBone.updateMatrixWorld(true);
      endBone.getWorldPosition(_ccdEndWorld);

      _ccdToEnd.copy(_ccdEndWorld).sub(_ccdBoneWorld);
      _ccdToTarget.copy(targetWorld).sub(_ccdBoneWorld);
      if (_ccdToEnd.lengthSq() < 1e-10 || _ccdToTarget.lengthSq() < 1e-10) continue;
      _ccdToEnd.normalize();
      _ccdToTarget.normalize();

      _ccdQ.setFromUnitVectors(_ccdToEnd, _ccdToTarget);
      _ccdQBlend.copy(_ccdQIdent.identity()).slerp(_ccdQ, blend);
      applyWorldRotationToBone(bone, _ccdQBlend);
    }
  }
  if (state.ikConstraintsEnabled) {
    for (const b of bones) clampBoneRotation(b);
  }

  // Orientation de l'effecteur :
  // - si on a Y et Z poles → look-at-with-up (pas de conflit)
  // - sinon, aim sur l'axe disponible
  if (poleWorld && orientationPoleWorld) {
    lookAtWithUp(endBone, orientationPoleWorld, poleWorld);
  } else if (poleWorld) {
    aimBoneAxisAt(endBone, 'y', poleWorld);
  } else if (orientationPoleWorld) {
    aimBoneAxisAt(endBone, 'z', orientationPoleWorld);
  }
}

// Translate directement un bone à une position monde donnée (pelvis).
const _trInv = new THREE.Matrix4();
const _trTmp = new THREE.Vector3();
export function translateBoneTo(bone, targetWorld) {
  if (bone.parent) {
    bone.parent.updateMatrixWorld(true);
    _trInv.copy(bone.parent.matrixWorld).invert();
    _trTmp.copy(targetWorld).applyMatrix4(_trInv);
    bone.position.copy(_trTmp);
  } else {
    bone.position.copy(targetWorld);
  }
  bone.updateMatrixWorld(true);
}

export function solve2BoneIK(rootBone, midBone, endBone, targetWorld, poleWorld) {
  rootBone.updateMatrixWorld(true);
  midBone.updateMatrixWorld(true);
  endBone.updateMatrixWorld(true);

  const rootWorld = rootBone.getWorldPosition(new THREE.Vector3());
  const midWorld  = midBone.getWorldPosition(new THREE.Vector3());
  const endWorld  = endBone.getWorldPosition(new THREE.Vector3());

  const L1 = rootWorld.distanceTo(midWorld);
  const L2 = midWorld.distanceTo(endWorld);
  if (L1 < 1e-6 || L2 < 1e-6) return;

  // Vecteur root → target
  _vToTarget.copy(targetWorld).sub(rootWorld);
  let dist = _vToTarget.length();

  // Clamp (évite singularités quand chaîne tendue ou pliée)
  const minDist = Math.abs(L1 - L2) + 1e-3;
  const maxDist = L1 + L2 - 1e-3;
  dist = Math.max(minDist, Math.min(maxDist, dist));
  _vToTarget.normalize();

  // Pole direction : projection perpendiculaire à toTarget.
  // Si pole donné explicitement (marker user) → on l'utilise.
  // Sinon : fallback sur la position courante du coude (pour préserver l'orientation).
  if (poleWorld) {
    _vToMid.copy(poleWorld).sub(rootWorld);
  } else {
    _vToMid.copy(midWorld).sub(rootWorld);
  }
  const dot = _vToMid.dot(_vToTarget);
  _vPole.copy(_vToMid).addScaledVector(_vToTarget, -dot);
  if (_vPole.lengthSq() < 1e-8) {
    _vPole.set(0, 1, 0);
    _vPole.addScaledVector(_vToTarget, -_vPole.dot(_vToTarget));
    if (_vPole.lengthSq() < 1e-8) _vPole.set(0, 0, 1);
  }
  _vPole.normalize();

  // Position du coude : loi des cosinus
  const cosA = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist);
  const cosAlpha = Math.max(-1, Math.min(1, cosA));
  const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));

  _vElbow.copy(rootWorld)
    .addScaledVector(_vToTarget, L1 * cosAlpha)
    .addScaledVector(_vPole, L1 * sinAlpha);

  _vEffTarget.copy(rootWorld).addScaledVector(_vToTarget, dist);

  // 1. Orienter root vers le coude calculé
  aimBoneAt(rootBone, midBone, _vElbow);
  // 2. Orienter mid vers la cible effective
  aimBoneAt(midBone, endBone, _vEffTarget);
}

// ---------- Markers IK (cibles draggables) ----------

function createTargetMarker() {
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.04, 16, 16),
    new THREE.MeshBasicMaterial({
      color: 0xff8800,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    }),
  );
  sphere.renderOrder = 1000;
  sphere.userData.ikType = 'target';
  return sphere;
}

// ---------- Plane de preview du sol ----------

function ensureGroundPreview() {
  if (state.ikGroundPreview) return state.ikGroundPreview;
  const geom = new THREE.PlaneGeometry(4, 4);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x00ddff,
    transparent: true,
    opacity: 0.15,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const plane = new THREE.Mesh(geom, mat);
  plane.rotation.x = -Math.PI / 2; // horizontal (XZ)
  plane.renderOrder = 1;
  state.ikGroundPreview = plane;
  return plane;
}

export function updateGroundPreview() {
  const shouldShow = state.ikMode && state.ikLockFeet;
  if (!shouldShow) {
    if (state.ikGroundPreview && state.ikGroundPreview.parent) {
      state.scene.remove(state.ikGroundPreview);
    }
    return;
  }
  const plane = ensureGroundPreview();
  if (!plane.parent) state.scene.add(plane);
  plane.position.y = state.ikGroundY + 0.001; // léger offset anti-Zfight
}

function createPoleMarker() {
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.025, 14, 14),
    new THREE.MeshBasicMaterial({
      color: 0x00ddff,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    }),
  );
  sphere.renderOrder = 1000;
  sphere.userData.ikType = 'pole';
  return sphere;
}

// Ligne reliant un pole/orientation marker au bone qu'il dirige.
// Mise à jour à chaque frame via updateIKConnectionLines().
function createConnectionLine(color) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.4,
    depthTest: false,
  });
  const line = new THREE.LineSegments(geom, mat);
  line.renderOrder = 999;
  line.frustumCulled = false;
  return line;
}

const _lineFrom = new THREE.Vector3();
const _lineTo = new THREE.Vector3();

export function updateIKConnectionLines() {
  if (!state.ikMode) return;
  for (const line of state.ikConnectionLines) {
    const fromMarker = line.userData.fromMarker;
    const toBone = line.userData.toBone;
    if (!fromMarker || !toBone) continue;
    _lineFrom.copy(fromMarker.position);
    toBone.updateMatrixWorld(true);
    toBone.getWorldPosition(_lineTo);
    const arr = line.geometry.attributes.position.array;
    arr[0] = _lineFrom.x; arr[1] = _lineFrom.y; arr[2] = _lineFrom.z;
    arr[3] = _lineTo.x;   arr[4] = _lineTo.y;   arr[5] = _lineTo.z;
    line.geometry.attributes.position.needsUpdate = true;
  }
}

function addConnectionLine(marker, targetBone, color) {
  const line = createConnectionLine(color);
  line.userData.fromMarker = marker;
  line.userData.toBone = targetBone;
  state.scene.add(line);
  state.ikConnectionLines.push(line);
}

function disposeConnectionLines() {
  for (const line of state.ikConnectionLines) {
    state.scene.remove(line);
    line.geometry.dispose();
    line.material.dispose();
  }
  state.ikConnectionLines.length = 0;
}

function createOrientationMarker() {
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.022, 14, 14),
    new THREE.MeshBasicMaterial({
      color: 0xff44ff,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    }),
  );
  sphere.renderOrder = 1000;
  sphere.userData.ikType = 'orientation';
  return sphere;
}

// Position initiale du orientation pole : à `distance` le long de l'axe local
// du end bone. Ainsi l'aim au premier solve est un no-op (pas de saut).
const _oriAxis = new THREE.Vector3();
const _oriQuat = new THREE.Quaternion();
function localAxisVector(axis, out) {
  if (axis === 'x') out.set(1, 0, 0);
  else if (axis === 'y') out.set(0, 1, 0);
  else out.set(0, 0, 1);
  return out;
}
function computeInitialOrientationPole(endBone, opts, out) {
  endBone.updateMatrixWorld(true);
  endBone.getWorldPosition(out);
  if (opts.worldDirection) {
    // Direction explicitement en world (utile quand l'axe local du bone ne pointe
    // pas dans la direction "naturelle" — ex: pelvis dont le Z+ local est en biais).
    const d = opts.worldDirection;
    _oriAxis.set(d.x || 0, d.y || 0, d.z || 0);
    if (_oriAxis.lengthSq() > 1e-10) _oriAxis.normalize();
  } else {
    endBone.getWorldQuaternion(_oriQuat);
    localAxisVector(opts.axis || 'z', _oriAxis).applyQuaternion(_oriQuat);
  }
  out.addScaledVector(_oriAxis, opts.distance ?? 0.15);
}

// Oriente l'axe local d'un bone (x/y/z) vers une cible monde, sans toucher
// à sa position. Utilisé pour les pieds (axis Z = pointe), mains (Z = doigts),
// pelvis (Z = avant du corps).
const _aimAxis = new THREE.Vector3();
const _aimDelta = new THREE.Vector3();
const _aimWorldQ = new THREE.Quaternion();
const _aimRotQ = new THREE.Quaternion();
function aimBoneAxisAt(bone, axis, targetWorld) {
  bone.updateMatrixWorld(true);
  bone.getWorldPosition(_ccdBoneWorld);
  bone.getWorldQuaternion(_aimWorldQ);
  localAxisVector(axis, _aimAxis).applyQuaternion(_aimWorldQ);
  _aimDelta.copy(targetWorld).sub(_ccdBoneWorld);
  if (_aimAxis.lengthSq() < 1e-10 || _aimDelta.lengthSq() < 1e-10) return;
  _aimDelta.normalize();
  _aimRotQ.setFromUnitVectors(_aimAxis, _aimDelta);
  applyWorldRotationToBone(bone, _aimRotQ);
}

// Position de pole initiale : projection perpendiculaire de la position actuelle du coude
// par rapport à la ligne (root → end), poussée vers l'extérieur du coude.
// `multiplier` contrôle la distance (fraction de la longueur de la chaîne).
function computeInitialPolePosition(rootBone, midBone, endBone, out, multiplier = 0.4) {
  rootBone.updateMatrixWorld(true);
  midBone.updateMatrixWorld(true);
  endBone.updateMatrixWorld(true);

  const rW = rootBone.getWorldPosition(new THREE.Vector3());
  const mW = midBone.getWorldPosition(new THREE.Vector3());
  const eW = endBone.getWorldPosition(new THREE.Vector3());

  const toEnd = eW.clone().sub(rW);
  const chainLen = toEnd.length();
  if (chainLen < 1e-6) { out.copy(mW); return out; }
  toEnd.divideScalar(chainLen);

  const toMid = mW.clone().sub(rW);
  const dot = toMid.dot(toEnd);
  const perp = toMid.clone().addScaledVector(toEnd, -dot);

  // Si la chaîne est presque tendue (mid quasi sur la ligne root→end), perp est
  // trop court pour donner une direction stable. Fallback : Z+ world ("devant"
  // pour un humanoïde) projeté perpendiculaire à la chaîne, plus robuste que Y+
  // qui placerait le pole au-dessus pour les jambes ou bras horizontaux.
  if (perp.length() < 0.01) {
    perp.set(0, 0, 1);
    perp.addScaledVector(toEnd, -perp.dot(toEnd));
    if (perp.lengthSq() < 1e-8) {
      perp.set(0, 1, 0);
      perp.addScaledVector(toEnd, -perp.dot(toEnd));
    }
  }
  perp.normalize();

  // Place le pole à mi-chaîne, offset perpendiculaire (pli + un peu plus loin que le coude)
  const midPoint = rW.clone().addScaledVector(toEnd, chainLen * 0.5);
  const offset = chainLen * multiplier;
  out.copy(midPoint).addScaledVector(perp, offset);
  return out;
}

// Remonte la hiérarchie depuis le premier bone jusqu'au plus haut bone du squelette
// (le bone dont le parent n'est plus un bone). Retourne sa Y monde.
function getSkeletonRootY() {
  if (!state.bones.length) return 0;
  let root = state.bones[0];
  while (root.parent && root.parent.isBone) root = root.parent;
  root.updateMatrixWorld(true);
  return root.getWorldPosition(new THREE.Vector3()).y;
}

// Position initiale du pole pour une chaîne CCD avec orientation (la tête).
// On le place dans la direction de l'axe Y local actuel du end, à 30 cm du bone.
const _ccdPoleTmp = new THREE.Vector3();
const _ccdPoleQuat = new THREE.Quaternion();
function computeInitialCCDPolePosition(endBone, out) {
  endBone.updateMatrixWorld(true);
  endBone.getWorldPosition(out);
  endBone.getWorldQuaternion(_ccdPoleQuat);
  _ccdPoleTmp.set(0, 1, 0).applyQuaternion(_ccdPoleQuat); // axe Y local en world
  out.addScaledVector(_ccdPoleTmp, 0.3);
}

function getChainBones(chain) {
  const type = chain.type || '2bone';
  if (type === '2bone') {
    const root = state.bonesByName.get(chain.root);
    const mid = state.bonesByName.get(chain.mid);
    const end = state.bonesByName.get(chain.end);
    if (!root || !mid || !end) return null;
    const extension = (chain.extension || [])
      .map((n) => state.bonesByName.get(n))
      .filter(Boolean);
    return {
      type, root, mid, end, extension,
      lockEndRotation: !!chain.lockEndRotation,
      poleOffsetMultiplier: chain.poleOffsetMultiplier ?? 0.4,
      orientationPole: chain.orientationPole || null,
    };
  }
  if (type === 'ccd') {
    const ccdBones = (chain.bones || [])
      .map((n) => state.bonesByName.get(n))
      .filter(Boolean);
    const end = state.bonesByName.get(chain.end);
    if (!end || ccdBones.length === 0) return null;
    return {
      type, ccdBones, end,
      pole: !!chain.pole,
      orientationPole: chain.orientationPole || null,
    };
  }
  if (type === 'translate') {
    const bone = state.bonesByName.get(chain.bone);
    if (!bone) return null;
    return { type, bone, orientationPole: chain.orientationPole || null };
  }
  return null;
}

// Bone "principal" qui suit le target marker — sert pour positionner le marker
// initialement et pour les feedbacks visuels.
function getPrimaryBone(bones) {
  if (bones.type === '2bone' || bones.type === 'ccd') return bones.end;
  if (bones.type === 'translate') return bones.bone;
  return null;
}

function placeMarkerAt(marker, bone) {
  bone.updateMatrixWorld(true);
  bone.getWorldPosition(marker.position);
}

// ---------- Enter / Exit ----------

export function enterIKMode() {
  if (state.weightPaintMode) exitWeightPaintMode();
  if (state.jointEditMode) exitJointEditMode();

  state.ikMode = true;

  if (state.mixer) state.mixer.timeScale = 0;
  if (state.mixerFbx) state.mixerFbx.timeScale = 0;

  state.transformControls.detach();

  // Masque tous les bone markers et le skeleton helper pour ne laisser
  // visibles que les markers IK (cibles + poles).
  state.boneMarkersGroup.visible = false;
  if (state.skeletonHelper) state.skeletonHelper.visible = false;

  // Nettoie les markers précédents
  state.ikTargetMarkers.forEach((m) => state.scene.remove(m));
  state.ikTargetMarkers.clear();
  state.ikPoleMarkers.forEach((m) => state.scene.remove(m));
  state.ikPoleMarkers.clear();
  state.ikOrientationMarkers.forEach((m) => state.scene.remove(m));
  state.ikOrientationMarkers.clear();

  let validCount = 0;
  for (const [name, chain] of Object.entries(ikChains)) {
    const bones = getChainBones(chain);
    if (!bones) continue;

    const primary = getPrimaryBone(bones);
    if (!primary) continue;

    // Cible : présent pour tous les types
    const target = createTargetMarker();
    target.userData.chainName = name;
    placeMarkerAt(target, primary);
    state.scene.add(target);
    state.ikTargetMarkers.set(name, target);

    // Pole : pour 2-bone (toujours), et pour ccd si le flag pole est activé
    if (bones.type === '2bone') {
      const pole = createPoleMarker();
      pole.userData.chainName = name;
      computeInitialPolePosition(
        bones.root, bones.mid, bones.end, pole.position,
        bones.poleOffsetMultiplier,
      );
      state.scene.add(pole);
      state.ikPoleMarkers.set(name, pole);
      // Ligne pole → mid (coude / genou)
      addConnectionLine(pole, bones.mid, 0x00ddff);
    } else if (bones.type === 'ccd' && bones.pole) {
      const pole = createPoleMarker();
      pole.userData.chainName = name;
      computeInitialCCDPolePosition(bones.end, pole.position);
      state.scene.add(pole);
      state.ikPoleMarkers.set(name, pole);
      // Ligne pole → end (sommet de la tête)
      addConnectionLine(pole, bones.end, 0x00ddff);
    }

    // Pole d'orientation (axe Z par défaut) : pour mains, pieds, pelvis
    if (bones.orientationPole) {
      const endBone = bones.type === 'translate' ? bones.bone : bones.end;
      if (endBone) {
        const oriMarker = createOrientationMarker();
        oriMarker.userData.chainName = name;
        computeInitialOrientationPole(endBone, bones.orientationPole, oriMarker.position);
        state.scene.add(oriMarker);
        state.ikOrientationMarkers.set(name, oriMarker);
        // Ligne orientation → end (le bone qu'elle oriente)
        addConnectionLine(oriMarker, endBone, 0xff44ff);
      }
    }

    validCount++;
  }

  if (validCount === 0) {
    updateInfo('Aucune chaîne IK valide — vérifie les noms dans ikChains.');
  } else {
    updateInfo(`Mode IK actif — ${validCount} chaîne(s). Drag les sphères orange (cibles) ou cyan (poles).`);
  }

  // Initialise le sol à la Y monde du root du squelette (Hips / Armature racine).
  state.ikGroundY = getSkeletonRootY();
  updateGroundPreview();
  console.log("state.ikGroundY", state.ikGroundY);

  document.getElementById('rotation-controls').classList.remove('visible');
  document.getElementById('ik-controls').classList.add('visible');
  document.getElementById('mode-pose-btn').classList.remove('active');
  document.getElementById('mode-paint-btn').classList.remove('active');
  document.getElementById('mode-joints-btn').classList.remove('active');
  document.getElementById('mode-ik-btn').classList.add('active');
}

export function exitIKMode() {
  if (!state.ikMode) return;
  state.ikMode = false;
  state.isDraggingIK = false;
  state.controls.enabled = true;

  if (state.mixer) state.mixer.timeScale = 1;
  if (state.mixerFbx) state.mixerFbx.timeScale = 1;

  // Cache le plane de preview du sol
  updateGroundPreview();

  // Restaure la visibilité des bone markers et du skeleton helper
  state.boneMarkersGroup.visible = state.skeletonVisible;
  if (state.skeletonHelper) state.skeletonHelper.visible = state.skeletonVisible;

  // Retire les markers
  const disposeMarker = (m) => {
    state.scene.remove(m);
    m.geometry.dispose();
    m.material.dispose();
  };
  state.ikTargetMarkers.forEach(disposeMarker);
  state.ikTargetMarkers.clear();
  state.ikPoleMarkers.forEach(disposeMarker);
  state.ikPoleMarkers.clear();
  state.ikOrientationMarkers.forEach(disposeMarker);
  state.ikOrientationMarkers.clear();
  disposeConnectionLines();

  state.ikDragSnapshot.chainName = null;
  state.ikDragSnapshot.type = null;
  state.ikDragSnapshot.plane = null;
  state.ikDragSnapshot.grabOffset = null;

  document.getElementById('ik-controls').classList.remove('visible');
  document.getElementById('mode-ik-btn').classList.remove('active');
  document.getElementById('mode-pose-btn').classList.add('active');

  if (state.selectedBone) {
    document.getElementById('rotation-controls').classList.add('visible');
    attachGizmoTo(state.selectedBone);
  }
}

// ---------- Auto balance dynamique ----------
// Approxime le centre de masse du squelette via une somme pondérée des positions
// monde de bones clés (poids inspirés de la répartition anatomique humaine).
// Décale le Pelvis horizontalement pour que la projection au sol du COM tombe
// au-dessus du segment entre les deux pieds (base de support).

const _COM_WEIGHTS = {
  "Hip":         0.20,
  "Waist":       0.10,
  "Spine01":     0.10,
  "Spine02":     0.15,
  "NeckTwist01": 0.04,
  "Head":        0.08,
  "L_Upperarm":  0.025,
  "L_Forearm":   0.020,
  "L_Hand":      0.010,
  "R_Upperarm":  0.025,
  "R_Forearm":   0.020,
  "R_Hand":      0.010,
  "L_Thigh":     0.10,
  "L_Calf":      0.05,
  "L_Foot":      0.015,
  "R_Thigh":     0.10,
  "R_Calf":      0.05,
  "R_Foot":      0.015,
};

const _comTmp = new THREE.Vector3();
const _comAccum = new THREE.Vector3();
const _supportL = new THREE.Vector3();
const _supportR = new THREE.Vector3();
const _balanceOffset = new THREE.Vector3();

function computeCenterOfMass(out) {
  out.set(0, 0, 0);
  let totalW = 0;
  for (const [name, w] of Object.entries(_COM_WEIGHTS)) {
    const bone = state.bonesByName.get(name);
    if (!bone) continue;
    bone.updateMatrixWorld(true);
    bone.getWorldPosition(_comTmp);
    out.addScaledVector(_comTmp, w);
    totalW += w;
  }
  if (totalW > 0) out.divideScalar(totalW);
  return out;
}

// Trouve le point sur le segment [A, B] le plus proche de P (en X/Z, ignore Y).
// Renvoie le scaled barycentric in [0, 1] et écrit le point dans `out`.
function projectOnSegmentXZ(A, B, P, out) {
  const ax = A.x, az = A.z;
  const bx = B.x, bz = B.z;
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-8) {
    out.set(ax, A.y, az);
    return 0;
  }
  let t = ((P.x - ax) * dx + (P.z - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  out.set(ax + dx * t, A.y, az + dz * t);
  return t;
}

// Ajuste le Pelvis horizontalement pour que le COM se projette dans la base de support.
// Skipped si la chaîne en cours de drag est le Pelvis (sinon on écrase l'input user).
function applyAutoBalance(currentChainName) {
  if (!state.ikAutoBalance) return;
  if (currentChainName === 'Pelvis') return;

  const hip = state.bonesByName.get('Hip');
  const lFoot = state.bonesByName.get('L_Foot');
  const rFoot = state.bonesByName.get('R_Foot');
  if (!hip || !lFoot || !rFoot) return;

  // Centre de masse + projection au sol
  computeCenterOfMass(_comAccum);
  lFoot.getWorldPosition(_supportL);
  rFoot.getWorldPosition(_supportR);

  // Point cible sur le segment entre les pieds (en X/Z), le plus proche du COM
  projectOnSegmentXZ(_supportL, _supportR, _comAccum, _comTmp);
  // _comTmp est maintenant le point cible idéal au sol

  // Décalage horizontal nécessaire (en world)
  _balanceOffset.x = (_comTmp.x - _comAccum.x) * state.ikAutoBalanceStrength;
  _balanceOffset.z = (_comTmp.z - _comAccum.z) * state.ikAutoBalanceStrength;

  // Conversion world → local pour le Pelvis
  const parent = hip.parent;
  if (parent) {
    parent.updateMatrixWorld(true);
    const parentScale = parent.scale.x || 1;
    hip.position.x += _balanceOffset.x / parentScale;
    hip.position.z += _balanceOffset.z / parentScale;
  } else {
    hip.position.x += _balanceOffset.x;
    hip.position.z += _balanceOffset.z;
  }
  hip.updateMatrixWorld(true);
}

// ---------- Lock feet to ground ----------
// Capture la position monde courante de chaque pied (en clampant Y au sol)
// pour pouvoir les y maintenir pendant un drag d'une autre cible.
function snapshotFeetPositions(currentlyDraggedChain) {
  const out = [];
  for (const footChainName of ['L_Leg', 'R_Leg']) {
    if (footChainName === currentlyDraggedChain) continue;
    const chain = ikChains[footChainName];
    if (!chain) continue;
    const targetMarker = state.ikTargetMarkers.get(footChainName);
    if (!targetMarker) continue;
    const pos = targetMarker.position.clone();
    pos.y = Math.max(state.ikGroundY, pos.y); // jamais sous le sol
    if (pos.y < state.ikGroundY + 0.05) pos.y = state.ikGroundY; // snap si proche
    out.push({ chainName: footChainName, worldPos: pos });
  }
  return out.length > 0 ? out : null;
}

// Force chaque pied à rester à sa position snapshot en re-solvant la chaîne IK.
// Sans extension/full-body ici (sinon on aurait une recursion sur la colonne).
function restoreFeetToSnapshot(snapshot) {
  for (const { chainName, worldPos } of snapshot) {
    const chain = ikChains[chainName];
    if (!chain) continue;
    const bones = getChainBones(chain);
    if (!bones) continue;
    const marker = state.ikTargetMarkers.get(chainName);
    if (marker) marker.position.copy(worldPos);
    const poleMarker = state.ikPoleMarkers.get(chainName);
    const oriMarker = state.ikOrientationMarkers.get(chainName);
    solveExtendedIK(
      bones.root, bones.mid, bones.end,
      worldPos, poleMarker ? poleMarker.position : null,
      null,
      bones.lockEndRotation,
      bones.orientationPole,
      oriMarker ? oriMarker.position : null,
    );
  }
}

// Replace les target markers à la position courante de leur bone primaire.
// Les pole markers gardent leur position monde (réglée par l'utilisateur).
export function refreshIKMarkers() {
  if (!state.ikMode) return;
  for (const [name, marker] of state.ikTargetMarkers) {
    const chain = ikChains[name];
    if (!chain) continue;
    const bones = getChainBones(chain);
    if (!bones) continue;
    const primary = getPrimaryBone(bones);
    if (primary) placeMarkerAt(marker, primary);
  }
}

// ---------- Drag direct des markers IK ----------

const _ikPlane = new THREE.Plane();
const _ikCamDir = new THREE.Vector3();
const _ikTmp = new THREE.Vector3();
const _ikGrab = new THREE.Vector3();

export function attachIKDragListeners() {
  const dom = state.renderer.domElement;

  dom.addEventListener('pointerdown', (e) => {
    if (!state.ikMode || e.button !== 0) return;

    const rect = dom.getBoundingClientRect();
    state.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    state.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    state.raycaster.setFromCamera(state.mouse, state.camera);

    // Raycast contre les 3 types de markers IK
    const markers = [
      ...state.ikTargetMarkers.values(),
      ...state.ikPoleMarkers.values(),
      ...state.ikOrientationMarkers.values(),
    ];
    const hits = state.raycaster.intersectObjects(markers, false);
    if (hits.length === 0) return;
    const marker = hits[0].object;
    const chainName = marker.userData.chainName;
    const type = marker.userData.ikType; // 'target' | 'pole'
    if (!chainName || !type) return;

    state.camera.getWorldDirection(_ikCamDir);
    _ikPlane.setFromNormalAndCoplanarPoint(_ikCamDir, marker.position);

    const hitOnPlane = new THREE.Vector3();
    if (!state.raycaster.ray.intersectPlane(_ikPlane, hitOnPlane)) return;

    _ikGrab.copy(marker.position).sub(hitOnPlane);

    pushUndo();

    state.ikDragSnapshot.chainName = chainName;
    state.ikDragSnapshot.type = type;
    state.ikDragSnapshot.plane = _ikPlane;
    state.ikDragSnapshot.grabOffset = _ikGrab.clone();

    // Lock feet : snapshot des positions de pieds si on drag autre chose qu'un pied
    if (state.ikLockFeet) {
      state.ikFeetSnapshot = snapshotFeetPositions(chainName);
    } else {
      state.ikFeetSnapshot = null;
    }

    state.isDraggingIK = true;
    state.controls.enabled = false;
    e.stopPropagation();
    e.preventDefault();
    try { dom.setPointerCapture(e.pointerId); } catch (_) {}
  }, true);

  dom.addEventListener('pointermove', (e) => {
    if (!state.ikMode || !state.isDraggingIK) return;
    e.stopPropagation();

    const { chainName, type } = state.ikDragSnapshot;
    if (!chainName) return;
    const chain = ikChains[chainName];
    const bones = getChainBones(chain);
    if (!bones) return;

    const targetMarker = state.ikTargetMarkers.get(chainName);
    const poleMarker = state.ikPoleMarkers.get(chainName);
    const oriMarker = state.ikOrientationMarkers.get(chainName);
    if (!targetMarker) return;
    if (type === 'pole' && !poleMarker) return;
    if (type === 'orientation' && !oriMarker) return;

    const rect = dom.getBoundingClientRect();
    state.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    state.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    state.raycaster.setFromCamera(state.mouse, state.camera);

    if (!state.raycaster.ray.intersectPlane(state.ikDragSnapshot.plane, _ikTmp)) return;
    _ikTmp.add(state.ikDragSnapshot.grabOffset);

    // Lock feet : clamp en temps réel — aucune cible ne peut passer sous le sol
    if (state.ikLockFeet && _ikTmp.y < state.ikGroundY) {
      _ikTmp.y = state.ikGroundY;
    }

    // Met à jour le marker en cours de drag
    if (type === 'target') targetMarker.position.copy(_ikTmp);
    else if (type === 'pole' && poleMarker) poleMarker.position.copy(_ikTmp);
    else if (type === 'orientation' && oriMarker) oriMarker.position.copy(_ikTmp);

    // Dispatch selon le type de chaîne
    if (bones.type === '2bone') {
      const extensionBones = state.ikFullBody ? bones.extension : null;
      solveExtendedIK(
        bones.root, bones.mid, bones.end,
        targetMarker.position, poleMarker ? poleMarker.position : null,
        extensionBones,
        bones.lockEndRotation,
        bones.orientationPole,
        oriMarker ? oriMarker.position : null,
      );
    } else if (bones.type === 'ccd') {
      solveCCDChain(
        bones.ccdBones, bones.end,
        targetMarker.position,
        poleMarker ? poleMarker.position : null,
        oriMarker ? oriMarker.position : null,
      );
    } else if (bones.type === 'translate') {
      translateBoneTo(bones.bone, targetMarker.position);
      if (bones.orientationPole && oriMarker) {
        aimBoneAxisAt(bones.bone, bones.orientationPole.axis || 'z', oriMarker.position);
      }
    }

    // Auto-balance : ajuste le pelvis pour ramener le COM au-dessus des pieds
    applyAutoBalance(chainName);

    // Lock feet : re-solve les chaînes de jambes pour garder les pieds à leur snapshot
    // (utile aussi pour rattraper le déplacement du pelvis fait par auto-balance).
    if (state.ikLockFeet && state.ikFeetSnapshot) {
      restoreFeetToSnapshot(state.ikFeetSnapshot);
    }
  }, true);

  function endIKDrag(e) {
    if (!state.isDraggingIK) return;
    state.isDraggingIK = false;
    state.controls.enabled = true;
    state.ikDragSnapshot.chainName = null;
    state.ikFeetSnapshot = null;
    if (e && e.pointerId !== undefined) {
      try { dom.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  }
  dom.addEventListener('pointerup', endIKDrag, true);
  dom.addEventListener('pointercancel', endIKDrag, true);
  dom.addEventListener('pointerleave', endIKDrag, true);
}
