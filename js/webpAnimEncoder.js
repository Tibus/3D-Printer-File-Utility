// ============================================================================
// Animated WebP Muxer
// ============================================================================
// Browsers can encode a still WebP (canvas.toBlob('image/webp')) but have no
// API for animated WebP. This assembles already-encoded still frames into an
// animated RIFF container — container work only, no re-encoding, no deps.
// Spec: https://developers.google.com/speed/webp/docs/riff_container

const WEBP_FLAG_ALPHA = 0x10;
const WEBP_FLAG_ANIMATION = 0x02;

// ANMF flags: bit 1 = blending method (1 = do not blend), bit 0 = disposal.
// Frames are full-canvas keyframes, so overwriting avoids alpha accumulation.
const WEBP_ANMF_FLAGS = 0x02;

function webpFourCC(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function webpReadUint32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function webpWriteUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function webpWriteUint24LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

function webpChunk(tag, payload) {
  const padded = payload.length + (payload.length & 1);
  const chunk = new Uint8Array(8 + padded);
  for (let i = 0; i < 4; i++) chunk[i] = tag.charCodeAt(i);
  webpWriteUint32LE(chunk, 4, payload.length);
  chunk.set(payload, 8);
  return chunk;
}

/**
 * Extract the image payload (ALPH + VP8/VP8L chunks) of a still WebP file.
 * Handles both the simple formats and the extended (VP8X) one Chrome emits
 * when the canvas has an alpha channel.
 */
function parseStillWebP(bytes) {
  if (bytes.length < 12 || webpFourCC(bytes, 0) !== 'RIFF' || webpFourCC(bytes, 8) !== 'WEBP') {
    throw new Error('Not a WebP file');
  }

  const parts = [];
  let hasAlpha = false;
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const tag = webpFourCC(bytes, offset);
    const size = webpReadUint32LE(bytes, offset + 4);
    const padded = size + (size & 1);
    const chunk = bytes.subarray(offset, Math.min(offset + 8 + padded, bytes.length));

    if (tag === 'ALPH') {
      hasAlpha = true;
      parts.push(chunk);
    } else if (tag === 'VP8 ') {
      parts.push(chunk);
    } else if (tag === 'VP8L') {
      // VP8L header: signature byte, then 14b width-1, 14b height-1, 1b alpha_is_used
      const header = webpReadUint32LE(bytes, offset + 9);
      if ((header >>> 28) & 1) hasAlpha = true;
      parts.push(chunk);
    }

    offset += 8 + padded;
  }

  if (!parts.length) throw new Error('No image data found in WebP frame');
  return { parts, hasAlpha };
}

/**
 * Build an animated WebP from still WebP frames.
 * @param {Blob[]|Uint8Array[]|ArrayBuffer[]} frames - Still WebP frames, all the same size
 * @param {object} opts - { width, height, delay (ms per frame), loop (0 = infinite) }
 * @returns {Promise<Blob>} animated image/webp blob
 */
async function encodeAnimatedWebP(frames, opts = {}) {
  if (!frames || !frames.length) throw new Error('No frames to encode');

  const width = opts.width | 0;
  const height = opts.height | 0;
  const delay = Math.max(1, Math.round(opts.delay != null ? opts.delay : 50));
  const loop = opts.loop != null ? opts.loop : 0;

  if (width < 1 || height < 1 || width > 16384 || height > 16384) {
    throw new Error('Invalid canvas size for animated WebP');
  }

  const body = [];
  let hasAlpha = false;

  for (const frame of frames) {
    let bytes;
    if (frame instanceof Uint8Array) bytes = frame;
    else if (frame instanceof ArrayBuffer) bytes = new Uint8Array(frame);
    else bytes = new Uint8Array(await frame.arrayBuffer());

    const parsed = parseStillWebP(bytes);
    if (parsed.hasAlpha) hasAlpha = true;

    let payloadLength = 0;
    for (const p of parsed.parts) payloadLength += p.length;

    const anmf = new Uint8Array(16 + payloadLength);
    webpWriteUint24LE(anmf, 0, 0);              // frame X / 2
    webpWriteUint24LE(anmf, 3, 0);              // frame Y / 2
    webpWriteUint24LE(anmf, 6, width - 1);
    webpWriteUint24LE(anmf, 9, height - 1);
    webpWriteUint24LE(anmf, 12, delay);
    anmf[15] = WEBP_ANMF_FLAGS;

    let at = 16;
    for (const p of parsed.parts) { anmf.set(p, at); at += p.length; }

    body.push(webpChunk('ANMF', anmf));
  }

  const vp8x = new Uint8Array(10);
  vp8x[0] = WEBP_FLAG_ANIMATION | (hasAlpha ? WEBP_FLAG_ALPHA : 0);
  webpWriteUint24LE(vp8x, 4, width - 1);
  webpWriteUint24LE(vp8x, 7, height - 1);

  const anim = new Uint8Array(6);
  webpWriteUint32LE(anim, 0, 0x00000000);       // background colour (BGRA), transparent
  anim[4] = loop & 0xff;
  anim[5] = (loop >>> 8) & 0xff;

  const chunks = [webpChunk('VP8X', vp8x), webpChunk('ANIM', anim), ...body];

  let payloadLength = 4; // 'WEBP'
  for (const c of chunks) payloadLength += c.length;

  const file = new Uint8Array(8 + payloadLength);
  file[0] = 0x52; file[1] = 0x49; file[2] = 0x46; file[3] = 0x46; // 'RIFF'
  webpWriteUint32LE(file, 4, payloadLength);
  file[8] = 0x57; file[9] = 0x45; file[10] = 0x42; file[11] = 0x50; // 'WEBP'

  let at = 12;
  for (const c of chunks) { file.set(c, at); at += c.length; }

  return new Blob([file], { type: 'image/webp' });
}

/**
 * Feature test: does this browser encode still WebP from a canvas?
 */
async function canEncodeWebP() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.8));
    return !!blob && blob.type === 'image/webp';
  } catch {
    return false;
  }
}
