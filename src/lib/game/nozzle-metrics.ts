// === 尾喷口自动测量 + 后燃器自动适配 (per user request) ========================
// 用户: "后燃器要根据机体模型自动适配大小和位置(凝结云面片也是), 通常放在尾喷口那一段"。
//
// 做法: 直接在**模型几何**上量: 以每个发动机喷口(火焰轴线)为轴心, 取机身尾部那一小段
// 里的顶点, 求出
//   · aftZ   = 该段最靠后的 z(喷口所在截面) —— 火焰从这里往后喷;
//   · radius = 该截面附近的最小横向半径(喷口唇口) —— 火焰的粗细/长度都按它成比例。
// 于是每种机型(F-16/MiG-29/Su-35/B-52/AC-130…)都会自己量出喷口, 大机体自然得到大火焰。
// 量不到(极少见)时退回"按机型长度比例"的估计值, 不会没有火焰。
//
// === 为什么会有 positionArrays() 这一层 (per fix) ==============================
// 曾经这套测量**从来没生效过**: 多材质真实模型(F-16C / MiG-29)的
// AircraftGeometryInfo.geometry 是一个**空占位几何**(它们渲染走的是几十个 sub-mesh,
// 单几何只是给老代码留的接口), 于是 getAttribute('position') 恒为 undefined,
// 每次都悄悄走 fallback —— 火焰尺寸一直是"按机长比例估的", 不是量出来的。
// 现在改为: 机型可以给出 scanGeometries(真正要量的那些 sub-mesh 几何), 扫描统一走
// positionArrays(): 有 scanGeometries 就量它们, 否则回落到 geometry。
import * as THREE from 'three';

/** 扫描用的几何来源: 优先 scanGeometries(多材质模型), 否则用单个 geometry。 */
export interface ScanSource {
  geometry?: THREE.BufferGeometry;
  scanGeometries?: THREE.BufferGeometry[];
}

/**
 * 取出可直接按 stride=3 读的 position 数组(Float32Array)。
 * 只接受普通 BufferAttribute(非 interleaved)、itemSize=3 —— OBJLoader/BufferGeometry
 * 产出的都是这种;遇到认不出来的就跳过, 绝不让调用方读到 undefined。
 */
export function positionArrays(info: ScanSource): Float32Array[] {
  const out: Float32Array[] = [];
  const push = (g?: THREE.BufferGeometry | null) => {
    if (!g) return;
    const a = g.getAttribute?.('position') as THREE.BufferAttribute | undefined;
    if (!a || a.itemSize !== 3) return;
    if ((a as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) return;
    const arr = a.array as unknown;
    if (arr instanceof Float32Array) out.push(arr);
  };
  if (info.scanGeometries && info.scanGeometries.length) for (const g of info.scanGeometries) push(g);
  else push(info.geometry);
  return out;
}

/** 顶点总数(诊断用: 0 就意味着这次扫描只能走估计值)。 */
export function vertexCount(info: ScanSource): number {
  let n = 0;
  for (const a of positionArrays(info)) n += a.length / 3;
  return n;
}

export interface NozzleMetrics {
  /** 喷口截面(最靠后的 z) */
  aftZ: number;
  /** 喷口半径(横向) */
  radius: number;
  /** 是否来自实测(false = 按长度比例估计) */
  measured: boolean;
}

/**
 * @param axes 每台发动机的**火焰轴线**(不是发动机中心) —— 调用方应传
 *             enginePositions[i] 再叠加 buildAfterburner 内部那个垂直偏移后的点,
 *             也就是"火焰真正会出现在哪", 否则统计出来的半径是偏心的。
 */
export function deriveNozzleMetrics(
  info: { geometry?: THREE.BufferGeometry; scanGeometries?: THREE.BufferGeometry[]; noseZ: number; tailZ: number; halfSpan: number },
  axes: THREE.Vector3[],
): NozzleMetrics[] {
  const arrays = positionArrays(info);
  const L = Math.max(0.5, info.noseZ - info.tailZ);
  const fallback = (): NozzleMetrics[] => axes.map(() => ({
    // 估计: 喷口在机尾附近, 半径按机长的一小部分(≈ 0.045L) —— 保证任何机型都有合理比例
    aftZ: info.tailZ + L * 0.03,
    radius: L * 0.045,
    measured: false,
  }));
  if (arrays.length === 0) return fallback();
  const out: NozzleMetrics[] = [];
  const R = Math.max(0.2, info.halfSpan);
  for (const ep of axes) {
    // 判定半径放宽到 0.5 半展长: 实测机尾蒙皮都在 r≈1.0 之外(半展长 3.19),
    // 原来的 0.25(0.8) 一颗顶点都圈不到 ⇒ 永远退回估计值。
    const lim = R * 0.5;
    // 取样带围着轴线前后各一段(前 0.12L / 后 0.06L):
    //   aftZ   = 最小 z(真正的喷口截面)
    //   radius = 到轴线的最小横向半径(喷口唇口;比外壳的 max r 更接近口径)
    let aftZ = Infinity;
    const zLo = ep.z - L * 0.12, zHi = ep.z + L * 0.06;
    for (const arr of arrays) {
      for (let i = 0; i < arr.length; i += 3) {
        const z = arr[i + 2];
        if (z < zLo || z > zHi) continue;
        const r = Math.hypot(arr[i] - ep.x, arr[i + 1] - ep.y);
        if (r > lim) continue;
        if (z < aftZ) aftZ = z;
      }
    }
    let radius = Infinity;
    if (Number.isFinite(aftZ)) {
      const slice = L * 0.02;
      for (const arr of arrays) {
        for (let i = 0; i < arr.length; i += 3) {
          const z = arr[i + 2];
          if (z < aftZ || z > aftZ + slice) continue;
          const r = Math.hypot(arr[i] - ep.x, arr[i + 1] - ep.y);
          if (r > lim) continue;
          if (r > 1e-4 && r < radius) radius = r;   // 最内圈
        }
      }
    }
    if (!Number.isFinite(radius) || radius === Infinity) radius = 0;
    if (!Number.isFinite(aftZ) || aftZ === Infinity || radius <= 1e-4) {
      out.push(fallback()[out.length]);
      continue;
    }
    out.push({ aftZ, radius, measured: true });
  }
  return out;
}
