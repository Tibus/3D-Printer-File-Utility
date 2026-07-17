// Alphas de brush : grille niveaux de gris (0..1) échantillonnée sur l'empreinte
// carrée du brush. Remplace le falloff radial fixe. Défaut : carré flou (Nomad).

function smoothstep(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

// Masque carré (bords nets + fin liseré AA). La douceur du bord vient du falloff.
export function makeSquareAlpha(n = 64) {
  const grid = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n, v = (j + 0.5) / n;
      const d = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2; // Chebyshev → carré
      grid[j * n + i] = 1 - smoothstep(0.94, 1.0, d);
    }
  }
  return { grid, n, name: 'square' };
}

// Masque rond (disque + fin liseré AA).
export function makeRoundAlpha(n = 64) {
  const grid = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n, v = (j + 0.5) / n;
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      grid[j * n + i] = 1 - smoothstep(0.94, 1.0, r);
    }
  }
  return { grid, n, name: 'round' };
}

// Courbe de falloff radial (LUT indexée par la distance normalisée 0..1).
// hardness (0..1) = taille du cœur plat : 0 = falloff très progressif depuis le
// centre, 1 = pas de falloff (bord net, force pleine partout).
export function makeFalloff(hardness, n = 64) {
  const lut = new Float32Array(n);
  const h = Math.min(0.999, Math.max(0, hardness));
  for (let i = 0; i < n; i++) {
    const r = i / (n - 1);
    lut[i] = 1 - smoothstep(h, 1.0, r);
  }
  return lut;
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('Image illisible'));
    im.src = url;
  });
}

// Charge une image (grayscale = hauteur ; blanc = plein, noir = rien).
export async function loadAlphaFromImage(file, n = 128) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const cv = document.createElement('canvas');
    cv.width = cv.height = n;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, n, n);
    const d = ctx.getImageData(0, 0, n, n).data;
    const grid = new Float32Array(n * n);
    for (let k = 0; k < n * n; k++) {
      const a = d[k * 4 + 3] / 255;
      const lum = (0.299 * d[k * 4] + 0.587 * d[k * 4 + 1] + 0.114 * d[k * 4 + 2]) / 255;
      grid[k] = lum * a;
    }
    return { grid, n, name: 'custom' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Construit une LUT de falloff depuis une image : profil de la ligne médiane,
// gauche = centre du brush (r=0), droite = bord (r=1). Blanc = plein, noir = rien.
export async function loadFalloffFromImage(file, n = 64) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w = 256, h = 8;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const row = h >> 1;
    const lut = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = Math.min(w - 1, Math.round((i / (n - 1)) * (w - 1)));
      const k = (row * w + x) * 4;
      const a = d[k + 3] / 255;
      const lum = (0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]) / 255;
      lut[i] = lum * a;
    }
    return lut;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Dessine la courbe de falloff (centre → bord) dans un petit canvas.
export function renderFalloffPreview(canvas, lut) {
  if (!canvas || !lut) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#12121e';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const n = lut.length;
  for (let x = 0; x < w; x++) {
    const t = x / (w - 1);
    const v = lut[Math.min(n - 1, (t * (n - 1)) | 0)];
    const y = (h - 1) - v * (h - 2);
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// Dessine un aperçu de l'alpha dans un canvas.
export function renderAlphaPreview(canvas, alpha) {
  if (!canvas || !alpha) return;
  const { grid, n } = alpha;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(n, n);
  for (let k = 0; k < n * n; k++) {
    const g = Math.round(grid[k] * 255);
    img.data[k * 4] = g; img.data[k * 4 + 1] = g; img.data[k * 4 + 2] = g; img.data[k * 4 + 3] = 255;
  }
  const tmp = document.createElement('canvas');
  tmp.width = tmp.height = n;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
}
