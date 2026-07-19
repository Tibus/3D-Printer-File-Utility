// Export du mesh sculpté en GLB ou OBJ.

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { state } from './state.js';
import { setStatus } from './ui.js';

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// On exporte une copie propre (sans l'overlay wireframe enfant), en gardant le
// matériau/texture courant (le GLB embarque la texture ; l'OBJ l'ignore).
function buildExportMesh() {
  const src = state.targetMesh;
  const geom = src.geometry.clone();
  if (geom.boundsTree) delete geom.boundsTree;
  return new THREE.Mesh(geom, (src.userData.baseMat || src.material).clone());
}

export function exportGLB() {
  if (!state.targetMesh) { setStatus('Aucun modèle à exporter.'); return; }
  const mesh = buildExportMesh();
  new GLTFExporter().parse(
    mesh,
    (result) => {
      download(new Blob([result], { type: 'model/gltf-binary' }), 'sculpt.glb');
      setStatus('Exporté : sculpt.glb');
    },
    (err) => { console.error(err); setStatus('Erreur export GLB'); },
    { binary: true },
  );
}

export function exportOBJ() {
  if (!state.targetMesh) { setStatus('Aucun modèle à exporter.'); return; }
  const mesh = buildExportMesh();
  const text = new OBJExporter().parse(mesh);
  download(new Blob([text], { type: 'text/plain' }), 'sculpt.obj');
  setStatus('Exporté : sculpt.obj');
}
