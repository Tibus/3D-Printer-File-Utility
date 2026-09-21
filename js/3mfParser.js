// ============================================================================
// 3MF Parser
// ============================================================================

// ============================================================================
// MMU Segmentation tree decoder (PrusaSlicer / Bambu Studio)
// ============================================================================

/**
 * Get the mmu_segmentation attribute from a triangle element.
 * Handles namespace variations.
 */
function getMmuSegmentationAttr(triangle) {
  let val = triangle.getAttribute('slic3rpe:mmu_segmentation');
  if (!val) val = triangle.getAttributeNS('http://schemas.slic3r.org/3mf/2017/06', 'mmu_segmentation');
  if (!val) val = triangle.getAttribute('paint_color');
  if (!val) {
    for (let a = 0; a < triangle.attributes.length; a++) {
      const attr = triangle.attributes[a];
      if (attr.localName === 'mmu_segmentation') { val = attr.value; break; }
    }
  }
  return val || '';
}

/**
 * Expand a triangle with mmu_segmentation subdivision data into sub-triangles.
 *
 * PrusaSlicer encoding: hex string is REVERSED. Each nibble (4 bits) encodes:
 *   - Low 2 bits: number of split sides (0=leaf, 1-3=split with 2-4 children)
 *   - High 2 bits: for leaves = state (0-2), for splits = special side index
 *   - If leaf high bits = 3: extended state, next nibble + 3
 *
 * State mapping: 0=unpainted (default), 1+=extruder index (1-based)
 *
 * Split types create midpoint vertices on edges:
 *   - 3 split sides (4 children): full quad subdivision (midpoints on all 3 edges)
 *   - 1 split side (2 children): bisect on one edge
 *   - 2 split sides (3 children): split on two edges
 */
function expandMmuTriangle(vi0, vi1, vi2, hexStr, vertices, colorMap, objColor, sharedMidCache) {
  // Read nibbles right-to-left (reversed encoding)
  const nibbles = [];
  for (let i = hexStr.length - 1; i >= 0; i--) {
    nibbles.push(parseInt(hexStr[i], 16));
  }

  const newFaces = [];
  const newFaceColors = [];
  let pos = 0;
  let truncated = false;   // ran out of nibbles: not a valid segmentation tree
  let painted = false;     // at least one leaf carries a paint state

  // Use shared midpoint cache to ensure adjacent triangles share midpoint vertices
  const midCache = sharedMidCache || new Map();
  const addedKeys = [];
  const vertexCountBefore = vertices.length;
  function midpoint(a, b) {
    const key = Math.min(a, b) + '_' + Math.max(a, b);
    if (midCache.has(key)) return midCache.get(key);
    const va = vertices[a], vb = vertices[b];
    const mid = {
      x: (va.x + vb.x) / 2, y: (va.y + vb.y) / 2, z: (va.z + vb.z) / 2,
      color: objColor ? objColor.clone() : new Color(0.8, 0.8, 0.8, 'default')
    };
    const idx = vertices.length;
    vertices.push(mid);
    midCache.set(key, idx);
    addedKeys.push(key);
    return idx;
  }

  function stateToColor(state) {
    if (state === 0) return objColor || new Color(0.8, 0.8, 0.8, 'default');
    // State N (1-based) → extruder N → colorMap[N-1] (0-based)
    const extIdx = state - 1;
    return colorMap.get(extIdx) || objColor || new Color(0.8, 0.8, 0.8, 'default');
  }

  function walk(i0, i1, i2, depth) {
    if (pos >= nibbles.length || depth > 12) {
      // Fallback: treat as unpainted leaf
      truncated = true;
      newFaces.push([i0, i1, i2]);
      newFaceColors.push(objColor || new Color(0.8, 0.8, 0.8, 'default'));
      return;
    }

    const nib = nibbles[pos++];
    const splitSides = nib & 3;
    const high = (nib >> 2) & 3;

    if (splitSides === 0) {
      // Leaf node
      let state;
      if (high < 3) {
        state = high;
      } else {
        // Extended state: the 0b11 marker is followed by 4-bit groups, each
        // full group (0xF) meaning "+15, read another one" (see serialize()).
        state = 3;
        let group;
        do {
          if (pos >= nibbles.length) { truncated = true; break; }
          group = nibbles[pos++];
          state += group;
        } while (group === 15);
      }
      if (state > 0) painted = true;
      const color = stateToColor(state);
      newFaces.push([i0, i1, i2]);
      newFaceColors.push(color);
    } else if (splitSides === 3) {
      // Quad split: 4 children. Stream order is reversed: child[3], child[2], child[1], child[0]
      const m01 = midpoint(i0, i1);
      const m12 = midpoint(i1, i2);
      const m20 = midpoint(i2, i0);
      walk(m01, m12, m20, depth + 1);  // child[3] = center (1st in stream)
      walk(m12, i2, m20, depth + 1);   // child[2] = corner v2
      walk(m01, i1, m12, depth + 1);   // child[1] = corner v1
      walk(i0, m01, m20, depth + 1);   // child[0] = corner v0 (last in stream)
    } else if (splitSides === 1) {
      // 1 split side (2 children). special_side (high) determines which edge to split.
      // After vertex rotation by special_side, midpoint is always on edge v1-v2.
      // Stream order is reversed: child[1] first, child[0] second.
      if (high === 0) {
        // special_side=0: split edge i1-i2
        const m = midpoint(i1, i2);
        walk(m, i2, i0, depth + 1);    // child[1]
        walk(i0, i1, m, depth + 1);    // child[0]
      } else if (high === 1) {
        // special_side=1: split edge i2-i0
        const m = midpoint(i2, i0);
        walk(m, i0, i1, depth + 1);    // child[1]
        walk(i1, i2, m, depth + 1);    // child[0]
      } else {
        // special_side=2: split edge i0-i1
        const m = midpoint(i0, i1);
        walk(m, i1, i2, depth + 1);    // child[1]
        walk(i2, i0, m, depth + 1);    // child[0]
      }
    } else {
      // 2 split sides (3 children). Stream order reversed: child[2], child[1], child[0]
      if (high === 0) {
        // special_side=0: split i0-i1 and i2-i0
        const m01 = midpoint(i0, i1);
        const m20 = midpoint(i2, i0);
        walk(i1, i2, m20, depth + 1);  // child[2]
        walk(m01, i1, m20, depth + 1); // child[1]
        walk(i0, m01, m20, depth + 1); // child[0]
      } else if (high === 1) {
        // special_side=1: split i1-i2 and i0-i1
        const m12 = midpoint(i1, i2);
        const m01 = midpoint(i0, i1);
        walk(i2, i0, m01, depth + 1);  // child[2]
        walk(m12, i2, m01, depth + 1); // child[1]
        walk(i1, m12, m01, depth + 1); // child[0]
      } else {
        // special_side=2: split i2-i0 and i1-i2
        const m20 = midpoint(i2, i0);
        const m12 = midpoint(i1, i2);
        walk(i0, i1, m12, depth + 1);  // child[2]
        walk(m20, i0, m12, depth + 1); // child[1]
        walk(i2, m20, m12, depth + 1); // child[0]
      }
    }
  }

  walk(vi0, vi1, vi2, 0);

  // A well-formed tree consumes every nibble: the writer emits 4 or 8 bits per
  // node, so a leftover (or a truncated walk) means this string is not a
  // segmentation tree and the caller should fall back to a whole-face decode.
  const valid = !truncated && pos === nibbles.length;
  if (!valid) {
    // Undo the midpoints this walk allocated: a string that is not a tree must
    // not leave phantom vertices in the shared cache, or the T-junction pass
    // would split neighbouring triangles against them.
    for (const key of addedKeys) midCache.delete(key);
    vertices.length = vertexCountBefore;
  }
  return { faces: newFaces, faceColors: newFaceColors, valid, painted };
}

/**
 * Get dominant color from a long mmu_segmentation hex string (fallback).
 * Counts base-4 digit occurrences and returns the most common painted state.
 */
function decodeMmuSegmentationDominant(hexStr, colorMap, objColor) {
  // Read nibbles reversed, walk tree, count leaf states
  const nibbles = [];
  for (let i = hexStr.length - 1; i >= 0; i--) {
    nibbles.push(parseInt(hexStr[i], 16));
  }

  const stateCounts = {};
  let pos = 0;

  function walk() {
    if (pos >= nibbles.length) return;
    const nib = nibbles[pos++];
    const splitSides = nib & 3;
    const high = (nib >> 2) & 3;

    if (splitSides === 0) {
      let state = high < 3 ? high : (pos < nibbles.length ? nibbles[pos++] + 3 : 0);
      stateCounts[state] = (stateCounts[state] || 0) + 1;
    } else {
      const numChildren = splitSides + 1;
      for (let c = 0; c < numChildren; c++) walk();
    }
  }

  walk();

  // Find dominant non-zero state (state 0 = unpainted)
  let maxCount = 0, dominant = 0;
  for (const [state, count] of Object.entries(stateCounts)) {
    const s = parseInt(state);
    if (s > 0 && count > maxCount) { maxCount = count; dominant = s; }
  }

  if (dominant > 0) {
    const extIdx = dominant - 1;
    return colorMap.get(extIdx) || objColor || null;
  }
  return null;
}

/**
 * Decode a paint_color / mmu_segmentation hex value to a 0-based filament index.
 *
 * The encoding is a base-4 trit tree used by Bambu Studio and PrusaSlicer:
 *   - d1 values 1-3 map to extruders 1-3 (indices 0-2)
 *   - When d1=3 and higher digits exist, they encode extruders 4+
 *     (d2=1 → index 3, d2=2 → index 4, d2=3 → index 5 or continue, etc.)
 *
 * A static lookup covers all standard whole-face paint values (up to 8 extruders).
 * A general trit-walk fallback handles other values.
 */
function decodePaintColorIndex(hexStr) {
  const value = parseInt(hexStr, 16);
  if (isNaN(value) || value <= 0 || value == Infinity) return -1;

  // Static reverse lookup for known whole-face paint values
  // These match the mmu encoding used by Bambu Studio / PrusaSlicer / our export
  const KNOWN = { 1: 0, 4: 0, 8: 1, 12: 2, 28: 3, 44: 4, 60: 5, 76: 6 };
  if (value in KNOWN) return KNOWN[value];

  // Fallback: general base-4 trit tree decode
  // Extract digits, walk from d1 upward while digit==3 (continuation flag)
  const digits = [];
  let v = value;
  while (v > 0) {
    digits.push(v % 4);
    v = Math.floor(v / 4);
  }

  if (digits.length <= 1) return digits[0] > 0 ? digits[0] - 1 : -1;

  let level = 1;
  while (level < digits.length - 1 && digits[level] === 3) {
    level++;
  }

  const digit = digits[level];
  if (digit <= 0) return -1;

  return 3 * (level - 1) + digit - 1;
}

/**
 * Parse a 3MF file (ZIP containing XML model data)
 * Handles both simple 3MF (mesh in main model) and Bambu/Prusa style
 * (components referencing sub-model files)
 * @param {ArrayBuffer} buffer - The 3MF file as ArrayBuffer
 * @returns {Promise<Object>} { vertices, faces }
 */
async function parse3MF(buffer) {
  const zip = await JSZip.loadAsync(buffer);

  // Try to load filament colors from project settings config
  const filamentColors = await parseProjectSettings(zip);

  // Try to load per-part extruder assignments from model settings config
  const partExtruderMap = await parseModelSettings(zip);

  // Find and parse all .model files in the archive
  const modelFiles = new Map();
  const filenames = Object.keys(zip.files);
  for (const filename of filenames) {
    if (filename.toLowerCase().endsWith('.model')) {
      const content = await zip.files[filename].async('text');
      // Normalize path: remove leading slash, use forward slashes
      const normalizedPath = '/' + filename.replace(/^\//, '');
      modelFiles.set(normalizedPath, content);
      modelFiles.set(filename, content);
    }
  }

  if (modelFiles.size === 0) {
    throw new Error('No .model file found in 3MF archive');
  }

  // Find the main model file (usually 3D/3dmodel.model)
  let mainModelContent = null;
  for (const [path, content] of modelFiles) {
    if (path.toLowerCase().includes('3dmodel.model')) {
      mainModelContent = content;
      break;
    }
  }
  // Fallback: use first .model file found
  if (!mainModelContent) {
    mainModelContent = modelFiles.values().next().value;
  }

  return parseModelXML(mainModelContent, filamentColors, modelFiles, partExtruderMap);
}

/**
 * Parse filament colors from Metadata/project_settings.config
 * @param {JSZip} zip - The unzipped 3MF archive
 * @returns {Promise<Color[]>} Array of filament colors
 */
async function parseProjectSettings(zip) {
  // 1. Bambu Studio: project_settings.config (JSON with filament_colour array)
  const bambuConfigNames = [
    'Metadata/project_settings.config',
    'metadata/project_settings.config'
  ];

  for (const name of bambuConfigNames) {
    const file = zip.files[name];
    if (file) {
      try {
        const content = await file.async('text');
        const config = JSON.parse(content);
        if (config.filament_colour && Array.isArray(config.filament_colour)) {
          return config.filament_colour
            .map(hex => parse3MFColorString(hex))
            .filter(c => c !== null);
        }
      } catch (e) {
        console.warn('Failed to parse project_settings.config:', e);
      }
    }
  }

  // 2. PrusaSlicer: Slic3r_PE.config (INI-style with extruder_colour = #HEX;#HEX;...)
  const prusaConfigNames = [
    'Metadata/Slic3r_PE.config',
    'metadata/Slic3r_PE.config',
    'Metadata/slic3r_pe.config'
  ];

  for (const name of prusaConfigNames) {
    const file = zip.files[name];
    if (file) {
      try {
        const content = await file.async('text');
        // Match extruder_colour (may be commented with '; ' prefix in PrusaSlicer config)
        const match = content.match(/^;?\s*extruder_colour\s*=\s*(.+)$/m);
        if (match) {
          const colors = match[1].trim().split(';')
            .map(hex => parse3MFColorString(hex.trim()))
            .filter(c => c !== null);
          if (colors.length > 0) return colors;
        }
      } catch (e) {
        console.warn('Failed to parse Slic3r_PE.config:', e);
      }
    }
  }

  return [];
}

/**
 * Parse per-part extruder assignments from Metadata/model_settings.config
 * @param {JSZip} zip - The unzipped 3MF archive
 * @returns {Promise<Map<string, number>>} Map of partId -> extruder index (1-based)
 */
async function parseModelSettings(zip) {
  const partExtruderMap = new Map();

  // 1. Bambu Studio: model_settings.config with <part id="N"><metadata key="extruder" value="M"/>
  const bambuNames = [
    'Metadata/model_settings.config',
    'metadata/model_settings.config'
  ];

  for (const name of bambuNames) {
    const file = zip.files[name];
    if (file) {
      try {
        const content = await file.async('text');
        const parser = new DOMParser();
        const doc = parser.parseFromString(content, 'application/xml');
        const parts = doc.getElementsByTagName('part');
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const partId = part.getAttribute('id');
          if (!partId) continue;
          const metadatas = part.getElementsByTagName('metadata');
          for (let j = 0; j < metadatas.length; j++) {
            const meta = metadatas[j];
            if (meta.getAttribute('key') === 'extruder') {
              const extruder = parseInt(meta.getAttribute('value') || meta.textContent);
              if (!isNaN(extruder)) {
                partExtruderMap.set(partId, extruder);
              }
            }
          }
        }
        if (partExtruderMap.size > 0) return partExtruderMap;
      } catch (e) {
        console.warn('Failed to parse model_settings.config:', e);
      }
    }
  }

  // 2. PrusaSlicer: Slic3r_PE_model.config with <object id="N"><metadata type="object" key="extruder" value="M"/>
  const prusaNames = [
    'Metadata/Slic3r_PE_model.config',
    'metadata/Slic3r_PE_model.config'
  ];

  for (const name of prusaNames) {
    const file = zip.files[name];
    if (file) {
      try {
        const content = await file.async('text');
        const parser = new DOMParser();
        const doc = parser.parseFromString(content, 'application/xml');
        const objects = doc.getElementsByTagName('object');
        for (let i = 0; i < objects.length; i++) {
          const obj = objects[i];
          const objId = obj.getAttribute('id');
          if (!objId) continue;
          // Only look at direct child metadata with type="object"
          const metadatas = obj.getElementsByTagName('metadata');
          for (let j = 0; j < metadatas.length; j++) {
            const meta = metadatas[j];
            if (meta.getAttribute('type') === 'object' && meta.getAttribute('key') === 'extruder') {
              const extruder = parseInt(meta.getAttribute('value') || meta.textContent);
              if (!isNaN(extruder) && extruder > 0) {
                partExtruderMap.set(objId, extruder);
              }
            }
          }
        }
        if (partExtruderMap.size > 0) return partExtruderMap;
      } catch (e) {
        console.warn('Failed to parse Slic3r_PE_model.config:', e);
      }
    }
  }

  return partExtruderMap;
}

/**
 * Parse the XML model content
 * @param {string} xmlContent - The XML content of the main .model file
 * @param {Color[]} filamentColors - Filament colors from project settings
 * @param {Map<string,string>} modelFiles - All .model files keyed by path
 * @param {Map<string,number>} partExtruderMap - Per-part extruder assignments (partId -> 1-based extruder index)
 * @returns {Object} { vertices, faces }
 */
function parseModelXML(xmlContent, filamentColors = [], modelFiles = new Map(), partExtruderMap = new Map()) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlContent, 'application/xml');
  const ns = detect3MFNamespace(doc);

  // Build color map from all available sources
  const colorMap = buildColorMap(doc, ns, filamentColors);

  // Parse all objects from this document into a lookup by ID
  const objectsById = parseObjectsFromDoc(doc, ns, colorMap, filamentColors, partExtruderMap);

  // Check if main model uses components referencing sub-models
  const components = findComponents(doc, ns);

  if (components.length > 0 && modelFiles.size > 0) {
    // Parse referenced sub-model files and collect their objects
    const subObjectsById = new Map();
    const parsedSubModels = new Set();

    for (const comp of components) {
      const subPath = comp.path;
      if (subPath && !parsedSubModels.has(subPath)) {
        const subContent = modelFiles.get(subPath) || modelFiles.get(subPath.replace(/^\//, ''));
        if (subContent) {
          const subDoc = parser.parseFromString(subContent, 'application/xml');
          const subNs = detect3MFNamespace(subDoc);
          const subColorMap = buildColorMap(subDoc, subNs, filamentColors);
          // Merge sub color map into main if main is empty
          if (colorMap.size === 0) {
            for (const [k, v] of subColorMap) colorMap.set(k, v);
          }
          const subObjects = parseObjectsFromDoc(subDoc, subNs, colorMap.size > 0 ? colorMap : subColorMap, filamentColors, partExtruderMap);
          for (const [id, obj] of subObjects) {
            subObjectsById.set(id, obj);
          }
          parsedSubModels.add(subPath);
        }
      }
    }

    // Assemble model from components
    return assembleFromComponents(components, objectsById, subObjectsById);
  }

  // No components - use objects directly from the main document
  if (objectsById.size === 0) {
    throw new Error('No mesh found in 3MF model');
  }

  // Parse build items to get per-object transforms
  const buildItems = parseBuildItems(doc, ns);

  return mergeObjects(objectsById, buildItems);
}

/**
 * Detect the 3MF namespace used in the document
 */
function detect3MFNamespace(doc) {
  const namespaces = [
    'http://schemas.microsoft.com/3dmanufacturing/core/2015/02',
    'http://schemas.microsoft.com/3dmanufacturing/core/2018',
    ''
  ];

  for (const ns of namespaces) {
    const meshes = ns === '' ? doc.getElementsByTagName('mesh') : doc.getElementsByTagNameNS(ns, 'mesh');
    if (meshes.length > 0) return ns;
    // Also check for objects (which may contain components instead of meshes)
    const objects = ns === '' ? doc.getElementsByTagName('object') : doc.getElementsByTagNameNS(ns, 'object');
    if (objects.length > 0) return ns;
  }

  return namespaces[0]; // Default
}

/**
 * Build color map from all available sources in a document
 */
function buildColorMap(doc, ns, filamentColors) {
  const colorMap = new Map();

  parseBaseMaterials(doc, ns, colorMap);
  parseColorGroups(doc, ns, colorMap);

  // If no colors found from XML, use filament colors from project settings
  if (colorMap.size === 0 && filamentColors.length > 0) {
    for (let i = 0; i < filamentColors.length; i++) {
      colorMap.set(i, filamentColors[i]);
      colorMap.set(String(i), filamentColors[i]);
    }
  }

  return colorMap;
}

/**
 * Parse all objects with meshes from a document, indexed by object ID
 * @param {Document} doc
 * @param {string} ns
 * @param {Map} colorMap
 * @param {Color[]} filamentColors - Filament colors from project settings
 * @param {Map<string,number>} partExtruderMap - Per-part extruder assignments (partId -> 1-based extruder index)
 * @returns {Map<string, {vertices: Array, faces: Array}>}
 */
function parseObjectsFromDoc(doc, ns, colorMap, filamentColors = [], partExtruderMap = new Map()) {
  const objects = ns === '' ? doc.getElementsByTagName('object') : doc.getElementsByTagNameNS(ns, 'object');
  const result = new Map();

  // Get global default color
  let globalDefaultColor = colorMap.has(0) ? colorMap.get(0) : null;
  for (let objIdx = 0; objIdx < objects.length; objIdx++) {
    const obj = objects[objIdx];
    const objId = obj.getAttribute('id');
    if (!objId) continue;

    // Determine per-object default color:
    // 1. Per-part extruder from model_settings.config (Bambu/Prusa style)
    // 2. Object-level pid/pindex attribute
    // 3. Global default (filament_colour[0])
    let objColor = globalDefaultColor;

    if (partExtruderMap.has(objId) && filamentColors.length > 0) {
      const extruder = partExtruderMap.get(objId); // 1-based
      const filamentIdx = extruder - 1; // 0-based
      if (filamentIdx >= 0 && filamentIdx < filamentColors.length) {
        objColor = filamentColors[filamentIdx];
      }
    }

    const pid = obj.getAttribute('pid');
    const pindex = obj.getAttribute('pindex');
    if (pid && pindex !== null) {
      const colorKey = `${pid}_${pindex}`;
      if (colorMap.has(colorKey)) {
        objColor = colorMap.get(colorKey);
      } else if (colorMap.has(parseInt(pindex))) {
        objColor = colorMap.get(parseInt(pindex));
      }
    }

    // Find mesh in this object
    const meshes = ns === '' ? obj.getElementsByTagName('mesh') : obj.getElementsByTagNameNS(ns, 'mesh');
    if (meshes.length === 0) continue;

    const mesh = meshes[0];
    const vertices = [];
    let faces = [];
    let faceColors = [];

    // Parse vertices
    const verticesEl = ns === ''
      ? mesh.getElementsByTagName('vertices')[0]
      : mesh.getElementsByTagNameNS(ns, 'vertices')[0];

    const vertexEls = verticesEl
      ? (ns === '' ? verticesEl.getElementsByTagName('vertex') : verticesEl.getElementsByTagNameNS(ns, 'vertex'))
      : [];

    for (let i = 0; i < vertexEls.length; i++) {
      const v = vertexEls[i];
      const x = parseFloat(v.getAttribute('x')) || 0;
      const y = parseFloat(v.getAttribute('y')) || 0;
      const z = parseFloat(v.getAttribute('z')) || 0;

      const color = objColor
        ? objColor.clone()
        : new Color(0.8, 0.8, 0.8, 'default');

      vertices.push({ x, y, z, color });
    }

    // Parse triangles
    const trianglesEl = ns === ''
      ? mesh.getElementsByTagName('triangles')[0]
      : mesh.getElementsByTagNameNS(ns, 'triangles')[0];

    const triangleEls = trianglesEl
      ? (ns === '' ? trianglesEl.getElementsByTagName('triangle') : trianglesEl.getElementsByTagNameNS(ns, 'triangle'))
      : [];

    // Shared midpoint cache across all triangles so adjacent subdivisions share vertices
    const sharedMidCache = new Map();

    for (let i = 0; i < triangleEls.length; i++) {
      const t = triangleEls[i];
      const v1 = parseInt(t.getAttribute('v1')) || 0;
      const v2 = parseInt(t.getAttribute('v2')) || 0;
      const v3 = parseInt(t.getAttribute('v3')) || 0;

      // Check for mmu_segmentation data. The string length says nothing about
      // whether the triangle is subdivided — a single split encodes in 3 chars,
      // shorter than some whole-face values — so decode the tree and let it
      // report whether it made sense of the string.
      const mmuSeg = getMmuSegmentationAttr(t);
      if (mmuSeg) {
        const expanded = expandMmuTriangle(v1, v2, v3, mmuSeg, vertices, colorMap, objColor, sharedMidCache);
        if (expanded.valid && (expanded.painted || expanded.faces.length > 1)) {
          for (let j = 0; j < expanded.faces.length; j++) {
            faces.push(expanded.faces[j]);
            faceColors.push(expanded.faceColors[j]);
          }
          continue;
        }
        // Not a tree (or nothing painted): fall through to the flat decode,
        // which also covers pid/p1 material colours.
      }

      let faceColor = getTriangleColor(t, colorMap);
      const effectiveColor = faceColor || objColor || new Color(0.8, 0.8, 0.8, 'default');

      faceColors.push(effectiveColor);
      faces.push([v1, v2, v3]);
    }

    // T-junction fix: split non-subdivided triangles that have midpoints on their edges
    if (sharedMidCache.size > 0) {
      const fixedFaces = [];
      const fixedFaceColors = [];

      for (let i = 0; i < faces.length; i++) {
        const face = faces[i];
        const fc = faceColors[i];
        const [a, b, c] = face;

        // Check which edges have midpoints from subdivision
        const mAB = sharedMidCache.get(Math.min(a, b) + '_' + Math.max(a, b));
        const mBC = sharedMidCache.get(Math.min(b, c) + '_' + Math.max(b, c));
        const mCA = sharedMidCache.get(Math.min(c, a) + '_' + Math.max(c, a));

        const splits = (mAB !== undefined ? 1 : 0) + (mBC !== undefined ? 1 : 0) + (mCA !== undefined ? 1 : 0);

        if (splits === 0) {
          // No midpoints on edges, keep as-is
          fixedFaces.push(face);
          fixedFaceColors.push(fc);
        } else if (splits === 3) {
          // All 3 edges have midpoints: 4 sub-triangles
          fixedFaces.push([a, mAB, mCA]);
          fixedFaces.push([mAB, b, mBC]);
          fixedFaces.push([mCA, mBC, c]);
          fixedFaces.push([mAB, mBC, mCA]);
          for (let k = 0; k < 4; k++) fixedFaceColors.push(fc);
        } else if (splits === 1) {
          // 1 edge has a midpoint: 2 sub-triangles
          if (mAB !== undefined) {
            fixedFaces.push([a, mAB, c]);
            fixedFaces.push([mAB, b, c]);
          } else if (mBC !== undefined) {
            fixedFaces.push([a, b, mBC]);
            fixedFaces.push([a, mBC, c]);
          } else {
            fixedFaces.push([a, b, mCA]);
            fixedFaces.push([mCA, b, c]);
          }
          fixedFaceColors.push(fc);
          fixedFaceColors.push(fc);
        } else {
          // 2 edges have midpoints: 3 sub-triangles
          if (mAB !== undefined && mBC !== undefined) {
            fixedFaces.push([a, mAB, c]);
            fixedFaces.push([mAB, b, mBC]);
            fixedFaces.push([mAB, mBC, c]);
          } else if (mBC !== undefined && mCA !== undefined) {
            fixedFaces.push([a, b, mBC]);
            fixedFaces.push([a, mBC, mCA]);
            fixedFaces.push([mBC, c, mCA]);
          } else {
            fixedFaces.push([a, mAB, mCA]);
            fixedFaces.push([mAB, b, c]);
            fixedFaces.push([mAB, c, mCA]);
          }
          for (let k = 0; k < 3; k++) fixedFaceColors.push(fc);
        }
      }

      faces = fixedFaces;
      faceColors = fixedFaceColors;
    }

    // Set vertex colors from face colors
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      const fc = faceColors[i];
      if (fc) {
        for (const vi of f) {
          if (vertices[vi]) vertices[vi].color = fc.clone();
        }
      }
    }

    result.set(objId, { vertices, faces, faceColors });
  }

  return result;
}

/**
 * Find all component references in the document, with build item transforms
 * properly composed per-object.
 * @returns {Array<{path: string, objectid: string, transform: number[]|null}>}
 */
function findComponents(doc, ns) {
  const components = [];
  const pNs = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

  // Map build item objectid -> transform
  const buildTransformMap = new Map();
  const buildItemEls = ns === ''
    ? doc.getElementsByTagName('item')
    : doc.getElementsByTagNameNS(ns, 'item');
  for (let i = 0; i < buildItemEls.length; i++) {
    const item = buildItemEls[i];
    const objectid = item.getAttribute('objectid');
    const transformStr = item.getAttribute('transform');
    if (objectid && transformStr) {
      buildTransformMap.set(objectid, parseTransform(transformStr));
    }
  }

  // Find components per object, composing with their parent's build transform
  const objects = ns === '' ? doc.getElementsByTagName('object') : doc.getElementsByTagNameNS(ns, 'object');

  for (let oi = 0; oi < objects.length; oi++) {
    const obj = objects[oi];
    const objId = obj.getAttribute('id');
    const buildTransform = buildTransformMap.get(objId) || null;

    const compEls = ns === ''
      ? obj.getElementsByTagName('component')
      : obj.getElementsByTagNameNS(ns, 'component');

    for (let i = 0; i < compEls.length; i++) {
      const el = compEls[i];
      const path = el.getAttributeNS(pNs, 'path') || el.getAttribute('p:path') || el.getAttribute('path') || '';
      const objectid = el.getAttribute('objectid') || '';
      const transformStr = el.getAttribute('transform');
      const compTransform = transformStr ? parseTransform(transformStr) : null;

      // Compose: vertex * compTransform * buildTransform
      let finalTransform;
      if (compTransform && buildTransform) {
        finalTransform = multiplyTransforms(compTransform, buildTransform);
      } else if (buildTransform) {
        finalTransform = buildTransform;
      } else {
        finalTransform = compTransform;
      }

      components.push({ path, objectid, transform: finalTransform });
    }
  }

  return components;
}

/**
 * Parse a 3MF transform string (12 numbers: 3x4 affine matrix)
 * Format: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32
 * @returns {number[]} 12-element array
 */
function parseTransform(str) {
  const nums = str.trim().split(/\s+/).map(Number);
  if (nums.length !== 12) return null;
  return nums;
}

/**
 * Multiply two 3MF transforms (A * B)
 * Each is [m00,m01,m02, m10,m11,m12, m20,m21,m22, m30,m31,m32]
 */
function multiplyTransforms(a, b) {
  // 3MF 4x4 matrix (row-vector convention: [x,y,z,1] * M):
  // | m00 m01 m02 0 |     transform[0..2]  = row 0
  // | m10 m11 m12 0 |     transform[3..5]  = row 1
  // | m20 m21 m22 0 |     transform[6..8]  = row 2
  // | m30 m31 m32 1 |     transform[9..11] = translation

  // Expand to 4x4 matrices
  const a4 = [
    a[0], a[1], a[2], 0,
    a[3], a[4], a[5], 0,
    a[6], a[7], a[8], 0,
    a[9], a[10], a[11], 1
  ];
  const b4 = [
    b[0], b[1], b[2], 0,
    b[3], b[4], b[5], 0,
    b[6], b[7], b[8], 0,
    b[9], b[10], b[11], 1
  ];

  // C = A * B (4x4)
  const c4 = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      for (let k = 0; k < 4; k++) {
        c4[i * 4 + j] += a4[i * 4 + k] * b4[k * 4 + j];
      }
    }
  }

  return [c4[0], c4[1], c4[2], c4[4], c4[5], c4[6], c4[8], c4[9], c4[10], c4[12], c4[13], c4[14]];
}

/**
 * Apply a 3MF transform to a vertex (in-place)
 * 3MF uses row-vector convention: [x,y,z,1] * M
 */
function applyTransform(vertex, transform) {
  if (!transform) return;
  const x = vertex.x, y = vertex.y, z = vertex.z;
  // [x,y,z,1] * M where M is:
  // | m00 m01 m02 0 |
  // | m10 m11 m12 0 |
  // | m20 m21 m22 0 |
  // | m30 m31 m32 1 |
  vertex.x = x * transform[0] + y * transform[3] + z * transform[6] + transform[9];
  vertex.y = x * transform[1] + y * transform[4] + z * transform[7] + transform[10];
  vertex.z = x * transform[2] + y * transform[5] + z * transform[8] + transform[11];
}

/**
 * Assemble final model from component references
 */
function assembleFromComponents(components, mainObjects, subObjects) {
  const allVertices = [];
  const allFaces = [];
  const allFaceColors = [];

  for (const comp of components) {
    // Look up the referenced object
    const obj = subObjects.get(comp.objectid) || mainObjects.get(comp.objectid);
    if (!obj) {
      console.warn(`3MF: Component references object ${comp.objectid} but it was not found`);
      continue;
    }

    // Clone vertices and apply transform
    const startOffset = allVertices.length;
    for (const v of obj.vertices) {
      const newV = { x: v.x, y: v.y, z: v.z, color: v.color ? v.color.clone() : null };
      if (comp.transform) {
        applyTransform(newV, comp.transform);
      }
      allVertices.push(newV);
    }

    // Add faces with adjusted indices
    for (const face of obj.faces) {
      allFaces.push([face[0] + startOffset, face[1] + startOffset, face[2] + startOffset]);
    }

    // Add per-face colors
    if (obj.faceColors) {
      for (const color of obj.faceColors) {
        allFaceColors.push(color);
      }
    }
  }

  if (allVertices.length === 0) {
    throw new Error('No mesh found in 3MF model');
  }

  return { vertices: allVertices, faces: allFaces, faceColors: allFaceColors };
}

/**
 * Parse build items from the <build> section
 * @returns {Map<string, number[]|null>} Map of objectid -> transform
 */
function parseBuildItems(doc, ns) {
  const buildItems = new Map();
  const itemEls = ns === ''
    ? doc.getElementsByTagName('item')
    : doc.getElementsByTagNameNS(ns, 'item');

  for (let i = 0; i < itemEls.length; i++) {
    const item = itemEls[i];
    const objectid = item.getAttribute('objectid');
    if (!objectid) continue;
    const transformStr = item.getAttribute('transform');
    buildItems.set(objectid, transformStr ? parseTransform(transformStr) : null);
  }

  return buildItems;
}

/**
 * Merge all objects into a single mesh (for simple 3MF without components)
 * @param {Map} objectsById - Objects indexed by ID
 * @param {Map} buildItems - Build item transforms indexed by object ID
 */
function mergeObjects(objectsById, buildItems = new Map()) {
  const allVertices = [];
  const allFaces = [];
  const allFaceColors = [];

  for (const [id, obj] of objectsById) {
    const startOffset = allVertices.length;
    const transform = buildItems.get(id) || null;

    for (const v of obj.vertices) {
      const newV = { x: v.x, y: v.y, z: v.z, color: v.color };
      if (transform) {
        applyTransform(newV, transform);
      }
      allVertices.push(newV);
    }
    for (const face of obj.faces) {
      allFaces.push([face[0] + startOffset, face[1] + startOffset, face[2] + startOffset]);
    }
    if (obj.faceColors) {
      for (const color of obj.faceColors) {
        allFaceColors.push(color);
      }
    }
  }

  return { vertices: allVertices, faces: allFaces, faceColors: allFaceColors };
}

// ============================================================================
// Color parsing helpers
// ============================================================================

/**
 * Parse basematerials elements
 */
function parseBaseMaterials(doc, ns, colorMap) {
  const baseMaterialsList = ns === ''
    ? doc.getElementsByTagName('basematerials')
    : doc.getElementsByTagNameNS(ns, 'basematerials');

  for (let m = 0; m < baseMaterialsList.length; m++) {
    const materials = baseMaterialsList[m];
    const materialsId = materials.getAttribute('id') || '0';

    const bases = ns === ''
      ? materials.getElementsByTagName('base')
      : materials.getElementsByTagNameNS(ns, 'base');

    for (let i = 0; i < bases.length; i++) {
      const base = bases[i];
      const displayColor = base.getAttribute('displaycolor');
      if (displayColor) {
        const color = parse3MFColorString(displayColor);
        if (color) {
          colorMap.set(i, color);
          colorMap.set(`${materialsId}_${i}`, color);
          colorMap.set(String(i), color);
        }
      }
    }
  }
}

/**
 * Parse colorgroup elements (Bambu/Prusa style)
 */
function parseColorGroups(doc, ns, colorMap) {
  const materialNs = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';

  let colorGroups = doc.getElementsByTagNameNS(materialNs, 'colorgroup');
  if (colorGroups.length === 0) {
    colorGroups = doc.getElementsByTagName('colorgroup');
  }

  for (let g = 0; g < colorGroups.length; g++) {
    const group = colorGroups[g];
    const groupId = group.getAttribute('id') || '0';

    let colors = group.getElementsByTagNameNS(materialNs, 'color');
    if (colors.length === 0) {
      colors = group.getElementsByTagName('color');
    }

    for (let i = 0; i < colors.length; i++) {
      const colorEl = colors[i];
      const colorValue = colorEl.getAttribute('color');
      if (colorValue) {
        const color = parse3MFColorString(colorValue);
        if (color) {
          colorMap.set(i, color);
          colorMap.set(`${groupId}_${i}`, color);
        }
      }
    }
  }
}

/**
 * Get color for a triangle from various attributes
 */
function getTriangleColor(triangle, colorMap) {
  // 1. paint_color (Bambu style - hex-encoded base-4 trit tree)
  const paintColor = triangle.getAttribute('paint_color');
  if (paintColor) {
    const idx = decodePaintColorIndex(paintColor);
    if (idx >= 0 && colorMap.has(idx)) return colorMap.get(idx);
  }

  // 2. slic3rpe:mmu_segmentation (PrusaSlicer/Bambu style - same encoding)
  let mmuSeg = triangle.getAttribute('slic3rpe:mmu_segmentation');
  if (!mmuSeg) mmuSeg = triangle.getAttributeNS('http://schemas.slic3r.org/3mf/2017/06', 'mmu_segmentation');
  // Fallback: scan attributes for mmu_segmentation (handles namespace prefix variations)
  if (!mmuSeg) {
    for (let a = 0; a < triangle.attributes.length; a++) {
      const attr = triangle.attributes[a];
      if (attr.localName === 'mmu_segmentation') {
        mmuSeg = attr.value;
        break;
      }
    }
  }
  if (mmuSeg) {
    const idx = decodePaintColorIndex(mmuSeg);
    if (idx >= 0 && colorMap.has(idx)) return colorMap.get(idx);
  }

  // 3. pid + p1 (standard 3MF)
  const pid = triangle.getAttribute('pid');
  const p1 = triangle.getAttribute('p1');

  if (p1 !== null) {
    const idx = parseInt(p1);
    if (pid && colorMap.has(`${pid}_${idx}`)) {
      return colorMap.get(`${pid}_${idx}`);
    }
    if (colorMap.has(idx)) {
      return colorMap.get(idx);
    }
  }

  return null;
}

/**
 * Parse a color string (hex format like #RRGGBB or #RRGGBBAA)
 * @param {string} colorStr - Color string
 * @returns {Color|null}
 */
function parse3MFColorString(colorStr) {
  if (!colorStr) return null;

  let hex = colorStr.replace('#', '');

  if (hex.length === 6) {
    const r = parseInt(hex.substr(0, 2), 16) / 255;
    const g = parseInt(hex.substr(2, 2), 16) / 255;
    const b = parseInt(hex.substr(4, 2), 16) / 255;
    return new Color(r, g, b, colorStr);
  } else if (hex.length === 8) {
    const r = parseInt(hex.substr(0, 2), 16) / 255;
    const g = parseInt(hex.substr(2, 2), 16) / 255;
    const b = parseInt(hex.substr(4, 2), 16) / 255;
    return new Color(r, g, b, colorStr);
  }

  return null;
}
