// === 序列帧导入烘制 (per user request: 以导入的爆炸序列帧自动适配特效动画) ===
// 纯函数(编辑器导入用;游戏运行时只消费烘制产物 SpriteSheetCfg.dataUrl):
//   1. 按文件名前缀 token 分组(fxxx → 'f',4xxx → '4',自动对应 地面/空中 槽位)
//   2. 组内帧按数字自然排序
//   3. 每帧等比缩放到最长边 ≤ 档位(128/256/512),排成 cols×rows 帧网格,
//      输出单张 RGBA PNG dataURL(带 GPU/内存尺寸护栏,超限自动降档)
import type { SpriteSheetCfg } from './fx-core';

export const BAKE_SIZES = [128, 256, 512] as const;
export type BakeSize = (typeof BAKE_SIZES)[number];
/** 序列帧动画标称帧率(自动适配:lifetime = frames / fps) */
export const SEQUENCE_FPS = 24;
/** 图集单边护栏:cols/rows 超过它时自动降档(WebGL 尺寸/内存上限) */
const MAX_SHEET_SIDE = 4096;

export interface SequenceFrameFile {
  name: string;
  file: File;
}

/** 分组 token:开头连续字母(f001.png → 'f')或开头连续数字(4001.png → '4')。 */
export function fileToken(name: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  const m = base.match(/^([a-zA-Z]+|[0-9]+)/);
  return (m ? m[1] : base).toLowerCase();
}

/** 自然数字排序:a2.png < a10.png */
export function naturalCompare(a: string, b: string): number {
  const pa = a.split(/(\d+)/);
  const pb = b.split(/(\d+)/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const ca = pa[i] ?? '';
    const cb = pb[i] ?? '';
    if (ca === cb) continue;
    const na = parseInt(ca, 10);
    const nb = parseInt(cb, 10);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else {
      return ca < cb ? -1 : 1;
    }
  }
  return 0;
}

/** 按 token 分组并组内自然排序(保持原 token 出现顺序)。 */
export function groupFrames(files: SequenceFrameFile[]): { token: string; frames: SequenceFrameFile[] }[] {
  const groups = new Map<string, SequenceFrameFile[]>();
  for (const f of files) {
    const t = fileToken(f.name);
    const arr = groups.get(t) ?? [];
    arr.push(f);
    groups.set(t, arr);
  }
  return [...groups.entries()].map(([token, arr]) => {
    arr.sort((a, b) => naturalCompare(a.name, b.name));
    return { token, frames: arr };
  });
}

/** token 建议槽位:f → 地面爆炸,4 → 空中爆炸(与素材命名约定一致)。 */
export function suggestSlot(token: string): 'ground' | 'air' | null {
  if (token === 'f') return 'ground';
  if (token === '4') return 'air';
  return null;
}

async function decodeImage(file: File): Promise<HTMLImageElement | ImageBitmap> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch { /* 走 fallback */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`decode failed: ${file.name}`));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface BakedSheet {
  /** 产物(可直接写进 SpriteEmitterCfg.sheet;key 由调用方赋予稳定值) */
  cfg: SpriteSheetCfg;
  /** 图集像素尺寸(诊断/预览用) */
  width: number;
  height: number;
  /** 实际使用的帧边长(护栏降档后的值) */
  cell: number;
}

/**
 * 烘制一组帧 → 单张帧网格图集 PNG dataURL。
 * 帧保持原始宽高比,在正方形帧格内居中;超过 MAX_SHEET_SIDE 自动降档。
 */
export async function bakeSheet(frames: SequenceFrameFile[], edge: BakeSize): Promise<BakedSheet> {
  const n = Math.max(1, frames.length);
  let cols = Math.ceil(Math.sqrt(n));
  let rows = Math.ceil(n / cols);
  let cell: number = edge;
  while (cols * cell > MAX_SHEET_SIDE || rows * cell > MAX_SHEET_SIDE) {
    cell = Math.max(32, Math.floor(cell / 2));
  }
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell;
  canvas.height = rows * cell;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (let i = 0; i < frames.length; i++) {
    const img = await decodeImage(frames[i].file);
    // decodeImage 返回 HTMLImageElement | ImageBitmap:统一按元素取像素尺寸
    // (naturalWidth 缺失的 ImageBitmap 回退到 width)。
    const el = img as HTMLImageElement;
    const iw = el.naturalWidth || el.width;
    const ih = el.naturalHeight || el.height;
    const s = Math.min(cell / Math.max(1, iw), cell / Math.max(1, ih));
    const dw = Math.max(1, Math.round(iw * s));
    const dh = Math.max(1, Math.round(ih * s));
    const x = (i % cols) * cell + (cell - dw) / 2;
    const y = Math.floor(i / cols) * cell + (cell - dh) / 2;
    ctx.drawImage(img as CanvasImageSource, x, y, dw, dh);
    if ('close' in img && typeof img.close === 'function') img.close();
  }

  return {
    cfg: {
      dataUrl: canvas.toDataURL('image/png'),
      cols,
      rows,
      frames: frames.length,
    },
    width: canvas.width,
    height: canvas.height,
    cell,
  };
}
