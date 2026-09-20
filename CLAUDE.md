# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

3D Printer File Utility is a client-side web application with tools for 3D printing workflows. It includes a 3D file viewer and a color converter that reduces vertex colors to a limited palette (e.g., multi-material printing on Bambu Lab or Prusa printers).

**Technology Stack**: Vanilla JavaScript (ES6+), HTML5, CSS3. No build step required - this is a pure static site.

## Development

This is a static web application with no build process. To develop:

1. Open `index.html` directly in a browser, or
2. Use any local HTTP server (e.g., `python -m http.server 8000`)

The application runs entirely in the browser - all OBJ parsing and color processing happens client-side.

## Deployment

The site auto-deploys to GitHub Pages via `.github/workflows/static.yml` on every push to `main`. The workflow uploads the entire repository root as-is (no build step).

## Architecture

### Core Processing Pipeline

The application follows a multi-stage pipeline in `app.js`:

1. **OBJ Parsing** (`parseOBJ`) - Extracts vertices with RGB colors and face topology
2. **Graph Construction** - Builds adjacency graphs for both vertices and faces
3. **Color Selection** (`selectBestColors`) - Analyzes input colors and selects the N most representative colors from `COLOR_POOL` (13 predefined colors)
4. **Color Remapping** (`remapColors`) - Maps each vertex to its nearest palette color using weighted Euclidean distance (2R² + 4G² + 3B²)
5. **Island Detection & Merging** - Two-pass cleanup:
   - Vertex islands: Connected components in vertex adjacency graph
   - Face islands: Connected components in face adjacency graph
6. **Export** - Generates OBJ (text) or 3MF (ZIP with XML) format

### Key Algorithms

**Color Distance**: Uses perceptually-weighted RGB distance (more weight on green):
```
distance = sqrt(2*dR² + 4*dG² + 3*dB²)
```

**Island Merging**: Iterative algorithm that merges small isolated color regions into adjacent colors by finding the most common neighboring color. Runs until convergence (max 10 iterations). Two separate passes:
- `mergeSmallIslands()` - Works on vertex connectivity
- `mergeIsolatedFaces()` - Works on face connectivity and face dominant colors

**Face Color Assignment**: For 3MF export, each face gets the color that appears most frequently among its vertices.

### Data Flow

```
File Upload → Parse OBJ → Build Graphs → Select Palette →
Remap Colors → Merge Vertex Islands → Merge Face Islands →
Export (OBJ or 3MF)
```

### 3MF Format

The 3MF export uses the `paint_color` attribute (1-based index) on triangles, compatible with Bambu Studio and PrusaSlicer. The implementation:
- Triangulates polygonal faces using fan triangulation
- Maps each color to a 1-based index
- Assigns face colors based on dominant vertex color
- Creates proper 3MF ZIP structure with XML manifest

### State Management

Global state variables in `app.js`:
- `loadedFile` - Original uploaded file object
- `processedOBJ` - Text content of processed OBJ file
- `processedData` - Object containing `{vertices, faces}` for 3MF export
- `selectedFormat` - Current export format ('obj' or '3mf')

### UI Architecture

The app is split into three HTML pages:
- `index.html` - Landing page with links to viewer and converter
- `viewer.html` - 3D file viewer with AO, shadows, and color adjustments. Exports a still PNG or a
  360° turntable as an animated WebP (`exportViewerTurntableWebP` spins the model around the vertical
  axis, captures one still WebP per frame, and `js/webpAnimEncoder.js` muxes them into an animated
  RIFF container — container work only, no encoder dependency)
- `converter.html` - Color conversion pipeline with palette selection, processing, and export

Each page uses `data-page` attribute on `<body>` to control page-specific initialization in `main.js`.

The converter UI is organized into cards:
1. File Upload - Drag-and-drop or click to browse
2. Color Pool - Shows all 13 available colors
3. Parameters - Number of colors (1-13) and island threshold
4. Process Button - Triggers the pipeline
5. Results - Shows final color distribution
6. Log - Processing steps and statistics

Modal overlay for export options (filename and format selection).

## Color Pool

The application has 13 predefined colors in `COLOR_POOL` (app.js:39-53):
- Basic: white, black, red, orange, yellow, green, gray
- Browns: dark_brown, light_brown, cream
- Blues: dark_blue, light_blue
- Pink

These are optimized for common 3D printing filament colors. Modifying this pool requires understanding the color selection algorithm's behavior.

## Important Implementation Details

### Vertex Indexing
- OBJ format uses 1-based vertex indices
- Internal arrays use 0-based indices
- Face parsing handles both positive indices and negative (relative) indices

### Line Preservation
The parser preserves original OBJ file lines and only modifies vertex (v) lines during export. This maintains comments, material definitions, and other metadata.

### Async Operations
Processing uses `async/await` with artificial delays (`sleep()`) to allow UI updates during long operations. The delays are cosmetic for progress bar updates.

### Dependencies
- JSZip (3.10.1) - Loaded from CDN for 3MF generation
- No other external dependencies

## Common Modifications

**Adding a new color**: Add to `COLOR_POOL` array with RGB values (0-1 range) and a descriptive name.

**Changing color distance metric**: Modify the `distanceTo()` method in the `Color` class (app.js:17-22). Current weights (2,4,3) approximate human perception.

**Adjusting island merge behavior**: Tune the threshold parameter or modify the neighbor selection logic in `mergeSmallIslands()` and `mergeIsolatedFaces()`.

**Supporting other formats**: Add export logic similar to `generate3MF()` and update the modal UI.