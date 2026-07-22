# CLAUDE.md — Outil **Sculpt** (`js/sculpt/`)

> Guide développeur complet et autonome de l'outil Sculpt. C'est l'application principale du repo :
> un éditeur 3D navigateur (vanilla JS + Three.js r160, **sans build**) qui regroupe sculpture,
> retexturing (IA), export FDM multicouleur, rigging/animation, dépliage UV, découpe, et un mode rendu.
> Objectif de ce doc : pouvoir reprendre n'importe quelle feature sans réapprendre les contraintes.

Page : `sculpt.html`. Point d'entrée JS : `js/sculpt/main.js` (module ES). Styles : `sculpt.css`.
Aucune étape de build : on édite les fichiers, on recharge le navigateur. Déploiement auto GitHub Pages.

---

## 0. Règles de travail (IMPORTANT)

- **Répondre en français.**
- **Commits** : `cat` est une fonction shell qui colorise (ANSI) → messages de commit corrompus.
  Toujours écrire le message via l'outil Write dans un fichier temporaire puis `git commit -F <fichier>`.
  Finir les messages par les lignes `Co-Authored-By:` / `Claude-Session:` demandées.
  Commiter/pusher **uniquement quand l'utilisateur le demande**. Commits thématiques quand c'est possible
  (mais `main.js` touche presque toutes les features → souvent regroupé).
- **Pas de grosses dépendances WASM/worker externes** (voir mémoire projet) : xatlas a été retiré car
  trop lent/bloquant → le dépliage UV est fait **en interne**. Manifold (déjà en place) reste OK.
  Si une lib externe est indispensable : prévoir **timeout + fallback**.
- **Vérifier la syntaxe** après édition JS : `node --check js/sculpt/<fichier>.js`.
- Le diagnostic TypeScript `Property '__objects' may not exist on Window` est **pré-existant/bénin**
  (debug `window.__objects`), à ignorer.
- Ne pas modifier le **mailleur de cap du split** sans cas de repro réel (2 régressions passées — voir §7).

---

## 1. Architecture générale

```
sculpt.html  ── importmap (three, three-mesh-bvh, three-bvh-csg, manifold-3d, meshoptimizer)
   │           ── coi-serviceworker.js (COOP/COEP -> SharedArrayBuffer pour les workers de split)
   └── main.js  (orchestrateur : UI, boucle de rendu, événements, colle tous les modules)
        ├── scene.js        init Three (scene/camera/renderer/controls/lumières/curseur brush)
        ├── state.js        état global partagé (state.*, state.params.*)
        ├── loader.js       chargement fichiers, createObject, topologie (BVH + soudure), gestion scène
        ├── brush.js        collecte de sommets + application des brosses + curseur
        ├── mask.js         masque par sommet (attribut `mask`)
        ├── symmetry.js     symétrie multi-axes + plans visuels + curseurs miroir + gizmo d'édition
        ├── split*.js       découpe (lasso/masque) : manifold / csg / worker CDT / caps
        ├── connectors.js   tenons/mortaises sur les pièces d'un split
        ├── retexture.js    capture/reprojection UV, calques, masques, IA (Nano Banana)
        ├── unwrap.js       dépliage UV automatique (interne)
        ├── vertexpaint.js  peinture couleur par sommet -> export 3MF MMU (FDM)
        ├── rig*.js         squelette : pose, weight paint, retarget, bake
        ├── render-mode.js  mode Rendu (preview studio : GTAO, ombres, GI optionnelle)
        ├── display.js      matériaux d'affichage (texture/matcap/clay/vertex colors)
        ├── remesh/decimate/hollow/repair/orient/wallcheck.js   opérations de maillage
        ├── boolean.js      booléens entre 2 objets (Manifold)
        ├── gizmo.js        TransformControls objet (déplacer/tourner/redimensionner)
        ├── history.js      undo/redo (géométrie, masque, couleur, actions génériques)
        ├── autosave.js     persistance IndexedDB (restaure la scène au rechargement)
        ├── alpha.js        formes d'alpha / falloff du brush
        ├── exporter.js     export GLB / OBJ
        └── ui.js           setStatus / showLoading / setProgress / refreshWireframe
```

L'outil est **multi-objets** : `state.objects[]`, l'objet actif = `state.targetMesh`. Le split crée
plusieurs objets. Chaque objet est un `THREE.Mesh` (ou `THREE.SkinnedMesh` pour un rig) ajouté à la scène.

Les **outils** sont sélectionnés par des boutons `.tool-btn[data-tool=...]` : `draw, smooth, flatten,
inflate, pinch, crease, move, split, gizmo, mask, retexture, vertexpaint, bones, other, render`.
`state.params.tool` porte l'outil courant. Les panneaux/options se montrent via `data-tools="..."`
(token exact, ou alias `sculpt` = toutes les brosses ; voir `applyToolVisibility` dans main.js).

---

## 2. Modèle de données & conventions géométriques

### state (state.js)
- `state.targetMesh` : objet sculpté ; `state.objects[]` : tous les objets.
- **Topologie** reconstruite à chaque `setActiveObject` via `buildTopology` (loader.js) :
  - `state.vertexNeighbors: Int32Array[]` — voisins buffer par sommet (lissage).
  - `state.rep: Int32Array` — représentant du groupe de position (**soudure LOGIQUE** par position
    quantifiée, `Q=1e4`). Deux sommets coïncidents (couture UV/normale) partagent le même `rep`.
  - `state.groupMembers: Map<rep, Int32Array>` — membres coïncidents.
  - `state.repNeighbors: Map<rep, Int32Array>` — voisins unifiés à travers la couture.
- `state.params` : tous les réglages UI (voir state.js pour la liste commentée). Notable :
  - `size` = rayon **monde** du brush, **dérivé** de `sizeFrac` (fraction d'écran) à chaque coup via
    `syncBrushRadius` (main.js) → **taille écran constante, suit le zoom**. Ne pas régler `size` à la main.
  - `symmetry {x,y,z}`, `symmetrySpace 'local'|'world'`, `symmetryShowPlanes`.
  - `displayMode 'texture'|'matcap'|'clay'|'vcflat'`.

### Conventions géométrie
- Indices OBJ 1-based en entrée ; tout est 0-based en interne.
- **`reorderSpatially(geometry)` (loader.js)** réordonne les sommets par code de Morton pour la localité
  mémoire (upload GPU partiel pendant le stroke → gros gain de perf). **Il RÉÉCRIT l'index et permute
  AUSSI `skinIndex`/`skinWeight`/`tangent`/uv/color/normal.** Conséquence : après chargement, les attributs
  sont des `BufferAttribute` **plats** (dé-entrelacés) — c'est pourquoi `copyAttr(.array.slice())` est sûr
  à la sauvegarde. NE PAS réordonner à la restauration autosave (géométrie déjà ordonnée + masque aligné).
- **`geometry.computeBoundsTree()` (three-mesh-bvh) RÉORDONNE l'index EN PLACE.** Donc si on partage un
  index entre 2 géométries (ex. un proxy), cloner l'index d'abord (bug déjà rencontré sur le weight paint).
- **Attributs entrelacés (InterleavedBufferAttribute)** : possible sur un GLB brut. Écrire une position via
  `attr.array.set(...)` corromprait le buffer entrelacé → utiliser `attr.setXYZ(i, ...)` (voir `bakePose`).
- Le sculpt écrit `geometry.attributes.position` puis `position.needsUpdate = true` +
  `geometry.computeVertexNormals()` (ou moyenne locale) + refit du BVH.
- **Géométrie non indexée** : acceptée. `buildTopology` (re)crée un index et **re-soude par position** →
  normales lisses et brosses continues aux coutures. (C'est pourquoi `unwrap.js` peut sortir du non-indexé.)

---

## 3. Boucle de rendu (main.js `animate`)

1. `state.controls.update()` (OrbitControls, damping).
2. `updateRigs()` — mixers d'animation / retarget des objets riggés en lecture.
3. `updatePoseMarkers()` si pose active ; `updateBonesTimeUI()` si outil bones.
4. Symétrie : `updateSymmetryHelper(...)` (plans) + `updateSymmetryCursor(...)` (points miroir).
5. **Rendu** : `if (isRenderMode()) renderModeFrame(); else renderer.render(scene, camera);`
6. HUD perf (EMA frame/render/sculpt) si activé.

**Résolution dynamique** : pendant un stroke, `setSculptResolution(true)` baisse le pixelRatio à 1
(raccourcit le stall GPU dû à l'écriture du buffer chaque frame) ; pleine résolution au repos.

---

## 4. Interaction souris / clavier (main.js)

- **Clic gauche** sur l'objet : applique l'outil courant (sculpt/mask/vertexpaint). `pointerdown` gère
  le début de stroke, coalescing `pointermove` (une passe par frame via `processMove`).
- **Clic droit** : pan (OrbitControls). **Shift + clic droit = rotation** (natif OrbitControls : le bouton
  droit est PAN par défaut, et Shift bascule pan↔rotate — **ne PAS remapper `mouseButtons`**, ça ré-inverse).
- **Maintien Shift** : bascule temporaire vers **Smooth** (visible dans le menu, `_tempTool`). Rétabli au
  relâchement. Uniquement depuis une brosse de sculpt.
- **Maintien Ctrl** (pas Cmd, pour éviter Cmd+Z sur Mac) : bascule temporaire vers **Masque**.
  Ctrl+Alt = démasque. Sur Mac, Ctrl+clic = clic droit : géré (menu contextuel supprimé, orbite off,
  clic accepté pour peindre). Le clic droit sur les boutons du panneau les **active** (pas de menu).
- **X maintenu** : règle le rayon du brush à la souris (radiusMode) ; `sizeFrac` en fraction d'écran.
- **Alt** (dans un stroke) : inverse l'outil (draw retire, inflate dégonfle…).

---

## 5. Brosses (brush.js)

Collecte : `brushCollect(worldPoint, radius)` → `collectInSphere` (via BVH shapecast) remplit un buffer de
sommets touchés. `performStroke(worldPoint, opts)` applique la brosse + **tous les points miroir**
`symmetryPoints(worldPoint)`.

- Outils surfaciques dans `applyStrokeAt` : `draw, flatten, smooth, inflate, pinch, crease` (+ `mask` →
  `applyMaskStroke`). Le lissage/couture respecte `state.rep`/`groupMembers` (pas de sur-peinture des
  coutures UV, normales moyennées par groupe).
- **Falloff** radial (LUT `state.falloff`) + **alpha** (forme du coup, `state.alpha`) — voir alpha.js.
- `intensity` (0..200 %), `falloffHardness` (dureté du bord).
- **Curseur** : `updateBrushCursor(hit, orient, showRing, rad, nrm)` — anneau (RingGeometry, normale
  +Z = `_up`) orienté sur la normale de surface + point de collision (façon Nomad). Rayon = fraction
  d'écran via `syncBrushRadius`. Le helper commun `showInfluenceCursor(hit)` (main.js) sert sculpt +
  retexture + weight paint (orienté normale en weight).

---

## 6. Symétrie (symmetry.js) — feature détaillée

- Axes **X/Y/Z indépendants** (combinables → jusqu'à 7 reflets), espace **Local** ou **Monde**.
- **Local** : miroir dans un **repère éditable** `mesh.userData.symFrame = { pos, quat }` (relatif à
  l'objet, appliqué par `mesh.matrixWorld`). Défaut : `pos` = centre de la bbox d'ORIGINE
  (`storeSymCenter`, appelé dans `createObject` et `buildRigMesh`). `symWorldMatrix` = `matrixWorld · frame`.
- **Monde** : miroir autour de l'**origine du monde (0,0,0)**, axes du monde (PAS la position de l'objet).
- Édition du plan local : `enterSymEdit(mesh)` attache un `TransformControls` sur un proxy ;
  `setSymGizmoMode('translate'|'rotate')` ; `resetSymFrame` (recentre). Bouton ✎ ; pendant l'édition le
  sculpt est bloqué (`isSymEditing()` garde le pointerdown). Sortie auto si on quitte le sculpt / passe en
  Monde / Rendu / change d'objet (garde dans `animate`).
- **Plans visuels** (X rouge / Y vert / Z bleu), toggle ▦ (`symmetryShowPlanes`). **Points miroir**
  (fantômes) au survol (`updateSymmetryCursor` ; points seulement, pas de cercle d'influence).
- **Persistance localStorage** : clé `sculpt-symmetry` (axes + espace + affichage plans).
- Gotcha : le point de coup passé aux brosses (`_ls`) est un simple `{x,y,z}`, PAS un `Vector3` →
  dans symmetry.js utiliser `_p.copy(worldPoint)` (jamais `worldPoint.clone()`).

---

## 7. Découpe / Split (split*.js, cap-*.js) — ZONE FRAGILE

Deux entrées : **lasso** (outil `split`, tracé écran) et **masque** (bouton du panneau Masque, `splitByMask`).
Le lasso produit `{ inside, outside, capMode }`. Modes (state.params.splitMode) :
- `csg` (défaut, "Précise") : d'abord **localisé** (`lassoSplitLocalized`), sinon **Manifold**
  (`lassoSplitManifold`, watertight), sinon **three-bvh-csg** (`lassoSplitCSG`, marche partout, caps parfois
  imparfaits). → produit TOUJOURS un résultat.
- `fast` : CDT dans un **worker** (`split-worker.js` / `split.js`), rapide mais exige une densité suffisante
  sous le lasso (sinon refus pour ne pas détruire le maillage).
- **Manifold EXIGE une entrée 2-manifold/watertight** ; sinon `{ fallback: true }` → l'appelant retombe sur CSG.

**Caps** (`cap-loop.js` `fillLoopsCDT`, `cap-mesher.js` `retopoMesh`) : ⚠️ **NE PAS modifier le mailleur de
cap sans cas de repro réel** (2 régressions passées). Garde de planarité obligatoire : bord non-plan →
éventail 3D (le CDT planaire s'étrangle). Le split rate les coupes sans sommet enclos (ex. cube) → le fix
choisi est le **raffinement conformant le long du lasso**.

### Connecteurs (connectors.js)
Case « Connecteurs (tenons) » (`state.params.splitConnectors`, outils Split/Masque). Après split :
`addConnectors(insideGeom, outsideGeom, {size})` → détecte l'**interface** (sommets d'`inside` proches de la
surface d'`outside` via BVH `closestPointToPoint`), **fit un plan** (PCA, Jacobi 3×3), place **1–3 tenons**
cylindriques le long de l'axe le plus long → **union** sur une pièce + **soustraction (avec jeu)** sur l'autre,
via **Manifold**. **Fallback propre** (renvoie null → pièces gardées) si interface introuvable ou non-watertight.
Marche mieux en mode split « Précise/Manifold ». `maybeAddConnectors(res, refGeom)` dans main.js l'appelle.

---

## 8. Retexturing (retexture.js) — feature détaillée

Compositing de **calques** (`mesh.userData._retexLayers`) sur une texture UV (`RETEX_SIZE = 2048`).
Exige des **UV** (voir §9). L'outil **Retexture** est **accessible sans UV** mais alors seul le bouton
**Déplier les UV** est actif (`updateRetexUVState` : bandeau `#retex-needuv` + actions `[data-needuv]`
grisées + peinture bloquée). Tout se débloque après le dépliage.

- **Capture** : `captureView` (screenshot 1:1 de la vue, cadre `#capture-frame`), `getPendingCam` mémorise
  la caméra pour la reprojection. **Reprojection** : `reprojectToUV(img, mesh, size)` bake l'image caméra
  sur la texture UV (via la caméra de capture).
- **Peinture de masque** : `paintMaskDab` (par calque ou pré-génération/inpaint) ; `renderMaskView`
  (masque des zones vides pour l'inpaint multi-vues).
- **IA (Nano Banana = Gemini 2.5 Flash Image, BYOK)** : `generateNanoBanana(capUrl, prompt, key, ?, maskUrl)`.
  - **Multi-vues** (`multiViewTexture`, main.js) : accumule les reprojections, `destination-over` = ne
    remplit que le vide (inpaint cohérent). **6 vues = FACES DU CUBE** (avant/arrière/gauche/droite/dessus/
    dessous) ; **12 vues = orbite 360°**. Poses calculées dans `multiViewTexture`.
  - **Relief IA** (`retex-relief`) : height map niveaux de gris reprojetée → **calque de type `relief`**
    (déplacement des vertices le long des normales) dont on règle l'**amplitude** à la volée (0..~20 %,
    volontairement faible). Le masque du calque relief = poids par sommet.
  - **Texture + Relief** (`retex-texrelief`) : 2 appels IA chaînés (couleur puis height map dérivée du rendu
    couleur → le relief se creuse où la couleur est peinte).
- **Calques** : liste à gauche (`#retex-layers`), type couleur ou relief, opacité/amplitude, masque N&B,
  clic droit (menu), affichage du masque seul, plein/vide/inverser. `recomposeRetex()` recompose.
- **Aperçu débug** (`#texture-preview`, bas-gauche) : montre la texture composite **+ le fil-de-fer des UV**
  superposé (`drawUVWireframe`, échantillonné au-delà de 60k tris). Le calque « FDM » ne montre PAS les
  vertex colors ; en Retexture on force l'affichage `texture`.
- Application finale : `applyTextureCanvas(mesh, canvas)` pose la texture sur `baseMat.map`.

---

## 9. Dépliage UV automatique (unwrap.js) — feature détaillée

`unwrapUVs(geometry)` (interne, **sans dépendance**, cf. mémoire : xatlas retiré car trop lent) :
1. **Charts quasi-plans** : croissance de région par adjacence, bornée par la normale MOYENNE du chart (35°)
   ET la normale de DÉPART (65°) → pas d'enroulement/repli → **projection planaire sans recouvrement**.
2. Projection planaire de chaque chart sur son plan moyen (base T,B).
3. **Packing serré binary-tree** (façon lightmap) + **échelle UNIFORME** (densité de texels homogène, pas de
   distorsion ; le bin binary-tree est ~carré donc remplit bien le carré UV).
4. Sortie = géométrie **NON INDEXÉE** (uv par coin) → bijective → exploitable par la reprojection retexture.
   Le sculpt re-soude logiquement par position (`buildTopology`) → normales lisses conservées.

Bouton **🗺️ Déplier les UV** présent dans le panneau **Autres** ET **Retexture** (`doUnwrap`, xatlas ne doit
pas être réintroduit sans demande explicite). Remplace la géométrie via `createObject` (+ undo).

---

## 10. Export FDM / Vertex Paint (vertexpaint.js) — feature détaillée

Outil **FDM export** (`vertexpaint`) : peinture de **couleurs par sommet** depuis une palette, export **3MF
multicouleur (MMU)**.
- Palette par objet (`getPalette(mesh)`, `mesh.userData._vpPalette`). `ensureColorAttr` garantit un attribut
  `color` (sinon rendu noir). Affichage `vcflat` (matcap × couleur, **à plat** par face, frontières nettes).
- **Pipette** : `i` maintenu = prélève en continu la couleur de palette la plus proche (sélectionne, n'ajoute
  pas) ; panneau pipette = ajoute la couleur. Éditer une couleur de palette **recolore tous les sommets** de
  l'ancienne couleur. En mode color-picker : cache le cercle d'influence + curseur pipette.
- Symétrie appliquée aussi (`symmetryPoints`).
- **3MF MMU** : `buildVertexPaint3MF` — segmentation `slic3rpe:mmu_segmentation` (`["1","4","8","0C",...]`) +
  métadonnées PrusaSlicer pour que **Bambu Studio reconnaisse les couleurs** (couleur dominante par triangle
  → slot filament = index palette + 1). (Le converter.html historique fait la même chose côté palette.)

---

## 11. Rigging / Bones (rig*.js) — feature détaillée

Un modèle riggé conserve le **graphe Three natif** (SkinnedMesh + bones + clips) — le chargement normal
aplatirait la géométrie et détruirait skinIndex/skinWeight → **chemin séparé** (`loader.js` détecte via
`extractRig`, `addRiggedObject`). Chaque SkinnedMesh est un objet sculptable de `state.objects` avec un
`userData.rig` partagé `{ root, skinned, bones, skeleton, mixer, helper, animations, ... }`.

- **Tout fonctionne sur un rig** : sculpt, move, retexture. Le squelette n'est **jamais retiré**.
- **Perf** : `SkinnedMesh` a son propre raycast CPU O(n) → patché avec `acceleratedRaycast` (BVH).
  `reorderSpatially` permute aussi skinIndex/skinWeight (sinon gros upload GPU = lag). Normales calculées
  au build (`computeVertexNormals`) sinon la brosse plante (`averageNormalWorld` lit `normal.array`).
- **Soudure du skin au chargement** (`unifySkinWeights` dans loader.js/buildRigMesh) : beaucoup de GLB ont
  des sommets coïncidents non soudés avec des poids DIFFÉRENTS → **trous aux coutures** quand on bouge un os.
  On uniformise skinIndex/skinWeight par groupe de même position (4 influences dominantes renormalisées),
  **sans toucher la topologie**.
- **Pose** (rig-pose.js) : liste d'os + schéma SVG + marqueurs 3D (sphères, taille écran constante).
  Les os **Twist** sont cliquables à la souris (mais le 1er clic d'une pile prend un os NORMAL, le cyclage
  atteint ensuite le twist) ; sélectionnables aussi via la liste. Gizmo rotation (twist = axe Y seul).
  **Offset de joint** = déplacer le joint SANS bouger le skin (recalcule `boneInverse`).
- **Weight paint** (rig-weightpaint.js) : heatmap, pinceau screen-constant (même zone d'influence que le
  sculpt), respecte les seams UV, force 0..0.5, sélection d'os cible avec cyclage (twists via cycle), Ctrl+Z.
  Proxy **skinné** pour le raycast (`bakeProxy`/`pickPoint`, clone l'index pour ne pas corrompre le BVH mesh).
  Mode Pose actif par défaut à l'entrée dans **Bones** ; on ne quitte la pose qu'en sortant de Bones ou en
  passant en Weight. L'os sélectionné est conservé entre pose↔weight.
- **Bake de pose** (`bakePose`) : sculpter un rig posé fige la pose comme nouveau bind **en gardant le
  squelette**. Écrit les positions posées (`applyBoneTransform`, via `setXYZ` car buffer possiblement
  entrelacé) puis **`sm.bind(sm.skeleton)` SANS bindMatrix** → `calculateInverses()` recalcule les
  `boneInverses` à la pose courante (⚠️ passer `bindMatrix` à `bind()` NE recalcule PAS les inverses →
  pose appliquée en double = saut). Déclenché **à la SORTIE du menu squelette** (pas au 1er clic) → BVH prêt
  pour le hover. Flag `poseDirty`.
- **Retarget** (rig-retarget.js) : mapping d'os (`boneMapping`, calibré rig maison + sources Mixamo/human).
  Import d'animations GLB/FBX rejouées via mapping.
- **Autosave** : les rigs sont sérialisés/restaurés **entièrement** (géométrie courante + skinIndex/skinWeight
  + arbre d'os + boneInverses + bindMatrix + clips `AnimationClip.toJSON`) — voir §14.

---

## 12. Mode Rendu (render-mode.js) — feature détaillée

Outil **🎬 Rendu** = preview (édition désactivée, orbite dispo, helpers masqués). Rendu via `EffectComposer`.
Système calqué sur le viewer, en **lampes physiques r160** :
- **Éclairage** : HemisphereLight (fill / GI douce, slider **Ambiant**) + DirectionalLight forte (modelé +
  auto-ombrage). Les lumières d'édition sont éteintes le temps du rendu. Fond blanc.
- **Matériaux** : `MeshLambertMaterial` (comme le viewer, couleurs franches) — texture si présente, sinon
  **vertex colors linéarisés** (⚠️ les vertex colors sont stockées en sRGB ; sans `pow(2.2)` le pipeline les
  ré-encode → « voile blanc »). GI (checkbox) → repasse en `MeshStandard` + environnement studio (IBL).
- **AO** : GTAO. Rendu **uniquement sur les objets** : le composer rend le modèle seul (sol masqué), l'AO ne
  touche donc ni le sol ni le fond. Sliders **AO force / AO rayon**.
- **Ombres au sol** = **contact shadows** (silhouette vue de dessus, floutée gaussien 2 passes, projetée sur
  le sol via mapping projectif → toujours alignée, pas de shadow map hachée) — dessinées en **overlay APRÈS**
  le composer (passe profondeur du modèle pour occulter). Deux ombres combinables : **contact** (toujours) +
  **projection** (axe lumière, toggle). Sliders : **Ombre sol** (opacité), **Contact flou**, **Ombre flou**
  (sol + auto-ombrage), Direction/Hauteur (90° = pile dessus), **Ombre objet** (opacité de l'auto-ombrage via
  une lumière de remplissage même-axe : clé + remplissage = constant → zones éclairées inchangées).
- **Auto-ombrage** du modèle : `PCFSoftShadowMap` (VSM rétrécissait) ; flou piloté par la résolution de la
  shadow map + rayon PCF ; `normalBias` croissant avec le flou (anti-stries).
- **Réglages persistés en localStorage** (`sculpt-render-params`).

---

## 13. Opérations de maillage (panneau « Autres »)

Toutes remplacent la géométrie via `createObject` + `pushAction` (undo) et conservent le transform.
- **Subdiviser** (`subdivideTarget`, loader.js) — ajoute du détail.
- **Décimer** (`decimateMesh`, meshoptimizer QEM) — low-poly, garde forme + texture.
- **Voxel remesh** (`voxelRemesh`, remesh.js) — topologie propre/watertight via SDF + Manifold levelSet ;
  reprojette les attributs. Répare les meshes IA.
- **Réparer** (`repairMesh`) — souder, retirer bouts flottants, boucher trous (`fillHoles`).
- **Évider** (`hollowMesh`) — coque d'épaisseur donnée (Manifold levelSet inset).
- **Vérifier l'épaisseur** (`checkThickness`, wallcheck.js) — colore en rouge les parois trop fines.
- **Auto-orienter** (`autoOrient`, orient.js) — minimise les surplombs, meilleure base au sol (impression).
- **Séparer les parties** (`separateComponents`) — composantes connexes → objets distincts.
- **Booléens** (`booleanObjects`, boolean.js) — union/soustraction/intersection entre 2 objets (Manifold).
- **Déplier les UV** (`unwrapUVs`) — voir §9.

---

## 14. Persistance / Autosave (autosave.js, IndexedDB)

Débouncé après chaque modif + au masquage/fermeture d'onglet ; restauration auto au chargement (si scène
vide). Sérialise par objet : géométrie (pos/nor/uv/color/index + skinIndex/skinWeight pour les rigs),
matériau (type/couleur/roughness/metalness/map en blob), masque, transform, nom, visibilité. + méta
(caméra, mode d'affichage).
- **Objets normaux** : `{kind:'mesh', ...}` → `createObject` (géométrie déjà ordonnée, ne pas réordonner).
- **Rigs** : `{kind:'rig', ...}` → `restoreRig` reconstruit Group + Bones + Skeleton + SkinnedMesh + re-bind
  + mixer/helper/wireframe/BVH (`buildRigMesh` avec `reorder=false`, `addRiggedObject` avec `fit:false`).
  Dédup : un rig = plusieurs SkinnedMesh partageant un `rig` → sérialisé UNE fois.

---

## 15. Autres systèmes

- **Undo/redo** (history.js) : `pushGeom` (positions), `pushMask`, `pushColor`, `pushAction(undo, redo,
  dispose?)` (générique, pour attach/detach d'objets). Ctrl/Cmd+Z / +Shift+Z. `setHistoryListener` met à
  jour l'UI (boutons + markDirty autosave).
- **Gizmo objet** (gizmo.js) : `TransformControls` (translate/rotate/scale), **Alt = déplacer le pivot**.
- **Masque** (mask.js) : attribut `mask` par sommet (0..1), flou (`setMaskBlur`/`bakeMaskBlur`), inversion,
  effacer. Undo via `maskRecordBegin/Touch/End`. Les sommets masqués sont protégés des brosses.
- **Display** (display.js) : `texture` (matcap × map), `matcap`, `clay`, `vcflat` (vertex colors à plat).
  En mode Texture **sans map mais avec vertex colors**, on affiche les vertex colors (pas un matcap blanc).
  Le vrai matériau est `mesh.userData.baseMat` ; l'affichage en dérive.
- **Focus caméra** : double-clic sur un objet de la liste → cadre sur le **centre de la bounding box**
  (setFromObject précis), pas l'origine.
- **Alpha du brush** (alpha.js) : formes carré/rond/image, falloff éditable + LUT.

---

## 16. Dépendances & environnement

- **importmap** (sculpt.html) : `three@0.160.0`, `three/addons/`, `three-mesh-bvh@0.7.8`,
  `three-bvh-csg@0.0.17`, `manifold-3d@3.5.1`, `meshoptimizer` (vendored `js/vendor/`).
- **three-mesh-bvh** est patché sur `BufferGeometry.prototype` (computeBoundsTree/disposeBoundsTree) +
  `SkinnedMesh.prototype.raycast = acceleratedRaycast` (loader.js).
- **Manifold** (WASM) : `getManifold()` (split-manifold.js), `warmupManifold()` au démarrage. Exige des
  entrées 2-manifold ; fournir un fallback.
- **coi-serviceworker.js** : COOP/COEP pour SharedArrayBuffer (workers de split multi-thread). Un rechargement
  au 1er chargement. Les ressources CDN (three, manifold…) passent car servies avec les bons en-têtes.
- **Restauration IndexedDB** volumineuse → pas localStorage. localStorage utilisé seulement pour les petits
  réglages (symétrie, render params, clé Gemini).

---

## 17. Checklist pour AJOUTER une feature

1. Créer un module `js/sculpt/<feature>.js` si autonome (garder les fichiers petits et ciblés).
2. Câbler dans `main.js` : import, listener(s), état dans `state.params`, appel dans la boucle si besoin.
3. UI dans `sculpt.html` : bouton d'outil (`.tool-btn[data-tool]`) ou options (`data-tools="..."`), panneau.
   Styles dans `sculpt.css`.
4. Si ça remplace la géométrie : passer par `createObject` + `pushAction` (undo) + conserver le transform.
5. Respecter les invariants §2 (reorder/BVH/soudure/entrelacé).
6. Réglages persistables → localStorage (petits) ; jamais dans IndexedDB (réservé à l'autosave scène).
7. `node --check` sur les fichiers modifiés. Tester en navigateur (le WASM/worker ne se teste pas en CLI).
8. Commit thématique via `git commit -F` (jamais via `cat`), sur demande de l'utilisateur.

---

## 18. Pièges connus (récap rapide)

- `cat` corrompt les messages de commit (ANSI) → `git commit -F`.
- `computeBoundsTree` réordonne l'index EN PLACE → cloner l'index d'un proxy partagé.
- `reorderSpatially` réécrit index + permute skinIndex/skinWeight/tangent/uv/color/normal.
- Attributs entrelacés → `setXYZ`, pas `array.set`.
- `SkinnedMesh.bind(skeleton, bindMatrix)` ne recalcule PAS les boneInverses ; `bind(skeleton)` seul oui.
- Le point de coup `_ls` est un `{x,y,z}`, pas un `Vector3` (`_p.copy`, pas `.clone()`).
- Vertex colors stockées en sRGB → linéariser (`pow(2.2)`) sous éclairage PBR (mode Rendu).
- Ne pas remapper `OrbitControls.mouseButtons` pour Shift+droit (natif).
- Mailleur de cap du split : fragile, ne pas toucher sans repro.
- Manifold exige du watertight → toujours un fallback (CSG pour le split, null pour les connecteurs).
- Ne PAS réintroduire xatlas (unwrap interne, cf. mémoire).
