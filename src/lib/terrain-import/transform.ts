// === 导入贴图/高度场 手动对齐变换(共享:游戏引擎/编辑器) ===
// Gaea 导出的 高度/基础色/AO/法线 可能相对期望朝向旋转/镜像;统一以
// `MapTransform` 存储(90°步进 + H/V 镜像),应用顺序:flipY → flipX →
// rot(CW 90°×n)。tune 保存到 maps.<slot>.transform,编辑器可手动对准。
export interface MapTransform {
  rot?: number;       // 0 | 90 | 180 | 270(顺时针步进)
  flipX?: boolean;    // 左右镜像
  flipY?: boolean;    // 上下镜像
}
export type NormTransform = { rot: 0 | 90 | 180 | 270; flipX: boolean; flipY: boolean };
export function normTransform(t: MapTransform | null | undefined): NormTransform {
  const r = ((((t?.rot ?? 0) % 360) + 360) % 360);
  return { rot: (r === 90 || r === 180 || r === 270 ? r : 0), flipX: !!t?.flipX, flipY: !!t?.flipY };
}
export function isIdentity(t: NormTransform): boolean {
  return t.rot === 0 && !t.flipX && !t.flipY;
}

/** 方形高度/纹理数据 90°CW 旋转(尺寸不变,W==H)。 */
export function rotateGridCW90(data: Float32Array, size: number): Float32Array {
  const out = new Float32Array(data.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out[y * size + x] = data[(size - 1 - y) * size + x];
    }
  }
  return out;
}

/** 方形 90°CCW。 */
export function rotateGridCCW90(data: Float32Array, size: number): Float32Array {
  const out = new Float32Array(data.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out[y * size + x] = data[x * size + (size - 1 - y)];
    }
  }
  return out;
}

/** 对方形 Float32 数据应用 MapTransform。 */
export function applyGridTransform(data: Float32Array, size: number, t: MapTransform | null | undefined): Float32Array {
  const n = normTransform(t);
  if (isIdentity(n)) return data;
  let d = data;
  const S = size;
  if (n.flipY) { // 上下镜像(行序反转)
    const out = new Float32Array(d.length);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) out[y * S + x] = d[(S - 1 - y) * S + x];
    d = out;
  }
  if (n.flipX) { // 左右镜像
    const out = new Float32Array(d.length);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) out[y * S + x] = d[y * S + (S - 1 - x)];
    d = out;
  }
  if (n.rot === 90) d = rotateGridCW90(d, S);
  else if (n.rot === 180) d = rotateGridCW90(rotateGridCW90(d, S), S);
  else if (n.rot === 270) d = rotateGridCCW90(d, S);
  return d;
}

/**
 * 把贴图按 MapTransform 重绘成新 canvas(与高度场同一像素域约定,再交给
 * CanvasTexture 上传)。输入可为 HTMLCanvasElement / ImageBitmap / 图像。
 */
export function transformImageToCanvas(
  img: HTMLCanvasElement | ImageBitmap | HTMLImageElement,
  t: MapTransform | null | undefined,
): HTMLCanvasElement {
  const n = normTransform(t);
  const w = 'naturalWidth' in (img as HTMLImageElement) ? (img as HTMLImageElement).naturalWidth : img.width;
  const h = 'naturalHeight' in (img as HTMLImageElement) ? (img as HTMLImageElement).naturalHeight : img.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  // 与 applyGridTransform 同序:flipY → flipX → rot CW。
  if (n.flipY) { ctx.translate(0, h); ctx.scale(1, -1); }
  if (n.flipX) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  if (n.rot === 90) { ctx.translate(w, 0); ctx.rotate(Math.PI / 2); }
  else if (n.rot === 180) { ctx.translate(w, h); ctx.rotate(Math.PI); }
  else if (n.rot === 270) { ctx.translate(0, h); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(img as CanvasImageSource, 0, 0);
  return c;
}
