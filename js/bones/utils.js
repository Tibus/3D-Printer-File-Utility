// Petits helpers purs.

import * as THREE from 'three';

export function isTwistBone(bone) {
  const name = (bone.name || '').toLowerCase();
  return name.includes('twist');
}

export function isDescendantOf(child, ancestor) {
  let p = child.parent;
  while (p) {
    if (p === ancestor) return true;
    p = p.parent;
  }
  return false;
}

export function depthFromRoot(bone) {
  let d = 0;
  let p = bone.parent;
  while (p) { d++; p = p.parent; }
  return d;
}

// Heatmap bleu (0) → cyan (0.25) → vert (0.5) → jaune (0.75) → rouge (1)
export function weightToHeatmap(w, outRGB) {
  w = Math.max(0, Math.min(1, w));
  let r, g, b;
  if (w < 0.25) {
    const t = w / 0.25;
    r = 0; g = t; b = 1;
  } else if (w < 0.5) {
    const t = (w - 0.25) / 0.25;
    r = 0; g = 1; b = 1 - t;
  } else if (w < 0.75) {
    const t = (w - 0.5) / 0.25;
    r = t; g = 1; b = 0;
  } else {
    const t = (w - 0.75) / 0.25;
    r = 1; g = 1 - t; b = 0;
  }
  outRGB[0] = r; outRGB[1] = g; outRGB[2] = b;
}

const _mSourceRot = new THREE.Matrix4();
const _mParentInvRot = new THREE.Matrix4();
const _mLocalTarget = new THREE.Matrix4();

// Aligne la rotation mondiale de boneCible sur celle de boneSource.
// Utilisé pour transposer une animation FBX vers le rig GLB.
export function alignBones(boneSource, boneCible) {
  _mSourceRot.extractRotation(boneSource.matrixWorld);
  const parentCible = boneCible.parent;
  if (parentCible) {
    _mParentInvRot.extractRotation(parentCible.matrixWorld);
    _mParentInvRot.invert();
    _mLocalTarget.multiplyMatrices(_mParentInvRot, _mSourceRot);
    boneCible.quaternion.setFromRotationMatrix(_mLocalTarget);
  } else {
    boneCible.quaternion.setFromRotationMatrix(_mSourceRot);
  }
  boneCible.updateMatrixWorld();
}

// Effectue une rotation autour du parent en pivot, sans modifier la pose locale du bone.
export function rotateOnParent(bone, rx, ry, rz) {
  const parent = bone.parent;
  const group = new THREE.Group();
  parent.add(group);
  group.position.copy(bone.position);
  group.updateWorldMatrix(false, false);
  group.attach(bone);
  group.rotateX(rx);
  group.rotateY(ry);
  group.rotateZ(rz);
  parent.attach(bone);
}
