/**
 * TextureClassifier — auto-detect a texture's PBR channel
 * =====================================================================
 * When the user batch-imports a folder of texture images, we need to guess
 * which channel each one belongs to (albedo / normal / roughness / etc.).
 *
 * Two signals are combined:
 *
 *   1. FILENAME HEURISTICS (highest confidence)
 *      Industry-standard suffixes — `_col`, `_albedo`, `_nrm`, `_rough`,
 *      `_met`, `_ao`, `_emi`, `_disp` — are scanned case-insensitively.
 *      If a strong filename hit is found, that wins outright.
 *
 *   2. PIXEL-FEATURE ANALYSIS (fallback / disambiguation)
 *      We downscale to 64×64 and compute statistics:
 *        - Average RGB + saturation
 *        - Brightness mean & variance
 *        - "Blueness" — how much B exceeds R/G (normal maps are bluish)
 *        - "Grayness" — how close R=G=B (roughness/metallic/AO are gray)
 *        - "Colorfulness" — variance of hue (albedo is colorful)
 *        - "Hotspot ratio" — fraction of pixels above 0.9 brightness
 *          (emissive maps have bright spots on dark backgrounds)
 *
 *      Rules:
 *        - blueness > 0.10 AND brightness in [0.25, 0.85]   → normal
 *        - saturation < 0.04 AND brightness < 0.35            → ao  (dark gray)
 *        - saturation < 0.04 AND brightness > 0.65            → height OR roughness/metallic (need filename)
 *        - saturation < 0.04 AND 0.35 ≤ brightness ≤ 0.65     → roughness OR metallic (need filename)
 *        - saturation > 0.18 AND brightness > 0.3             → albedo
 *        - hotspot ratio > 0.05 AND mean brightness < 0.4     → emissive
 *
 * The classifier returns a ranked list of (channel, confidence) tuples
 * so the UI can show "we think this is X, but if wrong pick from Y/Z".
 */

import type { TextureChannel } from './aircraft-presets';

export interface ClassificationResult {
  /** Best guess */
  best: TextureChannel;
  /** Confidence 0-1 */
  confidence: number;
  /** Ranked alternatives */
  ranked: { channel: TextureChannel; score: number }[];
  /** Features we extracted, for UI debug display */
  features: TextureFeatures;
}

export interface TextureFeatures {
  meanR: number;
  meanG: number;
  meanB: number;
  meanBrightness: number;
  saturation: number;
  blueness: number;
  grayness: number;
  colorfulness: number;
  hotspotRatio: number;
  brightnessVariance: number;
}

// === Filename heuristics ====================================================

interface FilenameRule {
  channel: TextureChannel;
  patterns: RegExp[];
  weight: number; // how strongly this rule asserts
}

const FILENAME_RULES: FilenameRule[] = [
  // Albedo
  { channel: 'albedo', weight: 0.95, patterns: [
    /_albedo/i, /_basecolor/i, /_base_color/i, /_base/i, /_color/i, /_colou?r/i,
    /_diff/i, /_diffuse/i, /_dif/i, /^color/i, /^albedo/i, /^base/i,
  ]},
  // Normal
  { channel: 'normal', weight: 0.97, patterns: [
    /_normal/i, /_nrm/i, /_nor/i, /_n\./i, /_n_/i, /^normal/i, /^nrm/i,
    /_bump/i, /_nmap/i,
  ]},
  // Roughness
  { channel: 'roughness', weight: 0.94, patterns: [
    /_rough/i, /_roughness/i, /_rgh/i, /^rough/i, /_r\./i, /_r_/i,
  ]},
  // Metallic
  { channel: 'metallic', weight: 0.94, patterns: [
    /_metal/i, /_metallic/i, /_metalness/i, /_met/i, /_m\./i, /_m_/i, /^metal/i,
  ]},
  // AO
  { channel: 'ao', weight: 0.93, patterns: [
    /_ao/i, /_ambient/i, /_occ/i, /_occlusion/i, /^ao/i, /_ao\./i,
  ]},
  // Emissive
  { channel: 'emissive', weight: 0.93, patterns: [
    /_emiss/i, /_emi/i, /_emit/i, /_illum/i, /^emiss/i, /^emi/i,
  ]},
  // Height
  { channel: 'height', weight: 0.92, patterns: [
    /_height/i, /_hgt/i, /_disp/i, /_displacement/i, /^height/i, /^disp/i,
  ]},
];

function filenameMatch(filename: string): { channel: TextureChannel; weight: number } | null {
  const base = filename.replace(/\.[^.]+$/, ''); // strip extension
  let best: { channel: TextureChannel; weight: number } | null = null;
  for (const rule of FILENAME_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(base)) {
        if (!best || rule.weight > best.weight) {
          best = { channel: rule.channel, weight: rule.weight };
        }
      }
    }
  }
  return best;
}

// === Pixel-feature analysis =================================================

/** Downscale image to 64×64 canvas and read pixel data. */
async function loadImageData(dataUrl: string): Promise<ImageData | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0, 64, 64);
        resolve(ctx.getImageData(0, 0, 64, 64));
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

export async function analyzeTextureFeatures(dataUrl: string): Promise<TextureFeatures> {
  const imgData = await loadImageData(dataUrl);
  if (!imgData) {
    // Fallback: assume gray midpoint
    return {
      meanR: 0.5, meanG: 0.5, meanB: 0.5,
      meanBrightness: 0.5, saturation: 0, blueness: 0,
      grayness: 1, colorfulness: 0, hotspotRatio: 0, brightnessVariance: 0,
    };
  }
  const d = imgData.data;
  const n = d.length / 4;
  let sumR = 0, sumG = 0, sumB = 0;
  let sumBright = 0;
  let sumBrightSq = 0;
  let hotspotCount = 0;
  let sumMaxMin = 0; // for saturation
  let sumHueVar = 0;
  let sumBMinusRG = 0;
  let sumGraynessDelta = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i+1] / 255, b = d[i+2] / 255;
    const bright = (r + g + b) / 3;
    sumR += r; sumG += g; sumB += b;
    sumBright += bright;
    sumBrightSq += bright * bright;
    if (bright > 0.9) hotspotCount++;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    sumMaxMin += (mx - mn);
    // blueness = b - (r+g)/2, only positive contributions
    const blueness = b - (r + g) / 2;
    if (blueness > 0) sumBMinusRG += blueness;
    // grayness = 1 - (max-min)
    sumGraynessDelta += (mx - mn);
    // colorfulness — variance across channels
    const mean = (r + g + b) / 3;
    sumHueVar += (Math.abs(r - mean) + Math.abs(g - mean) + Math.abs(b - mean)) / 3;
  }
  const meanR = sumR / n, meanG = sumG / n, meanB = sumB / n;
  const meanBrightness = sumBright / n;
  const brightnessVariance = Math.abs(sumBrightSq / n - meanBrightness * meanBrightness);
  const saturation = sumMaxMin / n;
  const colorfulness = sumHueVar / n;
  const blueness = sumBMinusRG / n;
  const grayness = 1 - sumGraynessDelta / n;
  const hotspotRatio = hotspotCount / n;
  return {
    meanR, meanG, meanB,
    meanBrightness, saturation, blueness, grayness,
    colorfulness, hotspotRatio, brightnessVariance,
  };
}

// === Combined classifier ====================================================

/**
 * Combine filename + features into a ranked channel list.
 * Filename is a strong prior; features refine / disambiguate.
 */
export async function classifyTexture(
  filename: string,
  dataUrl: string,
): Promise<ClassificationResult> {
  const features = await analyzeTextureFeatures(dataUrl);
  const scores: Record<TextureChannel, number> = {
    albedo: 0, normal: 0, roughness: 0, metallic: 0,
    ao: 0, emissive: 0, height: 0,
  };

  // 1. Filename prior
  const fnMatch = filenameMatch(filename);
  if (fnMatch) {
    scores[fnMatch.channel] += fnMatch.weight * 1.0;
  }

  // 2. Feature-based scoring (each rule adds fractional evidence)
  // Normal: bluish + mid brightness
  if (features.blueness > 0.06 && features.meanBrightness > 0.2 && features.meanBrightness < 0.85) {
    scores.normal += Math.min(0.8, features.blueness * 4);
  }
  // Albedo: colorful + bright enough
  if (features.colorfulness > 0.06 && features.saturation > 0.08 && features.meanBrightness > 0.2) {
    scores.albedo += Math.min(0.7, features.colorfulness * 3);
  }
  // AO: very dark + low saturation + low variance
  if (features.meanBrightness < 0.35 && features.saturation < 0.05 && features.brightnessVariance < 0.05) {
    scores.ao += 0.5;
  }
  // Roughness/Metallic: grayscale + mid-bright
  if (features.grayness > 0.92 && features.meanBrightness > 0.25 && features.meanBrightness < 0.85) {
    // Can't distinguish rough from metallic without filename — split
    scores.roughness += 0.25;
    scores.metallic += 0.2;
  }
  // Height: grayscale + high variance
  if (features.grayness > 0.92 && features.brightnessVariance > 0.06) {
    scores.height += 0.3;
  }
  // Emissive: hotspots on dark background
  if (features.hotspotRatio > 0.03 && features.meanBrightness < 0.5) {
    scores.emissive += 0.5;
  }
  // Metallic: very bright grayscale
  if (features.grayness > 0.95 && features.meanBrightness > 0.7) {
    scores.metallic += 0.3;
  }

  // 3. Rank
  const ranked = (Object.keys(scores) as TextureChannel[])
    .map(c => ({ channel: c, score: scores[c] }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    // No signal — default to albedo with low confidence
    return {
      best: 'albedo',
      confidence: 0.1,
      ranked: [{ channel: 'albedo', score: 0.1 }],
      features,
    };
  }

  const best = ranked[0];
  // Confidence = best score normalized to [0,1], with diminishing returns
  const confidence = Math.min(0.99, best.score);
  return { best: best.channel, confidence, ranked, features };
}

// === Per-part mesh classification ===========================================

/**
 * Given a mesh name (e.g. "Fuselage_01" or "Wing_L"), suggest which PBR
 * texture set it should use. This is used to auto-route textures to the
 * right part when the imported GLB has named meshes.
 */
export type BodyPart = 'fuselage' | 'wing' | 'tail' | 'canopy' | 'exhaust' | 'missile' | 'gear' | 'generic';

export function classifyMeshPart(meshName: string): BodyPart {
  const n = meshName.toLowerCase();
  if (/canopy|cockpit|glass|windshield|cab/.test(n)) return 'canopy';
  if (/wing|main_wing|stabilizer|stab/.test(n)) return 'wing';
  if (/tail|vertical|fin|rudder|hsta|h_stab/.test(n)) return 'tail';
  if (/exhaust|nozzle|engine|thruster|pipe/.test(n)) return 'exhaust';
  if (/missile|pylon|weapon|rocket|bomb/.test(n)) return 'missile';
  if (/gear|wheel|landing|strut/.test(n)) return 'gear';
  if (/fuse|body|nose|main|center|cockpit_body/.test(n)) return 'fuselage';
  return 'generic';
}

export const PART_LABELS: Record<BodyPart, string> = {
  fuselage: '机身',
  wing: '机翼',
  tail: '尾翼',
  canopy: '座舱',
  exhaust: '喷口',
  missile: '挂载武器',
  gear: '起落架',
  generic: '其它',
};
