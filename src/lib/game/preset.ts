// === 默认预设 (per user request: 把本会话设定的设置固化为预设设置) ===
// On first launch (key absent in localStorage) these values are seeded so a
// fresh player gets the session-tuned configuration — mouse-aim mode, the
// locked view-centre, sprite/overcast clouds, the default volumes etc. The
// player can still change everything in Settings afterwards; existing saves
// are never overwritten.
export const DEFAULT_PRESET: Record<string, string> = {
  'skybound.controlMode': 'mouseAim',
  'skybound.maFloat': '0',        // 视野中心锁死（不飘）
  'skybound.maSens': '1',         // 视角灵敏度 ×1.0
  // === 虚拟按键 (§336 起默认关) ==============================================
  // ⚠ 这里**刻意不种这个键**: 它的默认值交给 device-mode 的 auto-on 规则
  //   (`isVirtualJoystickEnabled` → resolveAutoOnSetting):
  //     桌面  未设置 ⇒ 关(= 用户要的默认)
  //     手持  未设置 ⇒ **开**(触屏没有键鼠, 种死 'off' 等于手机没法玩)
  //   老预设把 'on' 种进了存档, 由 PRESET_MIGRATIONS 的 v3->v4 迁到 'off'。
  //   (种键会盖住上面这条规则, 所以只能靠"缺席"来表达默认。)
  // 'skybound.virtualJoystick': 'off',
  // === 云: 默认「体积云开 + 贴图云关」(per user request) ===
  // 两套云画的是同一个东西, 仓库本来就有"体积云开着时强制关贴片云"的逻辑(engine 里
  // cloudBillboardsOn 的 `!takramCloudsOn`)。这里把出厂预设也定成这个组合:
  //   cloudMode 'off' + cloudBillboards 'off' = 贴片云不入场景(零绘制)
  //   volumeClouds 'on'                       = @takram 物理体积云接管
  // ⚠ 手机档(device-mode 判定为手持)会把体积云强制关掉 —— 那时引擎让贴片云兜底,
  //   否则天空会一片云都没有(见 engine 里 cloudBillboardsOn 的设备档让路)。
  'skybound.cloudMode': 'off',
  'skybound.cloudBillboards': 'off',
  'skybound.volumeClouds': 'on',
  'skybound.cloudCoverage': 'overcast',
  'skybound.difficulty': 'normal',
  'skybound.gunAim': 'on',        // 机炮自动瞄准
  'skybound.ssr': 'off',
  'skybound.bloom': 'on',
  // === AO 全关 (per user request) ==========================================
  // GTAO 与 SSAO 都默认关。GTAO 是整帧最大的一笔固定开销(实测 4.3~4.8ms @1912x956,
  // 主要是它要重渲一遍 MeshNormalMaterial 场景), 关掉它换来的帧时远比它带来的
  // 接触遮蔽值钱; SSAO 本来默认就关, 这里显式写出来是为了让"所有 AO 选项都关"
  // 在出厂预设里可见可查。要开在设置里手动开(键语义不变: 只有显式 'on' 才开)。
  'skybound.gtao': 'off',
  'skybound.ssao': 'off',
  // === 静态正交平行光 (per user request) ==================================
  // 用户: "能不能让整个关卡都用静态正交平行光, 因为没有实时修改太阳角度的要求"。
  // 能, 而且它就是这个项目的正确默认 —— 太阳角度固定 ⇒ 一盏固定的正交平行光
  // 覆盖整个战区就够, 阴影不再随相机级联游移(机体这种小物体的投影也就不会
  // 一直闪)。机体自身的动态自阴影由 `projected-shadow`(贴花式注入, 只压直接光
  // 累计项、保留 IBL)提供, 与 CSM 无关, 也不占 three 的阴影灯预算。
  'skybound.staticShadow': 'on',
  'skybound.csm': 'off',
  // === PBR 贴图质量 (per user request: 纹理性能优化) ===
  'skybound.textureQuality': 'high',
  // === PC 帧率上限 (per user request: 最大帧率限制) ===
  'skybound.fpsCap': '0',
  // === 渲染管线 (per user request: 延迟渲染实验管线) ===
  // 默认前向（稳定）；deferred/auto 由用户在设置里切换。
  'skybound.pipeline': 'forward',
  'skybound.volumeMaster': '0.8',
  'skybound.volumeMusic': '0.3',
  'skybound.volumeSfx': '0.8',
  'skybound.volumeEngine': '0.6',
  'skybound.volumeWind': '0.5',
};

/**
 * 预设版本 + 一次性迁移。
 *
 * 为什么需要: 上面的 seed **只在键不存在时**写入。老存档里 `skybound.staticShadow`
 * 已经被上一版预设写成 `'off'` 了 → 光改 DEFAULT_PRESET 对老玩家无效。
 * 但无条件覆盖又会踩掉"用户自己在设置里改过"的值。
 *
 * 折中: 只有当键的当前值**仍等于旧预设默认值**(即用户从没动过它)时才迁移到新默认。
 * 用户手动改过的值一律保留。版本号写在 localStorage, 每档只迁移一次。
 */
const PRESET_VERSION_KEY = 'skybound.presetVersion';
const PRESET_VERSION = '4';   // §336: 关贴图云/开体积云/关虚拟按键/关所有 AO
const PRESET_MIGRATIONS: Array<{ key: string; from: string; to: string }> = [
  // v1 → v2: 关卡阴影默认从"CSM / 贴身自阴影灯"改为"静态正交平行光"。
  // (旧 v1 预设把它种成 'off'; 而 'off' 会落到那盏 intensity=0 的自阴影灯上 ——
  //  见 engine.ts 里 useTight 处关于 three 阴影只乘本灯颜色的说明。)
  { key: 'skybound.staticShadow', from: 'off', to: 'on' },
  { key: 'skybound.csm', from: 'on', to: 'off' },
  // v2 → v3: 把"投影贴花自阴影"打开。它是**机体自阴影的唯一实现**
  // (关卡里那张 ±4000/4096 的静态大图只有 1.95 单位/纹素, 机体只跨约 10 个纹素,
  //  糊且会游走; 贴花是每帧把视锥紧贴机体 —— 与机库那套"固定小视锥"同一个思路)。
  // 老 UI 的默认显示是"关", 所以很多存档里是 'off'(并非有意关闭)。
  { key: 'skybound.selfShadowMap', from: 'off', to: 'on' },
  // v3 → v4 (per user request: 关贴图云/开体积云/关虚拟按键/关所有 AO):
  // 只迁移**上一版预设亲自种下去过的键**(等于"用户从没动过它"):
  //   · virtualJoystick 旧预设种的是 'on' ⇒ 迁到 'off'
  //   · cloudMode 旧预设种的是 'sprite' ⇒ 迁到 'off'(贴图云全关)
  // 而 cloudBillboards / gtao / ssao / volumeClouds 的"旧默认"是**键不存在**
  // (gtao 缺席=开, 其余缺席=关) —— 这些不需要迁移: applyDefaultPreset 的补种
  // 会把缺失的键直接写成新默认, 而用户显式改过的值(键存在)一律保留。
  { key: 'skybound.virtualJoystick', from: 'on', to: 'off' },
  { key: 'skybound.cloudMode', from: 'sprite', to: 'off' },
  // 这两项旧默认是"键不存在"(gtao 缺席=开) —— 正常存档里没有 'on' 字符串可匹配, 靠
  // 补种就能变成新默认。但**显式存过 'on' 的存档**(玩家自己开过 GTAO / 选过贴片云)会
  // 被"保留用户选择"的约定挡住, 于是"关掉所有 AO / 关贴图云"对那份存档不生效 ——
  // 用户这次的要求是**游戏默认就该是这个**, 所以 v4 一次性把显式的 'on' 也迁过来。
  // ⚠ 只迁这一次(版本戳 v4): 之后玩家在设置里再打开就一直听玩家的。
  { key: 'skybound.gtao', from: 'on', to: 'off' },
  { key: 'skybound.cloudBillboards', from: 'on', to: 'off' },
];

/** 出厂默认(阴影相关)的权威来源 —— 自动化钩子必须读它, 别再硬编码一份(历史上就是这样漂的)。
 *  `#autotest` 想量的就是"玩家实机默认", 所以它写进 localStorage 的值必须来自这里。 */
export function factoryShadowMode(): { csm: boolean; staticShadow: boolean } {
  const csm = DEFAULT_PRESET['skybound.csm'] === 'on';
  return { csm, staticShadow: DEFAULT_PRESET['skybound.staticShadow'] !== 'off' };
}

/** 把预设版本号"打上已应用"标记。
 *
 *  ⚠ 为什么必须有: `#autotest-csm` / `#autotest-static` 这类 hash 会**直接写**
 *  `skybound.csm`, 而 `applyDefaultPreset()` 的迁移判据是"当前值 == 旧默认值"
 *  —— 如果 hash 写进去的值恰好等于旧默认值(migration.from), 迁移就会把它**改掉**,
 *  hash 被静默吃掉(实测踩过: `#autotest-csm` 量出来还是静态阴影)。
 *  强制写完立刻打版本戳 ⇒ 那一次迁移被跳过, hash 的意图不会被覆盖。 */
export function markPresetApplied() {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(PRESET_VERSION_KEY, PRESET_VERSION); } catch { /* ignore */ }
}

/** Seed the preset into localStorage where the key is absent. */
export function applyDefaultPreset() {
  if (typeof window === 'undefined') return;
  try {
    // 先迁移(旧值 == 旧默认值才动), 再补种缺失的键。
    if (localStorage.getItem(PRESET_VERSION_KEY) !== PRESET_VERSION) {
      for (const m of PRESET_MIGRATIONS) {
        if (localStorage.getItem(m.key) === m.from) localStorage.setItem(m.key, m.to);
      }
      localStorage.setItem(PRESET_VERSION_KEY, PRESET_VERSION);
    }
    for (const [k, v] of Object.entries(DEFAULT_PRESET)) {
      if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    }
  } catch { /* ignore */ }
}
