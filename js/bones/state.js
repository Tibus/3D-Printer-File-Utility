// État global partagé entre tous les modules.
// Pattern : un objet mutable dont les modules lisent et mutent les propriétés.
// Évite l'export de let/setters pour limiter le boilerplate.

import * as THREE from 'three';

export const state = {
  // Scene
  scene: null,
  camera: null,
  renderer: null,
  controls: null,         // OrbitControls
  transformControls: null,// gizmo (utilisé en mode Pose)
  brushHelper: null,      // anneau qui suit la souris en weight paint

  // Modèle principal
  currentModel: null,
  principalAnimations: [],
  hipsOriginalPosition: null,

  // Modèle FBX secondaire (pour transposer une animation)
  secondaryFbxModel: null,
  skeletonHelperFbx: null,
  fbxHipsOriginalPosition: null,
  fbxRootOriginalPosition: null,
  fbxAnimations: [],
  fbxSourceFormat: null,    // 'FBX' | 'GLB' — détermine la convention de root
  fbxSourceRootName: null,  // 'Hips' (FBX/Mixamo) ou 'root' (GLB)
  fbxHipsBone: null,        // référence directe au bone racine de la source secondaire
  fbxRootBone: null,        // référence directe au bone racine de la source secondaire

  // Hauteurs world cachées au load (ratio de translation Hip pour le retargeting FBX)
  glbHeight: 1,
  fbxHeight: 1,
  // Positions LOCALES bind des Hips (pour calculer le delta local du retargeting FBX)
  hipsOriginalLocalPosition: null,
  fbxHipsOriginalLocalPosition: null,
  rootOriginalLocalPosition: null,
  fbxRootOriginalLocalPosition: null,

  // Animation
  mixer: null,
  mixerFbx: null,
  activeAction: null,
  isPlaying: true,
  clock: new THREE.Clock(),
  isScrubbingTimeline: false,  // true pendant que l'utilisateur drag le slider de la timeline
  pendingSeekTime: null,        // temps en secondes à appliquer au prochain frame (coalesce les events input)

  // Bones
  bones: [],
  bonesByName: new Map(),
  fbxBonesByName: new Map(),
  selectedBone: null,
  selectedBoneIndex: -1,
  multiSelectedBones: new Set(),  // bones secondaires (en plus du primary `selectedBone`)
  skeletonHelper: null,
  skeletonVisible: true,

  // Visualisation des bones
  boneMarkersGroup: null,
  boneMarkers: [],
  selectableBoneMarkers: [],

  // Raycasting (réutilisé partout)
  raycaster: new THREE.Raycaster(),
  mouse: new THREE.Vector2(),

  // Rotations originales (bind pose)
  originalBoneRotations: new Map(),

  // Toggle "rest pose"
  atRestPose: false,
  posedBoneRotations: new Map(),

  // Weight paint
  weightPaintMode: false,
  skinnedMeshes: [],
  originalMaterials: new Map(),       // mesh.uuid -> material
  paintMaterials: new Map(),          // mesh.uuid -> MeshBasicMaterial vertexColors
  originalBoundingSpheres: new Map(), // mesh.uuid -> {center, radius}
  originalBoundingBoxes: new Map(),   // mesh.uuid -> {min, max}
  brushRadius: 0.08,
  brushStrength: 0.5,
  brushFalloff: 2,                    // exposant du falloff : 0 = uniforme, 1 = linéaire, 2+ = smooth aux bords
  brushGeodesic: true,                // true = distance le long de la surface, false = distance 3D euclidienne
  // Mode sélection rectangle pour assigner un poids à un set de vertices
  paintSelectionMode: false,
  selectedVertexGroups: new Map(),    // mesh.uuid -> Set<groupId>
  selectionWeight: 1.0,
  brushSubtract: false,
  isPainting: false,
  cachedWorldPositions: new Map(),    // mesh.uuid -> Float32Array
  vertexGroups: new Map(),            // mesh.uuid -> { vertexToGroup: Int32Array, groups: number[][] }
  weightPaintShowShading: true,       // ombrage view-space actif par défaut (cohérent avec le checked HTML)

  // Joint edit
  jointEditMode: false,
  savedRotationsForJointEdit: null,
  jointDragSnapshot: {
    bone: null,
    followSet: new Set(),
    worldStart: new Map(),
    skinningPerMesh: new Map(),
    childWorldPositions: new Map(),
  },
  originalBoneInverses: new Map(),
  originalBonePositions: new Map(),
  isDraggingJoint: false,
  // Snapshot pour le drag de rotation (gizmo en mode joints, bones rotatables)
  jointRotateSnapshot: {
    bone: null,
    skinningPerMesh: new Map(),  // skinnedMesh -> Matrix4 (S figé pour le bone draggé)
    childMatrixWorld: new Map(), // child bone -> Matrix4 (matrixWorld complète figée)
  },

  // IK
  ikMode: false,
  ikTargetMarkers: new Map(),       // chainName -> Mesh (cible orange — main, pied, tête, pelvis)
  ikPoleMarkers: new Map(),         // chainName -> Mesh (pole cyan — coude, genou, sommet de tête)
  ikOrientationMarkers: new Map(),  // chainName -> Mesh (pole magenta — orientation du end bone)
  ikConnectionLines: [],            // Lines reliant chaque pole/orientation au bone qu'il dirige
  ikDragSnapshot: {
    chainName: null,
    type: null,                // 'target' | 'pole'
    plane: null,
    grabOffset: null,
  },
  isDraggingIK: false,
  ikFullBody: false,             // pré-pass CCD sur les extension bones
  ikConstraintsEnabled: true,    // clamp anatomique (genoux/coudes/colonne)
  ikLockFeet: true,             // verrouille les pieds au sol pendant un drag
  ikAutoBalance: false,         // ajuste le Pelvis pour que le COM se projette entre les pieds
  ikAutoBalanceStrength: 0.5,   // fraction du décalage appliqué par frame (smooth)
  ikGroundY: 0,                  // hauteur du sol (en world Y)
  ikFeetSnapshot: null,          // snapshot des positions de pieds pour le lock
  ikGroundPreview: null,         // THREE.Mesh affiché au niveau du sol quand lock feet est on

  // ArrowHelper affichant l'axe Y local du bone sélectionné en mode joints
  // (mains/pieds) — pour visualiser le sens de la main/pied.
  jointAxisArrow: null,

  // Props (objets additionnels importés en GLB)
  propsMode: false,
  props: [],                // [{ id, name, root: Object3D }]
  selectedProp: null,
  propGizmoMode: 'translate', // 'translate' | 'rotate' | 'scale'
};

// Expose pour debug console
window.state = state;
window.THREE = THREE;
