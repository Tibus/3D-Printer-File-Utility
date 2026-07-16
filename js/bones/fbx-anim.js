// Mapping FBX (Mixamo) → squelette GLB cible.
// Appelé chaque frame quand une animation FBX secondaire pilote le modèle principal.

import { state } from './state.js';
import { alignBones, rotateOnParent } from './utils.js';

window.rotateOnParent = rotateOnParent;

export const boneMapping = {
  // Racine et bassin
  "Hips": ["Hip", "Pelvis"],

  // Colonne vertébrale
  "Spine":  ["Waist"],
  "Spine1": ["Spine01"],
  "Spine2": ["Spine02"],

  // Cou et tête
  "Neck": ["NeckTwist01", "NeckTwist02"],
  "Head": ["Head"],

  // Jambe gauche
  "LeftUpLeg":   ["L_Thigh"],
  "LeftLeg":     ["L_Calf"],
  "LeftToeBase": ["L_Foot"],

  // Jambe droite
  "RightUpLeg":   ["R_Thigh"],
  "RightLeg":     ["R_Calf"],
  "RightToeBase": ["R_Foot"],

  // Bras gauche
  "LeftShoulder": ["L_Clavicle"],
  "LeftArm":      ["L_Upperarm"],
  "LeftForeArm":  ["L_Forearm"],
  "LeftHand":     ["L_Hand"],

  // Bras droit
  "RightShoulder": ["R_Clavicle"],
  "RightArm":      ["R_Upperarm"],
  "RightForeArm":  ["R_Forearm"],
  "RightHand":     ["R_Hand"],


  //GLB
  "pelvis": ["Hip", "Pelvis","Waist"],
  // "spine":  ["Waist"],
  "spine_01": ["Spine01"],
  "spine_02": ["Spine02"],
  "neck_01": ["NeckTwist01"],
  "head": ["NeckTwist02"],
  "head_leaf": ["Head"],
  "clavicle_l": ["L_Clavicle"],
  "upperarm_l": ["L_Upperarm"],
  "lowerarm_l": ["L_Forearm"],
  "hand_l": ["L_Hand"],

  "clavicle_r": ["R_Clavicle"],
  "upperarm_r": ["R_Upperarm"],
  "lowerarm_r": ["R_Forearm"],
  "hand_r": ["R_Hand"],

  "thigh_l": ["L_Thigh"],
  "calf_l": ["L_Calf"],
  "foot_l": ["L_Foot"],

  "thigh_r": ["R_Thigh"],
  "calf_r": ["R_Calf"],
  "foot_r": ["R_Foot"],
};
window.boneMapping = boneMapping;

export function matchFbxAnimationToPrincipal() {
  const { bonesByName, fbxBonesByName, originalBoneRotations } = state;

  // Reset à la bind pose avant d'appliquer le delta de l'animation FBX
  bonesByName.forEach((bone) => {
    const originalRot = originalBoneRotations.get(bone.uuid);
    if (originalRot) bone.rotation.copy(originalRot);
  });

  // Aligne chaque bone FBX sur son équivalent GLB
  fbxBonesByName.forEach((bone, name) => {
    const mappedBoneNames = boneMapping[name];
    if (mappedBoneNames) {
      for (const targetName of mappedBoneNames) {
        const targetBone = bonesByName.get(targetName);
        if (targetBone) alignBones(bone, targetBone);
      }
    } else if (bonesByName.get(name)) {
      alignBones(bone, bonesByName.get(name));
    }
  });

  if(state.fbxSourceFormat === "FBX"){
    // Corrections manuelles spécifiques au rig (axes inversés, twists, clavicules)
    bonesByName.get("L_Clavicle")?.rotateY(-Math.PI / 2);
    bonesByName.get("R_Clavicle")?.rotateY(Math.PI / 2);

    if (bonesByName.get("R_Upperarm")) rotateOnParent(bonesByName.get("R_Upperarm"), 0, -Math.PI / 2, 0);
    bonesByName.get("R_UpperarmTwist01")?.rotateY(Math.PI / 2);
    // bonesByName.get("R_Hand")?.rotateY(Math.PI / 2);

    if (bonesByName.get("L_Upperarm")) rotateOnParent(bonesByName.get("L_Upperarm"), 0, Math.PI / 2, 0);
    bonesByName.get("L_UpperarmTwist01")?.rotateY(-Math.PI / 2);
    // bonesByName.get("L_Hand")?.rotateY(-Math.PI / 2);

    bonesByName.get("Pelvis")?.rotateY(Math.PI);
    if (bonesByName.get("L_Thigh")) rotateOnParent(bonesByName.get("L_Thigh"), 0, Math.PI, 0);
    if (bonesByName.get("R_Thigh")) rotateOnParent(bonesByName.get("R_Thigh"), 0, Math.PI, 0);
    bonesByName.get("Waist")?.rotateY(Math.PI);

    if (bonesByName.get("L_Clavicle")) rotateOnParent(bonesByName.get("L_Clavicle"), 0, Math.PI, 0);
    if (bonesByName.get("R_Clavicle")) rotateOnParent(bonesByName.get("R_Clavicle"), 0, Math.PI, 0);

    const head = bonesByName.get("Head");
    if (head) { head.rotation.x *= -1; head.rotation.z *= -1; }

    const neck1 = bonesByName.get("NeckTwist01");
    if (neck1) { neck1.rotation.x *= -1; neck1.rotation.z *= -1; }
    const neck2 = bonesByName.get("NeckTwist02");
    if (neck2) { neck2.rotation.x *= -1; neck2.rotation.z *= -1; }

    const spine1 = bonesByName.get("Spine01");
    if (spine1) { spine1.rotation.x *= -1; spine1.rotation.z *= -1; }
    const spine2 = bonesByName.get("Spine02");
    if (spine2) { spine2.rotation.x *= -1; spine2.rotation.z *= -1; }

  }else{

    bonesByName.get("Pelvis")?.rotateY(Math.PI);

    let l_thigh = bonesByName.get("L_Thigh");
    if(l_thigh) { l_thigh.rotation.x *= -1; l_thigh.rotation.z *= -1; }
    let r_thigh = bonesByName.get("R_Thigh");
    if(r_thigh) { r_thigh.rotation.x *= -1; r_thigh.rotation.z *= -1; }

    bonesByName.get("Waist")?.rotateY(Math.PI);
    bonesByName.get("Waist").rotateX(Math.PI/10);

    const spine1 = bonesByName.get("Spine01");
    if (spine1) {
      spine1.rotation.x *= -1; spine1.rotation.z *= -1;
      spine1.rotateX(-Math.PI/20);
    }
    const spine2 = bonesByName.get("Spine02");
    if (spine2) {
      spine2.rotation.x *= -1; spine2.rotation.z *= -1;
      spine2.rotateX(-Math.PI/20);
    }


    const neck1 = bonesByName.get("NeckTwist01");
    if (neck1) {
      neck1.rotation.x *= -1;
      neck1.rotation.z *= -1;
      neck1.rotateX(Math.PI/6);
    }
    const neck2 = bonesByName.get("NeckTwist02");
    if (neck2) {
      neck2.rotation.x *= -1;
      neck2.rotation.z *= -1;
      neck2.rotateX(-Math.PI/6);
    }
    //
    const head = bonesByName.get("Head");
    if (head) {
      head.rotation.x *= -1;
      head.rotation.z *= -1;
    }

    // const head = bonesByName.get("Head");
    // if (head) {
    //   head.rotation.x *= -1; head.rotation.z *= -1;
    //   //head.rotateX(Math.PI/6);
    // }

    if (bonesByName.get("L_Clavicle")) rotateOnParent(bonesByName.get("L_Clavicle"), 0, Math.PI, 0);
    if (bonesByName.get("R_Clavicle")) rotateOnParent(bonesByName.get("R_Clavicle"), 0, Math.PI, 0);

    bonesByName.get("R_Clavicle").rotateY(-Math.PI/2)
    rotateOnParent(bonesByName.get("R_Upperarm"),0, Math.PI/2,0)
    bonesByName.get("R_Clavicle").rotateX(Math.PI/4)
    rotateOnParent(bonesByName.get("R_Upperarm"),-Math.PI/4, 0, 0)

    bonesByName.get("L_Clavicle").rotateY(Math.PI/2)
    rotateOnParent(bonesByName.get("L_Upperarm"),0, -Math.PI/2,0)
    bonesByName.get("L_Clavicle").rotateX(Math.PI/4)
    rotateOnParent(bonesByName.get("L_Upperarm"),-Math.PI/4, 0, 0)

    bonesByName.get("R_Forearm").rotateY(-Math.PI/2)
    bonesByName.get("L_Forearm").rotateY(Math.PI/2)

    rotateOnParent(bonesByName.get("R_Hand"), 0, Math.PI/2,0);
    rotateOnParent(bonesByName.get("L_Hand"), 0, -Math.PI/2,0);

    bonesByName.get("R_Hand").rotateY(-Math.PI/2)
    bonesByName.get("L_Hand").rotateY(Math.PI/2)


    let l_calf = bonesByName.get("L_Calf");
    if(l_calf) { l_calf.rotation.x *= -1; l_calf.rotation.z *= -1; }
    let r_calf = bonesByName.get("R_Calf");
    if(r_calf) { r_calf.rotation.x *= -1; r_calf.rotation.z *= -1; }


    let l_foot = bonesByName.get("L_Foot");
    if(l_foot) { l_foot.rotation.x *= -1; l_foot.rotation.z *= -1; l_foot.rotation.x += Math.PI / 8; }
    let r_foot = bonesByName.get("R_Foot");
    if(r_foot) { r_foot.rotation.x *= -1; r_foot.rotation.z *= -1; r_foot.rotation.x += Math.PI / 8; }

    window.r?.();

    // bonesByName.get("R_Clavicle").rotateZ(Math.PI)
    // bonesByName.get("L_Clavicle").rotateZ(Math.PI)
    //
    // bonesByName.get("R_Clavicle").rotateY(-Math.PI/2)
    //
    // rotateOnParent(bonesByName.get("R_Upperarm"),0, Math.PI/2, 0)
    // //bonesByName.get("R_Upperarm").rotateX(-Math.PI/2)
  }


  // Reprend la position verticale du Hip depuis l'animation source.
  // - FBX (Mixamo) : root nommé "Hips", axe vertical LOCAL = Y, bind en cm typiquement.
  // - GLB (ce rig) : root nommé "root", axe vertical LOCAL = Z, bind en m typiquement.
  // Le bone est résolu au load via state.fbxRootBone (selon fbxSourceFormat).
  // Le ratio = magnitude(bindLocal_target) / magnitude(bindLocal_source) compense
  // automatiquement les différences d'units (cm/m) sans tuning manuel.
  const fbxHips = state.fbxHipsBone;
  const fbxHipsBindLocal = state.fbxHipsOriginalLocalPosition;
  const targetHip = bonesByName.get('Hip');
  const targetHipBindLocal = state.hipsOriginalLocalPosition;

  if (fbxHips && fbxHipsBindLocal && targetHip && targetHipBindLocal) {
    const fbxBindMag = fbxHipsBindLocal.length();
    const ratio = fbxBindMag > 1e-6 ? targetHipBindLocal.length() / fbxBindMag : 1;
    if(state.fbxSourceFormat == "FBX"){
      // Axe vertical FBX = Y (Mixamo), GLB = Z (ce rig). Ajuste si besoin.
      const deltaVerticalFBX_Y = fbxHips.position.y - fbxHipsBindLocal.y;
      targetHip.position.z = targetHipBindLocal.z + deltaVerticalFBX_Y * ratio;

      const deltaVerticalFBX_X = fbxHips.position.x - fbxHipsBindLocal.x;
      targetHip.position.x = targetHipBindLocal.x + deltaVerticalFBX_X * ratio;

      const deltaVerticalFBX_Z = fbxHips.position.z - fbxHipsBindLocal.z;
      targetHip.position.y = targetHipBindLocal.y - deltaVerticalFBX_Z * ratio;
    }else{
      // Axe vertical FBX = Y (Mixamo), GLB = Z (ce rig). Ajuste si besoin.
      const deltaVerticalFBX_Y = fbxHips.position.y - fbxHipsBindLocal.y;
      targetHip.position.y = targetHipBindLocal.y + deltaVerticalFBX_Y * ratio;

      const deltaVerticalFBX_X = fbxHips.position.x - fbxHipsBindLocal.x;
      targetHip.position.x = targetHipBindLocal.x + deltaVerticalFBX_X * ratio;

      const deltaVerticalFBX_Z = fbxHips.position.z - fbxHipsBindLocal.z;
      targetHip.position.z = targetHipBindLocal.z + deltaVerticalFBX_Z * ratio;
    }
  }

  // Reprend la position verticale du Hip depuis l'animation source.
  // - FBX (Mixamo) : root nommé "Hips", axe vertical LOCAL = Y, bind en cm typiquement.
  // - GLB (ce rig) : root nommé "root", axe vertical LOCAL = Z, bind en m typiquement.
  // Le bone est résolu au load via state.fbxRootBone (selon fbxSourceFormat).
  // Le ratio = magnitude(bindLocal_target) / magnitude(bindLocal_source) compense
  // automatiquement les différences d'units (cm/m) sans tuning manuel.
  const fbxRoot = state.fbxRootBone;
  const fbxRootBindLocal = state.fbxRootOriginalLocalPosition;
  const targetRoot = bonesByName.get('Root');
  const targetRootBindLocal = state.rootOriginalLocalPosition;

  if (fbxRoot && fbxRootBindLocal && targetRoot && targetRootBindLocal) {
    const fbxBindMag = fbxHipsBindLocal.length();
    const ratio = fbxBindMag > 1e-6 ? targetHipBindLocal.length() / fbxBindMag : 1;
    if(state.fbxSourceFormat === "FBX"){
      // Axe vertical FBX = Y (Mixamo), GLB = Z (ce rig). Ajuste si besoin.
      const deltaVerticalFBX_Y = fbxRoot.position.y - fbxRootBindLocal.y;
      targetRoot.position.z = targetRootBindLocal.z + deltaVerticalFBX_Y * ratio;

      const deltaVerticalFBX_X = fbxRoot.position.x - fbxRootBindLocal.x;
      targetRoot.position.x = targetRootBindLocal.x + deltaVerticalFBX_X * ratio;

      const deltaVerticalFBX_Z = fbxRoot.position.z - fbxRootBindLocal.z;
      targetRoot.position.y = targetRootBindLocal.y - deltaVerticalFBX_Z * ratio;
    }else{
      // Axe vertical FBX = Y (Mixamo), GLB = Z (ce rig). Ajuste si besoin.
      const deltaVerticalFBX_Y = fbxRoot.position.y - fbxRootBindLocal.y;
      targetRoot.position.z = targetRootBindLocal.z + deltaVerticalFBX_Y * ratio;
      //
      const deltaVerticalFBX_X = fbxRoot.position.x - fbxRootBindLocal.x;
      targetRoot.position.y = targetRootBindLocal.y + deltaVerticalFBX_X * ratio;

      const deltaVerticalFBX_Z = fbxRoot.position.z - fbxRootBindLocal.z;
      targetRoot.position.x = targetRootBindLocal.x + deltaVerticalFBX_Z * ratio;
    }
  }
}
