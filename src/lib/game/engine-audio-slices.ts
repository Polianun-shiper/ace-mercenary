// ============================================================================
// 引擎音频切片表 (由 scripts/slice-engine-audio.mjs 自动生成, 请勿手改)
// ============================================================================
// 素材: public/audio/engine_throttle.wav (用户录音, 9.62s; 单文件构建时会被
//       compress-audio.mjs 压成**单声道 32kHz** —— 消费端一律走 decodeAudioData,
//       采样率/声道数变化对播放无感, 切片时间点是秒数, 不受影响)
//   结构 = 怠速(0~0.7s) → 节流阀推起(0.7~1.3s) → 中间各档(1.3~8.5s)
//          → 开加力轰鸣(8.6~9.6s, 峰值)
//
// 切片原则: 每档取一段**电平平稳**的片段做循环体 —— 平稳才不会有接缝咔哒声。
//   选片算法(见切片脚本): 在目标电平窗内找 RMS 方差最小的窗; 找不到就递增容差
//   并缩短片段; 全加力档用"最响窗"兜底(因为包络里只有单点触及峰值, 任何窗的
//   平均值都到不了 0.9, 这是素材本身的限制)。
//
// 运行时用法(audio.ts):
//   按油门选相邻两档 → 各自循环播放 → 用增益做**交叉淡化** →
//   于是 0→1 全程都有连续、随油门变化的真实引擎音色。
//   档位之间用交叉淡化而不是硬切, 避免"换档"时的爆音。

export interface EngineSlice {
  /** 档位键 */
  key: string;
  /** 该档代表的油门(0..1) */
  thr: number;
  /** 中文标签(诊断显示用) */
  label: string;
  /** 循环体起止(秒) */
  startSec: number;
  endSec: number;
  /** 实测 RMS 电平(相对整段峰值) */
  level: number;
  /** 片段内 RMS 标准差 —— 越小越平稳、循环接缝越干净 */
  stability: number;
}

export const ENGINE_AUDIO_URL = '/audio/engine_throttle.wav';

/** 八档切片(按 thr 升序)。 */
export const ENGINE_SLICES: EngineSlice[] = [
  { key: 'idle', thr: 0.00, label: '怠速',     startSec: 0.00, endSec: 1.20, level: 0.069, stability: 0.0842 },
  { key: 't15',  thr: 0.15, label: '小推力',   startSec: 0.54, endSec: 1.74, level: 0.234, stability: 0.1704 },
  { key: 't30',  thr: 0.30, label: '巡航低',   startSec: 5.18, endSec: 6.38, level: 0.354, stability: 0.0560 },
  { key: 't45',  thr: 0.45, label: '巡航中',   startSec: 1.82, endSec: 3.02, level: 0.446, stability: 0.0497 },
  { key: 't60',  thr: 0.60, label: '巡航高',   startSec: 6.98, endSec: 8.18, level: 0.497, stability: 0.0657 },
  { key: 't72',  thr: 0.72, label: '军用推力', startSec: 8.34, endSec: 9.54, level: 0.554, stability: 0.1226 },
  { key: 't85',  thr: 0.85, label: '加力初段', startSec: 8.42, endSec: 9.62, level: 0.550, stability: 0.1248 },
  { key: 'ab',   thr: 1.00, label: '全加力',   startSec: 8.72, endSec: 9.62, level: 0.545, stability: 0.0993 },
];

/** 引擎里判定"进入加力"的油门阈值(与 audio.ts 既有合成层、engine.ts 的
 *  afterburner 强度计算保持一致: thr>=0.85 起燃)。 */
export const AFTERBURNER_THR = 0.85;

/** 循环接缝交叉淡化时长(秒)。两个交替的源在接缝处互淡, 避免爆音。 */
export const LOOP_XFADE_SEC = 0.06;
