// Animations : play/pause, rest pose, skeleton helper visibility, animations list, boucle render.

import * as THREE from 'three';
import { state } from './state.js';
import { updateInfo } from './ui.js';
import { updateRotationUI, updateBoneMarkers } from './bones.js';
import { matchFbxAnimationToPrincipal } from './fbx-anim.js';
import { rebuildWorldPositionCache, refreshWeightColors } from './weight-paint.js';
import { refreshIKMarkers, updateIKConnectionLines } from './ik.js';
import { isBoneRotatableInJointMode, getJointAxisForBone, getJointAxisSignForBone } from './joint-edit.js';

const _arrowDir = new THREE.Vector3();
const _arrowQ = new THREE.Quaternion();

function updateJointAxisArrow() {
  const arrow = state.jointAxisArrow;
  if (!arrow) return;
  const bone = state.selectedBone;
  if (state.jointEditMode && bone && isBoneRotatableInJointMode(bone)) {
    bone.updateMatrixWorld(true);
    bone.getWorldPosition(arrow.position);
    bone.getWorldQuaternion(_arrowQ);
    const axis = getJointAxisForBone(bone);
    const sign = getJointAxisSignForBone(bone);
    if (axis === 'x') _arrowDir.set(sign, 0, 0);
    else if (axis === 'y') _arrowDir.set(0, sign, 0);
    else _arrowDir.set(0, 0, sign);
    _arrowDir.applyQuaternion(_arrowQ);
    arrow.setDirection(_arrowDir);
    arrow.visible = true;
  } else {
    arrow.visible = false;
  }
}

export function playAnimation(index, source = 'glb') {
  const mixer = source === 'fbx' ? state.mixerFbx : state.mixer;
  if (!mixer) return;

  const animations = source === 'glb' ? state.principalAnimations : state.fbxAnimations;
  if (index >= animations.length) return;

  const clip = animations[index];

  if (state.activeAction) state.activeAction.fadeOut(0.1);

  state.activeAction = mixer.clipAction(clip);
  state.activeAction.reset();
  state.activeAction.fadeIn(0.1);
  state.activeAction.play();

  // Changer d'animation reprend automatiquement la lecture si on était en pause
  if (!state.isPlaying) togglePlayPause();

  document.querySelectorAll('.anim-btn').forEach((btn) => {
    const btnSource = btn.dataset.source;
    const btnIndex = parseInt(btn.dataset.index);
    btn.classList.toggle('active', btnSource === source && btnIndex === index);
  });

  updateInfo(`Animation: "${clip.name}" (${clip.duration.toFixed(2)}s) - Source: ${source.toUpperCase()}`);

  document.getElementById('animation-timeline')?.classList.add('visible');
  syncTimelinePlayBtn();
}

function formatTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function syncTimelinePlayBtn() {
  const btn = document.getElementById('timeline-play-btn');
  if (!btn) return;
  if (state.isPlaying) {
    btn.textContent = '⏸️';
    btn.classList.remove('paused');
  } else {
    btn.textContent = '▶️';
    btn.classList.add('paused');
  }
}

// Repositionne l'animation au temps `time` (secondes). Force un update à delta=0
// du mixer concerné pour que la pose soit appliquée immédiatement même en pause
// (un AnimationAction "paused" est skipé par mixer.update — on l'unpause juste
// le temps d'évaluer puis on restaure le flag).
export function seekActiveActionTo(time) {
  const action = state.activeAction;
  if (!action) return;
  const clip = action.getClip();
  const t = Math.max(0, Math.min(clip.duration, time));
  action.time = t;
  const wasPaused = action.paused;
  action.paused = false;
  if (state.mixerFbx && action.getMixer() === state.mixerFbx) {
    state.mixerFbx.update(0);
    matchFbxAnimationToPrincipal();
  } else if (state.mixer) {
    state.mixer.update(0);
    if (state.selectedBone) updateRotationUI();
  }
  action.paused = wasPaused;
}

function updateTimelineUI() {
  const action = state.activeAction;
  const slider = document.getElementById('timeline-scrub');
  const cur = document.getElementById('timeline-current');
  const dur = document.getElementById('timeline-duration');
  if (!slider || !cur || !dur) return;
  if (!action) {
    cur.textContent = '0:00';
    dur.textContent = '0:00';
    slider.value = '0';
    return;
  }
  if (state.isScrubbingTimeline) return; // ne pas écraser pendant que l'user drag
  const clip = action.getClip();
  const duration = clip.duration || 0;
  const t = action.time;
  const ratio = duration > 0 ? Math.max(0, Math.min(1, t / duration)) : 0;
  slider.value = String(Math.round(ratio * 1000));
  cur.textContent = formatTime(t);
  dur.textContent = formatTime(duration);
}

export function attachTimelineListeners() {
  const playBtn = document.getElementById('timeline-play-btn');
  const slider = document.getElementById('timeline-scrub');
  if (!playBtn || !slider) return;

  playBtn.addEventListener('click', () => {
    togglePlayPause();
    syncTimelinePlayBtn();
  });

  // Quand l'utilisateur commence à scrubber : pause auto + flag
  let wasPlaying = false;
  const startScrub = () => {
    wasPlaying = state.isPlaying;
    state.isScrubbingTimeline = true;
    if (state.isPlaying) togglePlayPause();
  };
  const endScrub = () => {
    state.isScrubbingTimeline = false;
    if (wasPlaying && !state.isPlaying) togglePlayPause();
    syncTimelinePlayBtn();
  };

  slider.addEventListener('pointerdown', startScrub);
  slider.addEventListener('pointerup', endScrub);
  slider.addEventListener('pointercancel', endScrub);

  // Coalesce les events input : on enregistre juste le temps souhaité, l'animate
  // loop l'appliquera une fois par frame. Sinon matchFbxAnimationToPrincipal
  // (coûteux) peut être appelé plusieurs fois par frame sur certains browsers.
  slider.addEventListener('input', () => {
    const action = state.activeAction;
    if (!action) return;
    const ratio = parseFloat(slider.value) / 1000;
    const duration = action.getClip().duration || 0;
    state.pendingSeekTime = ratio * duration;
    const cur = document.getElementById('timeline-current');
    if (cur) cur.textContent = formatTime(state.pendingSeekTime);
  });
}

export function togglePlayPause() {
  state.isPlaying = !state.isPlaying;

  const btn = document.getElementById('play-pause-btn');
  if (state.isPlaying) {
    btn.textContent = '⏸️ Pause Animation';
    btn.classList.remove('paused');
    if (state.activeAction) state.activeAction.paused = false;
  } else {
    btn.textContent = '▶️ Play Animation';
    btn.classList.add('paused');
    if (state.activeAction) state.activeAction.paused = true;
  }
  syncTimelinePlayBtn();
}

export function toggleRestPose() {
  const btn = document.getElementById('toggle-rest-pose-btn');
  if (!state.atRestPose) {
    state.posedBoneRotations.clear();
    state.bones.forEach((bone) => {
      state.posedBoneRotations.set(bone.uuid, bone.rotation.clone());
      const orig = state.originalBoneRotations.get(bone.uuid);
      if (orig) bone.rotation.copy(orig);
    });
    state.atRestPose = true;
    btn.textContent = '🧍 Pose actuelle';
    btn.classList.add('active');
  } else {
    state.bones.forEach((bone) => {
      const posed = state.posedBoneRotations.get(bone.uuid);
      if (posed) bone.rotation.copy(posed);
    });
    state.posedBoneRotations.clear();
    state.atRestPose = false;
    btn.textContent = '🧍 Pose au repos';
    btn.classList.remove('active');
  }
  // Reconstruire le cache des positions skinnées si on est en weight paint
  if (state.weightPaintMode) {
    state.currentModel.updateMatrixWorld(true);
    state.skinnedMeshes.forEach((mesh) => rebuildWorldPositionCache(mesh));
    refreshWeightColors();
  }
  if (state.selectedBone) updateRotationUI();
}

export function toggleSkeleton() {
  state.skeletonVisible = !state.skeletonVisible;

  const btn = document.getElementById('toggle-skeleton-btn');
  if (state.skeletonVisible) {
    btn.textContent = '🦴 Masquer Squelette';
    btn.classList.remove('hidden');
  } else {
    btn.textContent = '🦴 Afficher Squelette';
    btn.classList.add('hidden');
  }

  if (state.skeletonHelper) state.skeletonHelper.visible = state.skeletonVisible;
  if (state.skeletonHelperFbx) state.skeletonHelperFbx.visible = state.skeletonVisible;
  state.boneMarkersGroup.visible = state.skeletonVisible;
}

export function updateAnimationsList() {
  const listContainer = document.getElementById('animations-list');
  listContainer.innerHTML = '';

  const hasGlbAnims = state.principalAnimations.length > 0;
  const hasFbxAnims = state.fbxAnimations.length > 0;

  if (!hasGlbAnims && !hasFbxAnims) {
    listContainer.innerHTML = '<p style="color: #888;">Aucune animation</p>';
    return;
  }

  if (hasGlbAnims) {
    const section = document.createElement('div');
    section.className = 'anim-section';

    const title = document.createElement('div');
    title.className = 'anim-section-title';
    title.textContent = 'GLB';
    section.appendChild(title);

    const buttons = document.createElement('div');
    buttons.style.display = 'flex';
    buttons.style.flexWrap = 'wrap';
    buttons.style.gap = '8px';

    state.principalAnimations.forEach((clip, index) => {
      const btn = document.createElement('button');
      btn.className = 'anim-btn';
      btn.textContent = clip.name || `Animation ${index + 1}`;
      btn.dataset.source = 'glb';
      btn.dataset.index = String(index);
      btn.addEventListener('click', () => playAnimation(index, 'glb'));
      buttons.appendChild(btn);
    });

    section.appendChild(buttons);
    listContainer.appendChild(section);
  }

  if (hasFbxAnims) {
    const section = document.createElement('div');
    section.className = 'anim-section';

    const title = document.createElement('div');
    title.className = 'anim-section-title';
    title.textContent = 'FBX';
    section.appendChild(title);

    const buttons = document.createElement('div');
    buttons.style.display = 'flex';
    buttons.style.flexWrap = 'wrap';
    buttons.style.gap = '8px';

    state.fbxAnimations.forEach((clip, index) => {
      const btn = document.createElement('button');
      btn.className = 'anim-btn from-fbx';
      btn.textContent = clip.name || `FBX Anim ${index + 1}`;
      btn.dataset.source = 'fbx';
      btn.dataset.index = String(index);
      btn.addEventListener('click', () => playAnimation(index, 'fbx'));
      buttons.appendChild(btn);
    });

    section.appendChild(buttons);
    listContainer.appendChild(section);
  }
}

export function animate() {
  requestAnimationFrame(animate);
  const delta = state.clock.getDelta();

  // En modes spéciaux on saute entièrement mixer.update — sinon le mixer
  // ré-écrit les rotations des bones à chaque frame avec les valeurs animées
  // au temps figé (timeScale=0 ne suffit pas, les tracks sont quand même évaluées).
  const inSpecialMode = state.jointEditMode || state.weightPaintMode || state.ikMode;
  const shouldUpdateAnim = !state.atRestPose && !inSpecialMode;

  if (shouldUpdateAnim) {
    if (state.mixerFbx) {
      state.mixerFbx.update(delta);
      if (state.isPlaying) matchFbxAnimationToPrincipal();
    } else if (state.mixer) {
      state.mixer.update(delta);
      if (state.isPlaying && state.selectedBone) updateRotationUI();
    }
  }

  // Applique le seek demandé par le scrub timeline (au plus une fois par frame)
  if (state.pendingSeekTime !== null) {
    seekActiveActionTo(state.pendingSeekTime);
    state.pendingSeekTime = null;
  }

  updateBoneMarkers();
  if (state.ikMode && !state.isDraggingIK) refreshIKMarkers();
  if (state.ikMode) updateIKConnectionLines();
  updateJointAxisArrow();
  updateTimelineUI();
  state.controls.update();
  state.renderer.render(state.scene, state.camera);
}
