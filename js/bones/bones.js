// Markers de bones, sélection, hiérarchie, contrôles de rotation.

import * as THREE from 'three';
import { state } from './state.js';
import { isTwistBone } from './utils.js';
import { updatePaintBoneName, refreshWeightColors } from './weight-paint.js';
import { updateJointBoneName, isBoneRotatableInJointMode } from './joint-edit.js';
import { pushUndo } from './history.js';

// ---------- Markers ----------

function createBoneMarker(bone, index, isSelected = false) {
  const isTwist = isTwistBone(bone);
  // Multi-sélectionné mais pas le primary : highlight orange (intermédiaire)
  const isMultiSelected = !isSelected
    && state.multiSelectedBones
    && state.multiSelectedBones.has(bone);
  const size = (isSelected || isMultiSelected) ? 0.045 : (isTwist ? 0.02 : 0.03);

  let color;
  if (isSelected) color = 0xffff00;
  else if (isMultiSelected) color = 0xff8800;
  else if (isTwist) color = 0x666666;
  else color = 0x4a9aff;

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(size, 16, 16),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: (isSelected || isMultiSelected) ? 1.0 : (isTwist ? 0.4 : 0.8),
      depthTest: false,
    }),
  );
  sphere.renderOrder = 999;
  sphere.userData.boneIndex = index;
  sphere.userData.isBoneMarker = true;
  sphere.userData.isTwistBone = isTwist;
  sphere.userData.isSelectable = !isTwist;

  if (isSelected) {
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(size * 1.5, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffff00,
        transparent: true,
        opacity: 0.3,
        depthTest: false,
      }),
    );
    glow.renderOrder = 998;
    sphere.add(glow);
  }

  return sphere;
}

export function updateBoneMarkers() {
  state.bones.forEach((bone, index) => {
    if (state.boneMarkers[index]) {
      bone.getWorldPosition(state.boneMarkers[index].position);
    }
  });
}

export function createAllBoneMarkers() {
  state.boneMarkersGroup.clear();
  state.boneMarkers = [];
  state.selectableBoneMarkers = [];

  state.bones.forEach((bone, index) => {
    const marker = createBoneMarker(bone, index, index === state.selectedBoneIndex);
    state.boneMarkersGroup.add(marker);
    state.boneMarkers.push(marker);
    if (!isTwistBone(bone)) state.selectableBoneMarkers.push(marker);
  });

  updateBoneMarkers();
}

export function updateSelectedBoneMarker() {
  createAllBoneMarkers();
}

// ---------- Schéma SVG du squelette (vue de face) ----------

// Met à jour la classe `selected` / `multi-selected` sur chaque node SVG.
export function updateBoneSchemaHighlight() {
  const nodes = document.querySelectorAll('#bone-schema .bone-node');
  nodes.forEach((node) => {
    const boneName = node.dataset.bone;
    const bone = state.bonesByName.get(boneName);
    const isPrimary = bone && bone === state.selectedBone;
    const isMulti = bone && state.multiSelectedBones.has(bone) && !isPrimary;
    node.classList.toggle('selected', !!isPrimary);
    node.classList.toggle('multi-selected', !!isMulti);
  });
}

// Branche un seul listener via délégation : tout élément avec data-bone est cliquable.
// Permet d'avoir des hit areas invisibles plus larges que les nodes visibles.
export function attachBoneSchemaListeners() {
  const schema = document.getElementById('bone-schema');
  if (!schema) return;
  schema.addEventListener('click', (e) => {
    const target = e.target.closest('[data-bone]');
    if (!target) return;
    const boneName = target.dataset.bone;
    const idx = state.bones.findIndex((b) => b.name === boneName);
    if (idx >= 0) selectBone(idx, e.shiftKey);
  });
}

// ---------- Liste hiérarchique ----------

export function updateBoneList() {
  const listContainer = document.getElementById('bone-list');
  listContainer.innerHTML = '';

  if (state.bones.length === 0) {
    listContainer.innerHTML = '<div id="no-bones-msg">Aucun bone trouvé</div>';
    document.getElementById('rotation-controls').classList.remove('visible');
    return;
  }

  const boneIndexMap = new Map();
  state.bones.forEach((bone, index) => boneIndexMap.set(bone, index));

  const rootBones = state.bones.filter(bone => {
    let parent = bone.parent;
    while (parent) {
      if (boneIndexMap.has(parent)) return false;
      parent = parent.parent;
    }
    return true;
  });

  function addBoneToList(bone, depth) {
    const index = boneIndexMap.get(bone);
    if (index === undefined) return;

    const item = document.createElement('div');
    item.className = 'bone-item';
    if (isTwistBone(bone)) item.classList.add('twist-bone');

    for (let i = 0; i < depth; i++) {
      const indent = document.createElement('span');
      indent.className = 'bone-indent';
      item.appendChild(indent);
    }

    const nameSpan = document.createElement('span');
    nameSpan.textContent = bone.name || `Bone ${index + 1}`;
    item.appendChild(nameSpan);

    item.dataset.index = String(index);
    item.addEventListener('click', (e) => selectBone(index, e.shiftKey));
    listContainer.appendChild(item);

    bone.children.forEach(child => {
      if (child.isBone && boneIndexMap.has(child)) addBoneToList(child, depth + 1);
    });
  }

  rootBones.forEach(rootBone => addBoneToList(rootBone, 0));
}

// ---------- Gizmo helper ----------
// Configure les axes visibles du gizmo en fonction du bone :
// les twist bones ne montrent que l'axe Y EN ROTATION (rotation autour de leur axe
// principal seulement). En translation, on garde les 3 axes pour pouvoir bouger
// librement le pivot d'un twist.
export function attachGizmoTo(bone) {
  if (!bone) {
    state.transformControls.detach();
    return;
  }
  const isTwist = isTwistBone(bone);
  const isRotateMode = state.transformControls.mode === 'rotate';
  const restrictToY = isTwist && isRotateMode;
  state.transformControls.showX = !restrictToY;
  state.transformControls.showY = true;
  state.transformControls.showZ = !restrictToY;
  state.transformControls.attach(bone);
}

// ---------- Sélection ----------

export function selectBone(index, additive = false) {
  const bone = state.bones[index];
  if (!bone) return;

  if (additive) {
    if (state.multiSelectedBones.has(bone)) {
      // Toggle off : retire de la multi-sélection
      state.multiSelectedBones.delete(bone);
      if (state.selectedBone === bone) {
        const remaining = [...state.multiSelectedBones];
        if (remaining.length > 0) {
          state.selectedBone = remaining[remaining.length - 1];
          state.selectedBoneIndex = state.bones.indexOf(state.selectedBone);
        } else {
          state.selectedBone = null;
          state.selectedBoneIndex = -1;
          state.transformControls.detach();
          updateSelectedBoneMarker();
          return;
        }
      }
    } else {
      state.multiSelectedBones.add(bone);
      state.selectedBone = bone;
      state.selectedBoneIndex = index;
    }
  } else {
    // Sélection simple : remplace toute la sélection
    state.multiSelectedBones.clear();
    state.multiSelectedBones.add(bone);
    state.selectedBone = bone;
    state.selectedBoneIndex = index;
  }

  document.querySelectorAll('.bone-item').forEach((item) => {
    const boneAtItem = state.bones[parseInt(item.dataset.index)];
    item.classList.toggle('selected', state.multiSelectedBones.has(boneAtItem));
  });
  updateBoneSchemaHighlight();

  const selectedItem = document.querySelector(`.bone-item[data-index="${state.selectedBoneIndex}"]`);
  if (selectedItem) selectedItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  document.getElementById('selected-bone-name').textContent =
    state.selectedBone.name || `Bone ${state.selectedBoneIndex + 1}`;

  updateRotationUI();
  updateSelectedBoneMarker();

  if (state.weightPaintMode) {
    state.transformControls.detach();
    document.getElementById('rotation-controls').classList.remove('visible');
    updatePaintBoneName();
    refreshWeightColors();
  } else if (state.jointEditMode) {
    document.getElementById('rotation-controls').classList.remove('visible');
    if (isBoneRotatableInJointMode(state.selectedBone)) {
      // Mains/pieds : gizmo de rotation + drag direct du marker pour translation
      state.transformControls.setMode('rotate');
      state.transformControls.setSpace('local');
    } else {
      // Autres bones : gizmo de translation (drag direct désactivé)
      state.transformControls.setMode('translate');
      state.transformControls.setSpace('world');
    }
    attachGizmoTo(state.selectedBone);
    updateJointBoneName();
  } else {
    document.getElementById('rotation-controls').classList.add('visible');
    state.transformControls.setMode('rotate');
    state.transformControls.setSpace('local');
    attachGizmoTo(state.selectedBone);
  }
}

export function deselectBone() {
  state.selectedBone = null;
  state.selectedBoneIndex = -1;
  state.multiSelectedBones.clear();

  document.querySelectorAll('.bone-item').forEach(item => item.classList.remove('selected'));
  document.getElementById('rotation-controls').classList.remove('visible');
  updateBoneSchemaHighlight();

  state.transformControls.detach();
  updateSelectedBoneMarker();

  if (state.weightPaintMode) {
    document.getElementById('paint-bone-name').textContent = 'Aucun bone sélectionné';
    refreshWeightColors();
  }
  if (state.jointEditMode) {
    document.getElementById('joint-bone-name').textContent = 'Aucun bone sélectionné';
  }
}

// ---------- Rotation UI ----------

export function updateRotationUI() {
  if (!state.selectedBone) return;
  const rot = state.selectedBone.rotation;
  const toDeg = THREE.MathUtils.radToDeg;
  document.getElementById('rot-x').value = toDeg(rot.x);
  document.getElementById('rot-x-num').value = Math.round(toDeg(rot.x));
  document.getElementById('rot-y').value = toDeg(rot.y);
  document.getElementById('rot-y-num').value = Math.round(toDeg(rot.y));
  document.getElementById('rot-z').value = toDeg(rot.z);
  document.getElementById('rot-z-num').value = Math.round(toDeg(rot.z));
}

export function updateBoneRotation(axis, value) {
  if (!state.selectedBone) return;
  const toRad = THREE.MathUtils.degToRad;
  state.selectedBone.rotation[axis] = toRad(value);
  document.getElementById(`rot-${axis}`).value = value;
  document.getElementById(`rot-${axis}-num`).value = Math.round(value);
}

export function resetBoneRotation() {
  if (!state.selectedBone) return;
  const originalRot = state.originalBoneRotations.get(state.selectedBone.uuid);
  if (originalRot) {
    pushUndo();
    state.selectedBone.rotation.copy(originalRot);
    updateRotationUI();
  }
}

// ---------- Click sur le canvas (sélection en mode Pose et Paint) ----------
//
// Le clic sélectionne TOUS les bones (twists inclus). Si plusieurs markers
// se chevauchent (twist sur leur "vrai" bone par exemple), un clic répété
// au même endroit cycle entre les bones empilés.

export function onCanvasClick(event) {
  if (event.target !== state.renderer.domElement) return;
  // En mode joints, la sélection est déjà faite par le pointerdown du joint-edit ;
  // déclencher onCanvasClick ferait un second appel à selectBone qui cyclerait
  // sur les bones empilés (effet "double action" indésirable au release).
  if (state.jointEditMode) return;
  // En mode props, le canvas click ne doit pas voler le gizmo aux props.
  if (state.propsMode) return;

  const rect = state.renderer.domElement.getBoundingClientRect();
  state.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  state.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  state.raycaster.setFromCamera(state.mouse, state.camera);

  // Raycast contre TOUS les bone markers (y compris twist)
  const intersects = state.raycaster.intersectObjects(state.boneMarkers, false);
  if (intersects.length === 0) return;

  const candidates = pickStackedBones(intersects);
  if (candidates.length === 0) return;

  selectBone(pickNextInStack(candidates).userData.boneIndex, event.shiftKey);
}

// Filtre les markers proches dans le stack du clic (à <2x du rayon du marker le plus proche)
// pour ne garder que les bones empilés au même endroit.
export function pickStackedBones(intersects) {
  if (intersects.length === 0) return [];
  const firstDist = intersects[0].distance;
  const tolerance = Math.max(0.05, firstDist * 0.15); // 15% ou 5cm minimum
  const out = [];
  for (const hit of intersects) {
    if (!hit.object.userData.isBoneMarker) continue;
    if (hit.distance > firstDist + tolerance) break;
    out.push(hit.object);
  }
  return out;
}

// Si le bone actuellement sélectionné est dans la pile, retourne le suivant ;
// sinon retourne le premier (le plus proche de la caméra).
export function pickNextInStack(stack) {
  if (state.selectedBoneIndex < 0) return stack[0];
  const currentIdx = stack.findIndex((m) => m.userData.boneIndex === state.selectedBoneIndex);
  if (currentIdx === -1) return stack[0];
  return stack[(currentIdx + 1) % stack.length];
}
