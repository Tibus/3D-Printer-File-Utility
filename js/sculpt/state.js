// État global partagé du sculpteur.

export const state = {
  // Three.js core
  scene: null,
  camera: null,
  renderer: null,
  controls: null,

  // Modèle actif (celui qu'on sculpte). Un des state.objects.
  targetMesh: null,
  // Tous les objets de la scène (THREE.Mesh) — le split en crée plusieurs.
  objects: [],
  objectSeq: 0, // compteur pour nommer les objets

  // Topologie reconstruite à chaque chargement / remesh :
  vertexNeighbors: null,   // Int32Array[] : voisins buffer par vertex (lissage)
  rep: null,               // Int32Array : représentant du groupe de position (soudure logique)
  groupMembers: null,      // Map<rep, Int32Array> : membres coïncidents (coutures UV)
  repNeighbors: null,      // Map<rep, Int32Array> : voisins unifiés à travers la couture

  // Brush (curseur 3D)
  brushMesh: null,
  brushActive: false,

  // Interaction
  mouse: { x: 0, y: 0 },      // NDC
  lastMouse: { x: 0, y: 0 },
  mouseDown: false,
  rightClick: false,
  brushDirty: false,          // le curseur doit être re-raycasté

  // État du grab (outil move)
  grab: {
    active: false,
    plane: null,              // THREE.Plane dans l'espace monde
    startPoint: null,         // THREE.Vector3 point de saisie initial
    indices: null,            // Int32Array des vertices affectés
    weights: null,            // Float32Array falloff par vertex
    startPositions: null,     // Float32Array positions locales initiales
  },

  // Paramètres de l'outil (pilotés par l'UI)
  params: {
    tool: 'draw',             // 'draw' | 'smooth' | 'flatten' | 'move'
    size: 0.12,               // rayon du brush (unités monde locales du mesh)
    intensity: 100,           // % (0..200), 100 = référence
    invert: false,            // remove au lieu d'add (pour 'draw')
    symmetryX: false,
    displayHelper: false,     // afficher le wireframe / bvh helper
    falloffHardness: 0.5,     // dureté du bord (0 = très doux, 1 = net)
    cutDetail: 10,            // finesse du retopo du cap (×10 cellules sur la diagonale)
    splitMode: 'csg',         // 'csg' (booléen three-bvh-csg, robuste, défaut) | 'fast' (CDT, worker, rapide)
    remeshRes: 80,            // résolution du voxel remesh (cellules sur la plus grande dimension)
    hollowThickness: 0.04,    // épaisseur de coque (fraction de la plus grande dimension)
    realSizeMM: 0,            // taille réelle (mm) de la plus grande dimension (0 = non défini)
  },

  // Alpha du brush : { grid: Float32Array(n*n), n, name } — forme du coup.
  // falloff : LUT Float32Array du falloff radial. Initialisés dans main.js.
  alpha: null,
  falloff: null,
};

// Vecteur de référence Z pour orienter le curseur brush selon la normale.
export const normalZ = { x: 0, y: 0, z: 1 };
