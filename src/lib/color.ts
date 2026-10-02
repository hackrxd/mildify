// Samples a representative colour from cover art so views and the player
// can take on the mood of what's on screen.

const cache = new Map<string, Promise<string | null>>();

export function coverColor(url: string | null | undefined): Promise<string | null> {
  if (!url) return Promise.resolve(null);
  let p = cache.get(url);
  if (!p) {
    p = sample(url).catch(() => null);
    cache.set(url, p);
  }
  return p;
}

function sample(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        resolve(dominant(data));
      } catch {
        // Tainted canvas (no CORS) or decode failure.
        resolve(null);
      }
    };
    img.src = url;
  });
}

/** Saturation-weighted average, so a vivid detail beats a sea of grey. */
export function dominant(data: Uint8ClampedArray): string {
  let r = 0, g = 0, b = 0, total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [pr, pg, pb] = [data[i], data[i + 1], data[i + 2]];
    const max = Math.max(pr, pg, pb);
    const min = Math.min(pr, pg, pb);
    const sat = max === 0 ? 0 : (max - min) / max;
    const lum = max / 255;
    // Favour saturated, mid-bright pixels; near-black and near-white count little.
    const w = 0.05 + sat * sat * (1 - Math.abs(lum - 0.6));
    r += pr * w; g += pg * w; b += pb * w; total += w;
  }
  return normalise(r / total, g / total, b / total);
}

/** Clamp lightness so the colour works as a wash behind light text. */
function normalise(r: number, g: number, b: number): string {
  const [h, s, l] = rgbToHsl(r, g, b);
  const sat = Math.min(0.65, s * 1.15);
  const light = Math.min(0.42, Math.max(0.22, l));
  return `hsl(${Math.round(h * 360)} ${Math.round(sat * 100)}% ${Math.round(light * 100)}%)`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}
