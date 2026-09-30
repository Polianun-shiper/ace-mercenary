// 引擎音频切片分析: 读 WAV → 计算 RMS 包络 → 找"节流阀递增"的档位台阶与开加力起点
// 用法: node scripts/analyze-engine-audio.mjs
import { readFileSync } from 'node:fs';

const path = 'public/audio/engine_throttle.wav';
const buf = readFileSync(path);

// --- 解析 WAV 头 ---
function parseWav(b) {
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE');
  }
  let off = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        sampleRate: b.readUInt32LE(body + 4),
        byteRate: b.readUInt32LE(body + 8),
        blockAlign: b.readUInt16LE(body + 12),
        bitsPerSample: b.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOff = body; dataLen = size;
    }
    off = body + size + (size % 2);
  }
  return { fmt, dataOff, dataLen };
}

const { fmt, dataOff, dataLen } = parseWav(buf);
console.log('格式:', JSON.stringify(fmt));
const dur = dataLen / fmt.byteRate;
console.log('时长: ' + dur.toFixed(2) + 's');

// --- 取单声道样本 ---
const bytesPer = fmt.bitsPerSample / 8;
const frames = Math.floor(dataLen / fmt.blockAlign);
const mono = new Float32Array(frames);
for (let i = 0; i < frames; i++) {
  let sum = 0;
  for (let c = 0; c < fmt.channels; c++) {
    const p = dataOff + i * fmt.blockAlign + c * bytesPer;
    if (fmt.bitsPerSample === 16) sum += buf.readInt16LE(p) / 32768;
    else if (fmt.bitsPerSample === 32) sum += buf.readFloatLE(p);
    else sum += (buf.readUInt8(p) - 128) / 128;
  }
  mono[i] = sum / fmt.channels;
}

// --- RMS 包络(按 50ms 窗) ---
const win = Math.max(1, Math.round(fmt.sampleRate * 0.05));
const env = [];
for (let i = 0; i + win <= frames; i += win) {
  let s = 0;
  for (let k = 0; k < win; k++) s += mono[i + k] * mono[i + k];
  env.push({ t: i / fmt.sampleRate, rms: Math.sqrt(s / win) });
}
const peak = Math.max(...env.map((e) => e.rms));
console.log('包络点: ' + env.length + '  峰值RMS: ' + peak.toFixed(4));

// --- 打印包络(每秒 4 个采样, 便于目视找台阶) ---
console.log('\n时间(s)  RMS(相对峰值)  直方图');
const step = Math.max(1, Math.round(env.length / 120));
for (let i = 0; i < env.length; i += step) {
  const e = env[i];
  const rel = e.rms / peak;
  const bar = '#'.repeat(Math.round(rel * 50));
  console.log(e.t.toFixed(2).padStart(7) + '  ' + rel.toFixed(3) + '  ' + bar);
}

// --- 自动检测"阶跃"位置: RMS 相对值跳变超过阈值的点 ---
console.log('\n=== 检测到的显著电平跃变(候选切片点) ===');
let prev = env[0]?.rms ?? 0;
for (const e of env) {
  const rel0 = prev / peak, rel1 = e.rms / peak;
  if (Math.abs(rel1 - rel0) > 0.12) {
    console.log('  t=' + e.t.toFixed(2) + 's  ' + rel0.toFixed(3) + ' -> ' + rel1.toFixed(3));
  }
  prev = e.rms;
}
