// Petits helpers DOM partagés.

export function updateInfo(message) {
  const info = document.getElementById('info');
  if (!info) return;
  info.querySelector('p').textContent = message;
}

export function setFbxInputEnabled(enabled) {
  const fbxInput = document.getElementById('fbx-input');
  const fbxLabel = document.getElementById('fbx-input-label');
  fbxInput.disabled = !enabled;
  if (enabled) {
    fbxLabel.classList.remove('disabled');
  } else {
    fbxLabel.classList.add('disabled');
  }
}
