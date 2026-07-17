// Initialisation Three.js : scene, camera, renderer, controls, lighting, brush helper.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { state } from './state.js';

export function initScene() {
  const container = document.getElementById('canvas-container');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);
  state.scene = scene;

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, 0.5, 2.2);
  state.camera = camera;

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  state.renderer = renderer;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.target.set(0, 0.3, 0);
  state.controls = controls;

  // Éclairage
  const ambient = new THREE.HemisphereLight(0xffffff, 0x223344, 0.9);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2, 3, 2);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x88aaff, 0.6);
  fill.position.set(-2, 1, -2);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 0.5);
  rim.position.set(0, -2, -1);
  scene.add(rim);

  // Grille de sol discrète
  const grid = new THREE.GridHelper(4, 20, 0x444466, 0x2a2a44);
  grid.position.y = -0.001;
  scene.add(grid);

  // Curseur brush : un cercle orienté sur la surface
  const brushGeom = new THREE.RingGeometry(0.98, 1, 48);
  const brushMat = new THREE.MeshBasicMaterial({
    color: 0x22d3ee,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  const brushMesh = new THREE.Mesh(brushGeom, brushMat);
  brushMesh.renderOrder = 999;
  brushMesh.visible = false;
  scene.add(brushMesh);
  state.brushMesh = brushMesh;
}
