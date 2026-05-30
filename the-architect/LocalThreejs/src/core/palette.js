// core/palette.js — default 256-color full-spectrum palette.
//
// Layout (256 slots, index 0 reserved for transparent = "show through to
// JPEG or default surface color"):
//
//   0           transparent (no paint)
//   1..16       grayscale ramp (white at 1 → black at 16)
//   17..256     240 rainbow colors arranged as a (hue × lightness × saturation)
//               grid: 24 hue steps × 5 lightness levels × 2 saturation levels
//
// Each palette entry is an RGB hex integer (0xRRGGBB).
// The level stores a 256-length array of hex integers; the author can swap
// any slot for a custom color via the inspector. Defaults below are the
// out-of-the-box spectrum.

const HUES = 24;          // every 15°
const LIGHTS = 5;         // very dark / dark / mid / light / very light
const SATS = 2;           // saturated / muted

export const TRANSPARENT_INDEX = 0;

// HSL → 0xRRGGBB hex int.
function hslToHex(h, s, l) {
  // h: 0..1, s: 0..1, l: 0..1
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

export function defaultPalette() {
  const out = new Array(256);
  out[0] = 0x000000;  // transparent — value irrelevant but keep deterministic
  // Grayscale 1..16: white → black
  for (let i = 0; i < 16; i++) {
    const v = Math.round(255 * (1 - i / 15));
    out[1 + i] = (v << 16) | (v << 8) | v;
  }
  // 240 rainbow: 24 hues × 5 lightness × 2 saturation
  let idx = 17;
  for (let h = 0; h < HUES; h++) {
    for (let l = 0; l < LIGHTS; l++) {
      for (let s = 0; s < SATS; s++) {
        const hue = h / HUES;
        const lightness = 0.15 + (l / (LIGHTS - 1)) * 0.7;   // 0.15 .. 0.85
        const saturation = s === 0 ? 0.95 : 0.5;
        out[idx++] = hslToHex(hue, saturation, lightness);
      }
    }
  }
  // Safety: ensure all 256 slots filled (in case of off-by-one).
  while (idx < 256) out[idx++] = 0x808080;
  return out;
}

// Convenience: convert palette hex int to CSS string.
export function hexToCss(hex) {
  return '#' + hex.toString(16).padStart(6, '0');
}

// Convert palette hex int to {r,g,b} 0..255.
export function hexToRgb(hex) {
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff };
}

// {r,g,b} → hex int.
export function rgbToHex(r, g, b) {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}
