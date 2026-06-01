# The Architect

A playable game instance built with the V3DD Engine, hosted as static files. One scene, one level — explore it from a first-person or leashed-third-person camera.

> made in Great Creation Studios Anticontainment System with V3DD Engine

## Play it

Live URL (after GitHub Pages is enabled for this repo): `https://greatcreations.github.io/dumping-grounds/the-architect/LocalThreejs/`

Or open `LocalThreejs/index.html` locally — the LocalThreejs build runs from `file://` without any HTTP server.

## Controls

| Key | Action |
|-----|--------|
| `W` `A` `S` `D` | Move |
| `Space` | Jump |
| `V` | Toggle camera (first-person ↔ leashed) |
| `R` | Reset to spawn |
| `P` | Toggle paint mode |
| `Alt+P` | Save paint to browser localStorage |
| `Alt+O` | Purge saved paint (forever) |
| `Shift + =` | Toggle crosshair |
| `'` | Toggle the bottom-left credit footer |
| `/` | Show / hide controls reference |
| `Esc` | Release pointer / close modals |

## Build variants

- **`LocalThreejs/`** — Three.js bundled into a single 38 MB IIFE. Works from `file://` (double-click `index.html`) and from any HTTPS static host. Currently the only built variant.
- **`OnlineThreejs/`** — *(planned)* Three.js loaded from jsDelivr CDN, lighter bundle (~1.5 MB), needs HTTP. Not yet built.

## Rebuilding the bundle

If the source level is edited in the V3D editor, regenerate the bundle with:

```sh
cd LocalThreejs
npm install
node build-tools/embed-level.mjs    # refresh embedded level
node build-tools/embed-stories.mjs  # refresh story bundle
node build-tools/embed-assets.mjs   # inline JPEGs + GLBs as data URLs
npm run build                        # esbuild → game.bundle.js
```

## Engine

V3DD Engine (private development at `D:\V3D Dev\`). This game folder is fully self-contained and does not require the editor or preview to run.
