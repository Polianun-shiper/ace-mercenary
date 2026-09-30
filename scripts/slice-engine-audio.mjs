// 引擎音频切片器: 为每个节流阀档位挑选"最稳定"的片段, 输出切片表(供运行时循环+交叉淡化)
//
// 依据: 用户录音 引擎与后燃器.wav 的结构 = 怠速(0~0.7s) → 节流阀推起(0.7~1.3s)
//       → 中间各档(1.3~8.5s) → 开加力轰鸣(8.6~9.6s, 峰值 RMS)
// 目标: 每个节流阀档位取一段电平平稳的 1.2s 片段做循环体 —— 平稳才不会有咔哒声。
//
// 用法: node scripts/slice-engine-audio.mjs   (打印切片表, 同时写入 JSON 供实现参考)
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'public/audio/engine_throttle.wav';
const buf = readFileSync(path);

function parseWav(b) {
  let off = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        byteRate: b.readUInt32LE(body + 8),
        blockAlign: b.readUInt16LE(body + 12),
        bitsPerSample: b.readUInt16LE(body + 14),
      };
    } else if (id === 'data') { dataOff = body; dataLen = size; }
    off = body + size + (size % 2);
  }
  return { fmt, dataOff, dataLen };
}
const { fmt, dataOff, dataLen } = parseWav(buf);
const dur = dataLen / fmt.byteRate;

// --- RMS 包络(20ms 窗, 比分析脚本更细) ---
const step = Math.max(1, Math.round(fmt.sampleRate * 0.02));
const segs = Math.floor(dataLen / fmt.blockAlign / step);
const env = new Float32Array(segs);
for (let s = 0; s < segs; s++) {
  let acc = 0, n = 0;
  const base = dataOff + s * step * fmt.blockAlign;
  for (let i = 0; i < step; i++) {
    const p = base + i * fmt.blockAlign;
    if (p + 2 > dataOff + dataLen) break;
    const v = buf.readInt16LE(p) / 32768;
    acc += v * v; n++;
  }
  env[s] = n ? Math.sqrt(acc / n) : 0;
}
const peak = Math.max(...env);

// --- 档位定义: 与引擎油门映射一致 ---
// 引擎里 afterburner = thr>=0.85, 所以 8 档里 7 档是加力。
const BANDS = [
  { key: 'idle',  thr: 0.00, lo: 0.00, hi: 0.12, label: '怠速' },
  { key: 't15',   thr: 0.15, lo: 0.12, hi: 0.24, label: '小推力' },
  { key: 't30',   thr: 0.30, lo: 0.24, hi: 0.36, label: '巡航低' },
  { key: 't45',   thr: 0.45, lo: 0.36, hi: 0.48, label: '巡航中' },
  { key: 't60',   thr: 0.60, lo: 0.48, hi: 0.62, label: '巡航高' },
  { key: 't72',   thr: 0.72, lo: 0.55, hi: 0.72, label: '军用推力' },
  { key: 't85',   thr: 0.85, lo: 0.58, hi: 0.78, label: '加力初段', fromSec: 8.30 },
  { key: 'ab',    thr: 1.00, lo: 0.60, hi: 1.01, label: '全加力', fromSec: 8.60 },
];
const LOOP_SEC = 1.2;

/**
 * 选择某档位的循环片段。
 *
 * 为什么需要"递增容差 + 可变长度":
 *   原始录音里 0.7s 之后**不再出现低电平**(节流阀是一路推上去的), 而加力段只有
 *   约 1s 且波动很大 —— 固定 1.2s + 严格电平窗会找不到任何片段。所以按
 *   ① 严格窗 → ② 放宽窗 → ③ 缩短片段 的顺序退化, 保证每档都能拿到素材,
 *   同时优先选**方差最小**的窗(方差小 = 循环接缝不会有咔哒声)。
 */
function pickSlice(lo, hi, exclude = [], fromSec = 0) {
  const attempts = [
    { sec: LOOP_SEC, tol: 0.00 },
    { sec: LOOP_SEC, tol: 0.04 },
    { sec: LOOP_SEC * 0.75, tol: 0.06 },
    { sec: LOOP_SEC * 0.5, tol: 0.10 },
    { sec: LOOP_SEC * 0.4, tol: 0.16 },
  ];
  for (const a of attempts) {
    const w = Math.max(4, Math.round(a.sec / 0.02));
    let best = null;
    const s0 = Math.max(0, Math.round(fromSec / 0.02));
    for (let s = s0; s + w <= segs; s++) {
      let sum = 0;
      for (let k = 0; k < w; k++) sum += env[s + k];
      const mean = sum / w / peak;
      if (mean < lo - a.tol || mean > hi + a.tol) continue;
      let varAcc = 0;
      for (let k = 0; k < w; k++) {
        const d = env[s + k] / peak - mean;
        varAcc += d * d;
      }
      const sd = Math.sqrt(varAcc / w);
      // 打分: 稳定性为主, 略微偏好"更靠近目标电平"
      const target = (lo + Math.min(hi, 1)) / 2;
      // 与已选片段重叠则罚分 —— 否则高档位会选到同一段素材, 听不出差别。
      let overlap = 0;
      for (const ex of exclude) {
        const o = Math.min(s + w, ex.end) - Math.max(s, ex.start);
        if (o > 0) overlap += o / w;
      }
      const score = sd + Math.abs(mean - target) * 0.15 + overlap * 0.5;
      if (!best || score < best.score) best = { s, w, mean, sd, score };
    }
    if (best) return best;
  }
  // 兜底: 取**最响**的窗。
  // 全加力档(lo=0.90)永远匹配不到 —— RMS 包络里只有单个点触及峰值, 任何窗的
  // 平均值都不可能到 0.90。此时"最响的一段"就是加力轰鸣本体 —— 这是素材本身的
  // 限制(录音里加力只持续约 1s 且波动大), 不是算法问题。
  {
    const w = Math.max(4, Math.round(LOOP_SEC * 0.75 / 0.02));
    const s0 = Math.max(0, Math.round(fromSec / 0.02));
    let loud = null;
    for (let s = s0; s + w <= segs; s++) {
      let sum = 0;
      for (let k = 0; k < w; k++) sum += env[s + k];
      const mean = sum / w / peak;
      let ov = 0;
      for (const ex of exclude) {
        const o = Math.min(s + w, ex.end) - Math.max(s, ex.start);
        if (o > 0) ov += o / w;
      }
      const sc = mean - ov * 0.25;
      if (!loud || sc > loud.score) loud = { s, w, mean, sd: 0, score: sc, fallback: true };
    }
    if (loud) return loud;
  }
  return null;
}

const out = { source: path, durationSec: +dur.toFixed(2), sampleRate: fmt.sampleRate, peak, loopSec: LOOP_SEC, bands: [] };

const chosen = [];
for (const band of BANDS) {
  const best = pickSlice(band.lo, band.hi, chosen, band.fromSec ?? 0);
  if (best) chosen.push({ start: best.s, end: best.s + best.w });
  const rec = best
    ? { key: band.key, thr: band.thr, label: band.label,
        startSec: +(best.s * 0.02).toFixed(3),
        endSec: +((best.s + best.w) * 0.02).toFixed(3),
        level: +best.mean.toFixed(3), stability: +best.sd.toFixed(4) }
    : { key: band.key, thr: band.thr, label: band.label, missing: true };
  out.bands.push(rec);
  console.log(
    (band.key + '  thr=' + band.thr.toFixed(2)).padEnd(18) +
    (best
      ? `start=${rec.startSec}s end=${rec.endSec}s len=${(rec.endSec - rec.startSec).toFixed(2)}s level=${rec.level} sd=${rec.stability}`
      : '未找到'),
  );
}

writeFileSync('scripts/engine-slices.json', JSON.stringify(out, null, 2));
console.log('\n已写入 scripts/engine-slices.json');
