// Cage cylindrique (lattice / FFD) pour déformer un prop importé.
//
// Principe :
// - Une cage cylindrique (RADIAL × (VERTICAL+1) vertices) est parentée au
//   prop.root, donc ses vertices vivent dans l'espace prop-local.
// - Au binding, chaque vertex du prop est lié aux K plus proches vertices de
//   cage (poids inversement proportionnels au carré de la distance, normalisés).
// - À la déformation, on calcule en prop-local :
//     P_deformé = P_rest + Σ_k  w_k × (cage_k_courant − cage_k_rest)
//   puis on reconvertit en mesh-local via M_propToMesh = (M_meshToProp)⁻¹.
// - La cage est marquée userData.glbBonesEditor.kind === 'cage' pour que
//   l'export/loader la reconnaissent (et l'export la skip).

import * as THREE from 'three';
import { state } from './state.js';
import { updateInfo } from './ui.js';

const RADIAL = 8;
const VERTICAL = 4;        // 4 segments verticaux ⇒ 5 anneaux ⇒ 5 × 8 = 40 vertices
const PADDING = 0.05;       // 5 % d'expansion autour du AABB du prop
const CAGE_COLOR = 0x44ff88;
const CAGE_COLOR_SELECTED = 0xff44ff;

// Calcule le layout cylindrique de la cage à partir de ses rest positions.
// On suppose que les vertices sont organisés en grille (vertical+1) × radial,
// avec l'axe du cylindre aligné sur Y en cage-local. Retourne center XZ + h range.
function computeCageLayout(restPositions) {
  const total = restPositions.length / 3;
  let hMin = Infinity, hMax = -Infinity, sumX = 0, sumZ = 0;
  for (let i = 0; i < total; i++) {
    const i3 = i * 3;
    const x = restPositions[i3], y = restPositions[i3 + 1], z = restPositions[i3 + 2];
    if (y < hMin) hMin = y;
    if (y > hMax) hMax = y;
    sumX += x;
    sumZ += z;
  }
  return {
    cx: sumX / total,
    cz: sumZ / total,
    hMin,
    hMax,
    numV: VERTICAL + 1,
    numR: RADIAL,
  };
}

// Pour un point (x, y, z) en cage-local, calcule les 4 cage vertex indices et
// leurs poids bilinéaires (h × θ). Comportement type lattice cylindrique :
// chaque cellule de la cage = un quad (h_lower, h_upper) × (θ_left, θ_right),
// le poids varie linéairement dans la cellule.
function computeBilinearWeights(x, y, z, layout) {
  const { cx, cz, hMin, hMax, numR } = layout;
  const dx = x - cx, dz = z - cz;
  let theta = Math.atan2(dz, dx); // -π … π
  if (theta < 0) theta += Math.PI * 2; // 0 … 2π

  const heightRange = (hMax - hMin) || 1e-6;
  const tHRaw = (y - hMin) / heightRange;
  const tHClamped = Math.max(0, Math.min(1, tHRaw));
  const vF = tHClamped * VERTICAL;
  let vLower = Math.floor(vF);
  if (vLower >= VERTICAL) vLower = VERTICAL - 1;
  const tv = vF - vLower;
  const vUpper = vLower + 1;

  const rF = (theta / (Math.PI * 2)) * numR;
  const rLowerInt = Math.floor(rF);
  const tr = rF - rLowerInt;
  const rLower = ((rLowerInt % numR) + numR) % numR;
  const rUpper = (rLower + 1) % numR;

  const idxLL = vLower * numR + rLower;
  const idxLR = vLower * numR + rUpper;
  const idxUL = vUpper * numR + rLower;
  const idxUR = vUpper * numR + rUpper;

  return [
    { idx: idxLL, weight: (1 - tr) * (1 - tv) },
    { idx: idxLR, weight: tr * (1 - tv) },
    { idx: idxUL, weight: (1 - tr) * tv },
    { idx: idxUR, weight: tr * tv },
  ];
}

// Buffers réutilisés (evite les allocations dans la hot loop)
const _vWork = new THREE.Vector3();
const _accum = new THREE.Vector3();

// Crée une cage autour d'un prop. Idempotent : no-op si déjà présent.
export function addCageToProp(prop) {
  if (!prop || prop.cage) return;
  prop.root.updateMatrixWorld(true);

  // 1. Collecte des meshes du prop + AABB en prop-local space
  const M_propInv = new THREE.Matrix4().copy(prop.root.matrixWorld).invert();
  const meshes = [];
  prop.root.traverse((c) => {
    if (c.isMesh && c.geometry?.attributes?.position) meshes.push(c);
  });
  if (meshes.length === 0) {
    updateInfo('Ce prop ne contient aucun mesh — cage impossible.');
    return;
  }

  const aabb = new THREE.Box3();
  const tmp = new THREE.Vector3();
  for (const mesh of meshes) {
    mesh.updateMatrixWorld(true);
    const M_meshToProp = new THREE.Matrix4().multiplyMatrices(M_propInv, mesh.matrixWorld);
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i).applyMatrix4(M_meshToProp);
      aabb.expandByPoint(tmp);
    }
  }
  if (aabb.isEmpty()) {
    updateInfo('AABB vide — cage impossible.');
    return;
  }

  const size = aabb.getSize(new THREE.Vector3());
  const center = aabb.getCenter(new THREE.Vector3());
  const radius = Math.max(Math.max(size.x, size.z) * (0.5 + PADDING), 1e-3);
  const halfH = Math.max(size.y * (0.5 + PADDING), 1e-3);

  // 2. Génère les vertices : grille cylindrique (VERTICAL+1) × RADIAL
  const cageVertexCount = (VERTICAL + 1) * RADIAL;
  const restPositions = new Float32Array(cageVertexCount * 3);
  for (let v = 0; v <= VERTICAL; v++) {
    const yT = v / VERTICAL;
    const y = (center.y - halfH) + yT * (halfH * 2);
    for (let r = 0; r < RADIAL; r++) {
      const theta = (r / RADIAL) * Math.PI * 2;
      const x = center.x + Math.cos(theta) * radius;
      const z = center.z + Math.sin(theta) * radius;
      const i = (v * RADIAL + r) * 3;
      restPositions[i + 0] = x;
      restPositions[i + 1] = y;
      restPositions[i + 2] = z;
    }
  }

  // 3. Indices (quads tessellés en triangles) pour la visualisation wireframe
  const indices = [];
  for (let v = 0; v < VERTICAL; v++) {
    for (let r = 0; r < RADIAL; r++) {
      const a = v * RADIAL + r;
      const b = v * RADIAL + ((r + 1) % RADIAL);
      const c = (v + 1) * RADIAL + ((r + 1) % RADIAL);
      const d = (v + 1) * RADIAL + r;
      indices.push(a, b, c, a, c, d);
    }
  }

  const livePositions = new Float32Array(restPositions); // mutable copy
  const cageGeom = new THREE.BufferGeometry();
  cageGeom.setAttribute('position', new THREE.BufferAttribute(livePositions, 3));
  cageGeom.setIndex(indices);
  const cageMat = new THREE.MeshBasicMaterial({
    color: CAGE_COLOR,
    wireframe: true,
    transparent: true,
    opacity: 0.45,
    depthTest: false,
  });
  const cageMesh = new THREE.Mesh(cageGeom, cageMat);
  cageMesh.renderOrder = 990;
  // userData posé sur le mesh (et non sur un Group) — le mesh est garanti d'être
  // exporté ; les Group node userData sont parfois perdus suivant les versions.
  cageMesh.userData.glbBonesEditor = { kind: 'cage' };

  // 4. Markers (un par cage vertex)
  const markers = [];
  const markerGeom = new THREE.SphereGeometry(0.012, 10, 10);
  for (let i = 0; i < cageVertexCount; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: CAGE_COLOR, depthTest: false });
    const m = new THREE.Mesh(markerGeom, mat);
    m.position.set(restPositions[i * 3], restPositions[i * 3 + 1], restPositions[i * 3 + 2]);
    m.userData.isCageMarker = true;
    m.userData.cageVertexIdx = i;
    m.userData.propId = prop.id;
    m.renderOrder = 991;
    markers.push(m);
  }

  // 5. Group parenté au prop : la cage suit toutes les transformations du prop
  const group = new THREE.Group();
  group.add(cageMesh);
  for (const m of markers) group.add(m);
  group.userData.glbBonesEditor = { kind: 'cage' };
  prop.root.add(group);

  // 6. Bindings bilinéaires cylindriques : chaque vertex du prop est lié aux
  //    4 cage vertices de sa cellule (h × θ), avec poids bilinéaires.
  const excludeSet = new Set([cageMesh, ...markers]);
  const meshBindings = computeMeshBindings(prop, restPositions, excludeSet);

  prop.cage = {
    group,
    cageMesh,
    cageGeom,
    livePositions,
    restPositions,
    markers,
    meshBindings,
    selectedVertexIdx: -1,
    vertexProxy: null,
  };
}

// Détache la cage et restaure les positions de rest des prop meshes.
export function removeCageFromProp(prop) {
  if (!prop?.cage) return;
  resetMeshesToRest(prop.cage);
  // Détache le gizmo si attaché à un proxy
  if (state.transformControls.object === prop.cage.vertexProxy) {
    state.transformControls.detach();
  }
  if (prop.cage.vertexProxy) {
    prop.root.remove(prop.cage.vertexProxy);
  }
  prop.root.remove(prop.cage.group);
  prop.cage.cageGeom.dispose();
  prop.cage.cageMesh.material.dispose();
  for (const m of prop.cage.markers) {
    m.geometry.dispose();
    m.material.dispose();
  }
  prop.cage = null;
}

// Remet les vertices de la cage à leur rest. La déformation du prop suit.
export function resetCageVertices(prop) {
  if (!prop?.cage) return;
  prop.cage.livePositions.set(prop.cage.restPositions);
  prop.cage.cageGeom.attributes.position.needsUpdate = true;
  for (let i = 0; i < prop.cage.markers.length; i++) {
    const i3 = i * 3;
    prop.cage.markers[i].position.set(
      prop.cage.restPositions[i3],
      prop.cage.restPositions[i3 + 1],
      prop.cage.restPositions[i3 + 2],
    );
  }
  if (prop.cage.vertexProxy && prop.cage.selectedVertexIdx >= 0) {
    const i3 = prop.cage.selectedVertexIdx * 3;
    prop.cage.vertexProxy.position.set(
      prop.cage.livePositions[i3],
      prop.cage.livePositions[i3 + 1],
      prop.cage.livePositions[i3 + 2],
    );
  }
  applyCageDeformation(prop, true);
}

// Réécrit chaque vertex du prop avec sa rest position prop-local → mesh-local.
function resetMeshesToRest(cage) {
  const v = new THREE.Vector3();
  for (const mb of cage.meshBindings) {
    const pos = mb.mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const i3 = i * 3;
      v.set(mb.restPropLocal[i3], mb.restPropLocal[i3 + 1], mb.restPropLocal[i3 + 2])
        .applyMatrix4(mb.M_propToMesh);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    mb.mesh.geometry.computeVertexNormals();
    mb.mesh.geometry.computeBoundingSphere();
  }
}

// Recalcule la déformation. recomputeNormals=true à la fin du drag (coûteux).
export function applyCageDeformation(prop, recomputeNormals = false) {
  if (!prop?.cage) return;
  const cage = prop.cage;
  for (const mb of cage.meshBindings) {
    const pos = mb.mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const i3 = i * 3;
      const baseX = mb.restPropLocal[i3];
      const baseY = mb.restPropLocal[i3 + 1];
      const baseZ = mb.restPropLocal[i3 + 2];
      _accum.set(0, 0, 0);
      const b = mb.binding[i];
      for (let k = 0; k < b.length; k++) {
        const j3 = b[k].idx * 3;
        const w = b[k].weight;
        _accum.x += (cage.livePositions[j3] - cage.restPositions[j3]) * w;
        _accum.y += (cage.livePositions[j3 + 1] - cage.restPositions[j3 + 1]) * w;
        _accum.z += (cage.livePositions[j3 + 2] - cage.restPositions[j3 + 2]) * w;
      }
      _vWork.set(baseX + _accum.x, baseY + _accum.y, baseZ + _accum.z)
        .applyMatrix4(mb.M_propToMesh);
      pos.setXYZ(i, _vWork.x, _vWork.y, _vWork.z);
    }
    pos.needsUpdate = true;
    if (recomputeNormals) {
      mb.mesh.geometry.computeVertexNormals();
      mb.mesh.geometry.computeBoundingSphere();
    }
  }
}

// Click handler : retourne true si un marker de cage a été cliqué.
export function tryPickCageVertex(event) {
  if (!state.propsMode) return false;
  // En mode "Orienter cage", on ne pioche pas de vertex — le gizmo manipule
  // tout le group.
  if (state.cageTransformMode) return false;
  const prop = state.selectedProp;
  if (!prop?.cage) return false;
  const rect = state.renderer.domElement.getBoundingClientRect();
  state.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  state.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  state.raycaster.setFromCamera(state.mouse, state.camera);
  const hits = state.raycaster.intersectObjects(prop.cage.markers, false);
  if (hits.length === 0) return false;
  selectCageVertex(prop, hits[0].object.userData.cageVertexIdx);
  return true;
}

export function selectCageVertex(prop, idx) {
  const cage = prop.cage;
  if (!cage.vertexProxy) {
    cage.vertexProxy = new THREE.Object3D();
    cage.vertexProxy.userData.isCageVertexProxy = true;
    prop.root.add(cage.vertexProxy);
  }
  const i3 = idx * 3;
  cage.vertexProxy.position.set(
    cage.livePositions[i3],
    cage.livePositions[i3 + 1],
    cage.livePositions[i3 + 2],
  );
  cage.selectedVertexIdx = idx;
  // Marqueurs : reset couleur + highlight le sélectionné
  for (let i = 0; i < cage.markers.length; i++) {
    cage.markers[i].material.color.setHex(i === idx ? CAGE_COLOR_SELECTED : CAGE_COLOR);
  }
  state.transformControls.setMode('translate');
  state.transformControls.setSpace('world');
  state.transformControls.attach(cage.vertexProxy);
  updateInfo(`Cage vertex #${idx} — déplacez avec le gizmo pour déformer le prop.`);
}

export function deselectCageVertex(prop) {
  if (!prop?.cage) return;
  prop.cage.selectedVertexIdx = -1;
  for (const m of prop.cage.markers) m.material.color.setHex(CAGE_COLOR);
  if (state.transformControls.object === prop.cage.vertexProxy) {
    state.transformControls.detach();
  }
}

// À appeler depuis le 'change' listener de transformControls : si on édite
// un cage vertex, propage sa nouvelle position dans la cage geometry et
// recalcule la déformation.
export function onTransformChangeForCage() {
  if (!state.propsMode) return;
  const prop = state.selectedProp;
  if (!prop?.cage) return;
  if (state.transformControls.object !== prop.cage.vertexProxy) return;
  const idx = prop.cage.selectedVertexIdx;
  if (idx < 0) return;
  const p = prop.cage.vertexProxy.position;
  const i3 = idx * 3;
  prop.cage.livePositions[i3] = p.x;
  prop.cage.livePositions[i3 + 1] = p.y;
  prop.cage.livePositions[i3 + 2] = p.z;
  prop.cage.cageGeom.attributes.position.needsUpdate = true;
  prop.cage.markers[idx].position.copy(p);
  applyCageDeformation(prop, false);
}

// À la fin du drag : recompute des normales + bounding sphere (coûteux).
export function onCageDragEnd() {
  const prop = state.selectedProp;
  if (!prop?.cage) return;
  if (state.transformControls.object !== prop.cage.vertexProxy) return;
  applyCageDeformation(prop, true);
}

export function attachCageListeners() {
  state.transformControls.addEventListener('change', onTransformChangeForCage);
  state.transformControls.addEventListener('mouseUp', onCageDragEnd);
}

// Mode "Orienter cage" : le gizmo manipule directement le cage group (translate
// / rotate / scale). Le prop n'est PAS affecté tant qu'on est dans ce mode car
// les positions cage-local des vertices ne changent pas — seule la matrice du
// group bouge. À la sortie du mode, on bake cette matrice dans rest+live et on
// recalcule les bindings.
export function enterCageTransformMode(prop) {
  if (!prop?.cage) return;
  state.cageTransformMode = true;
  // Désélectionne un éventuel cage vertex pour libérer le gizmo
  deselectCageVertex(prop);
  // Applique le mode courant (translate par défaut), space world pour t/s, local pour rotate
  const mode = state.propGizmoMode || 'translate';
  state.transformControls.setMode(mode);
  state.transformControls.setSpace(mode === 'rotate' ? 'local' : 'world');
  state.transformControls.attach(prop.cage.group);
  // Highlight visuel : couleur "selected" sur tous les markers
  for (const m of prop.cage.markers) m.material.color.setHex(CAGE_COLOR_SELECTED);
  updateInfo('Orienter cage : translate / rotate / scale via le gizmo. Cliquez à nouveau pour valider.');
}

export function exitCageTransformMode(prop) {
  if (!state.cageTransformMode) return;
  state.cageTransformMode = false;
  if (prop?.cage) {
    bakeCageGroupTransform(prop);
    // Recompute les bindings (les rest cage positions ont changé)
    const excludeSet = new Set([prop.cage.cageMesh, ...prop.cage.markers]);
    prop.cage.meshBindings = computeMeshBindings(prop, prop.cage.restPositions, excludeSet);
    // Re-applique la déformation (delta = 0 vu que rest = live après bake)
    applyCageDeformation(prop, true);
    // Restaure les couleurs des markers
    for (const m of prop.cage.markers) m.material.color.setHex(CAGE_COLOR);
  }
  state.transformControls.detach();
}

function bakeCageGroupTransform(prop) {
  const cage = prop.cage;
  const M = cage.group.matrix.clone();
  cage.group.updateMatrix();
  const v = new THREE.Vector3();
  const total = cage.restPositions.length / 3;
  for (let i = 0; i < total; i++) {
    const i3 = i * 3;
    v.set(cage.restPositions[i3], cage.restPositions[i3 + 1], cage.restPositions[i3 + 2])
      .applyMatrix4(M);
    cage.restPositions[i3] = v.x;
    cage.restPositions[i3 + 1] = v.y;
    cage.restPositions[i3 + 2] = v.z;

    v.set(cage.livePositions[i3], cage.livePositions[i3 + 1], cage.livePositions[i3 + 2])
      .applyMatrix4(M);
    cage.livePositions[i3] = v.x;
    cage.livePositions[i3 + 1] = v.y;
    cage.livePositions[i3 + 2] = v.z;

    cage.markers[i].position.set(
      cage.livePositions[i3],
      cage.livePositions[i3 + 1],
      cage.livePositions[i3 + 2],
    );
  }
  cage.cageGeom.attributes.position.needsUpdate = true;
  // Reset le transform du group → cage-local redevient égal au prop-local
  cage.group.position.set(0, 0, 0);
  cage.group.quaternion.identity();
  cage.group.scale.set(1, 1, 1);
  cage.group.updateMatrix();
}

// Helper interne : (re)calcule les bindings (M_propToMesh, restPropLocal,
// binding bilinéaire cylindrique) pour un set de cage rest positions.
// `excludeSet` doit contenir cageMesh + tous les markers à exclure.
//
// Approche lattice : chaque vertex du prop est lié aux 4 cage vertices formant
// la cellule (h, θ) qui le contient sur le cylindre. Les poids sont bilinéaires
// (1-th)(1-tv), th(1-tv), th×tv, (1-th)×tv → déformation lisse et structurée
// (à la Blender Lattice Modifier), sans le côté chaotique du K-nearest.
function computeMeshBindings(prop, restPositions, excludeSet) {
  prop.root.updateMatrixWorld(true);
  const M_propInv = new THREE.Matrix4().copy(prop.root.matrixWorld).invert();

  const meshes = [];
  prop.root.traverse((c) => {
    if (!c.geometry?.attributes?.position) return;
    if (!c.isMesh && !c.isSkinnedMesh) return;
    if (excludeSet.has(c)) return;
    let n = c.parent;
    while (n && n !== prop.root) {
      if (excludeSet.has(n)) return;
      n = n.parent;
    }
    meshes.push(c);
  });

  const layout = computeCageLayout(restPositions);

  const meshBindings = [];
  for (const mesh of meshes) {
    mesh.updateMatrixWorld(true);
    const M_meshToProp = new THREE.Matrix4().multiplyMatrices(M_propInv, mesh.matrixWorld);
    const M_propToMesh = new THREE.Matrix4().copy(M_meshToProp).invert();
    const pos = mesh.geometry.attributes.position;
    const restPropLocal = new Float32Array(pos.count * 3);
    const binding = new Array(pos.count);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(M_meshToProp);
      restPropLocal[i * 3 + 0] = v.x;
      restPropLocal[i * 3 + 1] = v.y;
      restPropLocal[i * 3 + 2] = v.z;
      binding[i] = computeBilinearWeights(v.x, v.y, v.z, layout);
    }
    meshBindings.push({ mesh, M_propToMesh, restPropLocal, binding });
  }
  return meshBindings;
}

// Reconstruit la cage d'un prop ré-importé. La géométrie du prop est en pose
// rest (l'exporter l'a écrite ainsi), les rest positions de la cage sont
// stockées dans cageMesh.userData.glbBonesEditor.rest, les live positions sont
// dans le position attribute du cage mesh (déformation au moment de l'export).
export function rebuildCageFromImported(prop, cageMesh) {
  if (!prop || prop.cage) return;
  const restArray = cageMesh?.userData?.glbBonesEditor?.rest;
  if (!restArray || !cageMesh?.geometry?.attributes?.position) return;

  // On utilise le parent direct du cage mesh comme groupe de regroupement
  // (l'exporter écrit le mesh tel quel, donc son parent est typiquement
  // l'ancien cage group ou directement prop.root).
  const cageGroup = cageMesh.parent;
  if (!cageGroup) return;
  // Tag pour le filtrage côté traversal (utile si on relit ailleurs)
  cageGroup.userData.glbBonesEditor = { kind: 'cage' };

  const cageGeom = cageMesh.geometry;
  const livePositions = cageGeom.attributes.position.array;
  const restPositions = new Float32Array(restArray);
  const cageVertexCount = restPositions.length / 3;

  // Remplace le matériau. Le cage object peut être un Mesh (cas initial) ou
  // un LineSegments (après round-trip GLB, l'exporter convertit le Mesh
  // wireframe en topologie LINES). On choisit le matériau adapté au type.
  if (cageMesh.material) {
    if (Array.isArray(cageMesh.material)) cageMesh.material.forEach((m) => m.dispose());
    else cageMesh.material.dispose();
  }
  if (cageMesh.isLineSegments || cageMesh.isLine) {
    cageMesh.material = new THREE.LineBasicMaterial({
      color: CAGE_COLOR,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
    });
  } else {
    cageMesh.material = new THREE.MeshBasicMaterial({
      color: CAGE_COLOR,
      wireframe: true,
      transparent: true,
      opacity: 0.45,
      depthTest: false,
    });
  }
  cageMesh.renderOrder = 990;

  // (Re)génère les markers (qui ne sont pas exportés)
  const markers = [];
  const markerGeom = new THREE.SphereGeometry(0.012, 10, 10);
  for (let i = 0; i < cageVertexCount; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: CAGE_COLOR, depthTest: false });
    const m = new THREE.Mesh(markerGeom, mat);
    const i3 = i * 3;
    m.position.set(livePositions[i3], livePositions[i3 + 1], livePositions[i3 + 2]);
    m.userData.isCageMarker = true;
    m.userData.cageVertexIdx = i;
    m.userData.propId = prop.id;
    m.renderOrder = 991;
    cageGroup.add(m);
    markers.push(m);
  }

  // Bindings : la géométrie du prop est en pose REST, on calcule depuis là.
  // On exclut le cage mesh + tous les markers du binding.
  const excludeSet = new Set([cageMesh, ...markers]);
  const meshBindings = computeMeshBindings(prop, restPositions, excludeSet);

  prop.cage = {
    group: cageGroup,
    cageMesh,
    cageGeom,
    livePositions,
    restPositions,
    markers,
    meshBindings,
    selectedVertexIdx: -1,
    vertexProxy: null,
  };

  // Applique la déformation (live − rest) → prop revient dans sa forme déformée
  applyCageDeformation(prop, true);
}
