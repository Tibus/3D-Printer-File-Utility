// Mode Props : import de modèles GLB additionnels (sans bones), placement
// via gizmo translate/rotate/scale. Phase 1 : chargement + transform.
// Le système d'enveloppe (cage FFD) et le weight paint sur prop seront
// ajoutés dans des phases ultérieures.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { state } from './state.js';
import { updateInfo } from './ui.js';
import {
  addCageToProp, removeCageFromProp, resetCageVertices,
  deselectCageVertex,
  enterCageTransformMode, exitCageTransformMode,
} from './cage.js';
import { exitWeightPaintMode } from './weight-paint.js';
import { toggleRestPose } from './animation.js';

const gltfLoader = new GLTFLoader();

// Initialisation paresseuse des structures de state
function ensurePropsState() {
  if (!state.props) state.props = [];
}

// Active/désactive l'affichage des groupes de cage de tous les props.
// Utilisé pour les masquer quand on n'est pas en mode Props (la cage est un
// outil d'édition, pas un élément de la scène finale).
export function setAllCagesVisible(visible) {
  if (!state.props) return;
  for (const prop of state.props) {
    if (prop.cage?.group) prop.cage.group.visible = visible;
  }
}

// Convertit chaque SkinnedMesh en Mesh statique (géométrie en pose bind) et
// retire les Bones internes au subtree. Sans ça :
//  - le SkeletonHelper de currentModel les dessine (squelette indésirable) ;
//  - les bones internes se retrouvent ré-exportés et reviennent au reload.
//
// Important : on PRESERVE les SkinnedMeshes dont le squelette est partagé
// avec le corps (= au moins un bone est hors de propRoot). C'est le cas
// après un round-trip d'un prop "lié au squelette" : son skeleton pointe
// vers les bones du corps et on veut garder la peinture.
function isSkeletonPrivateToProp(skeleton, propRoot) {
  if (!skeleton?.bones?.length) return true;
  for (const bone of skeleton.bones) {
    let n = bone;
    let inside = false;
    while (n) {
      if (n === propRoot) { inside = true; break; }
      n = n.parent;
    }
    if (!inside) return false; // au moins un bone est partagé → garder skinning
  }
  return true;
}

function stripPropSkeleton(propRoot) {
  // 1. SkinnedMesh dont le squelette est privé au prop → Mesh statique
  const skinnedToStrip = [];
  propRoot.traverse((c) => {
    if (c.isSkinnedMesh && isSkeletonPrivateToProp(c.skeleton, propRoot)) {
      skinnedToStrip.push(c);
    }
  });
  for (const sm of skinnedToStrip) {
    if (!sm.parent) continue;
    const geom = sm.geometry.clone();
    geom.deleteAttribute('skinIndex');
    geom.deleteAttribute('skinWeight');
    const newMesh = new THREE.Mesh(geom, sm.material);
    newMesh.name = sm.name;
    newMesh.position.copy(sm.position);
    newMesh.quaternion.copy(sm.quaternion);
    newMesh.scale.copy(sm.scale);
    newMesh.castShadow = sm.castShadow;
    newMesh.receiveShadow = sm.receiveShadow;
    sm.parent.add(newMesh);
    sm.parent.remove(sm);
  }

  // 2. Retire les Bones internes au subtree (= ceux qui sont enfants directs/indirects de propRoot)
  const bones = [];
  propRoot.traverse((c) => { if (c.isBone) bones.push(c); });
  for (const bone of bones) bone.parent?.remove(bone);
}

export function loadProp(url, filename) {
  ensurePropsState();
  gltfLoader.load(
    url,
    (gltf) => {
      const propRoot = gltf.scene;
      stripPropSkeleton(propRoot);
      propRoot.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      // Normalise la taille (cible : ~0.4 unité max — petit objet posable)
      const box = new THREE.Box3().setFromObject(propRoot);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const fitScale = 0.4 / maxDim;
      propRoot.scale.setScalar(fitScale);

      // Place devant le modèle principal (au sol)
      propRoot.position.set(0.5, 0.4, 0.5);

      const propEntry = {
        id: state.props.length,
        name: filename || `Prop ${state.props.length + 1}`,
        root: propRoot,
      };
      state.props.push(propEntry);
      state.scene.add(propRoot);

      updatePropsListUI();
      selectProp(propEntry);
      updateInfo(`Prop "${propEntry.name}" importé.`);
    },
    undefined,
    (error) => {
      console.error('Erreur de chargement du prop:', error);
      updateInfo('Erreur lors du chargement du prop.');
    },
  );
}

// Pour les props ré-importés depuis un GLB (déjà placés dans la scène, ou à
// rattacher par l'appelant). Crée juste l'entrée et rafraîchit la liste UI.
export function registerImportedProp(root, name) {
  ensurePropsState();
  // Filet de sécurité au cas où un ancien GLB contient encore un squelette
  // dans le subtree d'un prop (avant que stripPropSkeleton soit appliqué à
  // l'import initial). Idempotent si déjà strippé.
  stripPropSkeleton(root);
  // Active les shadows sur les meshes du prop (le traverse principal les skip
  // pour ne pas polluer state.bones/state.skinnedMeshes).
  root.traverse((c) => {
    if (c.isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  const entry = {
    id: state.props.length,
    name: name || `Prop ${state.props.length + 1}`,
    root,
  };
  state.props.push(entry);
  updatePropsListUI();
  return entry;
}

// Vide la liste des props et les retire de la scène. Appelé au reset modèle.
export function clearAllProps() {
  ensurePropsState();
  for (const prop of state.props) {
    if (prop.cage) removeCageFromProp(prop);
    prop.root.parent?.remove(prop.root);
    prop.root.traverse?.((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
        else c.material.dispose();
      }
    });
  }
  state.props = [];
  state.selectedProp = null;
  updatePropsListUI();
  updateSelectedPropPanel();
}

export function selectProp(propEntry) {
  ensurePropsState();
  // Si on quitte un prop avec une cage en cours d'orientation, on bake d'abord
  if (state.cageTransformMode && state.selectedProp && state.selectedProp !== propEntry) {
    exitCageTransformMode(state.selectedProp);
  }
  // Si on changeait de prop alors qu'un cage vertex de l'ancien était sélectionné,
  // on déselectionne ce vertex pour revenir au gizmo "transform prop".
  if (state.selectedProp && state.selectedProp !== propEntry) {
    deselectCageVertex(state.selectedProp);
  }
  state.selectedProp = propEntry;
  if (state.propsMode && propEntry) {
    setPropGizmoMode(state.propGizmoMode || 'translate');
    state.transformControls.attach(propEntry.root);
  }
  updatePropsListUI();
  updateSelectedPropPanel();
}

export function deleteSelectedProp() {
  ensurePropsState();
  const prop = state.selectedProp;
  if (!prop) return;
  if (prop.cage) removeCageFromProp(prop);
  state.transformControls.detach();
  // prop.root peut être enfant de scene ou d'un bone (si lié) → on retire
  // depuis son parent réel
  prop.root.parent?.remove(prop.root);
  prop.root.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
      else child.material.dispose();
    }
  });
  state.props = state.props.filter((p) => p !== prop);
  state.selectedProp = null;
  updatePropsListUI();
  updateSelectedPropPanel();
}

export function setPropGizmoMode(mode) {
  if (!['translate', 'rotate', 'scale'].includes(mode)) return;
  state.propGizmoMode = mode;
  // Si un cage vertex est sélectionné on revient d'abord au mode "transform prop"
  if (state.selectedProp && !state.cageTransformMode) deselectCageVertex(state.selectedProp);
  state.transformControls.setMode(mode);
  state.transformControls.setSpace(mode === 'rotate' ? 'local' : 'world');
  // En mode "Orienter cage" le gizmo manipule le cage group, sinon le prop
  if (state.cageTransformMode && state.selectedProp?.cage?.group) {
    state.transformControls.attach(state.selectedProp.cage.group);
  } else if (state.selectedProp) {
    state.transformControls.attach(state.selectedProp.root);
  }
  ['translate', 'rotate', 'scale'].forEach((m) => {
    const btn = document.getElementById(`prop-gizmo-${m}`);
    if (btn) btn.classList.toggle('active', m === mode);
  });
}

// Lie un prop au squelette principal en convertissant chacun de ses Mesh en
// SkinnedMesh qui partage la skeleton du corps. À l'init, tous les vertices
// ont un poids 1.0 vers le bone choisi (équivalent attach rigide). L'utilisateur
// peut ensuite passer en mode 🎨 Paint pour redistribuer les poids vers
// plusieurs bones (utile pour une armure complète, une cape, etc.).
export function bindPropToBone(prop, bone) {
  if (!prop || !bone) return;
  const referenceMesh = state.skinnedMeshes.find((m) => m.skeleton);
  const skeleton = referenceMesh?.skeleton;
  if (!skeleton) {
    updateInfo("Pas de squelette dans le modèle principal — impossible de lier le prop.");
    return;
  }
  const boneIndex = skeleton.bones.indexOf(bone);
  if (boneIndex < 0) {
    updateInfo(`Le bone "${bone.name}" n'appartient pas au squelette principal.`);
    return;
  }

  // Sortir du weight paint si actif (les SkinnedMeshes ajoutés ensuite n'auraient
  // pas leur material setup paint sinon).
  if (state.weightPaintMode) exitWeightPaintMode();

  // Si déjà bind, on relâche d'abord pour repartir de Meshes simples
  if (prop.binding) unbindProp(prop);

  // Détache d'un éventuel parent bone (mode rigide précédent), met dans la scène
  if (prop.root.parent !== state.scene) state.scene.attach(prop.root);

  // S'assure que les matrices monde sont à jour pour calculer les boneInverses
  state.scene.updateMatrixWorld(true);

  // IMPORTANT : on crée un Skeleton dédié au prop qui partage les MÊMES bones
  // (même array → indices valides en commun avec le body), mais avec ses
  // propres boneInverses calculés sur la pose courante des bones. Ainsi
  // skinMatrix = bone.matrixWorld × propBoneInverse = identité à l'instant du
  // bind → le prop ne se déplace pas, et il suivra ensuite les déformations.
  const propBoneInverses = skeleton.bones.map((b) => {
    const inv = new THREE.Matrix4();
    inv.copy(b.matrixWorld).invert();
    return inv;
  });
  const propSkeleton = new THREE.Skeleton(skeleton.bones, propBoneInverses);

  // Cherche tous les Meshes (non-SkinnedMesh) dans le subtree
  const meshes = [];
  prop.root.traverse((c) => {
    if (c.isMesh && !c.isSkinnedMesh) meshes.push(c);
  });

  const meshMap = new Map(); // oldMesh → newSkinnedMesh (pour remap cage)
  const skinnedMeshes = [];

  for (const mesh of meshes) {
    if (!mesh.parent) continue;
    mesh.updateMatrixWorld(true);
    const bindMatrix = new THREE.Matrix4().copy(mesh.matrixWorld);

    const geom = mesh.geometry;
    const vertCount = geom.attributes.position.count;
    const skinIndex = new Uint16Array(vertCount * 4);
    const skinWeight = new Float32Array(vertCount * 4);
    for (let i = 0; i < vertCount; i++) {
      skinIndex[i * 4] = boneIndex;
      skinWeight[i * 4] = 1.0;
    }
    geom.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geom.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));

    const skinned = new THREE.SkinnedMesh(geom, mesh.material);
    skinned.name = mesh.name;
    skinned.castShadow = mesh.castShadow;
    skinned.receiveShadow = mesh.receiveShadow;
    skinned.userData = mesh.userData;
    skinned.position.copy(mesh.position);
    skinned.quaternion.copy(mesh.quaternion);
    skinned.scale.copy(mesh.scale);

    skinned.bind(propSkeleton, bindMatrix);
    // bindMode 'detached' : sans ça, Three.js recalcule bindMatrixInverse
    // depuis matrixWorld à chaque frame, ce qui annule complètement la
    // transform du mesh au rendu (gizmo translate/rotate/scale sans effet).
    // En 'detached', bindMatrixInverse reste figé → la matrixWorld du prop
    // s'applique normalement par-dessus le skinning des bones.
    skinned.bindMode = 'detached';

    const parent = mesh.parent;
    parent.add(skinned);
    parent.remove(mesh);

    skinnedMeshes.push(skinned);
    meshMap.set(mesh, skinned);
  }

  // Remap les meshBindings de la cage pour pointer vers les nouveaux SkinnedMeshes
  if (prop.cage) {
    for (const mb of prop.cage.meshBindings) {
      const replacement = meshMap.get(mb.mesh);
      if (replacement) mb.mesh = replacement;
    }
  }

  // Ajoute les SkinnedMeshes du prop à state.skinnedMeshes pour que le weight
  // paint les voie comme n'importe quel mesh skinné du corps.
  for (const sm of skinnedMeshes) {
    if (!state.skinnedMeshes.includes(sm)) state.skinnedMeshes.push(sm);
  }

  prop.binding = {
    boneName: bone.name,
    mode: 'skinned',
    skinnedMeshes,
  };
  updateInfo(`Prop "${prop.name}" lié au squelette (poids initial → ${bone.name}). Mode 🎨 Paint pour redistribuer.`);
}

// Délie le prop : reconvertit chaque SkinnedMesh en Mesh statique, retire les
// attributs skinIndex/skinWeight, retire de state.skinnedMeshes.
export function unbindProp(prop) {
  if (!prop || !prop.binding) return;

  if (state.weightPaintMode) exitWeightPaintMode();

  const meshMap = new Map(); // oldSkinned → newMesh
  for (const sm of prop.binding.skinnedMeshes || []) {
    if (!sm.parent) continue;
    const mesh = new THREE.Mesh(sm.geometry, sm.material);
    mesh.name = sm.name;
    mesh.castShadow = sm.castShadow;
    mesh.receiveShadow = sm.receiveShadow;
    mesh.userData = sm.userData;
    mesh.position.copy(sm.position);
    mesh.quaternion.copy(sm.quaternion);
    mesh.scale.copy(sm.scale);

    mesh.geometry.deleteAttribute('skinIndex');
    mesh.geometry.deleteAttribute('skinWeight');

    sm.parent.add(mesh);
    sm.parent.remove(sm);
    meshMap.set(sm, mesh);

    const idx = state.skinnedMeshes.indexOf(sm);
    if (idx >= 0) state.skinnedMeshes.splice(idx, 1);
  }

  // Remap cage meshBindings vers les Meshes redevenus statiques
  if (prop.cage) {
    for (const mb of prop.cage.meshBindings) {
      const replacement = meshMap.get(mb.mesh);
      if (replacement) mb.mesh = replacement;
    }
  }

  prop.binding = null;
}

function onClickBindProp() {
  if (!state.selectedProp) return;
  const select = document.getElementById('prop-bind-bone');
  const boneName = select?.value;
  if (!boneName) {
    updateInfo("Sélectionne d'abord un bone dans la liste avant de lier.");
    return;
  }
  const bone = state.bonesByName.get(boneName);
  if (bone) {
    bindPropToBone(state.selectedProp, bone);
    updateSelectedPropPanel();
  }
}

function onClickUnbindProp() {
  if (!state.selectedProp) return;
  unbindProp(state.selectedProp);
  updateSelectedPropPanel();
}

// Cage actions exposées au panneau Props
export function onAddCage() {
  if (!state.selectedProp) return;
  if (state.selectedProp.cage) return;
  addCageToProp(state.selectedProp);
  updateSelectedPropPanel();
  updateInfo('Cage ajoutée. Cliquez un point vert et glissez le gizmo pour déformer.');
}

export function onRemoveCage() {
  if (!state.selectedProp?.cage) return;
  removeCageFromProp(state.selectedProp);
  // Réattache le gizmo au prop
  state.transformControls.attach(state.selectedProp.root);
  updateSelectedPropPanel();
}

export function onResetCage() {
  if (!state.selectedProp?.cage) return;
  resetCageVertices(state.selectedProp);
}

export function onToggleOrientCage() {
  const prop = state.selectedProp;
  if (!prop?.cage) return;
  if (state.cageTransformMode) {
    exitCageTransformMode(prop);
    state.transformControls.attach(prop.root);
  } else {
    enterCageTransformMode(prop);
  }
  updateSelectedPropPanel();
}

export function enterPropsMode() {
  ensurePropsState();
  state.propsMode = true;

  // Force la pose de repos pendant qu'on travaille sur les props : ainsi
  // bindPropToBone capture une pose stable et reproductible (= bind pose du
  // body). On mémorise si on l'a déclenché pour le restaurer en sortie.
  state.propsModeForcedRest = false;
  if (!state.atRestPose) {
    toggleRestPose();
    state.propsModeForcedRest = true;
  }

  // Affiche les cages
  setAllCagesVisible(true);

  // Détache le gizmo des bones et configure pour les props
  state.transformControls.detach();
  setPropGizmoMode(state.propGizmoMode || 'translate');

  // Si un prop est déjà sélectionné, ré-attache
  if (state.selectedProp) {
    state.transformControls.attach(state.selectedProp.root);
  }

  document.getElementById('rotation-controls')?.classList.remove('visible');
  document.getElementById('weight-paint-controls')?.classList.remove('visible');
  document.getElementById('joint-edit-controls')?.classList.remove('visible');
  document.getElementById('ik-controls')?.classList.remove('visible');
  document.getElementById('props-controls')?.classList.add('visible');

  ['mode-pose-btn', 'mode-paint-btn', 'mode-joints-btn', 'mode-ik-btn']
    .forEach((id) => document.getElementById(id)?.classList.remove('active'));
  document.getElementById('mode-props-btn')?.classList.add('active');

  updatePropsListUI();
  updateSelectedPropPanel();
}

export function exitPropsMode() {
  if (!state.propsMode) return;
  // Si on est en train d'orienter une cage, on bake d'abord pour ne pas
  // perdre la transformation accumulée
  if (state.cageTransformMode && state.selectedProp) {
    exitCageTransformMode(state.selectedProp);
  }
  state.propsMode = false;

  // Restaure la pose précédente si on avait forcé la pose de repos à l'entrée
  if (state.propsModeForcedRest && state.atRestPose) {
    toggleRestPose();
  }
  state.propsModeForcedRest = false;

  // Masque les cages (elles ne sont pas un élément de la scène finale)
  setAllCagesVisible(false);

  state.transformControls.detach();
  // Restaure le mode rotate (utilisé par le pose mode classique)
  state.transformControls.setMode('rotate');
  state.transformControls.setSpace('local');

  document.getElementById('props-controls')?.classList.remove('visible');
  document.getElementById('mode-props-btn')?.classList.remove('active');
  document.getElementById('mode-pose-btn')?.classList.add('active');

  // Réattache le gizmo au bone sélectionné (si il y en a un) pour reprendre
  // exactement où le mode Pose s'était arrêté.
  if (state.selectedBone) {
    state.transformControls.attach(state.selectedBone);
    document.getElementById('rotation-controls')?.classList.add('visible');
  }
}

function updatePropsListUI() {
  ensurePropsState();
  const listEl = document.getElementById('props-list');
  if (!listEl) return;
  if (state.props.length === 0) {
    listEl.innerHTML = '<div id="no-props-msg" style="color:#888;">Aucun prop importé</div>';
    return;
  }
  listEl.innerHTML = '';
  state.props.forEach((prop) => {
    const btn = document.createElement('button');
    btn.className = 'prop-item';
    if (prop === state.selectedProp) btn.classList.add('active');
    btn.textContent = prop.name;
    btn.addEventListener('click', () => selectProp(prop));
    listEl.appendChild(btn);
  });
}

function updateSelectedPropPanel() {
  const panel = document.getElementById('prop-transform-controls');
  const nameEl = document.getElementById('prop-selected-name');
  const cageSection = document.getElementById('prop-cage-section');
  const addBtn = document.getElementById('prop-add-cage-btn');
  const cageActions = document.getElementById('prop-cage-actions');
  const bindSection = document.getElementById('prop-bind-section');
  const bindSelect = document.getElementById('prop-bind-bone');
  if (!panel || !nameEl) return;
  if (state.selectedProp) {
    panel.style.display = '';
    nameEl.textContent = state.selectedProp.name;
    if (cageSection) cageSection.style.display = '';
    const hasCage = !!state.selectedProp.cage;
    if (addBtn) addBtn.style.display = hasCage ? 'none' : '';
    if (cageActions) cageActions.style.display = hasCage ? '' : 'none';
    const orientBtn = document.getElementById('prop-orient-cage-btn');
    if (orientBtn) {
      orientBtn.classList.toggle('active', !!state.cageTransformMode);
      orientBtn.textContent = state.cageTransformMode ? '✓ Valider l\'orientation' : '↔️ Orienter cage';
    }

    if (bindSection) {
      const hasBones = state.bones && state.bones.length > 0;
      bindSection.style.display = hasBones ? '' : 'none';
      const isBound = !!state.selectedProp.binding;
      if (bindSelect && hasBones) {
        const currentBoneName = state.selectedProp.binding?.boneName || '';
        bindSelect.innerHTML = '';
        for (const b of state.bones) {
          const opt = document.createElement('option');
          opt.value = b.name;
          opt.textContent = b.name;
          if (b.name === currentBoneName) opt.selected = true;
          bindSelect.appendChild(opt);
        }
        bindSelect.disabled = isBound;
      }
      const bindBtn = document.getElementById('prop-bind-btn');
      const unbindBtn = document.getElementById('prop-unbind-btn');
      const hint = document.getElementById('prop-bind-hint');
      const status = document.getElementById('prop-bind-status');
      if (bindBtn) bindBtn.style.display = isBound ? 'none' : '';
      if (unbindBtn) unbindBtn.style.display = isBound ? '' : 'none';
      if (hint) hint.style.display = isBound ? 'none' : '';
      if (status) {
        status.style.display = isBound ? '' : 'none';
        if (isBound) {
          const mode = state.selectedProp.binding.mode || 'rigid';
          const bn = state.selectedProp.binding.boneName || '';
          status.textContent = mode === 'skinned'
            ? `✅ Skinné (ancrage initial : ${bn || '?'}) — peins en mode 🎨 Paint.`
            : `✅ Lié rigidement à ${bn || '?'}.`;
        }
      }
    }
  } else {
    panel.style.display = 'none';
    nameEl.textContent = '—';
    if (cageSection) cageSection.style.display = 'none';
    if (bindSection) bindSection.style.display = 'none';
  }
}

export function attachPropsListeners() {
  document.getElementById('prop-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadProp(URL.createObjectURL(file), file.name);
    e.target.value = ''; // permet de re-importer le même fichier
  });

  document.getElementById('prop-gizmo-translate')?.addEventListener('click', () => setPropGizmoMode('translate'));
  document.getElementById('prop-gizmo-rotate')?.addEventListener('click', () => setPropGizmoMode('rotate'));
  document.getElementById('prop-gizmo-scale')?.addEventListener('click', () => setPropGizmoMode('scale'));

  document.getElementById('prop-delete-btn')?.addEventListener('click', deleteSelectedProp);

  document.getElementById('prop-add-cage-btn')?.addEventListener('click', onAddCage);
  document.getElementById('prop-remove-cage-btn')?.addEventListener('click', onRemoveCage);
  document.getElementById('prop-reset-cage-btn')?.addEventListener('click', onResetCage);
  document.getElementById('prop-orient-cage-btn')?.addEventListener('click', onToggleOrientCage);

  document.getElementById('prop-bind-btn')?.addEventListener('click', onClickBindProp);
  document.getElementById('prop-unbind-btn')?.addEventListener('click', onClickUnbindProp);
}
