// ============================================================================
// Transparent cutout for path-traced exports
// ============================================================================
// Shared by the render page and the viewer's raytracing mode: both need to turn
// a shot on a white sweep into a PNG or WebP frame with a transparent backdrop
// and the shadow carried in the alpha channel.

// Anything within this fraction of the backdrop's brightness is treated as
// empty, not as a faint shadow. The backdrop is a flat clipped white, so this
// only has to swallow the denoiser's residual noise — a wide knee here would eat
// the outer edge of the penumbra instead.
const EMPTY_KNEE = 0.04;

const srgbToLinear = v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const linearToSrgb = v => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** Whether exports should be cut out; the tracer persists the toggle. */
const alphaExport = () => !window.PathRender || window.PathRender.settings.alphaExport !== false;

/**
 * Compose the transparent product shot.
 *
 *  - inside the object mask : the rendered pixel, fully opaque
 *  - along its silhouette   : fractional coverage from the oversampled mask,
 *                             with the backdrop taken back out of the colour
 *  - everywhere else        : black with alpha taken from how dark the pixel is,
 *                             so the shadow keeps its gradient and composites
 *                             over any background instead of carrying a white
 *                             plate with it
 *
 * The silhouette is the fiddly part. A rendered edge pixel is already a mix of
 * the model and the white floor behind it; declaring it opaque bakes that white
 * in and the cutout ends up with a pale rim on every contour. So where coverage
 * is partial the backdrop is un-mixed back out — in linear light, where the
 * mixing actually happened — leaving the model's own colour under a fractional
 * alpha.
 */
function composeAlpha(sourceCanvas, mask) {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;

  const ctx = out.getContext('2d');
  ctx.drawImage(sourceCanvas, 0, 0);
  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  const m = mask.buffer;
  const scale = mask.scale || 1;
  const blockArea = scale * scale;

  const luminanceAt = i => (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;

  // The backdrop is meant to be a flat white but the denoiser leaves it a hair
  // under, so calibrate on the brightest corner: that value is what counts as
  // empty, and it is also what gets subtracted back out along the silhouette.
  const corners = [
    0,
    (width - 1) * 4,
    (height - 1) * width * 4,
    ((height - 1) * width + width - 1) * 4
  ];
  const reference = Math.max(0.05, ...corners.map(luminanceAt));
  const referenceLinear = srgbToLinear(reference);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;

      // average the mask block behind this pixel; readRenderTargetPixels gives
      // bottom-up rows while the canvas is top-down
      let covered = 0;
      const blockY = (height - 1 - y) * scale;
      const blockX = x * scale;
      for (let sy = 0; sy < scale; sy++) {
        const row = (blockY + sy) * mask.width;
        for (let sx = 0; sx < scale; sx++) {
          covered += m[(row + blockX + sx) * 4];
        }
      }
      const coverage = covered / (blockArea * 255);

      if (coverage >= 0.999) {
        px[i + 3] = 255;
        continue;
      }

      // how much darker than the empty backdrop this pixel is, with a knee so
      // the bare floor stays fully clear
      const luminance = luminanceAt(i);
      const darkness = (reference - luminance) / reference;
      const shadowAlpha = Math.max(0, Math.min(1, (darkness - EMPTY_KNEE) / (1 - EMPTY_KNEE)));

      if (coverage <= 0.001) {
        px[i] = 0; px[i + 1] = 0; px[i + 2] = 0;   // shadow is pure black over alpha
        px[i + 3] = Math.round(shadowAlpha * 255);
        continue;
      }

      // Silhouette. What landed in the frame is
      //     rendered = coverage * model + (1 - coverage) * backdrop
      // so the model's own colour comes back by undoing that mix. The remaining
      // (1 - coverage) of the pixel is floor, which contributes black at its own
      // shadow alpha, and the two compose to:
      const alpha = coverage + (1 - coverage) * shadowAlpha;
      const weight = coverage / alpha;          // black carries no colour
      for (let c = 0; c < 3; c++) {
        const rendered = srgbToLinear(px[i + c] / 255);
        const model = (rendered - (1 - coverage) * referenceLinear) / coverage;
        const value = linearToSrgb(Math.max(0, Math.min(1, model)) * weight);
        px[i + c] = Math.round(Math.max(0, Math.min(1, value)) * 255);
      }
      px[i + 3] = Math.round(alpha * 255);
    }
  }

  ctx.putImageData(image, 0, 0);
  return out;
}
