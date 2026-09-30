import type { Mission } from './types';

export const MISSIONS: Mission[] = [
  {
    id: 'm13',
    codename: '试验·群山雪原',
    title: '新地形系统 · 群系雪山验证关',
    brief:
      '这是新地形系统的验收任务:雷达站群系雪山已经换成真实测绘生成的山脉 ' +
      '整图山脉(世界 48600m、峰顶 4320m),绕山飞行即可看到分块 LOD、' +
      '雪线分层与新山的全貌。一队敌机在山脊线上巡弋,打掉它们算完成。' +
      '飞行中按 ` 打开调试控制台,输入 fog 0.0002 之类即可实时调雾,方便对比能见度。',
    sky: 'day',
    // === 雪山雷达站(T-00)同款 HDRI 天空盒 (per user request) ===
    environment: 'textures/sky/evening.exr',
    weather: 'snow',
    map: 'custom',
    startAltitude: 2600,
    startSpeed: 460,
    startPos: [0, 2600, -9000],
    startHeading: 0,
    spawns: [
      { model: 'f16', role: 'wingman', position: [-80, 2590, -9100], heading: 0, altitude: 2590, isWingman: true, callsign: '雪鹰2号' },
      { model: 'f15', role: 'wingman', position: [80, 2590, -9100], heading: 0, altitude: 2590, isWingman: true, callsign: '雪鹰3号' },
    ],
    waves: [
      // 第一波:山脊巡弋编队(绕主峰)
      {
        waveNumber: 1,
        delayAfterPrevious: 3,
        banner: '第1/2波 — 山脊巡弋编队',
        spawns: [
          { model: 'su35', role: 'fighter', position: [2000, 2400, 4000], heading: Math.PI * 1.1, altitude: 2400, callsign: '巡弋1号' },
          { model: 'su35', role: 'fighter', position: [-2000, 2500, 4500], heading: Math.PI * 0.9, altitude: 2500, callsign: '巡弋2号' },
          { model: 'f16', role: 'fighter', position: [1500, 2300, 6000], heading: Math.PI * 1.0, altitude: 2300 },
          { model: 'f16', role: 'fighter', position: [-1500, 2300, 6000], heading: Math.PI * 1.0, altitude: 2300 },
        ],
      },
      // 第二波:雪原增援
      {
        waveNumber: 2,
        delayAfterPrevious: 6,
        banner: '第2/2波 — 雪原增援机队',
        spawns: [
          { model: 'f15', role: 'fighter', position: [0, 2800, 8000], heading: Math.PI, altitude: 2800, callsign: '增援1号' },
          { model: 'su35', role: 'fighter', position: [-1600, 2700, 7500], heading: Math.PI, altitude: 2700, callsign: '增援2号' },
          { model: 'su35', role: 'fighter', position: [1600, 2700, 7500], heading: Math.PI, altitude: 2700, callsign: '增援3号' },
        ],
      },
    ],
    objectives: [
      // === 过关目标 4 → 16 (per user request: 第一关测试关从击落 4 个提升到 16 个) ===
      { id: 'o1', label: '清除山脊巡弋编队', type: 'destroy', target: 'fighter', count: 16 },
      { id: 'o2', label: '击落雪原增援机队', type: 'destroy', target: 'any', count: 3 },
    ],
    timeLimit: 900,
    reward: '新地形验证合格证',
    recommendedCategories: ['fighter', 'attack', 'stealth'],
  },
  {
    id: 't00',
    codename: '行动·雪山突袭',
    title: '雪山突袭雷达站',
    brief:
      '关西空降第三突击队正在突袭关东边境的雪山预警雷达站——五门激光防空炮沿山脊一字排开。' +
      '驾驶你的战机为突击队清空空域、拔除激光炮，然后炸毁山谷中央的核心雷达站。' +
      '雷达站被摧毁后，关东王牌「雪鸮中队」将倾巢出动——他们机动极快、会规避导弹，' +
      '注意利用他们机体过热的窗口期。积雪山脊能见度偏低，保持警惕。',
    sky: 'day',
    // === HDRI 黄昏天空 (per user request: 第一关天空盒用 HDRI) ===
    environment: 'textures/sky/evening.exr',
    weather: 'snow',
    map: 'mountain',
    // === 全雪地形 (per user request: 雪山) ===
    terrain: {
      snowLine: 0.05,
      rockColor: '#3a3f45',
      grassColor: '#4a5558',
      sandColor: '#5a6068',
      snowColor: '#f4f8fc',
    },
    startAltitude: 2200,
    startSpeed: 476,
    startPos: [0, 2200, -8750],
    startHeading: 0,
    spawns: [
      // === 白隼小队僚机 (4 机) ===
      { model: 'f16', role: 'wingman', position: [-87, 2190, -8812], heading: 0, altitude: 2190, isWingman: true, callsign: '白隼2号' },
      { model: 'f16', role: 'wingman', position: [88, 2190, -8812], heading: 0, altitude: 2190, isWingman: true, callsign: '白隼3号' },
      { model: 'f15', role: 'wingman', position: [-250, 2200, -8875], heading: 0, altitude: 2200, isWingman: true, callsign: '白隼4号' },
      { model: 'f15', role: 'wingman', position: [250, 2200, -8875], heading: 0, altitude: 2200, isWingman: true, callsign: '白隼5号' },
    ],
    waves: [
      // 第一波·巡逻拦截：常规巡逻编队，打头阵消耗玩家弹药。
      {
        waveNumber: 1,
        delayAfterPrevious: 4,
        trigger: 'immediate',
        banner: '第1/4波 — 巡逻拦截机来袭',
        spawns: [
          { model: 'f16', role: 'fighter', position: [-1000, 2100, 4375], heading: Math.PI, altitude: 2100 },
          { model: 'f16', role: 'fighter', position: [1000, 2100, 4375], heading: Math.PI, altitude: 2100 },
          { model: 'f16', role: 'fighter', position: [-1875, 2300, 5625], heading: Math.PI, altitude: 2300 },
          { model: 'f16', role: 'fighter', position: [1875, 2300, 5625], heading: Math.PI, altitude: 2300 },
        ],
      },
      // 第二波·防空增援：摧毁第 1 门激光炮后，守备队战斗机分批进场。
      {
        waveNumber: 2,
        delayAfterPrevious: 6,
        trigger: 'laser1',
        banner: '第2/4波 — 守备队战斗机增援',
        spawns: [
          { model: 'f16', role: 'fighter', position: [-2500, 2200, 6875], heading: Math.PI, altitude: 2200 },
          { model: 'f16', role: 'fighter', position: [2500, 2200, 6875], heading: Math.PI, altitude: 2200 },
          { model: 'f15', role: 'fighter', position: [-1250, 2400, 7500], heading: Math.PI, altitude: 2400 },
          { model: 'f15', role: 'fighter', position: [1250, 2400, 7500], heading: Math.PI, altitude: 2400 },
          { model: 'f16', role: 'fighter', position: [0, 2600, 8125], heading: Math.PI, altitude: 2600 },
          { model: 'f15', role: 'fighter', position: [-3750, 2500, 8750], heading: Math.PI, altitude: 2500 },
        ],
      },
      // 第三波·守备总攻：摧毁第 2 门激光炮后，8 架分两队左右两翼包抄。
      {
        waveNumber: 3,
        delayAfterPrevious: 7,
        trigger: 'laser2',
        banner: '第3/4波 — 守备队两翼包抄',
        spawns: [
          { model: 'f16', role: 'fighter', position: [-4375, 2200, 5000], heading: Math.PI, altitude: 2200 },
          { model: 'f16', role: 'fighter', position: [-3500, 2300, 5625], heading: Math.PI, altitude: 2300 },
          { model: 'f15', role: 'fighter', position: [-5625, 2400, 6250], heading: Math.PI, altitude: 2400 },
          { model: 'f15', role: 'fighter', position: [-4750, 2500, 6875], heading: Math.PI, altitude: 2500 },
          { model: 'f16', role: 'fighter', position: [4375, 2200, 5000], heading: Math.PI, altitude: 2200 },
          { model: 'f16', role: 'fighter', position: [3500, 2300, 5625], heading: Math.PI, altitude: 2300 },
          { model: 'f15', role: 'fighter', position: [5625, 2400, 6250], heading: Math.PI, altitude: 2400 },
          { model: 'f15', role: 'fighter', position: [4750, 2500, 6875], heading: Math.PI, altitude: 2500 },
        ],
      },
      // 第四波·最终王牌：激光炮损失过半（≥3 门）后，雪鸮中队登场（锁血剧情后开战）。
      {
        waveNumber: 4,
        delayAfterPrevious: 8,
        trigger: 'laser3',
        banner: '雪鸮中队登场！',
        spawns: [
          { model: 'f15', role: 'fighter', position: [-3125, 2600, 6250], heading: Math.PI, altitude: 2600, callsign: '雪鸮1号', ace: true },
          { model: 'f15', role: 'fighter', position: [3125, 2600, 6250], heading: Math.PI, altitude: 2600, callsign: '雪鸮2号', ace: true },
          { model: 'f15', role: 'fighter', position: [0, 2800, 7500], heading: Math.PI, altitude: 2800, callsign: '雪鸮3号', ace: true },
          { model: 'f15', role: 'fighter', position: [-4375, 2700, 6875], heading: Math.PI, altitude: 2700, callsign: '雪鸮4号', ace: true },
          { model: 'f15', role: 'fighter', position: [4375, 2700, 6875], heading: Math.PI, altitude: 2700, callsign: '雪鸮5号', ace: true },
          { model: 'f15', role: 'fighter', position: [0, 3000, 8750], heading: Math.PI, altitude: 3000, callsign: '雪鸮6号', ace: true },
        ],
      },
    ],
    // === 固定点位地面单位 (per user request) ===
    // 5 门激光防空炮沿山脊一字排开 + 山谷中央核心雷达站 + 基地守备。
    groundSpawns: [
      { type: 'laser_aa', position: [-5000, 0, 3125], name: '激光防空炮 1' },
      { type: 'laser_aa', position: [-2500, 0, 2750], name: '激光防空炮 2' },
      { type: 'laser_aa', position: [0, 0, 2500], name: '激光防空炮 3' },
      { type: 'laser_aa', position: [2500, 0, 2750], name: '激光防空炮 4' },
      { type: 'laser_aa', position: [5000, 0, 3125], name: '激光防空炮 5' },
      { type: 'radar_station', position: [0, 0, 4750], name: '核心雷达站', hp: 220 },
      { type: 'sam_launcher', position: [-1875, 0, 5250], name: '守备队防空导弹' },
      { type: 'sam_launcher', position: [1875, 0, 5250], name: '守备队防空导弹' },
      { type: 'aa_vehicle', position: [-1000, 0, 5750], name: '守备队高炮' },
      { type: 'aa_vehicle', position: [1000, 0, 5750], name: '守备队高炮' },
      { type: 'aa_vehicle', position: [0, 0, 6250], name: '守备队高炮' },
    ],
    objectives: [
      { id: 'o1', label: '摧毁山脊上的 5 门激光防空炮', type: 'destroy', target: 'laser', count: 5 },
      { id: 'o2', label: '炸毁核心雷达站', type: 'destroy', target: 'radar', count: 1 },
      { id: 'o3', label: '全歼雪鸮王牌中队', type: 'destroy', target: 'ace', count: 6 },
    ],
    reward: '白隼小队首战勋章',
    recommendedCategories: ['fighter'],
  },
  {
    id: 'm01',
    codename: '行动·防波堤',
    title: '轰炸机拦截',
    brief:
      '敌方 B-52 战略轰炸机正扑向友军舰队。' +
      '从航母起飞，在它们进入武器投掷范围前将其拦截。' +
      '有战斗机护航，遇敌即可开火。敌人分三波来袭——在下一波到达前清除每一波。',
    sky: 'day',
    weather: 'clear',
    map: 'ocean',
    startAltitude: 1500,
    startSpeed: 446,
    startPos: [0, 1500, -6000],
    startHeading: 0,
    // === Wingmen + waves (per user request) ===
    // Wingmen spawn at mission start (defined in `spawns`); enemies arrive
    // in three escalating waves via `waves`. The first wave is the fighter
    // escort, the second is the main bomber formation, and the third is a
    // last-ditch counterattack by elite Su-35s.
    spawns: [
      // === Allied wingmen (RAPTOR flight — 4-ship) ===
      { model: 'f16', role: 'wingman', position: [-60, 1490, -6050], heading: 0, altitude: 1490, isWingman: true, callsign: '猛禽2号' },
      { model: 'f16', role: 'wingman', position: [60, 1490, -6050], heading: 0, altitude: 1490, isWingman: true, callsign: '猛禽3号' },
      { model: 'f15', role: 'wingman', position: [-180, 1500, -6100], heading: 0, altitude: 1500, isWingman: true, callsign: '猛禽4号' },
      { model: 'f15', role: 'wingman', position: [180, 1500, -6100], heading: 0, altitude: 1500, isWingman: true, callsign: '猛禽5号' },
    ],
    waves: [
      // Wave 1: enemy fighter escort sweeps ahead of the bombers.
      {
        waveNumber: 1,
        delayAfterPrevious: 0,
        banner: '第1/3波 — 战斗机护航编队来袭',
        spawns: [
          { model: 'f16', role: 'fighter', position: [-800, 1700, 7000], heading: Math.PI, altitude: 1700 },
          { model: 'f16', role: 'fighter', position: [800, 1700, 7000], heading: Math.PI, altitude: 1700 },
          { model: 'f16', role: 'fighter', position: [-1500, 1800, 8800], heading: Math.PI, altitude: 1800 },
          { model: 'f16', role: 'fighter', position: [1500, 1800, 8800], heading: Math.PI, altitude: 1800 },
        ],
      },
      // Wave 2: the main bomber formation. 5 B-52s + 2 Su-35 escorts.
      {
        waveNumber: 2,
        delayAfterPrevious: 6,
        banner: '第2/3波 — 发现轰炸机编队',
        spawns: [
          { model: 'b52', role: 'bomber', position: [0, 1400, 8000], heading: Math.PI, altitude: 1400, formationOffset: [0, 0, 0] },
          { model: 'b52', role: 'bomber', position: [-400, 1400, 8200], heading: Math.PI, altitude: 1400, formationOffset: [-400, 0, 200] },
          { model: 'b52', role: 'bomber', position: [400, 1400, 8200], heading: Math.PI, altitude: 1400, formationOffset: [400, 0, 200] },
          { model: 'b52', role: 'bomber', position: [-800, 1380, 8400], heading: Math.PI, altitude: 1380 },
          { model: 'b52', role: 'bomber', position: [800, 1380, 8400], heading: Math.PI, altitude: 1380 },
          { model: 'su35', role: 'fighter', position: [-1200, 1900, 7500], heading: Math.PI, altitude: 1900, callsign: '敌机1号' },
          { model: 'su35', role: 'fighter', position: [1200, 1900, 7500], heading: Math.PI, altitude: 1900, callsign: '敌机2号' },
        ],
      },
      // Wave 3: elite Su-35 counterattack.
      {
        waveNumber: 3,
        delayAfterPrevious: 8,
        banner: '第3/3波 — 精英侧卫来袭',
        spawns: [
          { model: 'su35', role: 'fighter', position: [-2000, 2100, 8000], heading: Math.PI, altitude: 2100, callsign: '敌机3号' },
          { model: 'su35', role: 'fighter', position: [2000, 2100, 8000], heading: Math.PI, altitude: 2100, callsign: '敌机4号' },
          { model: 'su35', role: 'fighter', position: [0, 2300, 9000], heading: Math.PI, altitude: 2300, callsign: '敌机5号' },
          { model: 'su35', role: 'fighter', position: [-2500, 2200, 8500], heading: Math.PI, altitude: 2200, callsign: '敌机6号' },
          { model: 'su35', role: 'fighter', position: [2500, 2200, 8500], heading: Math.PI, altitude: 2200, callsign: '敌机7号' },
        ],
      },
    ],
    objectives: [
      { id: 'o1', label: '摧毁敌方轰炸机', type: 'destroy', target: 'bomber', count: 5 },
      { id: 'o2', label: '歼灭护航战斗机', type: 'destroy', target: 'fighter', count: 11 },
    ],
    timeLimit: 420,
    reward: 'Naval commendation',
    recommendedCategories: ['fighter'],
  },
  {
    id: 'm02',
    codename: '行动·红色地平线',
    title: '舰队防御',
    brief:
      '侦测到大规模敌机编队正逼近友军航母战斗群。' +
      '守住防线，绝不能让任何轰炸机越过舰队防御线。' +
      '北方岛屿方向有多批敌机来袭——共三波。',
    sky: 'sunset',
    weather: 'cloudy',
    map: 'ocean',
    startAltitude: 1800,
    startSpeed: 510,
    startPos: [0, 1800, -3000],
    startHeading: 0,
    spawns: [
      // === Allied wingmen (VIPER flight — 4-ship) ===
      // Wingmen spawn at mission start; enemies arrive in waves below.
      { model: 'f16', role: 'wingman', position: [-60, 1790, -3050], heading: 0, altitude: 1790, isWingman: true, callsign: '蝰蛇2号' },
      { model: 'f16', role: 'wingman', position: [60, 1790, -3050], heading: 0, altitude: 1790, isWingman: true, callsign: '蝰蛇3号' },
      { model: 'f15', role: 'wingman', position: [-200, 1800, -3100], heading: 0, altitude: 1800, isWingman: true, callsign: '蝰蛇4号' },
      { model: 'f15', role: 'wingman', position: [200, 1800, -3100], heading: 0, altitude: 1800, isWingman: true, callsign: '蝰蛇5号' },
    ],
    // === Wave-based enemy spawns (per user request) ===
    // Each wave spawns MULTIPLE enemies simultaneously. The next wave only
    // spawns after the current wave is fully destroyed.
    waves: [
      // Wave 1: forward fighter sweep — 4 F-16s arrive together.
      {
        waveNumber: 1,
        delayAfterPrevious: 0,
        banner: '第1/3波 — 战斗机扫荡编队来袭',
        spawns: [
          { model: 'f16', role: 'fighter', position: [-600, 2000, 7000], heading: Math.PI, altitude: 2000 },
          { model: 'f16', role: 'fighter', position: [600, 2000, 7000], heading: Math.PI, altitude: 2000 },
          { model: 'f16', role: 'fighter', position: [-1200, 1800, 8500], heading: Math.PI, altitude: 1800 },
          { model: 'f16', role: 'fighter', position: [1200, 1800, 8500], heading: Math.PI, altitude: 1800 },
        ],
      },
      // Wave 2: bomber package with escort — 5 bombers + 2 Su-35s arrive together.
      {
        waveNumber: 2,
        delayAfterPrevious: 6,
        banner: '第2/3波 — 发现轰炸机群',
        spawns: [
          { model: 'b52', role: 'bomber', position: [-1500, 1500, 9000], heading: Math.PI, altitude: 1500 },
          { model: 'b52', role: 'bomber', position: [1500, 1500, 9000], heading: Math.PI, altitude: 1500 },
          { model: 'b52', role: 'bomber', position: [0, 1480, 9200], heading: Math.PI, altitude: 1480 },
          { model: 'tu95', role: 'bomber', position: [-2500, 1450, 9500], heading: Math.PI, altitude: 1450, callsign: '熊式8号' },
          { model: 'tu95', role: 'bomber', position: [2500, 1450, 9500], heading: Math.PI, altitude: 1450, callsign: '熊式9号' },
          { model: 'su35', role: 'fighter', position: [-1800, 2300, 7800], heading: Math.PI, altitude: 2300, callsign: '敌机12号' },
          { model: 'su35', role: 'fighter', position: [1800, 2300, 7800], heading: Math.PI, altitude: 2300, callsign: '敌机13号' },
        ],
      },
      // Wave 3: elite Su-35 ace squad — final gauntlet.
      {
        waveNumber: 3,
        delayAfterPrevious: 8,
        banner: '第3/3波 — 精英侧卫来袭',
        spawns: [
          { model: 'su35', role: 'fighter', position: [-2000, 2400, 8000], heading: Math.PI, altitude: 2400, callsign: '王牌1号' },
          { model: 'su35', role: 'fighter', position: [2000, 2400, 8000], heading: Math.PI, altitude: 2400, callsign: '王牌2号' },
          { model: 'su35', role: 'fighter', position: [0, 2600, 9000], heading: Math.PI, altitude: 2600, callsign: '王牌3号' },
          { model: 'su35', role: 'fighter', position: [-2800, 2500, 8500], heading: Math.PI, altitude: 2500, callsign: '王牌4号' },
          { model: 'su35', role: 'fighter', position: [2800, 2500, 8500], heading: Math.PI, altitude: 2500, callsign: '王牌5号' },
        ],
      },
    ],
    objectives: [
      { id: 'o1', label: '保卫友军舰队', type: 'protect', target: 'fleet', time: 240 },
      { id: 'o2', label: '歼灭全部敌机', type: 'destroy', target: 'any', count: 14 },
    ],
    allySpawns: [
      { position: [0, 0, -4500], hp: 100, name: '锚首号航母' },
      { position: [-800, 0, -4200], hp: 100, name: '风暴突破号驱逐舰' },
      { position: [800, 0, -4200], hp: 100, name: '铁壁号驱逐舰' },
    ],
    timeLimit: 240,
    reward: 'Defense ribbon',
    recommendedCategories: ['fighter', 'ew'],
  },
  {
    id: 'm03',
    codename: '行动·钢铁风暴',
    title: '夺取制空权',
    brief:
      '夺取战区制空权。八架敌方战斗机正在空域巡逻。' +
      '清扫空域，预计会遭遇激进机动与协同攻击。' +
      '祝好运，幽灵。',
    sky: 'storm',
    weather: 'storm',
    map: 'ocean',
    startAltitude: 2200,
    startSpeed: 574,
    startPos: [0, 2200, -5000],
    startHeading: 0,
    spawns: [
      // === Allied wingmen (GHOST flight — 4-ship) ===
      { model: 'f15', role: 'wingman', position: [-70, 2190, -5050], heading: 0, altitude: 2190, isWingman: true, callsign: '幽灵2号' },
      { model: 'f15', role: 'wingman', position: [70, 2190, -5050], heading: 0, altitude: 2190, isWingman: true, callsign: '幽灵3号' },
      { model: 'su35', role: 'wingman', position: [-200, 2200, -5100], heading: 0, altitude: 2200, isWingman: true, callsign: '幽灵4号' },
      { model: 'su35', role: 'wingman', position: [200, 2200, -5100], heading: 0, altitude: 2200, isWingman: true, callsign: '幽灵5号' },
      // === Enemy fighters (expanded to 12) ===
      { model: 'f16', role: 'fighter', position: [-1000, 2500, 6000], heading: Math.PI, altitude: 2500 },
      { model: 'f16', role: 'fighter', position: [1000, 2500, 6000], heading: Math.PI, altitude: 2500 },
      { model: 'f16', role: 'fighter', position: [-2000, 2300, 7000], heading: Math.PI, altitude: 2300 },
      { model: 'f16', role: 'fighter', position: [2000, 2300, 7000], heading: Math.PI, altitude: 2300 },
      { model: 'f16', role: 'fighter', position: [0, 2700, 5000], heading: Math.PI, altitude: 2700 },
      { model: 'f16', role: 'fighter', position: [-1500, 2800, 8000], heading: Math.PI, altitude: 2800 },
      { model: 'f16', role: 'fighter', position: [1500, 2800, 8000], heading: Math.PI, altitude: 2800 },
      { model: 'f16', role: 'fighter', position: [0, 3000, 9000], heading: Math.PI, altitude: 3000 },
      { model: 'su35', role: 'fighter', position: [-2500, 2600, 6500], heading: Math.PI, altitude: 2600, callsign: '侧卫1号' },
      { model: 'su35', role: 'fighter', position: [2500, 2600, 6500], heading: Math.PI, altitude: 2600, callsign: '侧卫2号' },
      { model: 'su35', role: 'fighter', position: [-1800, 2900, 9500], heading: Math.PI, altitude: 2900, callsign: '侧卫3号' },
      { model: 'su35', role: 'fighter', position: [1800, 2900, 9500], heading: Math.PI, altitude: 2900, callsign: '侧卫4号' },
    ],
    objectives: [
      { id: 'o1', label: '肃清战区全部敌机', type: 'destroy', target: 'any', count: 12 },
    ],
    timeLimit: 480,
    reward: 'Ace wings',
    recommendedCategories: ['fighter'],
  },
  {
    id: 'm04',
    codename: '行动·夜幕降临',
    title: '黎明巡逻 · 城市突袭',
    brief:
      '对敌方工业城市发动黎明突袭。苏-35 截击机与图-95 轰炸机正从城市机场起飞。' +
      '为攻击编队提供高空掩护，僚机实施压制。' +
      '小心高射炮，保持离地 800 英尺以上。',
    sky: 'dawn',
    weather: 'fog',
    map: 'city',
    startAltitude: 1800,
    startSpeed: 476,
    startPos: [-8000, 1800, -8000],
    startHeading: Math.PI / 4,
    spawns: [
      // === Allied wingmen (SUNRISE flight — 4-ship) ===
      { model: 'su35', role: 'wingman', position: [-8060, 1790, -8060], heading: Math.PI / 4, altitude: 1790, isWingman: true, callsign: '日出2号' },
      { model: 'su35', role: 'wingman', position: [-7940, 1790, -7940], heading: Math.PI / 4, altitude: 1790, isWingman: true, callsign: '日出3号' },
      { model: 'f16', role: 'wingman', position: [-8200, 1800, -8000], heading: Math.PI / 4, altitude: 1800, isWingman: true, callsign: '日出4号' },
      { model: 'f16', role: 'wingman', position: [-7800, 1800, -8120], heading: Math.PI / 4, altitude: 1800, isWingman: true, callsign: '日出5号' },
      // === Enemy interceptors (expanded to 6) ===
      { model: 'su35', role: 'interceptor', position: [-2000, 2000, 2000], heading: Math.PI * 1.25, altitude: 2000, callsign: '敌机1号' },
      { model: 'su35', role: 'interceptor', position: [2000, 2200, 2000], heading: Math.PI * 1.25, altitude: 2200, callsign: '敌机2号' },
      { model: 'su35', role: 'interceptor', position: [0, 2500, 3000], heading: Math.PI * 1.25, altitude: 2500, callsign: '敌机3号' },
      { model: 'su35', role: 'interceptor', position: [-3500, 2300, 2500], heading: Math.PI * 1.25, altitude: 2300, callsign: '敌机14号' },
      { model: 'su35', role: 'interceptor', position: [3500, 2300, 2500], heading: Math.PI * 1.25, altitude: 2300, callsign: '敌机15号' },
      { model: 'su35', role: 'interceptor', position: [0, 2800, 4500], heading: Math.PI * 1.25, altitude: 2800, callsign: '敌机16号' },
      // === Enemy bombers (expanded to 4) ===
      { model: 'tu95', role: 'bomber', position: [-1500, 1800, 5000], heading: Math.PI * 1.25, altitude: 1800, callsign: '熊式1号' },
      { model: 'tu95', role: 'bomber', position: [1500, 1800, 5000], heading: Math.PI * 1.25, altitude: 1800, callsign: '熊式2号' },
      { model: 'tu95', role: 'bomber', position: [-3000, 1750, 5500], heading: Math.PI * 1.25, altitude: 1750, callsign: '熊式10号' },
      { model: 'tu95', role: 'bomber', position: [3000, 1750, 5500], heading: Math.PI * 1.25, altitude: 1750, callsign: '熊式11号' },
      // === Enemy fighters ===
      { model: 'f16', role: 'fighter', position: [3000, 2400, 4000], heading: Math.PI * 1.25, altitude: 2400 },
      { model: 'f16', role: 'fighter', position: [-3000, 2400, 4000], heading: Math.PI * 1.25, altitude: 2400 },
      { model: 'f16', role: 'fighter', position: [0, 2600, 3500], heading: Math.PI * 1.25, altitude: 2600 },
    ],
    objectives: [
      { id: 'o1', label: '摧毁图-95轰炸机', type: 'destroy', target: 'bomber', count: 4 },
      { id: 'o2', label: '歼灭苏-35截击机', type: 'destroy', target: 'fighter', count: 9 },
    ],
    timeLimit: 480,
    reward: 'Sunrise commendation',
    recommendedCategories: ['fighter', 'stealth'],
  },
  {
    id: 'm05',
    codename: '行动·暴风雨',
    title: '风暴航线 · 山地伏击',
    brief:
      '雷暴前锋笼罩高山走廊，敌机正利用恶劣天气钻雷达网的空子。' +
      '在它们翻越山脊前截住机群。' +
      '报告称有强烈颠簸与闪电——飞行时保持机警。',
    sky: 'storm',
    weather: 'storm',
    map: 'mountain',
    startAltitude: 3000,
    startSpeed: 544,
    startPos: [0, 3000, -7500],
    startHeading: 0,
    spawns: [
      // === Allied wingmen (THUNDER flight — 4-ship) ===
      { model: 'f15', role: 'wingman', position: [-87, 2990, -7562], heading: 0, altitude: 2990, isWingman: true, callsign: '雷鸣2号' },
      { model: 'f15', role: 'wingman', position: [88, 2990, -7562], heading: 0, altitude: 2990, isWingman: true, callsign: '雷鸣3号' },
      { model: 'f16', role: 'wingman', position: [-250, 3000, -7625], heading: 0, altitude: 3000, isWingman: true, callsign: '雷鸣4号' },
      { model: 'f16', role: 'wingman', position: [250, 3000, -7625], heading: 0, altitude: 3000, isWingman: true, callsign: '雷鸣5号' },
      // === Enemy interceptors (expanded to 10) ===
      { model: 'su35', role: 'interceptor', position: [-1875, 3200, 5000], heading: Math.PI, altitude: 3200 },
      { model: 'su35', role: 'interceptor', position: [1875, 3200, 5000], heading: Math.PI, altitude: 3200 },
      { model: 'su35', role: 'interceptor', position: [0, 3500, 3750], heading: Math.PI, altitude: 3500 },
      { model: 'su35', role: 'interceptor', position: [-3125, 3400, 7500], heading: Math.PI, altitude: 3400 },
      { model: 'su35', role: 'interceptor', position: [3125, 3400, 7500], heading: Math.PI, altitude: 3400 },
      { model: 'su35', role: 'interceptor', position: [-4375, 3300, 6250], heading: Math.PI, altitude: 3300, callsign: '侧卫5号' },
      { model: 'su35', role: 'interceptor', position: [4375, 3300, 6250], heading: Math.PI, altitude: 3300, callsign: '侧卫6号' },
      { model: 'f15', role: 'fighter', position: [0, 3800, 6250], heading: Math.PI, altitude: 3800, callsign: '鹰1号' },
      { model: 'f15', role: 'fighter', position: [-2250, 3600, 8750], heading: Math.PI, altitude: 3600, callsign: '鹰2号' },
      { model: 'f15', role: 'fighter', position: [2250, 3600, 8750], heading: Math.PI, altitude: 3600, callsign: '鹰6号' },
      // === Enemy bombers (expanded to 3) ===
      { model: 'tu95', role: 'bomber', position: [0, 2800, 11250], heading: Math.PI, altitude: 2800, callsign: '熊式3号' },
      { model: 'tu95', role: 'bomber', position: [-1875, 2750, 11500], heading: Math.PI, altitude: 2750, callsign: '熊式12号' },
      { model: 'tu95', role: 'bomber', position: [1875, 2750, 11500], heading: Math.PI, altitude: 2750, callsign: '熊式13号' },
    ],
    objectives: [
      { id: 'o1', label: '摧毁全部截击机', type: 'destroy', target: 'any', count: 13 },
    ],
    timeLimit: 600,
    reward: 'Storm rider badge',
    recommendedCategories: ['fighter', 'awacs'],
  },
  {
    id: 'm06',
    codename: '行动·沙尘暴',
    title: '沙漠之狐 · 猎杀A-10',
    brief:
      '一支装甲纵队正穿过沙漠盆地，由 A-10 疣猪护航。' +
      '肃清空域，让攻击编队打击装甲部队。A-10 虽慢但皮糙肉厚——' +
      '用机炮和近程导弹对付。天气炎热多雾。',
    sky: 'day',
    weather: 'clear',
    map: 'desert',
    startAltitude: 2000,
    startSpeed: 510,
    startPos: [-7500, 2000, -7500],
    startHeading: Math.PI / 4,
    spawns: [
      // === Allied wingmen (DUST flight — 4-ship A-10) ===
      { model: 'a10', role: 'wingman', position: [-7575, 1990, -7575], heading: Math.PI / 4, altitude: 1990, isWingman: true, callsign: '沙尘2号' },
      { model: 'a10', role: 'wingman', position: [-7425, 1990, -7425], heading: Math.PI / 4, altitude: 1990, isWingman: true, callsign: '沙尘3号' },
      { model: 'a10', role: 'wingman', position: [-7750, 2000, -7500], heading: Math.PI / 4, altitude: 2000, isWingman: true, callsign: '沙尘4号' },
      { model: 'a10', role: 'wingman', position: [-7250, 2000, -7650], heading: Math.PI / 4, altitude: 2000, isWingman: true, callsign: '沙尘5号' },
      // === Enemy A-10 attack aircraft (expanded to 6) ===
      { model: 'a10', role: 'attack', position: [-1875, 1800, 5000], heading: Math.PI * 1.25, altitude: 1800, callsign: '疣猪1号' },
      { model: 'a10', role: 'attack', position: [1875, 1800, 5000], heading: Math.PI * 1.25, altitude: 1800, callsign: '疣猪2号' },
      { model: 'a10', role: 'attack', position: [0, 1900, 6250], heading: Math.PI * 1.25, altitude: 1900, callsign: '疣猪3号' },
      { model: 'a10', role: 'attack', position: [-3750, 1700, 7500], heading: Math.PI * 1.25, altitude: 1700, callsign: '疣猪4号' },
      { model: 'a10', role: 'attack', position: [3750, 1700, 7500], heading: Math.PI * 1.25, altitude: 1700, callsign: '疣猪7号' },
      { model: 'a10', role: 'attack', position: [0, 1750, 8750], heading: Math.PI * 1.25, altitude: 1750, callsign: '疣猪8号' },
      // === Enemy fighters (expanded to 4) ===
      { model: 'f16', role: 'fighter', position: [-2500, 2400, 3750], heading: Math.PI * 1.25, altitude: 2400 },
      { model: 'f16', role: 'fighter', position: [2500, 2400, 3750], heading: Math.PI * 1.25, altitude: 2400 },
      { model: 'su35', role: 'fighter', position: [-3125, 2600, 3125], heading: Math.PI * 1.25, altitude: 2600, callsign: '侧卫7号' },
      { model: 'su35', role: 'fighter', position: [3125, 2600, 3125], heading: Math.PI * 1.25, altitude: 2600, callsign: '侧卫8号' },
    ],
    objectives: [
      { id: 'o1', label: '摧毁A-10攻击机', type: 'destroy', target: 'any', count: 10 },
    ],
    timeLimit: 420,
    reward: 'Sand viper insignia',
    recommendedCategories: ['attack', 'gunship'],
  },
  {
    id: 'm07',
    codename: '行动·火山',
    title: '珊瑚蝰蛇 · 群岛扫荡',
    brief:
      '火山群岛已成为敌方快速攻击机的中转点。' +
      '它们藏身于岛屿和珊瑚礁之间，把冒烟的火山峰当作雷达地标。' +
      '扫荡潟湖，清除所有敌机。当心火山烟柱——低空飞行时的导航障碍。',
    sky: 'sunset',
    weather: 'clear',
    map: 'archipelago',
    startAltitude: 1800,
    startSpeed: 510,
    startPos: [0, 1800, -8750],
    startHeading: 0,
    spawns: [
      // === Allied wingmen (CORAL flight — 4-ship) ===
      { model: 'f16', role: 'wingman', position: [-87, 1790, -8812], heading: 0, altitude: 1790, isWingman: true, callsign: '珊瑚2号' },
      { model: 'f16', role: 'wingman', position: [88, 1790, -8812], heading: 0, altitude: 1790, isWingman: true, callsign: '珊瑚3号' },
      { model: 'f15', role: 'wingman', position: [-250, 1800, -8875], heading: 0, altitude: 1800, isWingman: true, callsign: '珊瑚4号' },
      { model: 'f15', role: 'wingman', position: [250, 1800, -8875], heading: 0, altitude: 1800, isWingman: true, callsign: '珊瑚5号' },
      // === Enemy strike package — expanded ===
      { model: 'su35', role: 'interceptor', position: [-3125, 2200, 5000], heading: Math.PI, altitude: 2200, callsign: '蝰蛇1号' },
      { model: 'su35', role: 'interceptor', position: [3125, 2200, 5000], heading: Math.PI, altitude: 2200, callsign: '蝰蛇2号' },
      { model: 'su35', role: 'interceptor', position: [0, 2500, 6875], heading: Math.PI, altitude: 2500, callsign: '蝰蛇3号' },
      { model: 'su35', role: 'interceptor', position: [-4375, 2300, 4375], heading: Math.PI, altitude: 2300, callsign: '蝰蛇4号' },
      { model: 'su35', role: 'interceptor', position: [4375, 2300, 4375], heading: Math.PI, altitude: 2300, callsign: '蝰蛇5号' },
      { model: 'f16', role: 'fighter', position: [-2250, 2000, 7500], heading: Math.PI, altitude: 2000 },
      { model: 'f16', role: 'fighter', position: [2250, 2000, 7500], heading: Math.PI, altitude: 2000 },
      { model: 'f16', role: 'fighter', position: [0, 2100, 8125], heading: Math.PI, altitude: 2100 },
      { model: 'tu95', role: 'bomber', position: [-3750, 1700, 10000], heading: Math.PI, altitude: 1700, callsign: '熊式4号' },
      { model: 'tu95', role: 'bomber', position: [3750, 1700, 10000], heading: Math.PI, altitude: 1700, callsign: '熊式5号' },
      { model: 'tu95', role: 'bomber', position: [0, 1650, 10625], heading: Math.PI, altitude: 1650, callsign: '熊式14号' },
    ],
    objectives: [
      { id: 'o1', label: '摧毁图-95轰炸机', type: 'destroy', target: 'bomber', count: 3 },
      { id: 'o2', label: '肃清群岛全部战斗机', type: 'destroy', target: 'fighter', count: 8 },
    ],
    timeLimit: 540,
    reward: 'Coral viper wings',
    recommendedCategories: ['fighter', 'stealth'],
  },
  {
    id: 'm08',
    codename: '行动·白障',
    title: '幽灵干扰 · 电子战压制',
    brief:
      '敌方一体化防空网络正在锁定我们的攻击编队。' +
      '驾驶 EA-18G 咆哮者飞在编队前方，用干扰脉冲扰乱他们的火控雷达。' +
      '一旦开始辐射信号，敌机将迅速逼近——用电子战脉冲诱骗导弹，' +
      '让攻击编队通过。推荐机型：EA-18G 咆哮者。',
    sky: 'dawn',
    weather: 'fog',
    map: 'archipelago',
    startAltitude: 2200,
    startSpeed: 476,
    startPos: [-6250, 2200, -6250],
    startHeading: Math.PI / 4,
    spawns: [
      // === Allied wingmen (PROWLER flight — 4-ship) ===
      { model: 'ea18g', role: 'wingman', position: [-6325, 2190, -6325], heading: Math.PI / 4, altitude: 2190, isWingman: true, callsign: '徘徊者2号' },
      { model: 'ea18g', role: 'wingman', position: [-6175, 2190, -6175], heading: Math.PI / 4, altitude: 2190, isWingman: true, callsign: '徘徊者3号' },
      { model: 'f16', role: 'wingman', position: [-6500, 2200, -6250], heading: Math.PI / 4, altitude: 2200, isWingman: true, callsign: '徘徊者4号' },
      { model: 'f16', role: 'wingman', position: [-6000, 2200, -6400], heading: Math.PI / 4, altitude: 2200, isWingman: true, callsign: '徘徊者5号' },
      // === Enemy interceptors — expanded to 8 ===
      { model: 'su35', role: 'interceptor', position: [-1875, 2500, 3750], heading: Math.PI * 1.25, altitude: 2500, callsign: '敌机4号' },
      { model: 'su35', role: 'interceptor', position: [1875, 2500, 3750], heading: Math.PI * 1.25, altitude: 2500, callsign: '敌机5号' },
      { model: 'su35', role: 'interceptor', position: [0, 2700, 5000], heading: Math.PI * 1.25, altitude: 2700, callsign: '敌机6号' },
      { model: 'su35', role: 'interceptor', position: [-3500, 2600, 4375], heading: Math.PI * 1.25, altitude: 2600, callsign: '敌机17号' },
      { model: 'su35', role: 'interceptor', position: [3500, 2600, 4375], heading: Math.PI * 1.25, altitude: 2600, callsign: '敌机18号' },
      { model: 'f16', role: 'fighter', position: [-2750, 2400, 3125], heading: Math.PI * 1.25, altitude: 2400 },
      { model: 'f16', role: 'fighter', position: [2750, 2400, 3125], heading: Math.PI * 1.25, altitude: 2400 },
      { model: 'f15', role: 'fighter', position: [0, 2900, 6875], heading: Math.PI * 1.25, altitude: 2900, callsign: '鹰3号' },
      // === Enemy bombers (expanded to 2) ===
      { model: 'tu95', role: 'bomber', position: [0, 2000, 8750], heading: Math.PI * 1.25, altitude: 2000, callsign: '熊式6号' },
      { model: 'tu95', role: 'bomber', position: [-1875, 1950, 9000], heading: Math.PI * 1.25, altitude: 1950, callsign: '熊式15号' },
    ],
    objectives: [
      { id: 'o1', label: '压制敌方防空', type: 'destroy', target: 'any', count: 8 },
      { id: 'o2', label: '摧毁图-95轰炸机', type: 'destroy', target: 'bomber', count: 2 },
    ],
    timeLimit: 480,
    reward: 'Spectral jammer ribbon',
    recommendedCategories: ['ew', 'fighter'],
  },
  {
    id: 'm09',
    codename: '行动·重力天使',
    title: '魅影护航 · 炮艇盘旋',
    brief:
      '敌方车队正在沙漠盆地集结，准备发动黎明攻势。' +
      '驾驶 AC-130 魅影在目标区上空左盘旋，让 105 毫米榴弹炮对准目标。' +
      '压坡度进入绕桩转弯——侧炮会自动锁定左翼下方的目标。' +
      '敌机会紧急起飞拦截，保持速度并维持在 1500 英尺以上。推荐机型：AC-130 魅影。',
    sky: 'dawn',
    weather: 'clear',
    map: 'desert',
    startAltitude: 1800,
    startSpeed: 162,
    startPos: [-3750, 1800, -3750],
    startHeading: Math.PI / 4,
    spawns: [
      // === Allied wingmen (SPECTRE flight — 4-ship) ===
      { model: 'a10', role: 'wingman', position: [-3825, 1790, -3825], heading: Math.PI / 4, altitude: 1790, isWingman: true, callsign: '魅影2号' },
      { model: 'a10', role: 'wingman', position: [-3675, 1790, -3675], heading: Math.PI / 4, altitude: 1790, isWingman: true, callsign: '魅影3号' },
      { model: 'f16', role: 'wingman', position: [-4000, 1900, -3750], heading: Math.PI / 4, altitude: 1900, isWingman: true, callsign: '魅影4号' },
      { model: 'f16', role: 'wingman', position: [-3500, 1900, -3900], heading: Math.PI / 4, altitude: 1900, isWingman: true, callsign: '魅影5号' },
      // === Enemy interceptors (expanded to 6) ===
      { model: 'su35', role: 'interceptor', position: [-2250, 2400, 3125], heading: Math.PI * 1.25, altitude: 2400, callsign: '敌机7号' },
      { model: 'su35', role: 'interceptor', position: [2250, 2400, 3125], heading: Math.PI * 1.25, altitude: 2400, callsign: '敌机8号' },
      { model: 'su35', role: 'interceptor', position: [-3500, 2300, 3750], heading: Math.PI * 1.25, altitude: 2300, callsign: '敌机19号' },
      { model: 'su35', role: 'interceptor', position: [3500, 2300, 3750], heading: Math.PI * 1.25, altitude: 2300, callsign: '敌机20号' },
      { model: 'f16', role: 'fighter', position: [-2750, 2200, 4375], heading: Math.PI * 1.25, altitude: 2200 },
      { model: 'f16', role: 'fighter', position: [2750, 2200, 4375], heading: Math.PI * 1.25, altitude: 2200 },
      // === Enemy A-10s (expanded to 4) ===
      { model: 'a10', role: 'attack', position: [0, 1800, 6250], heading: Math.PI * 1.25, altitude: 1800, callsign: '疣猪5号' },
      { model: 'a10', role: 'attack', position: [-1875, 1700, 7500], heading: Math.PI * 1.25, altitude: 1700, callsign: '疣猪6号' },
      { model: 'a10', role: 'attack', position: [1875, 1700, 7500], heading: Math.PI * 1.25, altitude: 1700, callsign: '疣猪9号' },
      { model: 'a10', role: 'attack', position: [0, 1750, 8750], heading: Math.PI * 1.25, altitude: 1750, callsign: '疣猪10号' },
    ],
    objectives: [
      { id: 'o1', label: '摧毁敌方截击机', type: 'destroy', target: 'fighter', count: 6 },
      { id: 'o2', label: '摧毁A-10攻击机', type: 'destroy', target: 'any', count: 4 },
    ],
    timeLimit: 540,
    reward: 'Spectre overwatch commendation',
    recommendedCategories: ['gunship', 'attack'],
  },
  {
    id: 'm10',
    codename: '行动·黑标枪',
    title: '夜鹰突袭 · 隐身渗透',
    brief:
      '敌方高价值指挥所深藏在严密设防的空域后方。' +
      '驾驶 F-117 夜鹰低空慢速潜入——你的低可观测机体能让对方火控雷达' +
      '无法在远距离锁定。突进到 1.4 公里内，投下弹药，' +
      '在巡逻机群反应过来之前撤离。推荐机型：F-117 夜鹰。',
    sky: 'storm',
    weather: 'storm',
    map: 'mountain',
    startAltitude: 2500,
    startSpeed: 348,
    startPos: [-8750, 2500, -8750],
    startHeading: Math.PI / 4,
    spawns: [
      // === No wingmen — stealth mission is solo ===
      // === Heavy CAP — but stealth makes them less effective at range (expanded to 9) ===
      { model: 'su35', role: 'interceptor', position: [-2500, 2700, 2500], heading: Math.PI * 1.25, altitude: 2700, callsign: '敌机9号' },
      { model: 'su35', role: 'interceptor', position: [2500, 2700, 2500], heading: Math.PI * 1.25, altitude: 2700, callsign: '敌机10号' },
      { model: 'su35', role: 'interceptor', position: [0, 3000, 3750], heading: Math.PI * 1.25, altitude: 3000, callsign: '敌机11号' },
      { model: 'su35', role: 'interceptor', position: [-3750, 2800, 3125], heading: Math.PI * 1.25, altitude: 2800, callsign: '敌机21号' },
      { model: 'su35', role: 'interceptor', position: [3750, 2800, 3125], heading: Math.PI * 1.25, altitude: 2800, callsign: '敌机22号' },
      { model: 'f15', role: 'fighter', position: [-1875, 2900, 5000], heading: Math.PI * 1.25, altitude: 2900, callsign: '鹰4号' },
      { model: 'f15', role: 'fighter', position: [1875, 2900, 5000], heading: Math.PI * 1.25, altitude: 2900, callsign: '鹰5号' },
      { model: 'f15', role: 'fighter', position: [0, 3100, 6250], heading: Math.PI * 1.25, altitude: 3100, callsign: '鹰7号' },
      { model: 'f16', role: 'fighter', position: [-3125, 3000, 5625], heading: Math.PI * 1.25, altitude: 3000 },
      // === Enemy bombers (expanded to 3) ===
      { model: 'tu95', role: 'bomber', position: [0, 2200, 7500], heading: Math.PI * 1.25, altitude: 2200, callsign: '熊式7号' },
      { model: 'tu95', role: 'bomber', position: [-1875, 2150, 7750], heading: Math.PI * 1.25, altitude: 2150, callsign: '熊式16号' },
      { model: 'tu95', role: 'bomber', position: [1875, 2150, 7750], heading: Math.PI * 1.25, altitude: 2150, callsign: '熊式17号' },
    ],
    objectives: [
      { id: 'o1', label: '摧毁敌方轰炸机', type: 'destroy', target: 'bomber', count: 3 },
      { id: 'o2', label: '歼灭截击机', type: 'destroy', target: 'fighter', count: 9 },
    ],
    timeLimit: 480,
    reward: 'Black dart insignia',
    recommendedCategories: ['stealth', 'fighter'],
  },
  {
    id: 'm11',
    codename: '行动·午夜',
    title: '夜间突袭 · 城市防御',
    brief:
      '月光下，一场大规模夜间空袭正扑向我方沿海城市。' +
      '图-95 轰炸机与苏-35 护航机正借助夜色钻过我们的雷达。' +
      '在月光下紧急升空，在它们抵达市中心前接战。' +
      '爆炸、引擎尾焰与城市灯光会在夜空下泛光——利用它们远距离发现敌机。',
    sky: 'night',
    weather: 'clear',
    map: 'city',
    startAltitude: 1800,
    startSpeed: 476,
    startPos: [-8000, 1800, -8000],
    startHeading: Math.PI / 4,
    spawns: [
      // === Allied wingmen (NIGHT flight — 4-ship) ===
      { model: 'f15', role: 'wingman', position: [-8060, 1790, -8060], heading: Math.PI / 4, altitude: 1790, isWingman: true, callsign: '夜枭2号' },
      { model: 'f15', role: 'wingman', position: [-7940, 1790, -7940], heading: Math.PI / 4, altitude: 1790, isWingman: true, callsign: '夜枭3号' },
      { model: 'f16', role: 'wingman', position: [-8200, 1800, -8000], heading: Math.PI / 4, altitude: 1800, isWingman: true, callsign: '夜枭4号' },
      { model: 'f16', role: 'wingman', position: [-7800, 1800, -8120], heading: Math.PI / 4, altitude: 1800, isWingman: true, callsign: '夜枭5号' },
    ],
    waves: [
      // Wave 1: forward scout fighters probing the city defenses.
      {
        waveNumber: 1,
        delayAfterPrevious: 0,
        banner: '第1/3波 — 侦测到侦察战斗机',
        spawns: [
          { model: 'f16', role: 'fighter', position: [-2500, 2200, 2500], heading: Math.PI * 1.25, altitude: 2200 },
          { model: 'f16', role: 'fighter', position: [2500, 2200, 2500], heading: Math.PI * 1.25, altitude: 2200 },
          { model: 'f16', role: 'fighter', position: [0, 2400, 3000], heading: Math.PI * 1.25, altitude: 2400 },
          { model: 'su35', role: 'interceptor', position: [-1800, 2300, 2000], heading: Math.PI * 1.25, altitude: 2300, callsign: '敌机1号' },
          { model: 'su35', role: 'interceptor', position: [1800, 2300, 2000], heading: Math.PI * 1.25, altitude: 2300, callsign: '敌机2号' },
        ],
      },
      // Wave 2: the main bomber package — Tu-95s with fighter escort.
      {
        waveNumber: 2,
        delayAfterPrevious: 7,
        banner: '第2/3波 — 轰炸机群来袭',
        spawns: [
          { model: 'tu95', role: 'bomber', position: [-1500, 1800, 5000], heading: Math.PI * 1.25, altitude: 1800, callsign: '熊式1号' },
          { model: 'tu95', role: 'bomber', position: [1500, 1800, 5000], heading: Math.PI * 1.25, altitude: 1800, callsign: '熊式2号' },
          { model: 'tu95', role: 'bomber', position: [-3000, 1750, 5500], heading: Math.PI * 1.25, altitude: 1750, callsign: '熊式3号' },
          { model: 'tu95', role: 'bomber', position: [3000, 1750, 5500], heading: Math.PI * 1.25, altitude: 1750, callsign: '熊式4号' },
          { model: 'su35', role: 'interceptor', position: [-2200, 2400, 4000], heading: Math.PI * 1.25, altitude: 2400, callsign: '敌机3号' },
          { model: 'su35', role: 'interceptor', position: [2200, 2400, 4000], heading: Math.PI * 1.25, altitude: 2400, callsign: '敌机4号' },
          { model: 'f15', role: 'fighter', position: [0, 2600, 3500], heading: Math.PI * 1.25, altitude: 2600, callsign: '鹰1号' },
        ],
      },
      // Wave 3: elite Su-35 ace squad — the final gauntlet.
      {
        waveNumber: 3,
        delayAfterPrevious: 8,
        banner: '第3/3波 — 王牌中队来袭',
        spawns: [
          { model: 'su35', role: 'interceptor', position: [-2500, 2700, 4500], heading: Math.PI * 1.25, altitude: 2700, callsign: '王牌1号' },
          { model: 'su35', role: 'interceptor', position: [2500, 2700, 4500], heading: Math.PI * 1.25, altitude: 2700, callsign: '王牌2号' },
          { model: 'su35', role: 'interceptor', position: [0, 2900, 5000], heading: Math.PI * 1.25, altitude: 2900, callsign: '王牌3号' },
          { model: 'su35', role: 'interceptor', position: [-3000, 2800, 5500], heading: Math.PI * 1.25, altitude: 2800, callsign: '王牌4号' },
          { model: 'su35', role: 'interceptor', position: [3000, 2800, 5500], heading: Math.PI * 1.25, altitude: 2800, callsign: '王牌5号' },
        ],
      },
    ],
    objectives: [
      { id: 'o1', label: '摧毁图-95轰炸机', type: 'destroy', target: 'bomber', count: 4 },
      { id: 'o2', label: '歼灭全部敌机', type: 'destroy', target: 'fighter', count: 12 },
    ],
    timeLimit: 540,
    reward: 'Midnight ace wings',
    recommendedCategories: ['fighter', 'stealth'],
  },
  {
    id: 'm_test',
    codename: '行动·沙盒',
    title: '单位测试场',
    brief:
      '测试任务：模拟器中的全部单位类型都会在此出现。' +
      '可攻击战斗机、轰炸机、攻击机、干扰机、炮艇机、' +
      '隐身机、预警机，以及海军驱逐舰/巡洋舰和地面装甲/防空导弹/高炮。' +
      '友军僚机与友军海面/地面单位也在场。无时间限制。' +
      '用这个任务测试各武器与命中特效对每种目标的效果。',
    sky: 'day',
    weather: 'clear',
    map: 'desert',
    startAltitude: 1800,
    startSpeed: 476,
    startPos: [0, 1800, -5000],
    startHeading: 0,
    spawns: [
      // === Allied wingmen ===
      { model: 'f16', role: 'wingman', position: [-75, 1790, -5062], heading: 0, altitude: 1790, isWingman: true, callsign: '测试2号' },
      { model: 'f15', role: 'wingman', position: [75, 1790, -5062], heading: 0, altitude: 1790, isWingman: true, callsign: '测试3号' },
      // === Enemy aircraft — one of each playable + role type ===
      { model: 'f16', role: 'fighter', position: [-1875, 1900, 6250], heading: Math.PI, altitude: 1900, callsign: '敌机 F-16' },
      { model: 'su35', role: 'fighter', position: [1875, 1900, 6250], heading: Math.PI, altitude: 1900, callsign: '敌机 SU-35' },
      { model: 'b52', role: 'bomber', position: [0, 1700, 6875], heading: Math.PI, altitude: 1700, callsign: '熊式 B-52' },
      { model: 'a10', role: 'attack', position: [-3125, 1800, 5625], heading: Math.PI, altitude: 1800, callsign: '疣猪 A-10' },
      { model: 'ea18g', role: 'ew', position: [3125, 1800, 5625], heading: Math.PI, altitude: 1800, callsign: '徘徊者' },
      { model: 'ac130', role: 'gunship', position: [-4375, 2200, 6250], heading: Math.PI, altitude: 2200, callsign: '幽灵炮艇' },
      { model: 'f117', role: 'stealth', position: [4375, 2000, 6250], heading: Math.PI, altitude: 2000, callsign: '幽灵 F-117' },
      { model: 'e3', role: 'awacs', position: [0, 2400, 8125], heading: Math.PI, altitude: 2400, callsign: '望楼 E-3' },
    ],
    objectives: [
      { id: 'o1', label: '攻击全部单位类型（测试任务）', type: 'destroy', target: 'any', count: 1 },
    ],
    timeLimit: 1200,
    reward: 'Test pilot badge',
    recommendedCategories: ['fighter', 'attack', 'stealth'],
  },
  {
    id: 'm12',
    codename: '行动·风暴突破',
    title: '雷鸣狂奔 · 风暴峡谷炮艇',
    brief:
      '强雷暴已让我们的高速战机全部停飞，但敌人不在乎——' +
      '他们正借着雨幕掩护，把装甲纵队推过山间峡谷。' +
      '只有 AC-130 魅影能在这天气里飞行。冲进风暴，' +
      '在峡谷口盘旋，用 105 毫米榴弹炮瞄准穿过隘口的车队。' +
      '闪电会像频闪灯一样照亮峡谷——趁那些瞬间发现目标。' +
      '当心峡谷岩壁：山峦毫不留情。按 CapsLock 进入侧射炮手视角，' +
      '拖动鼠标瞄准。V 不会切换到空对空导弹——炮艇机没有导弹能力。' +
      '推荐机型：AC-130 魅影。',
    sky: 'storm',
    weather: 'storm',
    map: 'mountain',
    startAltitude: 1800,
    startSpeed: 130,
    startPos: [-4375, 1800, -4375],
    startHeading: Math.PI / 4,
    spawns: [
      // === Allied wingmen (SPOOKY flight — A-10 escorts for the gunship) ===
      { model: 'a10', role: 'wingman', position: [-4450, 1790, -4450], heading: Math.PI / 4, altitude: 1790, isWingman: true, callsign: '幽灵炮艇2号' },
      { model: 'a10', role: 'wingman', position: [-4300, 1790, -4300], heading: Math.PI / 4, altitude: 1790, isWingman: true, callsign: '幽灵炮艇3号' },
      // === Enemy interceptors scrambled through the storm (4) ===
      { model: 'su35', role: 'interceptor', position: [-1875, 2400, 3125], heading: Math.PI * 1.25, altitude: 2400, callsign: '敌机12号' },
      { model: 'su35', role: 'interceptor', position: [1875, 2400, 3125], heading: Math.PI * 1.25, altitude: 2400, callsign: '敌机13号' },
      { model: 'f16', role: 'fighter', position: [-2750, 2200, 4375], heading: Math.PI * 1.25, altitude: 2200 },
      { model: 'f16', role: 'fighter', position: [2750, 2200, 4375], heading: Math.PI * 1.25, altitude: 2200 },
      // === Enemy A-10s hiding in the valley (4 — primary 105mm targets) ===
      { model: 'a10', role: 'attack', position: [0, 1500, 6250], heading: Math.PI * 1.25, altitude: 1500, callsign: '疣猪7号' },
      { model: 'a10', role: 'attack', position: [-1500, 1500, 6875], heading: Math.PI * 1.25, altitude: 1500, callsign: '疣猪8号' },
      { model: 'a10', role: 'attack', position: [1500, 1500, 6875], heading: Math.PI * 1.25, altitude: 1500, callsign: '疣猪11号' },
      { model: 'a10', role: 'attack', position: [0, 1500, 8125], heading: Math.PI * 1.25, altitude: 1500, callsign: '疣猪12号' },
    ],
    objectives: [
      { id: 'o1', label: '摧毁峡谷内敌方攻击机', type: 'destroy', target: 'any', count: 4 },
      { id: 'o2', label: '清除敌方截击机', type: 'destroy', target: 'fighter', count: 4 },
    ],
    timeLimit: 540,
    reward: 'Storm rider commendation',
    recommendedCategories: ['gunship', 'attack'],
  },

  // ===========================================================================
  // #16 试验 · 林地流式 —— 1/4 面积的程序化山地测试关 (per user request)
  // 地形: blender/terrain 的 out_test 副本(36.5 km, 起伏 3240 m; 见其 README §1e),
  //      经 70_export_game.py 导成 .f32bin.gz → public/custom-maps/test/
  // 用途: ①验证**树木 LOD 的实时加载/卸载**(植被流式环) ②后续烘焙光影/法线
  // ⚠ 靠 terrain.slot='test' 指向 tune 的 maps.test; 不填 slot 的关卡继续吃
  //   maps.custom(m13 的雪山) ⇒ 两者互不影响
  // ===========================================================================
  {
    id: 'm16',
    codename: '试验·林地流式',
    title: '低空林地 · 树木流式测试',
    brief:
      '地形测试关：36.5 km 的程序化山地（1/4 面积副本），林区位置由 Blender 那边烘的 ' +
      'forest 遮罩决定，树线约 1720 m。低空穿越林区，观察树木的**实时加载/卸载**：' +
      '视野内的树分批出现、出视野后回收，LOD 环切换时不应有卡顿或突现。' +
      '控制台可调：veg off/on 开关植被、vegdbg 标出每一株的位置、' +
      'skybound.lod0Radius 与 skybound.lodScale 对比不同 LOD 半径下的流式行为。无时间限制。',
    sky: 'day',
    weather: 'clear',
    // 正午(用户要求: "调到中午, 不想看黄昏场景"): 仰角 80° / 方位 180°(正南) ⇒ 影子很短。
    // 旧值 52°/235°(下午两点)在大气里会带出暖地平线染色(雾偏灰、地形发灰), 观感偏黄昏;
    // 仰角一抬, 地平线染色 (1-elev)*0.9 从 0.19 掉到 0.014, turbidity 也随高度下降 ⇒ 清亮。
    sun: { elevation: 80, azimuth: 180 },
    map: 'custom',
    terrain: {
      slot: 'test',
      // 与 blender/terrain/terrain_config.json 的 mission_style **同一套调色板**
      // (温带绿山地: 山坡深绿林 / 脊线露灰褐岩 / 雪只在 0.92 以上) —— 关卡数据驱动,
      // 改那边记得同步这边。
      snowLine: 0.92,
      rockColor: '#8a8578',
      grassColor: '#3f5a2e',
      sandColor: '#7d7460',
      snowColor: '#eef2f5',
    },
    startAltitude: 1801,
    startSpeed: 430,
    // 出生点**按数据挑的**(不是拍的): 在 15_veg_mask 的林区图上按 1.5 km 窗找林区密度
    // 最高、且偏向地图中心的一处 ⇒ 窗内林区密度 59%、地面海拔 576 m、离地 400 m 通场。
    // 原来写的是 (0,-8000) —— 那片是南边的海/岸, 一开局看不到树, 会被误判成"坏了"。
    // 出生点按 **4× 地图的树位置表**挑(不再沿用 1/4 地图坐标): 最密 4km 格中心
    // (-14000, 42000)、地面 1421 m、该格 189 棵; 半径 11km 内 2851 棵 ⇒ 开局就在林子上方
    startPos: [-14000, 1801, 42000],
    startHeading: 0,
    spawns: [
      { model: 'f16', role: 'wingman', position: [-14080, 1791, 41940], heading: 0, altitude: 1791, isWingman: true, callsign: '林2号' },
      // ⚠ 空域不能是空的: 没有敌机时"空域已清"那条收尾会**在 1 秒内**判胜并结算
      //   (实测: 一进这关就 179900 分 + 任务完成 —— 179900 = 剩余 1799 秒 × 100 的时间奖励)。
      //   这两架敌机放在 20km 外、只为保证空域非空; 想清场就打下它们(= 完成 o1), 想安静测树就不理。
      { model: 'f16', role: 'fighter', position: [14000, 2000, -14000], heading: Math.PI, altitude: 2000, callsign: '靶机 1' },
      { model: 'su35', role: 'fighter', position: [-14500, 2200, -13500], heading: Math.PI, altitude: 2200, callsign: '靶机 2' },
    ],
    objectives: [
      // ⚠ 不能写 type:'survive'/'reach' —— 引擎的 checkObjectives() **只实现了 destroy/protect**,
      //   未处理的类型会被跳过 ⇒ allDone 恒 true ⇒ 进关 1 秒后(missionTime>1)就判"任务完成"
      //   (实测: 一进这关就显示任务完成)。用与 m_test 同形的 destroy 目标: 本关无敌机 ⇒
      //   击杀恒为 0 < 1 ⇒ 永不自动完成, 靠 timeLimit 自然收尾, 适合当测试场。
      { id: 'o1', label: '自由测试（无完成条件；30 分钟后自动结束）', type: 'destroy', target: 'any', count: 1 },
    ],
    timeLimit: 1800,
    reward: 'Test pilot badge',
    recommendedCategories: ['fighter', 'attack'],
  },

  // ===========================================================================
  // 正式版剧情 · 第一关 (per user request: 剧情菜单里单独搞的关卡)
  // ===========================================================================
  // 海面黄昏, 天空盒光照用用户指定的 EveningSkyHDRI046B(资产库外置, 见 asset-library.json)。
  // 本关**没有普通波次**: 全部敌人由引擎的剧情控制器(this.setupStoryS01)按阶段刷 ——
  // 敌方空中战舰「堡垒」(900x240x160 的 dreadnought) + 每阶段 16 个挂点 + 航空大队 + 轻型舰舰队 + 无人机。
  {
    id: 's01',
    campaign: 1,
    codename: '正式版剧情·第一关',
    title: '堡垒 · 空中战舰',
    brief: '黄昏海面。预警机在方位090、距离40处捕捉到一个"超大信号"—— 那不是常规目标, 是一艘长度近一公里的空中战舰「堡垒」。'
      + '它以护航战斗机开道, 六个面按法线方向挂满武器: 机炮、导弹发射器, 后期还有激光阵列与轻型舰舰队。'
      + '逐层剥掉它的表面火力, 逼它把核心露出来 —— 打完所有剧情阶段, 它才会坠落。',
    sky: 'sunset',
    // === 关卡专属天空盒 (per user request: 天空盒光照使用这个) ===
    // 这一关不走 evening.exr 那套 4K/2K 兜底, 直接用资产库里的新 HDRI(见 engine.loadHdrEnvironment)。
    environment: 'textures/sky/evening-046b.exr',
    weather: 'clear',
    // === 云/天气指数**固定 0.5** (per user request) =============================
    // 优先级: 这里 > localStorage(skybound.cloudWex) > 库默认 ⇒ 无论之前调过什么、
    // 或者上一条命留下的旋钮值, 这一关的天气指数都恒为 0.5(引擎里按 0.1..8 夹紧)。
    cloud: { wex: 0.5 },
    map: 'ocean',
    startAltitude: 4200,
    startSpeed: 330,
    startPos: [0, 4200, -12000],
    startHeading: 0,
    spawns: [],
    objectives: [
      { id: 'boss', label: '击毁空中战舰「堡垒」', type: 'destroy', target: 'boss', count: 1 },
    ],
    reward: 'Bastion breaker',
    recommendedCategories: ['fighter'],
    // === 简报情报(手写) =====================================================
    // 本关的敌人**全部由引擎的剧情控制器按阶段刷出**, 任务数据里没有任何坐标
    // (spawns/waves/groundSpawns 都是空的) —— 所以这套敌我态势只能手写。
    // 数值是简报层面的情报近似: 战舰居中、护航机环绕、轻型舰在北侧海面警戒,
    // 玩家从 startPos(0, 4200, -12000) 由南向北进入。与引擎实际刷出的舰体
    // 尺寸(900x240x160)和编队意图一致, 但不逐帧对齐 —— 简报本来就是"情报图"。
    briefing: {
      units: [
        { id: 'player', side: 'player', domain: 'air', code: 'LEAD',
          label: 'RAVEN 1', roleZh: '你 · 长机', roleEn: 'YOU · LEAD',
          x: 0, z: -12000, altitude: 4200, heading: 0, priority: 900 },
        { id: 'wm2', side: 'friendly', domain: 'air', code: 'F-16',
          label: 'RAVEN 2', roleZh: '僚机 2', roleEn: 'WINGMAN 2',
          x: -620, z: -12400, altitude: 4150, heading: 0, priority: 120 },
        { id: 'wm3', side: 'friendly', domain: 'air', code: 'F-16',
          label: 'RAVEN 3', roleZh: '僚机 3', roleEn: 'WINGMAN 3',
          x: 640, z: -12400, altitude: 4150, heading: 0, priority: 120 },
        // 空中战舰「堡垒」: 高价值目标, 线框舰体尺寸与引擎一致
        { id: 'bastion', side: 'target', domain: 'hvt', code: 'AIR-BOSS',
          label: 'BASTION', roleZh: '空中战舰「堡垒」· 高价值目标', roleEn: 'AIR DREADNOUGHT BASTION · HVT',
          x: 0, z: 1200, altitude: 2600, heading: Math.PI, priority: 900,
          hp: 999999, range: 14000,
          hull: [900, 240, 160],
          card: { title: 'BASTION · 堡垒', typeLabel: '空中战舰 · 旗舰级', weapon: 'QAAM · 核心暴露后', threat: 5 } },
        // 6 个挂点面的火力簇(简报把它们画成护航机 — 视觉信息量与旧版一致)
        { id: 'esc1', side: 'enemy', domain: 'air', code: 'F-15', label: 'ESC 1', roleZh: '敌护航机', roleEn: 'ENEMY ESCORT', x: 1400, z: 1600, altitude: 2650, heading: Math.PI, priority: 60, wave: 1 },
        { id: 'esc2', side: 'enemy', domain: 'air', code: 'F-15', label: 'ESC 2', roleZh: '敌护航机', roleEn: 'ENEMY ESCORT', x: -1300, z: 1750, altitude: 2500, heading: Math.PI, priority: 60, wave: 1 },
        { id: 'esc3', side: 'enemy', domain: 'air', code: 'F-16', label: 'ESC 3', roleZh: '敌护航机', roleEn: 'ENEMY ESCORT', x: 1750, z: 200, altitude: 2450, heading: Math.PI, priority: 55, wave: 1 },
        { id: 'esc4', side: 'enemy', domain: 'air', code: 'F-16', label: 'ESC 4', roleZh: '敌护航机', roleEn: 'ENEMY ESCORT', x: -1800, z: 80, altitude: 2450, heading: Math.PI, priority: 55, wave: 1 },
        { id: 'esc5', side: 'enemy', domain: 'air', code: 'F-15', label: 'ESC 5', roleZh: '敌护航机', roleEn: 'ENEMY ESCORT', x: 900, z: -900, altitude: 2750, heading: Math.PI, priority: 55, wave: 1 },
        { id: 'esc6', side: 'enemy', domain: 'air', code: 'F-15', label: 'ESC 6', roleZh: '敌护航机', roleEn: 'ENEMY ESCORT', x: -950, z: -1000, altitude: 2750, heading: Math.PI, priority: 55, wave: 1 },
        // 北侧海面警戒的轻型舰(简报里是"后续阶段"的舰队, 所以标成情报估计)
        { id: 'ffg21', side: 'enemy', domain: 'naval', code: 'FFG', label: 'FFG-21', roleZh: '敌轻护卫舰', roleEn: 'ENEMY LIGHT WARSHIP', x: -2400, z: 3400, altitude: 0, priority: 70, wave: 2, hp: 150, range: 5500 },
        { id: 'ffg27', side: 'enemy', domain: 'naval', code: 'FFG', label: 'FFG-27', roleZh: '敌轻护卫舰', roleEn: 'ENEMY LIGHT WARSHIP', x: 2600, z: 3250, altitude: 0, priority: 70, wave: 2, hp: 150, range: 5500 },
      ],
      routes: [
        { id: 'strike', side: 'friendly', label: 'ROUTE ALPHA',
          points: [[0, 4200, -12000], [-1800, 3600, -7200], [-1200, 3100, -3000], [0, 2600, 600]] },
        { id: 'ingress', side: 'enemy', label: 'INGRESS · 敌警戒幕', dash: true,
          points: [[0, 2600, 1200], [-400, 2800, -1800], [-200, 3400, -5600], [0, 4200, -9000]] },
      ],
    },
  },
  // ===========================================================================
  // §335 正式版剧情·第二关《洞川撤退》(per user request)
  // 狭长走廊型: 东北端 = 西坎奥莱控制区边缘(敌军出生点), 西南端 = 东奥莱防空圈(终点),
  // 中部是洞川工业区废墟。全部敌人/编队/战舰/区域由引擎的剧情控制器按阶段刷
  // (见 engine.ts 的 setupStoryS02 / updateStoryS02), 所以 spawns/waves 都是空的。
  // [!] 地图是**占位符**: city(程序化城市)只作为"工业区废墟"的临时替身, 换正式地图时
  //     只改 map/terrain 两行; 走廊几何由 s02Circle(西南防空圈) + 敌机进场方位决定。
  {
    id: 's02',
    campaign: 2,
    codename: '正式版剧情·第二关',
    title: '洞川撤退',
    brief: '合同命令: 掩护东奥莱联邦的轰炸机与运输机编队撤回己方防空圈。'
      + '编队已受损 —— 长弓3 引擎冒烟、速度受限, 铁锤的运输机里载着伤员。'
      + '西坎奥莱的"剑锋"中队会分三波从东北、正东、东南压上来: 他们的目标不是你们, 是编队。'
      + '最后挡在返航路上的, 是王牌中队"隼"和一艘每 50 秒发射空爆弹的中型空中战舰。',
    sky: 'day',
    weather: 'clear',
    // 占位地图(见上方说明): 程序化城市 = 洞川工业区废墟的临时替身
    // 正午(用户要求: "调到中午, 不想看黄昏场景"): 仰角 80° / 方位 180°(正南) ⇒ 影子很短。
    // 旧值 52°/235°(下午两点)在大气里会带出暖地平线染色(雾偏灰、地形发灰), 观感偏黄昏;
    // 仰角一抬, 地平线染色 (1-elev)*0.9 从 0.19 掉到 0.014, turbidity 也随高度下降 ⇒ 清亮。
    sun: { elevation: 80, azimuth: 180 },
    map: 'custom',        // ★ 广域山地(291.6 km 4× 地图), 不用 city 的程序化城市(用户要求)
    // 专属 tune 槽: 港口(实例化)+其它关卡级配置都挂在这(见 terrain-tune.json 的 maps.s02)
    terrain: { slot: 'test' },   // ★ 挂 test 槽: 4× 地图 + 25 万棵树 + 烘焙的 color/normal/AO
    startAltitude: 2600,
    startSpeed: 420,
    // ★ 世界标度覆盖: 默认 0.382 是给旧 72.9 km 城市地图的, 这张 4× 图(291.6 km)上会
    //   让所有单位慢 4 倍 —— 实测编队 92 m/s、撤退航线 263 km ⇒ 单是编队飞到第一路径点
    //   就要 26 分钟。取控制台上限 1.5(⇒ 世界标度 0.819, 全部单位快 2.14 倍):
    //   玩家 344 m/s、编队 197 m/s ⇒ 第一段约 12 分钟、全程约 31 分钟。
    //   想更快用控制台 `bomber 4`(编队 ×4) —— 这是给测试用的加速杆。
    worldSpeedK: 1.5,
    // ★ 玩家开局在**用户盒"第一路径点"**(boxes.json: -41044, 94984)出生; 编队从
    //   "第一出生点"(100831, 123654)沿 路径点1→2→3→撤离点 撤回。高度 6800 m:
    //   出生点地形只有 837 m, 但这条航线中段的山脊高 6050 m ⇒ 编队巡航在 7000 m。
    // §353 用户: "玩家开局出生到轰炸机编队周围"。原出生点在第一路径点(编队要走 200+km
    // 才到), 开局周围什么都没有; 现在放到**编队出生点**旁(沿航向后退 ~700m, 高度 6800m)。
    // ⚠ 这一改同时修正了敌机刷新位置: spawnEnemyFromWave 会把刷新点朝 mission.startPos
    //   拉 48%, 起点在编队旁 ⇒ 敌机才会出现在编队附近(原来被拉向 200km 外的旧起点)。
    startPos: [101272, 6800, 124198],
    startHeading: -2.461,     // 朝西南(指向第二路径点; 0=+Z)
    // === 鹫中队: 玩家 + 3 架僚机(游隼/夜枭/山雀) ==============================
    // [!] 顺序要紧: 引擎的"隼中队死盯鹫3"(roleTag 'ace-on-escort', targetWingman: 2)
    //     按 wingmen 数组下标取目标 ⇒ 下标 2 必须是**山雀**(剧本里的鹫3)。
    spawns: [
      { model: 'f16', role: 'fighter', position: [100832, 6800, 124618], heading: -2.461, altitude: 6800,
        isWingman: true, callsign: '游隼' },
      { model: 'f16', role: 'fighter', position: [101712, 6800, 123778], heading: -2.461, altitude: 6800,
        isWingman: true, callsign: '夜枭' },
      { model: 'f16', role: 'fighter', position: [101272, 6700, 124198], heading: -2.461, altitude: 6700,
        isWingman: true, callsign: '山雀' },
    ],
    objectives: [
      // 胜利条件: 编队**全部**进入撤离点判定盒(引擎按 allInside 判定)。
      // 圆心/半径 = 用户盒"撤退部队撤离点判定盒"(中心 -70192,-139581, 边长 56069 ⇒ r=28034)。
      // 之后还要打完隼中队并返航(那里由剧情控制器判定胜利, 见 updateStoryS02 阶段 6)
      {
        id: 'escort', label: '掩护东奥莱编队撤入撤离点', type: 'reach', target: 'escort',
        count: 5, pos: [-70192, 0, -139581], radius: 28034, allInside: true,
      },
    ],
    // 时限 = 60 分钟: 用户盒给定的撤退航线全长 263 km, 即使按 worldSpeedK 1.5 的
    // 加速标度也要飞 ~31 分钟(旧值 1500 s = 25 分钟 ⇒ 连航线都飞不完就超时判负)。
    timeLimit: 1500,   // 25 分钟: 阶段驱动 18 分钟 + 台词/收尾余量
    reward: 'Dongchuan withdrawal ribbon',
    recommendedCategories: ['fighter'],
    // === 简报情报(手写) =====================================================
    // 本关的敌人**全部由引擎的剧情控制器按阶段刷**(setupStoryS02 / gotoS02Stage),
    // 任务数据里没有敌方坐标 —— 所以这份敌我态势只能手写。
    // 坐标全部照抄引擎的实际生成式, 不是编的:
    //   · 护送编队 = 3 轰炸机(长弓)+2 运输机(铁锤), 出生点 = 用户盒"撤退部队第一出生点"
    //     (100831, 123654), 航向指向第一路径点(-41044, 94984) ⇒ side≈(-0.198, 0, 0.980);
    //     轰炸机沿 side 横排 300m、运输机在后方 900+260m;
    //   · 剑锋三波的进场方位 = 相对**编队当前位置**的 bearing π/4(东北)/π/2(正东)
    //     /3π/4(东南), 距离 7000+i*420(所以下面的坐标只是"那一刻编队在哪"的估计);
    //   · 隼中队(3 架 Su-35 王牌)= 编队 bearing π/2 两侧 ±0.3、距离 8200;
    //   · 中型空中战舰 = 沿撤退走廊西侧的巡逻航线, 每 50 秒一发空爆弹;
    //   · 高度: 编队巡航 7000 m(这条航线穿过的地形最高 6050 m), 玩家 6800 m。
    // 撤离点(用户盒"撤退部队撤离点判定盒", 中心 -70192,-139581, 半径 28034)
    // 由作战目标自带的 pos/radius 自动生成, 不必在这里写。
    briefing: {
      units: [
        // ---- 鹫中队: 玩家 + 3 架僚机(游隼/夜枭/山雀) ----
        { id: 'player', side: 'player', domain: 'air', code: 'LEAD',
          label: '鹫1', roleZh: '你 · 长机', roleEn: 'YOU · LEAD',
          x: 101272, z: 124198, altitude: 6800, heading: -2.461, priority: 900 },
        { id: 'wm1', side: 'friendly', domain: 'air', code: 'F-16',
          label: '游隼', roleZh: '僚机 2', roleEn: 'WINGMAN 2',
          x: 100832, z: 124618, altitude: 6800, heading: -2.461, priority: 130 },
        { id: 'wm2', side: 'friendly', domain: 'air', code: 'F-16',
          label: '夜枭', roleZh: '僚机 3', roleEn: 'WINGMAN 3',
          x: 101712, z: 123778, altitude: 6800, heading: -2.461, priority: 130 },
        // 山雀 的出生点与长机是同一个 XZ(引擎就把它放在长机正下方 100m),
        // 简报里靠"标签错位"把两个标签上下拉开(见 briefing-stage 的 stemK)。
        { id: 'wm3', side: 'friendly', domain: 'air', code: 'F-16',
          label: '山雀', roleZh: '僚机 4 · 隼中队的目标', roleEn: 'WINGMAN 4 · ACE TARGET',
          x: 101272, z: 124198, altitude: 6700, heading: -2.461, priority: 140 },
        // ---- 东奥莱编队(5 架, 受损): 3 轰炸机 + 2 运输机 ----
        { id: 'lb1', side: 'friendly', domain: 'air', code: 'B-52',
          label: '长弓1', roleZh: '轰炸机', roleEn: 'BOMBER',
          x: 100891, z: 123360, altitude: 7000, heading: -1.770, priority: 200 },
        { id: 'lb2', side: 'friendly', domain: 'air', code: 'B-52',
          label: '长弓2', roleZh: '轰炸机', roleEn: 'BOMBER',
          x: 100831, z: 123654, altitude: 7000, heading: -1.770, priority: 200 },
        { id: 'lb3', side: 'friendly', domain: 'air', code: 'B-52',
          label: '长弓3', roleZh: '轰炸机 · 引擎受损', roleEn: 'BOMBER · ENGINE DAMAGE',
          x: 100772, z: 123948, altitude: 7000, heading: -1.770, priority: 210,
          hp: 60, range: 4000,
          card: { title: '长弓3 · 受损', typeLabel: '轰炸机 · 引擎冒烟 · 速度 −20%', weapon: '必须护住', threat: 5 } },
        { id: 'th1', side: 'friendly', domain: 'air', code: 'TRANS',
          label: '铁锤1', roleZh: '运输机 · 载伤员', roleEn: 'TRANSPORT · WOUNDED ABOARD',
          x: 101745, z: 123675, altitude: 7000, heading: -1.770, priority: 195 },
        { id: 'th2', side: 'friendly', domain: 'air', code: 'TRANS',
          label: '铁锤2', roleZh: '运输机 · 载伤员', roleEn: 'TRANSPORT · WOUNDED ABOARD',
          x: 101937, z: 124040, altitude: 7000, heading: -1.770, priority: 195 },
        // ---- 西坎奥莱"剑锋"中队: 三波, 分别从东北 / 正东 / 东南压上 ----
        // wave>1 在简报里画得更暗并标注"情报估计" —— 后续波次本来就只是推断。
        { id: 'jf1', side: 'enemy', domain: 'air', code: 'F-15', label: '剑锋 1', roleZh: '敌战斗机 · 第1波', roleEn: 'BANDIT · WAVE 1', x: 105781, z: 128604, altitude: 6700, heading: -2.356, priority: 90, wave: 1,
          hp: 150, range: 7000,
          card: { title: '剑锋中队 · 第1波', typeLabel: '西坎奥莱攻击机群 · 专打编队', weapon: 'MSL · 拦截', threat: 3 } },
        { id: 'jf2', side: 'enemy', domain: 'air', code: 'F-16', label: '剑锋 2', roleZh: '敌战斗机 · 第1波', roleEn: 'BANDIT · WAVE 1', x: 106078, z: 128901, altitude: 6960, heading: -2.356, priority: 88, wave: 1 },
        { id: 'jf3', side: 'enemy', domain: 'air', code: 'F-15', label: '剑锋 3', roleZh: '敌战斗机 · 第2波', roleEn: 'BANDIT · WAVE 2', x: 65269, z: 115053, altitude: 6700, heading: -2.356, priority: 80, wave: 2 },
        { id: 'jf4', side: 'enemy', domain: 'air', code: 'F-16', label: '剑锋 4', roleZh: '敌战斗机 · 第2波', roleEn: 'BANDIT · WAVE 2', x: 68269, z: 115053, altitude: 6960, heading: -2.356, priority: 78, wave: 2 },
        { id: 'jf5', side: 'enemy', domain: 'air', code: 'F-15', label: '剑锋 5', roleZh: '敌战斗机 · 第3波', roleEn: 'BANDIT · WAVE 3', x: -36094, z: 90034, altitude: 6700, heading: -2.356, priority: 70, wave: 3 },
        { id: 'jf6', side: 'enemy', domain: 'air', code: 'F-16', label: '剑锋 6', roleZh: '敌战斗机 · 第3波', roleEn: 'BANDIT · WAVE 3', x: -35797, z: 89737, altitude: 6960, heading: -2.356, priority: 68, wave: 3 },
        // ---- 王牌中队"隼"(3 架 Su-35, 死盯鹫3 山雀) ----
        { id: 'hy1', side: 'enemy', domain: 'air', code: 'Su-35',
          label: '隼1', roleZh: '西坎奥莱王牌 · 死盯山雀', roleEn: 'ACE · HUNTS WINGMAN 4',
          x: -95225, z: 20857, altitude: 6700, heading: -2.356, priority: 700, hp: 160, range: 9000,
          card: { title: '隼中队 · 王牌', typeLabel: 'Su-35 三机 · 死盯鹫3(山雀)', weapon: 'QAAM · 缠斗', threat: 4 } },
        { id: 'hy2', side: 'enemy', domain: 'air', code: 'Su-35', label: '隼2', roleZh: '西坎奥莱王牌', roleEn: 'ACE', x: -94858, z: 18434, altitude: 6700, heading: -2.356, priority: 660, hp: 160, range: 9000 },
        { id: 'hy3', side: 'enemy', domain: 'air', code: 'Su-35', label: '隼3', roleZh: '西坎奥莱王牌', roleEn: 'ACE', x: -95225, z: 16011, altitude: 6700, heading: -2.356, priority: 660, hp: 160, range: 9000 },
        // ---- 中型空中战舰: 沿撤退走廊西侧巡逻, 每 50 秒一发空爆弹(半径 800m) ----
        // 舰体尺寸 = 引擎实际网格: AIR_WARSHIP_SIZE(620×168×103) × spawnAirWarship 的 0.62。
        { id: 'warship', side: 'target', domain: 'hvt', code: 'AIR-MED',
          label: '走廊西侧战舰', roleZh: '中型空中战舰 · 空爆弹', roleEn: 'MEDIUM AIR WARSHIP · AIRBURST',
          x: -115000, z: -20000, altitude: 7000, heading: 3.05, priority: 900,
          hp: 460, range: 9000, hull: [104, 64, 384],
          card: { title: '中型空中战舰', typeLabel: '走廊西侧巡逻 · 每 50 秒一发空爆弹', weapon: 'LASM · 反舰', threat: 5 } },
      ],
      // 区域: 撤离点判定盒(半径 28 km)。作战目标里已经带了 pos/radius, 本来会自动生成;
      // 这里手写一份是为了给它一个**短**的地图注解(目标 label 太长, 画在圆上会糊)。
      areas: [
        { id: 'aor', side: 'friendly', label: '撤离点 · 集结点', x: -70192, z: -139581, radius: 28034 },
      ],
      routes: [
        // 撤离走廊: 第一出生点 → 第一/二/三路径点 → 撤离点(坐标全照抄用户盒)
        { id: 'corridor', side: 'friendly', label: 'CORRIDOR · 撤离走廊',
          points: [[100831, 7000, 123654], [-41044, 6800, 94984], [-103058, 7000, 18434],
                   [-70192, 6500, -127686], [-70192, 6000, -139581]] },
        // 剑锋三波的进场方位(东北 / 正东 / 东南) —— 图上这三条红线就是"敌人从哪来"
        { id: 'ingress-ne', side: 'enemy', label: 'INGRESS NE', dash: true,
          points: [[140000, 6700, 160000], [122000, 6700, 142000], [105781, 6700, 128604]] },
        { id: 'ingress-e', side: 'enemy', label: 'INGRESS E', dash: true,
          points: [[148000, 6700, 124500], [125000, 6700, 123700], [107831, 6700, 123654]] },
        { id: 'ingress-se', side: 'enemy', label: 'INGRESS SE', dash: true,
          points: [[125000, 6700, 90000], [60000, 6700, 100000], [-36094, 6700, 90034]] },
        // 战舰的走廊西侧巡逻航线(虚线 = 它会一直在那儿绕, 不追你)
        { id: 'warship-patrol', side: 'enemy', label: 'WARSHIP PATROL', dash: true,
          points: [[-115000, 7000, -20000], [-92000, 7000, -55000], [-115000, 7000, -90000],
                   [-135000, 7000, -50000]] },
      ],
    },
  },
];

export function getMission(id: string): Mission | undefined {
  return MISSIONS.find((m) => m.id === id);
}
