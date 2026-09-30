// === 体积云"现场旋钮"的描述表(单一事实来源) ===================================
//
// 为什么要有这个文件: 这些表以前**只存在于 `engine.ts` 的 `vcloud` 分支里**(控制台用),
// 做 UI 就得抄第二份 ⇒ 抄出来的默认值/区间必然漂移。已经踩过一次: 控制台的 `shafts dens`
// 提示"默认 2.5", 而真正生效的 `readTuning('skybound.shaftDensK', 8.0, …)` 是 **8.0** ——
// 那个 2.5 是个从没被使用的装饰字段, 但足够让排查方向跑偏。
// 现在控制台命令与滑条面板**都从这里读**, 改一处两边同步。
//
// 三件东西要分清:
//   · `lo/hi`  —— 滑条范围, 也是 `readTuning` 的合法区间(**超范围会被读成默认值**);
//                 有一批被"构建级规矩"卡住的项(cov/dens/shape/cfw/detail/profile)区间**就是规矩值**。
//   · `def`    —— localStorage 键不存在时的出厂默认。⚠ 对 `unsetKeeps` 为真的项(库内部旋钮),
//                 "键不存在"意味着**不改库的值**(保持质量档给的数), 所以这里的 def 写的是
//                 **库 medium 档的生效值**(UI 显示与"重置此项"用它对得上)。
//   · `cost`   —— **性能开销等级**(§322 per user request: 滑条旁边要写清代价)。
//                 依据: §313 的实测成本排序 + §320 的"像素 vs 迭代"实测 + §302 的采样器复用。
//
// 面板用法: `tuner`(控制台) / `#tuner`(URL) / F2。面板只做"写 localStorage + 推一次
// `applyCloudKnobsNow`", 与手敲 `vcloud …` **完全是同一条路**, 所以两边读数必然一致。

/** 性能开销等级(实测口径, 见文件头) */
export type CostLevel = 'none' | 'low' | 'mid' | 'high' | 'linear';
export const COST_LABEL: Record<CostLevel, { text: string; color: string; tip: string }> = {
  none: { text: '免费', color: 'text-sky-300/70 border-sky-400/25', tip: '纯算术/开关, 不额外采样, 实测落在噪声里' },
  low: { text: '低', color: 'text-emerald-300/80 border-emerald-400/30', tip: '实测 <1.5ms, 或与像素数几乎无关' },
  mid: { text: '中', color: 'text-amber-300/85 border-amber-400/35', tip: '实测 1~5ms 量级' },
  high: { text: '高', color: 'text-orange-300 border-orange-400/40', tip: '实测 >5ms, 是主要成本项' },
  linear: { text: '线性', color: 'text-red-300 border-red-400/45', tip: '与取值近似成正比 —— 第一大头(主 march 迭代)' },
};

/** 一个数值旋钮 */
export interface CloudKnob {
  /** 控制台短名: `vcloud <name> <value>` */
  name: string;
  /** localStorage 键 */
  key: string;
  lo: number;
  hi: number;
  def: number;
  step: number;
  label: string;
  /** 仅显示用(不参与计算) */
  unit?: string;
  /** 键不存在时"不动库的值"(库内部旋钮) —— 见文件头 `def` 的说明 */
  unsetKeeps?: boolean;
  /** 额外说明(UI 第二行小字) */
  hint?: string;
  /**
   * 控制台子命令(不含 `vcloud ` 前缀与值)。默认 = `name`; 只有"名字在不同组里重名"的项才需要
   * 显式给(如光柱的 `shafts dens`)。**面板写 localStorage 一律用 `key`, 导出命令一律用 `cmd`** ——
   * 混用会出现"拖了没反应"(§323 的真实 bug: 云组与光柱组都有 `dens`, 名字→旋钮的映射只留了后者)。
   */
  cmd?: string;
  /** 性能开销等级(滑条旁边那个小标签) */
  cost: CostLevel;
}

export interface CloudKnobGroup {
  label: string;
  note?: string;
  items: CloudKnob[];
}

/** 一个布尔旋钮(存 '1'/'0', 或 'on'/'off' 由 `values` 决定) */
export interface CloudFlag {
  name: string;
  key: string;
  label: string;
  def: boolean;
  /** true = 改完要重进关/刷新才生效(云 pass 是建链时建的) */
  needsReload?: boolean;
  hint?: string;
  values?: [string, string];
  /** 三态(cover3d 的 unpatched) 用 `extra` 补一个按钮 */
  extra?: { label: string; value: string }[];
  cost?: CostLevel;
}

export interface CloudFlagGroup {
  label: string;
  note?: string;
  items: CloudFlag[];
}

// === ① 噪点 / 分辨率 / 性能(最常调, 放最上面) =====================================
// per user request: "噪波参数和分辨率应该需要可以以滑条调整" —— 它们本来就有滑条, 但排在
// 面板最下面(要滚动), 而且**分辨率上限被夹在 1**, 这条最划算的降噪路是堵死的。§322 一起解决:
// 上限放到 3, 并把这一组提到顶部 + 每项标开销。
export const CLOUD_NOISE_KNOBS: CloudKnob[] = [
  { name: 'res', key: 'skybound.cloudResScale', lo: 0.25, hi: 3, def: 1.6, step: 0.05, label: 'march 分辨率比例', cost: 'low',
    hint: '>1 = march 比画布更细(实测 9 倍像素只 +0.14ms, 最划算的画质路); 0.5 = 像素数 1/4(会糊成方块)' },
  { name: 'steps', key: 'skybound.cloudSteps', lo: 20, hi: 500, def: 95, step: 5, label: '主 march 迭代上限', unsetKeeps: true, cost: 'linear',
    hint: '最大成本项(近似线性): 500/250/120/40 => 23.7/12.5/6.8/4.8ms。门控态自动压到 2' },
  { name: 'minstep', key: 'skybound.cloudMinStep', lo: 10, hi: 500, def: 70, step: 5, unit: 'm', label: '步长下限', unsetKeeps: true, cost: 'high',
    hint: '与 ray 一起决定步数 = 距离/步长; 小=更细但步数更多' },
  { name: 'maxstep', key: 'skybound.cloudMaxStep', lo: 100, hi: 5000, def: 1000, step: 50, unit: 'm', label: '步长上限', unsetKeeps: true, cost: 'mid',
    hint: '大 = 远处更快跳过(省), 但层内结构变粗' },
  { name: 'mintrans', key: 'skybound.cloudMinTrans', lo: 0.001, hi: 0.5, def: 0.01, step: 0.001, label: '最小透过率', unsetKeeps: true, cost: 'low',
    hint: '越大主 march 越早终止(省); 太大厚云内部会被截断变平' },
  { name: 'taps', key: 'skybound.cloudSpatialTaps', lo: 4, hi: 9, def: 9, step: 1, label: '去噪抽头数', cost: 'low',
    hint: '4=十字(省 44% 抽取)/5=十字+中/9=3×3(默认, 最干净)' },
  { name: 'spread', key: 'skybound.cloudSpatialSpread', lo: 1, hi: 2.5, def: 1, step: 0.1, unit: 'texel', label: '去噪采样半径', cost: 'none',
    hint: '实测往大调更噪(间距一大抽头就不相关), 保持 1' },
  { name: 'sharp', key: 'skybound.cloudSpatialSharp', lo: 0.005, hi: 2, def: 0.12, step: 0.005, label: '去噪亮度灵敏度', cost: 'none',
    hint: '比 0.12 松(0.4)会变噪; 更紧(0.05)会撕边' },
  { name: 'range', key: 'skybound.cloudSpatialRange', lo: 20, hi: 20000, def: 900, step: 20, unit: 'm', label: '去噪深度灵敏度', cost: 'none',
    hint: '小 = 敢跨深度混合(天地交界处易糊)' },
  { name: 'clamp', key: 'skybound.cloudSpatialClamp', lo: 0, hi: 8, def: 2.5, step: 0.1, unit: 'σ', label: '离群钳制', cost: 'none',
    hint: '治突兀白点; 0=关; 实测只动几百个最极端像素, 但确实生效(最大 0.086 亮度)' },
  { name: 'soft', key: 'skybound.cloudSpatialSoft', lo: 0, hi: 1, def: 0, step: 0.05, label: '涂抹(绕过双边权重)', cost: 'none',
    hint: '成片噪点/云边串珠的急救: 0.3~0.5 明显变干净, 代价是边缘变糊(实测 p99 -29%)' },
  { name: 'fark', key: 'skybound.cloudSpatialFar', lo: 0, hi: 4, def: 2.0, step: 0.1, unit: 'texel', label: '远景附加环半径', cost: 'low',
    hint: '只对"远处"多采一圈(4 次额外读); ≤1=关' },
  { name: 'farm', key: 'skybound.cloudSpatialFarM', lo: 500, hi: 60000, def: 6000, step: 100, unit: 'm', label: '判定"远"的距离', cost: 'none' },
];

// === ② 云体形状(最影响"长什么样") ================================================
export const CLOUD_SHAPE_KNOBS: CloudKnob[] = [
  { name: 'base', key: 'skybound.cloudBaseM', lo: 200, hi: 12000, def: 7200, step: 50, unit: 'm', label: '云底高度', cost: 'none' },
  { name: 'top', key: 'skybound.cloudTopM', lo: 400, hi: 16000, def: 9200, step: 50, unit: 'm', label: '云顶高度', cost: 'none' },
  { name: 'shape', key: 'skybound.cloudShapeAmt', lo: 0.05, hi: 1, def: 0.4, step: 0.01, label: '形状调制(3D 噪声占比)', cost: 'none', hint: '规矩 0.4; 大=碎/小=实心块' },
  { name: 'cfw', key: 'skybound.cloudCovFilter', lo: 0.05, hi: 1, def: 0.7, step: 0.01, label: '覆盖率过渡带', cost: 'none', hint: '规矩 0.7; 小=边缘锐易切糕, 大=碎' },
  { name: 'detail', key: 'skybound.cloudDetailAmt', lo: 0, hi: 1, def: 0.3, step: 0.01, label: '细节侵蚀(菜花边)', cost: 'low', hint: '规矩 0.3; 每步多一次细节采样 => 代价与 steps 相乘' },
  { name: 'wex', key: 'skybound.cloudWex', lo: 0.1, hi: 8, def: 1.0, step: 0.05, label: '天气指数', cost: 'none' },
  { name: 'profile', key: 'skybound.cloudProfile', lo: 0, hi: 1, def: 0.6, step: 0.01, label: '竖直密度廓线', cost: 'none', hint: '规矩 0.6; 小=压云底, 大=堆云顶' },
  { name: 'wind', key: 'skybound.cloudWind', lo: 0, hi: 1, def: 0, step: 0.01, label: '风(0=静止)', cost: 'none', hint: '调画面时设 0 最省事' },
];

// === ③ 密度 / 距离 / 增益 / 时域 ================================================
export const CLOUD_EXTRA_KNOBS: CloudKnob[] = [
  { name: 'dens', key: 'skybound.cloudDensK', lo: 0.01, hi: 0.2, def: 0.2, step: 0.005, label: '密度倍率', cost: 'low', hint: '规矩上限 0.2(硬夹); 密度高 => 主 march 更早终止' },
  { name: 'cov', key: 'skybound.cloudCovK', lo: 0.05, hi: 0.75, def: 0.75, step: 0.01, label: '覆盖率倍率', cost: 'low', hint: '规矩上限 0.75(硬夹)' },
  { name: 'ray', key: 'skybound.cloudRayKm', lo: 5, hi: 200, def: 120, step: 1, unit: 'km', label: '单条光线最远', cost: 'high', hint: '库默认 200; 越大掠射越糊、越贵(步数 = 距离/步长)' },
  { name: 'gain', key: 'skybound.cloudsGain', lo: 0.02, hi: 200, def: 3.0, step: 0.05, label: '云增益基准', cost: 'none', hint: '实际 = 基准 × atmo exp' },
  { name: 'shadow', key: 'skybound.cloudShadowK', lo: 0, hi: 1, def: 0.55, step: 0.01, label: '地面云影强度', cost: 'low', hint: '要配合"地面云影"总开关' },
  { name: 'tvar', key: 'skybound.cloudTVarGamma', lo: 0.25, hi: 8, def: 1, step: 0.05, label: '时域方差裁剪 gamma', cost: 'none', hint: '仅时域路径; 越小越稳(库 2)' },
  { name: 'talpha', key: 'skybound.cloudTAlpha', lo: 0.01, hi: 0.5, def: 0.05, step: 0.01, label: '时域混合 alpha', cost: 'none', hint: '仅时域路径; 大=跟手, 小=稳(库 0.1)' },
];

// === ④ pass 内部(库的旋钮; 键不存在 = 不动库) ====================================
// 注: steps/minstep/maxstep/mintrans 已挪到 ① 噪点组(避免两处重复), 这里只剩这几项。
export const CLOUD_PERF_KNOBS: CloudKnob[] = [
  { name: 'sunsteps', key: 'skybound.cloudSunSteps', lo: 0, hi: 8, def: 2, step: 1, label: '到太阳的次级 march', unsetKeeps: true, cost: 'low', hint: '每个受光样本的次级 march 步数' },
  { name: 'groundsteps', key: 'skybound.cloudGroundSteps', lo: 0, hi: 8, def: 1, step: 1, label: '到地面的次级 march', unsetKeeps: true, cost: 'low' },
  { name: 'octaves', key: 'skybound.cloudOctaves', lo: 1, hi: 8, def: 8, step: 1, label: '多次散射阶数', unsetKeeps: true, cost: 'low', hint: '厚云内部透亮/体积感; 实测落在 <1.5ms 噪声里' },
];

// === ⑤ 太阳(方向光)强度 —— real-time knob (per user request) ==================
// `sunk` 是**倍率**(不是绝对值): 保留关卡/编辑器对每个任务的太阳强度设定(夜战的"月亮" sunI 很小),
// 只在你给的基准上乘。关卡的天空/云亮度走的是另一条(大气辐照度 = cfg.sunI), 现场要调天空用 `atmo exp`。
export const SUN_KNOBS: CloudKnob[] = [
  { name: 'sunk', key: 'skybound.sunK', lo: 0, hi: 4, def: 1, step: 0.05, label: '太阳光强度(倍率)', cost: 'none', hint: '0 = 无直射光(只剩天光) / 1 = 关卡原设定 / >1 更刺眼; 阴影会随之变深' },
];

// === ⑥ 机体自阴影(投影贴花, per user request: 要一个实时调"飞机自身阴影强度"的滑条) ==========
// 单个强度旋钮  0..2: 0=关, 1=现在的默认(最大强度), >1 = 继续压暗 ——
//   引擎侧把它拆成 strength(0..1) + floor/ambient(往"全黑/天光也全挡"插值), 于是"越大越明显"单调成立。
export const AIRCRAFT_SHADOW_KNOBS: CloudKnob[] = [
  { name: 'psx', key: 'skybound.psxStrength', lo: 0, hi: 2, def: 2, step: 0.05, label: '机体自阴影强度', cost: 'low', hint: '0=关 / 1=当前默认 / >1 继续压暗(同时压floor+挡天光) —— 越大越明显' },
  { name: 'psxhalf', key: 'skybound.psxHalf', lo: 8, hi: 200, def: 16, step: 1, unit: 'm', label: '自阴影覆盖半径', cost: 'low', hint: '投影相机半宽; 太小会把远处机身切掉' },
  { name: 'psxsoft', key: 'skybound.psxSoft', lo: 0, hi: 8, def: 1.5, step: 0.25, unit: 'texel', label: '阴影软边', cost: 'low', hint: '0=硬边(锯齿) / 3=默认 / 8=更糊' },
  { name: 'psxres', key: 'skybound.psxSize', lo: 256, hi: 4096, def: 1024, step: 128, unit: 'px', label: '自阴影贴图分辨率', cost: 'mid', hint: '改它会重建 RT(一次性的卡顿)' },
];

// === ⑥ 云隙光柱(丁达尔) ========================================================
export const CLOUD_SHAFT_KNOBS: CloudKnob[] = [
  { name: 'shafts-dens', cmd: 'shafts dens', key: 'skybound.shaftDensK', lo: 0.1, hi: 40, def: 12.6, step: 0.1, label: '光柱强度(霾密度倍率)', unsetKeeps: true, cost: 'none', hint: '用户定的预设 12.6(库默认 8.0; 控制台旧提示里的 2.5 是错的)' },
  { name: 'exp', key: 'skybound.shaftExpK', lo: 0.05, hi: 5, def: 1.8, step: 0.05, label: '光柱衰减(霾标高倍率)', unsetKeeps: true, cost: 'none', hint: '用户定的预设 1.8; 库标高 1km ⇒ 巡航高度看不到(0.3 才抬到 ~3.3km)' },
  { name: 'samp', key: 'skybound.shaftSamples', lo: 8, hi: 500, def: 8, step: 8, label: 'shadow-length 采样上限', unsetKeeps: true, cost: 'high', hint: '全屏第二遍 march(§313 第 4 大头); 门控态自动压到 8' },
  { name: 'opaque', key: 'skybound.shaftOpaqueK', lo: 0.1, hi: 6, def: 1.3, step: 0.1, label: '云实度=>光柱对比', unsetKeeps: true, cost: 'none' },
  { name: 'shafts-ray', cmd: 'shafts ray', key: 'skybound.shaftRayKm', lo: 5, hi: 200, def: 5, step: 1, unit: 'km', label: '光柱射线最远', unsetKeeps: true, cost: 'mid' },
];

// === ⑥ 3D 覆盖率(§302; 默认关) ==================================================
export const CLOUD_COVER3D_KNOBS: CloudKnob[] = [
  { name: 'k', key: 'skybound.cloudCover3DK', lo: 0, hi: 1, def: 1, step: 0.01, label: '强度(lerp 系数)', cost: 'none', hint: '0 = 恒等透传(等于关)' },
  // 掩码已改为"高度包络"(只随高度变化, 不采 3D 场) ⇒ 频率倍率不再起作用。保留是为了能回退对比。
  { name: 'scale', key: 'skybound.cloudCover3DScale', lo: 0.1, hi: 4, def: 1.2, step: 0.05, label: '(已失效)3D 场频率', cost: 'none', hint: '掩码改版后不再采 3D 场 ⇒ 这项当前无效' },
  { name: 'bias', key: 'skybound.cloudCover3DBias', lo: -0.3, hi: 0.3, def: 0, step: 0.01, label: '高度包络阈值', cost: 'none', hint: '>0 = 只在云带中段留云(挖得更狠); <0 = 更保守/近满云' },
];

/** 面板里按组展示(顺序 = 面板里从上到下) */
export const CLOUD_KNOB_GROUPS: CloudKnobGroup[] = [
  { label: '噪点 / 分辨率 / 性能', note: '降噪优先级: 先看 res, 再看 steps/minstep, 最后才动去噪权重; 标签是实测开销', items: CLOUD_NOISE_KNOBS },
  { label: '云体形状', note: '最直接决定"云长什么样"', items: CLOUD_SHAPE_KNOBS },
  { label: '密度 / 距离 / 增益 / 时域', items: CLOUD_EXTRA_KNOBS },
  { label: 'pass 内部', note: '键没动过时显示的是"库当前档位的值"', items: CLOUD_PERF_KNOBS },
  { label: '光柱(丁达尔)', note: '改完用 vcloud shafts 确认覆盖率 ≥0.2(否则霾为 0、光柱消失)', items: CLOUD_SHAFT_KNOBS },
  { label: '太阳 / 光照', note: '倍率; 天空亮度另有 atmo exp', items: SUN_KNOBS },
  { label: '机体自阴影(投影贴花)', note: '单个强度旋钮: 0=关 / 1=默认 / >1 继续压暗', items: AIRCRAFT_SHADOW_KNOBS },
  { label: '3D 覆盖率', note: '默认关(off = 注入保留但恒等透传)', items: CLOUD_COVER3D_KNOBS },
];

/** 名字 → 旋钮(跨组索引; UI 与自检用) */
export const CLOUD_KNOB_BY_NAME: Map<string, CloudKnob> = new Map(
  CLOUD_KNOB_GROUPS.flatMap((g) => g.items).map((k) => [k.name, k] as const),
);

/** localStorage 键 → 旋钮(反向) */
export const CLOUD_KNOB_BY_KEY: Map<string, CloudKnob> = new Map(
  CLOUD_KNOB_GROUPS.flatMap((g) => g.items).map((k) => [k.key, k] as const),
);

/** 全部数值旋钮(扁平; `vcloud reset` 的键表与快照/导出都从它取) */
export const CLOUD_ALL_KNOBS: CloudKnob[] = CLOUD_KNOB_GROUPS.flatMap((g) => g.items);

// === 布尔/档位 ==================================================================
export const CLOUD_FLAG_GROUPS: CloudFlagGroup[] = [
  {
    label: '总开关',
    note: '云 pass 是建链时建的 => 这两项要下一次进关/刷新才生效',
    items: [
      { name: 'on/off', key: 'skybound.volumeClouds', label: '体积云总开关', def: true, needsReload: true, values: ['on', 'off'], hint: '§336 起默认开(键缺席=开); 关掉退回贴片云(下一关生效)', cost: 'none' },
      { name: 'cover3d on/off/unpatched', key: 'skybound.cloudCover3D', label: '3D 覆盖率', def: false, values: ['on', 'off'], extra: [{ label: '还原成库原文', value: 'unpatched' }], cost: 'none' },
    ],
  },
  {
    label: '阴影',
    items: [
      { name: 'selfshadow', key: 'skybound.cloudSelfShadow', label: '云的自身投影(BSM)', def: true, values: ['on', 'off'], hint: '开=云有底部暗部/层次(§333 起默认开; 实测 +2.0ms)', cost: 'mid' },
      { name: 'cloudshadow', key: 'skybound.cloudShadow', label: '地面云影', def: true, values: ['on', 'off'], hint: '开=云影打到地形(§333 起默认开; 实测 +0.4ms), 强度用"地面云影强度"滑条', cost: 'low' },
    ],
  },
  {
    label: '性能门控 / 重建(降噪相关的三个开关都在这)',
    items: [
      { name: 'rayauto', key: 'skybound.cloudRayAuto', label: '视锥裁剪 march(门控)', def: true, values: ['on', 'off'], hint: '默认 on; 关掉可复现旧的"天顶白跑"行为', cost: 'none' },
      { name: 'rayclamp', key: 'skybound.cloudRayClamp', label: '按视锥几何裁渲染距离', def: true, values: ['on', 'off'], hint: '关 = 渲染距离只由"单条光线最远"决定(你说了算); 开 = 引擎按视锥上界再裁一刀', cost: 'high' },
      { name: 'tup', key: 'skybound.cloudTemporal', label: '时域上采样', def: false, values: ['on', 'off'], hint: '别关: 关了是全分辨率 march, 实测 141ms/帧', cost: 'high' },
      { name: 'spatial', key: 'skybound.cloudSpatial', label: '单帧空间滤波(去噪核心)', def: true, values: ['on', 'off'], hint: 'off = 回到库的时域解析图(有拖影; 且静态抖动会把噪点锁成固定图案)', cost: 'none' },
      { name: 'staticjitter', key: 'skybound.cloudStaticJitter', label: '静态抖动', def: true, values: ['on', 'off'], hint: '噪声固定成图案才被空间滤波吃掉; 必须与 spatial=on 配套, 单开会把噪点冻住', cost: 'none' },
      { name: 'shafts', key: 'skybound.lightShafts', label: '云隙光柱', def: false, values: ['on', 'off'], cost: 'high' },
    ],
  },
  {
    label: 'pass 内部开关(每步多一次采样)',
    items: [
      { name: 'sdetail', key: 'skybound.cloudShapeDetail', label: '形状细节(每步 +1 次 3D 采样)', def: true, values: ['1', '0'], cost: 'mid' },
      { name: 'turb', key: 'skybound.cloudTurb', label: '湍流', def: true, values: ['1', '0'], cost: 'low' },
      { name: 'haze', key: 'skybound.cloudHaze', label: '霾内散射', def: true, values: ['1', '0'], hint: '光柱靠它(覆盖率<0.2 时霾为 0)', cost: 'low' },
      { name: 'acc', key: 'skybound.cloudAcc', label: '精确太阳/天光', def: false, values: ['1', '0'], hint: '每步更多纹理读; 大范围/晨昏光照更真', cost: 'mid' },
    ],
  },
];

/**
 * 重名自检(§323): 名字是"面板写键 / 导出命令"的主键, 一旦两个描述项重名, 后者的映射会静默覆盖
 * 前者 ⇒ 表现为"某个滑条拖了没反应"。这里在模块加载时列出冲突, 并由 `cloudDiagText()` 报出来。
 */
export const CLOUD_NAME_COLLISIONS: string[] = (() => {
  const seen = new Map<string, number>();
  for (const k of CLOUD_ALL_KNOBS) seen.set(k.name, (seen.get(k.name) ?? 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([n]) => n);
})();
if (CLOUD_NAME_COLLISIONS.length) {
  console.error('[cloud-knobs] 旋钮名冲突(会让面板/导出用错键):', CLOUD_NAME_COLLISIONS);
}

/** 导出成控制台命令(用 `cmd` 而不是 `name`) */
export function cloudKnobCmd(k: CloudKnob, v: number): string {
  return `vcloud ${k.cmd ?? k.name} ${v}`;
}

export const CLOUD_ALL_FLAGS: CloudFlag[] = CLOUD_FLAG_GROUPS.flatMap((g) => g.items);

/** 开关名 → 开关 */
export const CLOUD_FLAG_BY_NAME: Map<string, CloudFlag> = new Map(
  CLOUD_FLAG_GROUPS.flatMap((g) => g.items).map((f) => [f.name, f] as const),
);
