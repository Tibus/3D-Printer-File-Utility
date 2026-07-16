// Export du modèle courant vers un fichier GLB binaire.
// Inclut : transforms des bones (rotations + positions), boneInverses
// (=> bind pose modifiée par le mode Joints), skinIndex/skinWeight
// (=> modifs de weight paint), animations originales.

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { state } from './state.js';
import { updateInfo } from './ui.js';
import { exitWeightPaintMode } from './weight-paint.js';
import { exitJointEditMode } from './joint-edit.js';
import { exitIKMode } from './ik.js';
import { exitPropsMode } from './props.js';

const exporter = new GLTFExporter();

export function exportToGLB() {
  if (!state.currentModel) {
    updateInfo('Aucun modèle à exporter.');
    return;
  }

  // Sortir des modes spéciaux pour rétablir les materials originaux
  // (sinon on exporterait un MeshBasicMaterial vertexColors).
  if (state.weightPaintMode) exitWeightPaintMode();
  if (state.jointEditMode) exitJointEditMode();
  if (state.ikMode) exitIKMode();
  if (state.propsMode) exitPropsMode();

  updateInfo('Export GLB en cours…');

  // ----- Préparation de l'état d'export : pause anim + bind pose + retrait des color attributes -----

  // 1. Mettre l'animation en pause — sinon mixer.update() écrase les rotations
  //    bind appliquées juste après (visible si parse() touche au mesh de manière async).
  const animSnap = {
    wasPaused: state.activeAction ? state.activeAction.paused : null,
    mixerScale: state.mixer ? state.mixer.timeScale : 1,
    mixerFbxScale: state.mixerFbx ? state.mixerFbx.timeScale : 1,
  };
  if (state.activeAction) state.activeAction.paused = true;
  if (state.mixer) state.mixer.timeScale = 0;
  if (state.mixerFbx) state.mixerFbx.timeScale = 0;

  // 2. Sauvegarder la pose courante (quaternion par bone) et appliquer la bind pose
  const savedRotations = new Map();
  const currentPoseQuat = new Map();
  state.bones.forEach((b) => {
    savedRotations.set(b.uuid, b.rotation.clone());
    currentPoseQuat.set(b.uuid, b.quaternion.clone());
    const bind = state.originalBoneRotations.get(b.uuid);
    if (bind) b.rotation.copy(bind);
  });
  state.currentModel.updateMatrixWorld(true);

  // 2b. Construire un AnimationClip "Current Pose" si la pose actuelle diffère
  //     de la bind pose pour au moins un bone. Sera réimporté au prochain load
  //     comme une animation jouable depuis le panneau d'animations.
  const poseTracks = [];
  state.bones.forEach((b) => {
    const cur = currentPoseQuat.get(b.uuid);
    if (!cur) return;
    // Après l'application de la bind pose, b.quaternion = bind quaternion
    const angleDiff = cur.angleTo(b.quaternion);
    if (angleDiff < 1e-4) return; // pas de diff perceptible

    // 2 keyframes identiques pour avoir un clip jouable (durée 1s)
    poseTracks.push(new THREE.QuaternionKeyframeTrack(
      `${b.name}.quaternion`,
      [0, 1],
      [cur.x, cur.y, cur.z, cur.w, cur.x, cur.y, cur.z, cur.w],
    ));
  });
  const poseClip = poseTracks.length > 0
    ? new THREE.AnimationClip('Current Pose', 1, poseTracks)
    : null;

  // 3. Retirer les attributs `color` (créés par le weight paint pour la heatmap)
  //    de toutes les geometries — on les remettra après l'export.
  const removedColorAttrs = new Map();
  state.currentModel.traverse((child) => {
    if (child.isMesh && child.geometry?.attributes?.color) {
      removedColorAttrs.set(child, child.geometry.attributes.color);
      child.geometry.deleteAttribute('color');
    }
  });

  // 4. Reparente chaque prop sous currentModel avec un marqueur dans userData.
  //    `attach()` (vs `add()`) convertit le matrix world→local pour préserver
  //    la position monde du prop pendant l'export.
  // 4b. Pour chaque prop avec cage : on remet la géométrie du prop en pose REST
  //     (avant déformation) puis on snapshot les positions déformées pour pouvoir
  //     les restaurer après parse(). Les rest positions de la cage sont stockées
  //     dans userData. La cage devient exportable, mais les markers (visualisation
  //     uniquement) sont cachés via visible=false (skipés par onlyVisible:true).
  //     => Le GLB contient :
  //        - la géométrie du prop en REST (= forme d'origine)
  //        - le cage mesh avec ses positions LIVE (= déformation actuelle)
  //        - userData.glbBonesEditor.rest = positions REST de la cage
  //     Au reload : binding recalculé sur le prop rest + cage rest, puis on
  //     ré-applique (live − rest) → la déformation est restaurée. Si l'utilisateur
  //     reset la cage, le prop revient à sa forme d'origine.
  const propsSnapshot = [];
  const cageExportSnapshots = []; // [{ deformedPerMesh: Map<mesh, Float32Array>, hiddenMarkers: [] }]
  if (Array.isArray(state.props)) {
    for (const prop of state.props) {
      propsSnapshot.push({ root: prop.root, parent: prop.root.parent });
      // Persist le binding éventuel (boundToBone) pour le retrouver au reload
      prop.root.userData.glbBonesEditor = {
        kind: 'prop',
        name: prop.name,
        ...(prop.binding ? { boundToBone: prop.binding.boneName } : {}),
      };
      // Si le prop est déjà dans le subtree de currentModel (cas des props
      // liés à un bone), on le laisse en place pour préserver le parent bone
      // dans le GLB. Sinon on l'attache à currentModel pour qu'il soit exporté.
      let insideCurrentModel = false;
      let n = prop.root.parent;
      while (n) {
        if (n === state.currentModel) { insideCurrentModel = true; break; }
        n = n.parent;
      }
      if (!insideCurrentModel) {
        state.currentModel.attach(prop.root);
      }

      if (prop.cage) {
        const deformedPerMesh = new Map();
        const tmpV = new THREE.Vector3();
        // Snapshot et reset chaque mesh à la rest
        for (const mb of prop.cage.meshBindings) {
          const pos = mb.mesh.geometry.attributes.position;
          deformedPerMesh.set(mb.mesh, new Float32Array(pos.array));
          for (let i = 0; i < pos.count; i++) {
            const i3 = i * 3;
            tmpV.set(mb.restPropLocal[i3], mb.restPropLocal[i3 + 1], mb.restPropLocal[i3 + 2])
              .applyMatrix4(mb.M_propToMesh);
            pos.setXYZ(i, tmpV.x, tmpV.y, tmpV.z);
          }
          pos.needsUpdate = true;
        }
        // userData posé sur le cage mesh lui-même (plus fiable que sur le Group
        // côté round-trip GLB).
        prop.cage.cageMesh.userData.glbBonesEditor = {
          kind: 'cage',
          rest: Array.from(prop.cage.restPositions),
        };
        // Markers : visible=false → skipés à l'export
        const hiddenMarkers = [];
        for (const m of prop.cage.markers) {
          if (m.visible) {
            m.visible = false;
            hiddenMarkers.push(m);
          }
        }
        // Cage group lui-même : visible (= exportable)
        prop.cage.group.visible = true;
        cageExportSnapshots.push({ prop, deformedPerMesh, hiddenMarkers });
      }
    }
  }

  const restoreState = () => {
    // Rotations
    state.bones.forEach((b) => {
      const r = savedRotations.get(b.uuid);
      if (r) b.rotation.copy(r);
    });
    state.currentModel.updateMatrixWorld(true);
    // Color attrs
    for (const [mesh, attr] of removedColorAttrs) {
      mesh.geometry.setAttribute('color', attr);
    }
    // Animation
    if (state.activeAction && animSnap.wasPaused !== null) {
      state.activeAction.paused = animSnap.wasPaused;
    }
    if (state.mixer) state.mixer.timeScale = animSnap.mixerScale;
    if (state.mixerFbx) state.mixerFbx.timeScale = animSnap.mixerFbxScale;
    // Props : remet chaque prop sous son parent d'origine (en préservant le world)
    for (const snap of propsSnapshot) {
      (snap.parent || state.scene).attach(snap.root);
    }
    // Cages : remet la déformation des prop meshes + markers visibles
    for (const snap of cageExportSnapshots) {
      for (const [mesh, arr] of snap.deformedPerMesh) {
        const pos = mesh.geometry.attributes.position;
        pos.array.set(arr);
        pos.needsUpdate = true;
      }
      for (const m of snap.hiddenMarkers) m.visible = true;
    }
    // Restaure la visibilité des cage groups selon le mode courant : visibles
    // uniquement si on est en mode Props.
    if (Array.isArray(state.props)) {
      for (const prop of state.props) {
        if (prop.cage?.group) prop.cage.group.visible = !!state.propsMode;
      }
    }
  };

  exporter.parse(
    state.currentModel,
    async (result) => {
      // Restaurer immédiatement la pose et les vertex colors — le binary est déjà figé.
      restoreState();

      const blob = new Blob([result], { type: 'model/gltf-binary' });
      const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const defaultName = `model-${ts}.glb`;

      // File System Access API : si dispo (Chrome/Edge), ouvre une vraie boîte de
      // dialogue "Enregistrer sous". Sinon fallback sur le téléchargement direct.
      if (window.showSaveFilePicker) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: defaultName,
            types: [{
              description: 'glTF binaire',
              accept: { 'model/gltf-binary': ['.glb'] },
            }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          updateInfo(`Modèle exporté : ${handle.name}`);
          return;
        } catch (err) {
          // L'utilisateur a annulé (AbortError) ou erreur d'accès → on n'écrit rien.
          if (err && err.name === 'AbortError') {
            updateInfo('Export annulé.');
            return;
          }
          console.warn('[GLB export] showSaveFilePicker a échoué, fallback download :', err);
          // Fall-through vers le fallback ci-dessous
        }
      }

      // Fallback : téléchargement direct via <a download>
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = defaultName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      updateInfo(`Modèle exporté : ${a.download}`);
    },
    (error) => {
      restoreState();
      console.error('[GLB export] erreur:', error);
      updateInfo("Erreur lors de l'export GLB — voir la console.");
    },
    {
      binary: true,
      // On exporte uniquement le clip "Current Pose" si la pose diffère de la bind.
      // Au prochain chargement du GLB, il apparaîtra dans la liste des animations.
      animations: poseClip ? [poseClip] : [],
    },
  );
}
