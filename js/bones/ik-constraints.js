// Contraintes d'angle anatomiques pour les bones — clamp les rotations
// après chaque résolution IK pour éviter les poses physiquement impossibles.
//
// Limitations :
// - On clamp les rotations Euler locales (ordre stocké dans bone.rotation.order).
//   L'effet exact dépend de l'orientation du bone dans le rig — les valeurs
//   ci-dessous sont calibrées pour un rig humanoïde Mixamo-like.
// - Les contraintes sont par axe (X/Y/Z), pas en swing-twist.
// - Si la cible IK est anatomiquement impossible, la chaîne n'atteindra pas
//   la cible (au lieu de se tordre bizarrement) — c'est le bon trade-off.
//
// Format : { "BoneName": { x?: [min, max], y?: [...], z?: [...] } }
// (en radians, undefined = pas de contrainte sur cet axe)

const PI = Math.PI;

export const boneConstraints = {
  // Genoux : pliure dans un seul sens (axe X local typiquement)
  "L_Calf":     { x: [-PI * 0.85, 0] },
  "R_Calf":     { x: [-PI * 0.85, 0] },

  // Coudes : pliure dans un seul sens
  "L_Forearm":  { x: [-PI * 0.85, 0] },
  "R_Forearm":  { x: [-PI * 0.85, 0] },

  // Colonne : flexion/torsion modérée
  "Spine01":    { x: [-PI * 0.4, PI * 0.4], y: [-PI * 0.5, PI * 0.5], z: [-PI * 0.3, PI * 0.3] },
  "Spine02":    { x: [-PI * 0.3, PI * 0.3], y: [-PI * 0.4, PI * 0.4], z: [-PI * 0.3, PI * 0.3] },
  "Waist":      { x: [-PI * 0.3, PI * 0.3], y: [-PI * 0.5, PI * 0.5], z: [-PI * 0.2, PI * 0.2] },

  // Cou
  "NeckTwist01": { x: [-PI * 0.4, PI * 0.4], y: [-PI * 0.5, PI * 0.5], z: [-PI * 0.3, PI * 0.3] },
  "NeckTwist02": { x: [-PI * 0.4, PI * 0.4], y: [-PI * 0.5, PI * 0.5], z: [-PI * 0.3, PI * 0.3] },

  // Épaules / hanches : pas de contrainte par défaut (grande amplitude)
};
window.boneConstraints = boneConstraints;

function clampVal(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function clampBoneRotation(bone) {
  if (!bone) return;
  const c = boneConstraints[bone.name];
  if (!c) return;
  const r = bone.rotation;
  let changed = false;
  if (c.x) {
    const v = clampVal(r.x, c.x[0], c.x[1]);
    if (v !== r.x) { r.x = v; changed = true; }
  }
  if (c.y) {
    const v = clampVal(r.y, c.y[0], c.y[1]);
    if (v !== r.y) { r.y = v; changed = true; }
  }
  if (c.z) {
    const v = clampVal(r.z, c.z[0], c.z[1]);
    if (v !== r.z) { r.z = v; changed = true; }
  }
  if (changed) bone.updateMatrixWorld(true);
}

// Clamp tous les bones d'une chaîne IK + extension
export function clampChain(rootBone, midBone, endBone, extensionBones) {
  if (extensionBones) {
    // Du plus haut (racine) vers le plus bas pour propager correctement
    for (let i = extensionBones.length - 1; i >= 0; i--) {
      clampBoneRotation(extensionBones[i]);
    }
  }
  clampBoneRotation(rootBone);
  clampBoneRotation(midBone);
  clampBoneRotation(endBone);
}
