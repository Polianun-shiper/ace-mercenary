// === STBN(时空蓝噪声)程序化生成 —— @takram/three-clouds 时域上采样的必需品 ==========
//
// 为什么需要: 库的时域上采样(temporalUpscale)把"每帧 1/16 像素真步进 + 重投影补帧"做起来,
// 但射线步进的**抖动值**取自一张 `Data3DTexture`(STBN = spatiotemporal blue noise):
//
//     float getSTBN() {                       // shared.js:1534
//       ivec3 size = textureSize(stbnTexture, 0);
//       vec3 scale = 1.0 / vec3(size);
//       return texture(stbnTexture, vec3(gl_FragCoord.xy, float(frame % size.z)) * scale).r;
//     }
//
//   · 采样坐标是**像素坐标 + 帧号**(z 轴 = 帧), 所以贴图必须 s/t 方向 **Repeat**,
//     否则 gl_FragCoord>size 之后全被钳到一个 texel(抖动退化成常数)。
//   · 只要 .r 一个通道, 值域 [0,1)。
// 库里**没有**程序化版本(它让用户自己去下 STBN 贴图), 传 null 时三维纹理采到 0 ⇒ 抖动为 0
// ⇒ 步进出现**规则条带**(banding)。所以这条路只有两个选择:
//   (a) 下载/内嵌一张 STBN(128×128×64 的 8bit = 1MB → base64 1.4MB) —— 单文件预算放不下;
//   (b) **程序化生成** —— 就是本文件。零资产、零体积开销(只多几百字节的生成代码)。
//
// 生成方案: **void-and-cluster**(Ulichney 1993)在一张 64×64 的环面(toroidal)上跑出
// 一张高质量蓝噪声 rank 图; 然后 3D 纹理的 64 个 z 切片各取该图的**不同环面平移**
// (偏移由 R2 低差异序列给出)。于是:
//   · 每个切片仍是标准蓝噪声(空间上无低频聚簇) —— 这是"抖动不产生规则条带"的来源;
//   · 相邻切片的图案不同(平移量不同) —— 这是"时间上被打散"的来源。
// 代价: 一次 ~几十 ms 的生成(只在开启时做一次), 之后一直在显存里。
import * as THREE from 'three';

/** 生成参数(改了要重新生成) */
const N = 64;        // 切片尺寸(正方形, 环面)
const DEPTH = 64;    // z 轴切片数(= 库的 frame % size.z, 64 帧一个循环)
const KERNEL_R = 5;  // 高斯核半径(环面距离)
const KERNEL_SIGMA = 1.7;
const SWAP_ITERS = 1400;   // 相位 0 的交换迭代次数(越大越均匀; 1400 已看不出差别)

/** 可复现的 PRNG(不引入依赖, 也不想每次启动的噪声图案都不一样) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * void-and-cluster: 返回 64×64 的 rank 图(每格是 [0,1) 的排序值, 均匀分布)。
 * 蓝噪声的关键在**rank 的顺序**: 按"先移除最紧的簇、再填充最大的洞"生成,
 * 于是 rank 的等值线(阈值化)是蓝噪声。
 */
function voidAndCluster(): Float32Array {
  const rng = mulberry32(0x5bf0a3d1);
  const n2 = N * N;
  // 高斯核(环面), 展开成一维偏移 + 权重
  const offs: number[] = [];
  const wts: number[] = [];
  for (let dy = -KERNEL_R; dy <= KERNEL_R; dy++) {
    for (let dx = -KERNEL_R; dx <= KERNEL_R; dx++) {
      if (dx === 0 && dy === 0) continue;
      const w = Math.exp(-(dx * dx + dy * dy) / (2 * KERNEL_SIGMA * KERNEL_SIGMA));
      if (w < 2e-3) continue;
      offs.push(dy, dx);
      wts.push(w);
    }
  }
  const taps = wts.length;
  const bin = new Uint8Array(n2);
  const energy = new Float32Array(n2);
  const bump = (i: number, sign: number) => {
    const x = i % N;
    const y = (i - x) / N;
    for (let k = 0; k < taps; k++) {
      const yy = (y + offs[k * 2] + N) % N;
      const xx = (x + offs[k * 2 + 1] + N) % N;
      energy[yy * N + xx] += sign * wts[k];
    }
  };

  // --- 初始: 随机一半密度 ---
  for (let i = 0; i < n2; i++) {
    if (rng() < 0.5) { bin[i] = 1; bump(i, 1); }
  }

  // --- 相位 0: 反复"最紧的簇 ↔ 最大的洞"交换, 直到不再改善 ---
  for (let it = 0; it < SWAP_ITERS; it++) {
    let ci = -1, cv = -1e9;
    for (let i = 0; i < n2; i++) if (bin[i] && energy[i] > cv) { cv = energy[i]; ci = i; }
    if (ci < 0) break;
    bin[ci] = 0; bump(ci, -1);           // 暂时摘掉这个簇再找洞(经典做法)
    let vi = -1, vv = 1e9;
    for (let i = 0; i < n2; i++) if (!bin[i] && energy[i] < vv) { vv = energy[i]; vi = i; }
    if (vi < 0) { bin[ci] = 1; bump(ci, 1); break; }
    bin[vi] = 1; bump(vi, 1);
  }

  // --- 相位 1/2: 按"移除最紧的簇"(rank 从半密度往下)与"填充最大的洞"(往上)排名 ---
  const rank = new Float32Array(n2).fill(-1);
  let count = 0;
  for (let i = 0; i < n2; i++) if (bin[i]) count++;
  let r = count - 1;
  const order: number[] = [];
  for (let step = 0; step < count; step++) {
    let ci = -1, cv = -1e9;
    for (let i = 0; i < n2; i++) if (bin[i] && energy[i] > cv) { cv = energy[i]; ci = i; }
    if (ci < 0) break;
    bin[ci] = 0; bump(ci, -1);
    order.push(ci);
  }
  // order[0] 是第一个被移除的(最紧的簇) ⇒ 它是**最后一个**被阈值化的 ⇒ rank 最大
  for (let k = 0; k < order.length; k++) rank[order[k]] = r--;
  r = count;
  for (;;) {
    let vi = -1, vv = 1e9;
    for (let i = 0; i < n2; i++) if (!bin[i] && energy[i] < vv) { vv = energy[i]; vi = i; }
    if (vi < 0) break;
    bin[vi] = 1; bump(vi, 1);
    rank[vi] = r++;
    if (r >= n2) break;
  }
  // 归一化到 [0,1)
  const out = new Float32Array(n2);
  for (let i = 0; i < n2; i++) out[i] = rank[i] < 0 ? 0 : rank[i] / n2;
  return out;
}

/**
 * 生成 STBN `Data3DTexture`(64×64×64, R8, s/t 方向 Repeat)。
 * 抛异常由调用方 catch(不可用就退回"不打开时域上采样")。
 */
export function createSTBN(): THREE.Data3DTexture {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const mask = voidAndCluster();
  const data = new Uint8Array(N * N * DEPTH);
  const R2A = 0.7548776662466927, R2B = 0.5698402909980532;   // R2 低差异序列
  for (let z = 0; z < DEPTH; z++) {
    // 每个切片一个不同的环面平移 ⇒ 切片之间"去相关", 但又都保持蓝噪声
    const sx = Math.floor((z * R2A % 1) * N);
    const sy = Math.floor((z * R2B % 1) * N);
    const base = z * N * N;
    for (let y = 0; y < N; y++) {
      const sy2 = (y + sy) % N;
      for (let x = 0; x < N; x++) {
        const sx2 = (x + sx) % N;
        data[base + y * N + x] = Math.min(255, Math.round(mask[sy2 * N + sx2] * 255));
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, N, N, DEPTH);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  // 采样端是 `vec3(gl_FragCoord.xy, frame % size.z) / size` —— 像素坐标会超过贴图尺寸,
  // 所以 s/t **必须 Repeat**(默认 ClampToEdge 会把整屏钳到一个 texel ⇒ 抖动=常数)。
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  console.info(`[clouds] STBN 已程序化生成 ${N}×${N}×${DEPTH}(void-and-cluster, 耗时 ${ms.toFixed(1)}ms, `
    + `${(data.length / 1024).toFixed(0)}KB)`);
  return tex;
}
