// Chargement des modèles GLB/FBX et application d'animations FBX secondaires.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { state } from './state.js';
import { updateInfo, setFbxInputEnabled } from './ui.js';
import { exitWeightPaintMode } from './weight-paint.js';
import { exitJointEditMode } from './joint-edit.js';
import { exitIKMode } from './ik.js';
import { exitPropsMode, clearAllProps, registerImportedProp, setAllCagesVisible } from './props.js';
import { rebuildCageFromImported } from './cage.js';
import { clearHistory } from './history.js';
import { createAllBoneMarkers, updateBoneList } from './bones.js';
import { updateAnimationsList, playAnimation } from './animation.js';

const gltfLoader = new GLTFLoader();
const fbxLoader = new FBXLoader();

export function loadPrincipal(url, filename) {
  const loading = document.getElementById('loading');
  loading.style.display = 'block';

  // Quitter les modes spéciaux pour rétablir un état propre avant dispose
  if (state.weightPaintMode) exitWeightPaintMode();
  if (state.jointEditMode) exitJointEditMode();
  if (state.ikMode) exitIKMode();
  if (state.propsMode) exitPropsMode();
  clearAllProps();
  clearHistory();

  // Dispose le modèle précédent
  if (state.currentModel) {
    state.scene.remove(state.currentModel);
    state.currentModel.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    });
  }

  // Reset état weight paint
  state.skinnedMeshes.length = 0;
  state.paintMaterials.forEach((cache) => {
    // cache = { basic?, lambert? } depuis le refactor du shading toggle
    if (cache && typeof cache === 'object') {
      if (cache.basic) cache.basic.dispose();
      if (cache.lambert) cache.lambert.dispose();
    }
  });
  state.paintMaterials.clear();
  state.originalMaterials.clear();
  state.vertexGroups.clear();

  // Reset état joint edit
  state.originalBoneInverses.clear();
  state.originalBonePositions.clear();
  state.jointDragSnapshot.bone = null;
  state.jointDragSnapshot.followSet.clear();
  state.jointDragSnapshot.worldStart.clear();
  state.jointDragSnapshot.skinningPerMesh.clear();
  state.jointDragSnapshot.childWorldPositions.clear();

  // Reset rest pose
  if (state.atRestPose) {
    state.atRestPose = false;
    const restBtn = document.getElementById('toggle-rest-pose-btn');
    if (restBtn) {
      restBtn.textContent = '🧍 Pose au repos';
      restBtn.classList.remove('active');
    }
  }
  state.posedBoneRotations.clear();

  // Clear skeleton helper
  if (state.skeletonHelper) {
    state.scene.remove(state.skeletonHelper);
    state.skeletonHelper.dispose();
    state.skeletonHelper = null;
  }

  state.transformControls.detach();

  // Clear bone markers + sélection
  state.boneMarkersGroup.clear();
  state.boneMarkers = [];
  state.selectableBoneMarkers = [];
  state.selectedBone = null;
  state.selectedBoneIndex = -1;
  state.bones = [];
  state.bonesByName.clear();
  state.originalBoneRotations.clear();
  state.principalAnimations = [];
  state.fbxAnimations = [];

  if (state.mixer) {
    state.mixer.stopAllAction();
    state.mixer = null;
  }
  state.activeAction = null;

  setFbxInputEnabled(false);
  document.getElementById('fbx-status').classList.remove('visible');
  document.getElementById('animation-timeline')?.classList.remove('visible');

  const lower = filename.toLowerCase();
  if (lower.endsWith('.gltf') || lower.endsWith('.glb')) {
    gltfLoader.load(
      url,
      (gltf) => {
        loading.style.display = 'none';
        state.currentModel = gltf.scene;
        state.principalAnimations = gltf.animations;
        manageCurrentModelAfterLoad();
      },
      (progress) => {
        const percent = (progress.loaded / progress.total * 100).toFixed(0);
        loading.querySelector('p').textContent = `Chargement... ${percent}%`;
      },
      (error) => {
        loading.style.display = 'none';
        console.error('Erreur de chargement GLB:', error);
        updateInfo('Erreur lors du chargement du fichier GLB.');
      },
    );
  } else if (lower.endsWith('.fbx')) {
    fbxLoader.load(
      url,
      (fbx) => {
        loading.style.display = 'none';
        state.currentModel = fbx;
        state.principalAnimations = fbx.animations;
        manageCurrentModelAfterLoad();
      },
      (progress) => {
        const percent = (progress.loaded / progress.total * 100).toFixed(0);
        loading.querySelector('p').textContent = `Chargement... ${percent}%`;
      },
      (error) => {
        loading.style.display = 'none';
        console.error('Erreur de chargement FBX:', error);
        updateInfo('Erreur lors du chargement du fichier FBX.');
      },
    );
  }
}

function manageCurrentModelAfterLoad() {
  state.skinnedMeshes.length = 0;

  // Pré-collecte des sous-arbres "props" (importés depuis un GLB précédemment
  // exporté). On ne les inclut pas dans la collecte de bones/skinned meshes.
  const propRoots = [];
  state.currentModel.traverse((c) => {
    if (c.userData?.glbBonesEditor?.kind === 'prop') propRoots.push(c);
  });
  const propDescendantUuids = new Set();
  for (const root of propRoots) {
    root.traverse((c) => propDescendantUuids.add(c.uuid));
  }

  state.currentModel.traverse((child) => {
    if (propDescendantUuids.has(child.uuid)) return;
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
    if (child.isSkinnedMesh) state.skinnedMeshes.push(child);
    if (child.isBone) {
      state.bones.push(child);
      state.bonesByName.set(child.name, child);
      state.originalBoneRotations.set(child.uuid, child.rotation.clone());
    }
  });
  const skinnedMesh = state.skinnedMeshes[0] || null;

  // Snapshot pour "Reset All Joints"
  for (const sm of state.skinnedMeshes) {
    state.originalBoneInverses.set(sm, sm.skeleton.boneInverses.map((m) => m.clone()));
  }
  state.bones.forEach((b) => state.originalBonePositions.set(b.uuid, b.position.clone()));

  // Centre + redimensionne le modèle (cible : taille max ≈ 2 unités)
  const box = new THREE.Box3().setFromObject(state.currentModel);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = 2 / maxDim;
  state.currentModel.scale.multiplyScalar(scale);

  box.setFromObject(state.currentModel);
  box.getCenter(center);
  state.currentModel.position.sub(center);
  state.currentModel.position.y += (size.y * scale) / 2;

  state.scene.add(state.currentModel);
  state.currentModel.updateWorldMatrix(true, true);

  // Repositionne verticalement le modèle pour que le bone root du squelette soit à Y=0.
  // Cohérent avec le ikGroundY (qui prend la Y du root) → le sol logique est aligné.
  if (state.bones.length > 0) {
    let rootBone = state.bones[0];
    while (rootBone.parent && rootBone.parent.isBone) rootBone = rootBone.parent;
    rootBone.updateMatrixWorld(true);
    const rootWorldY = rootBone.getWorldPosition(new THREE.Vector3()).y;
    state.currentModel.position.y -= rootWorldY;
    state.currentModel.updateWorldMatrix(true, true);
  }

  state.hipsOriginalPosition = state.bonesByName.get('Hip')?.getWorldPosition(new THREE.Vector3());
  state.hipsOriginalLocalPosition = state.bonesByName.get('Hip')?.position.clone();

  state.rootOriginalPosition = state.bonesByName.get('Root')?.getWorldPosition(new THREE.Vector3());
  state.rootOriginalLocalPosition = state.bonesByName.get('Root')?.position.clone();

  // Hauteur world du modèle (max des 3 axes — gère les rigs Y-up et Z-up)
  {
    const bbox = new THREE.Box3().setFromObject(state.currentModel);
    const size = bbox.getSize(new THREE.Vector3());
    state.glbHeight = Math.max(size.x, size.y, size.z);
  }

  if (skinnedMesh && skinnedMesh.skeleton) {
    state.skeletonHelper = new THREE.SkeletonHelper(state.currentModel);
    state.skeletonHelper.material.linewidth = 2;
    state.skeletonHelper.material.color.setHex(0x00ffaa);
    state.skeletonHelper.visible = state.skeletonVisible;
    state.scene.add(state.skeletonHelper);
  }

  // Extrait les props (sous-arbres marqués lors d'un export précédent) :
  // - prop libre → state.scene.attach (sort de currentModel, préserve world)
  // - prop lié à un bone → on le laisse parenté au bone (ou on le rattache
  //   par nom si le parent n'est pas exactement un Bone à cause du round-trip).
  // Puis on cherche une cage à reconstruire à l'intérieur de chaque prop.
  for (const propRoot of propRoots) {
    const ud = propRoot.userData?.glbBonesEditor || {};
    const name = ud.name || propRoot.name || 'Prop';
    const boundToBoneName = ud.boundToBone || null;

    // Détecte mode skinné : SkinnedMesh dans le subtree → le squelette pilote
    // déjà la transformation, on ne re-parente PAS à un bone.
    let hasSkinned = false;
    propRoot.traverse((c) => { if (c.isSkinnedMesh) hasSkinned = true; });

    let bindingBone = null;
    if (!hasSkinned) {
      // Mode rigide (legacy) : re-parenter à un bone si applicable
      if (propRoot.parent?.isBone) {
        bindingBone = propRoot.parent;
      } else if (boundToBoneName) {
        const byName = state.bonesByName.get(boundToBoneName);
        if (byName) {
          byName.attach(propRoot);
          bindingBone = byName;
        }
      }
    }
    if (!bindingBone) {
      state.scene.attach(propRoot);
    }

    const propEntry = registerImportedProp(propRoot, name);

    // Si le subtree contient des SkinnedMesh (cas d'un prop "lié au squelette"
    // exporté précédemment), les ajouter à state.skinnedMeshes pour que le
    // weight paint les voie comme n'importe quel mesh skinné du corps.
    const skinnedInProp = [];
    propRoot.traverse((c) => { if (c.isSkinnedMesh) skinnedInProp.push(c); });
    if (skinnedInProp.length > 0) {
      for (const sm of skinnedInProp) {
        if (!state.skinnedMeshes.includes(sm)) state.skinnedMeshes.push(sm);
      }
      propEntry.binding = {
        mode: 'skinned',
        skinnedMeshes: skinnedInProp,
        boneName: boundToBoneName || null,
      };
    } else if (bindingBone) {
      propEntry.binding = { mode: 'rigid', boneName: bindingBone.name };
    }

    // Détection cage : un Mesh OU LineSegments (GLTFExporter convertit notre
    // cage Mesh wireframe en topologie LINES → re-importé en LineSegments).
    // Plusieurs heuristiques en cascade.
    const isCageCandidate = (c) => {
      if (c === propRoot) return false;
      if (!c.geometry?.attributes?.position) return false;
      return c.isMesh || c.isLineSegments || c.isLine;
    };

    let cageMeshFound = null;
    let cageRestArray = null;

    // Pass 1 : userData sur l'objet lui-même
    propRoot.traverse((c) => {
      if (cageMeshFound) return;
      if (!isCageCandidate(c)) return;
      const ud = c.userData?.glbBonesEditor;
      if (ud?.kind === 'cage') {
        cageMeshFound = c;
        cageRestArray = ud.rest || null;
      }
    });

    // Pass 2 : userData sur parent (Group)
    if (!cageMeshFound) {
      propRoot.traverse((c) => {
        if (cageMeshFound) return;
        if (c === propRoot || c.geometry) return;
        const ud = c.userData?.glbBonesEditor;
        if (ud?.kind !== 'cage') return;
        for (const child of c.children) {
          if (isCageCandidate(child)) {
            cageMeshFound = child;
            cageRestArray = ud.rest || null;
            break;
          }
        }
      });
    }

    // Pass 3 : heuristique 40-vertices
    if (!cageMeshFound) {
      propRoot.traverse((c) => {
        if (cageMeshFound) return;
        if (!isCageCandidate(c)) return;
        if (c.geometry.attributes.position.count === 40) {
          cageMeshFound = c;
          console.warn('[cage] détecté via heuristique 40-verts (userData manquant)');
        }
      });
    }

    if (cageMeshFound) {
      if (!cageRestArray) {
        // Pas de rest data trouvée → fallback : on utilise les positions actuelles
        // comme rest (la déformation antérieure est perdue, mais la cage redevient
        // éditable). À la première édition, le binding marchera correctement.
        const live = cageMeshFound.geometry.attributes.position.array;
        cageRestArray = Array.from(live);
        console.warn('[cage] rest data perdue dans le round-trip GLB → fallback : positions actuelles utilisées comme rest. La déformation antérieure n\'est pas restaurée.');
      }
      cageMeshFound.userData.glbBonesEditor = { kind: 'cage', rest: cageRestArray };
      rebuildCageFromImported(propEntry, cageMeshFound);
    }
  }

  // Cages reconstruites : visibles uniquement si on est en mode Props.
  setAllCagesVisible(!!state.propsMode);

  createAllBoneMarkers();
  state.mixer = new THREE.AnimationMixer(state.currentModel);

  if (state.principalAnimations.length > 0) {
    updateAnimationsList();
  } else {
    updateAnimationsList();
    updateInfo('Modèle chargé. Aucune animation GLB trouvée.');
  }

  updateBoneList();
  setFbxInputEnabled(true);

  const distance = Math.max(size.x, size.y, size.z) * scale * 2;
  state.camera.position.set(distance, distance * 0.7, distance);
  state.controls.target.set(0, (size.y * scale) / 2, 0);
  state.controls.update();
}

// Post-load commun : positionnement, skeleton helper, mixer, collecte des bones,
// snapshot des positions Hips. `model` est le THREE.Object3D racine et `animations`
// est un array d'AnimationClip (déjà extraits du fichier source).
function setupSecondaryAnimationSource(model, animations, filename, sourceLabel) {
  state.secondaryFbxModel = model;
  state.fbxAnimations = animations || [];

  model.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  // Place le modèle à droite du modèle principal
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = 4 / maxDim;
  model.scale.multiplyScalar(scale);

  box.setFromObject(model);
  box.getCenter(center);
  model.rotation.y += Math.PI / 2;
  model.position.sub(center);
  model.position.y += (size.y * scale) / 2;
  model.position.z += (size.z * scale) * 2;
  model.visible = false;

  state.scene.add(model);

  const bbox = new THREE.Box3().setFromObject(model);
  const finalSize = bbox.getSize(new THREE.Vector3());
  state.fbxHeight = Math.max(finalSize.x, finalSize.y, finalSize.z);

  state.skeletonHelperFbx = new THREE.SkeletonHelper(model);
  state.skeletonHelperFbx.material.linewidth = 2;
  state.skeletonHelperFbx.material.color.setHex(0xffaa00);
  state.skeletonHelperFbx.visible = state.skeletonVisible;
  // state.scene.add(state.skeletonHelperFbx);

  if (animations.length > 0) {
    state.mixerFbx = new THREE.AnimationMixer(model);
  }

  // Collecte des bones (nettoyage des préfixes type "mixamorig")
  state.fbxBonesByName.clear();
  model.traverse((child) => {
    if (child.isBone) {
      const cleanName = child.name.replace(/^mixamorig[_:1-9]?/i, '');
      if (!state.fbxBonesByName.has(cleanName)) {
        state.fbxBonesByName.set(cleanName, child);
      }
    }
  });

  model.updateWorldMatrix(true, true);
  // Convention root selon la source :
  //   FBX (Mixamo) → bone "Hips"
  //   GLB           → bone "root"
  // On stocke le nom et la référence pour que fbx-anim.js sache quoi utiliser
  // pour la transposition verticale du Hip cible.
  state.fbxSourceFormat = sourceLabel;
  state.fbxSourceRootName = sourceLabel === 'FBX' ? 'Hips' : 'pelvis';
  let hipsBone = state.fbxBonesByName.get(state.fbxSourceRootName);
  if (!hipsBone) {
    // Fallback : tente l'autre convention au cas où le fichier ne suit pas la règle
    hipsBone = state.fbxBonesByName.get('Hips')
            || state.fbxBonesByName.get('root')
            || state.fbxBonesByName.get('pelvis');
  }
  state.fbxHipsBone = hipsBone || null;
  state.fbxRootBone = state.fbxBonesByName.get('root');
  state.fbxHipsOriginalPosition = hipsBone?.getWorldPosition(new THREE.Vector3());
  state.fbxHipsOriginalLocalPosition = hipsBone?.position.clone();

  state.fbxRootOriginalPosition = state.fbxBonesByName.get('root')?.getWorldPosition(new THREE.Vector3());
  state.fbxRootOriginalLocalPosition = state.fbxBonesByName.get('root')?.position.clone();

  if (state.fbxAnimations.length > 0) {
    updateAnimationsList();
    playAnimation(0, 'fbx');
    document.getElementById('fbx-filename').textContent = filename;
    document.getElementById('fbx-status').classList.add('visible');
    updateInfo(`${state.fbxAnimations.length} animation(s) ${sourceLabel} chargée(s) et appliquée(s).`);
  } else {
    updateInfo(`Aucune animation compatible trouvée dans le ${sourceLabel}. Vérifie que les noms des bones correspondent.`);
  }
}

// Charge un fichier d'animation secondaire — accepte FBX, GLB et GLTF.
// Le format est détecté via l'extension du filename.
export function loadFBXAnimation(url, filename) {
  if (!state.currentModel || !state.mixer) {
    updateInfo("Veuillez d'abord charger un modèle GLB.");
    return;
  }

  const loading = document.getElementById('loading');
  loading.style.display = 'block';

  // Supprime la source secondaire précédente
  if (state.secondaryFbxModel) {
    state.scene.remove(state.secondaryFbxModel);
    state.secondaryFbxModel.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    });
    state.secondaryFbxModel = null;
  }
  if (state.skeletonHelperFbx) {
    state.scene.remove(state.skeletonHelperFbx);
    state.skeletonHelperFbx = null;
  }
  if (state.mixerFbx) {
    state.mixerFbx.stopAllAction();
    state.mixerFbx = null;
  }

  const lower = filename.toLowerCase();
  const isGLB = lower.endsWith('.glb') || lower.endsWith('.gltf');
  const isFBX = lower.endsWith('.fbx');
  const sourceLabel = isGLB ? 'GLB' : 'FBX';
  loading.querySelector('p').textContent = `Chargement animation ${sourceLabel}...`;

  const onProgress = (progress) => {
    if (progress.total) {
      const percent = (progress.loaded / progress.total * 100).toFixed(0);
      loading.querySelector('p').textContent = `Chargement ${sourceLabel}... ${percent}%`;
    }
  };
  const onError = (error) => {
    loading.style.display = 'none';
    console.error(`Erreur de chargement ${sourceLabel}:`, error);
    updateInfo(`Erreur lors du chargement du fichier ${sourceLabel}.`);
  };

  if (isFBX) {
    fbxLoader.load(url, (fbx) => {
      loading.style.display = 'none';
      setupSecondaryAnimationSource(fbx, fbx.animations || [], filename, 'FBX');
    }, onProgress, onError);
  } else if (isGLB) {
    gltfLoader.load(url, (gltf) => {
      loading.style.display = 'none';
      setupSecondaryAnimationSource(gltf.scene, gltf.animations || [], filename, 'GLB');
    }, onProgress, onError);
  } else {
    loading.style.display = 'none';
    updateInfo(`Format non supporté pour l'animation : ${filename}`);
  }
}
