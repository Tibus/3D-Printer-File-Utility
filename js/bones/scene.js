// Initialisation Three.js : scene, camera, renderer, controls, lighting, ground, brush helper.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { state } from './state.js';

export function initScene() {
  const container = document.getElementById('canvas-container');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);
  state.scene = scene;

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(3, 2, 5);
  state.camera = camera;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  state.renderer = renderer;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.target.set(0, 1, 0);
  state.controls = controls;

  const transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setMode('rotate');
  transformControls.setSize(0.4);
  transformControls.setSpace('local');
  scene.add(transformControls);
  state.transformControls = transformControls;
  window.transformControls = transformControls;

  // Désactive OrbitControls pendant un drag du gizmo
  transformControls.addEventListener('dragging-changed', (event) => {
    controls.enabled = !event.value;
  });

  // Lumières
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
  directionalLight.position.set(5, 10, 7);
  directionalLight.castShadow = true;
  directionalLight.shadow.mapSize.width = 2048;
  directionalLight.shadow.mapSize.height = 2048;
  directionalLight.shadow.camera.near = 0.5;
  directionalLight.shadow.camera.far = 50;
  directionalLight.shadow.camera.left = -10;
  directionalLight.shadow.camera.right = 10;
  directionalLight.shadow.camera.top = 10;
  directionalLight.shadow.camera.bottom = -10;
  scene.add(directionalLight);

  const fillLight = new THREE.DirectionalLight(0x8888ff, 0.3);
  fillLight.position.set(-5, 5, -5);
  scene.add(fillLight);

  // Sol + grille
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardMaterial({ color: 0x2a2a4e, roughness: 0.8 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  scene.add(new THREE.GridHelper(20, 20, 0x444466, 0x333355));

  // Groupe pour les bone markers
  const boneMarkersGroup = new THREE.Group();
  scene.add(boneMarkersGroup);
  state.boneMarkersGroup = boneMarkersGroup;

  // Brush helper (anneau qui suit la souris en weight paint)
  const brushHelper = new THREE.Mesh(
    new THREE.RingGeometry(0.94, 1.0, 48),
    new THREE.MeshBasicMaterial({
      color: 0xff5aff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
    }),
  );
  brushHelper.renderOrder = 1001;
  brushHelper.visible = false;
  scene.add(brushHelper);
  state.brushHelper = brushHelper;

  // ArrowHelper pour montrer l'axe Y local du bone sélectionné (mode joints)
  const arrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 0),
    0.30,        // longueur
    0x00ff66,    // vert clair
    0.05,        // headLength
    0.035,       // headWidth
  );
  arrow.line.material.depthTest = false;
  arrow.cone.material.depthTest = false;
  arrow.line.renderOrder = 1002;
  arrow.cone.renderOrder = 1002;
  arrow.visible = false;
  scene.add(arrow);
  state.jointAxisArrow = arrow;
}
