// === 外部地形高度源(shared:游戏/编辑器/运行期) ===
// Gaea/其它 DCC 导出的地形经导入流程统一变成:
//   Float32 米制高度网格(.f32bin 规范格式:小端 float32 裸数据)+ 元数据
//   {size, resX, resY}(世界 ±size/2 对齐,海平面=0 语义沿用:低于 0 = 水下)。
// 本文件提供纯函数:双线性采样 heightAt、规范编码/解码、统计。
// 浏览器端 16-bit PNG/EXR 解码只发生在编辑器导入期(见
// src/lib/editor/gaea-import-decode.ts),运行期零额外依赖。
export interface HeightGrid {
  /** resY 行 × resX 列,行主序;对应世界 [-size/2, +size/2] 采样 */
  data: Float32Array;
  size: number;
  resX: number;
  resY: number;
  /** 可选:名义最大高(带报告/absolute 软化等用;缺省可现算) */
  maxHeight?: number;
}

/** 采样统计(导入期与运行期都会用,如 band 报告/引擎 maxHeight 兜底)。 */
export function gridMinMax(data: Float32Array): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  return { min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max };
}

/**
 * 外部高度场采样器 —— 与 environment 噪声 heightAt 同签名(世界坐标米)。
 * 双线性 + 边缘钳制;内部行序约定:data[cy * resX + cx],cy=0 在 -size/2 侧。
 */
export function buildExternalHeightAt(grid: HeightGrid): (x: number, z: number) => number {
  const { data, size, resX, resY } = grid;
  const sx = resX > 1 ? (resX - 1) / size : 0;
  const sy = resY > 1 ? (resY - 1) / size : 0;
  return (x: number, z: number) => {
    const fx = (x + size / 2) * sx;
    const fy = (z + size / 2) * sy;
    if (resX === 1 || resY === 1) {
      return data[0] ?? 0;
    }
    const ix = Math.min(resX - 2, Math.max(0, Math.floor(fx)));
    const iy = Math.min(resY - 2, Math.max(0, Math.floor(fy)));
    const tx = fx - ix;
    const ty = fy - iy;
    const a = data[iy * resX + ix];
    const b = data[iy * resX + ix + 1];
    const c = data[(iy + 1) * resX + ix];
    const d = data[(iy + 1) * resX + ix + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

/** 规范 .f32bin 编码(little-endian float32 裸数据)。 */
export function encodeF32Bin(data: Float32Array): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(data.length * 4));
  for (let i = 0; i < data.length; i++) out.setFloat32(i * 4, data[i], true);
  return out.buffer;
}

/** 规范 .f32bin 解码。 */
export function decodeF32Bin(buf: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = buf instanceof Uint8Array ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf;
  const n = Math.floor(bytes.byteLength / 4);
  const out = new Float32Array(n);
  const dv = new DataView(bytes);
  for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

/** 世界坐标 ↔ 遮罩/色图纹素(与既有 mask canvas 相同的 [-size/2,+size/2]→[0,res))。 */
export function worldToPx(x: number, size: number, res: number): number {
  return ((x + size / 2) / size) * res;
}
export function pxToWorld(px: number, size: number, res: number): number {
  return ((px + 0.5) / res) * size - size / 2;
}
