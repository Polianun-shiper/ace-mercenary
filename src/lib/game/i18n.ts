// === Lightweight i18n module ===============================================
// Single source of truth for all UI strings. Components call `t(key)` instead
// of hard-coding English, so the entire game can be flipped to Chinese (or any
// future locale) by flipping one localStorage key.
//
// Design:
//   - Two locales: 'en' and 'zh'. Default 'zh' (per user request: 全部中文).
//   - Storage key: 'skybound.lang'. Read on first load; written on toggle.
//   - Subscribe/notify pattern: components can call `subscribe(cb)` to be
//     notified when the language changes (so React can re-render).
//   - Keys are dotted paths ("menu.campaign"). If a key is missing in the
//     active locale, we fall back to English; if still missing, return the key
//     itself (so a missing string is obvious in the UI without crashing).
//   - Translation dictionaries are below. They cover every user-visible string
//     in Menus.tsx, Hud.tsx, Settings.tsx, GameApp.tsx.

export type Locale = 'en' | 'zh';

const LANG_KEY = 'skybound.lang';

let currentLocale: Locale = 'zh';
const listeners = new Set<() => void>();

function readStoredLocale(): Locale {
  if (typeof window === 'undefined') return 'zh';
  const v = window.localStorage.getItem(LANG_KEY);
  return v === 'en' ? 'en' : 'zh';
}

function writeStoredLocale(l: Locale) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LANG_KEY, l);
}

// Initialise on module load (browser only).
if (typeof window !== 'undefined') {
  currentLocale = readStoredLocale();
}

// === Translation dictionaries ==============================================
// Each key is a fully-qualified path; we keep them flat in a single object so
// `t('menu.campaign')` is a single hash lookup with no parsing overhead.
const en: Record<string, string> = {
  // ---- Main menu ----
  'menu.tagline': '◆ PROJECT SKYBOUND ◆',
  'menu.subtitle': 'AERIAL COMBAT SIMULATOR · EXPERT CONTROLS',
  'menu.campaign': 'CAMPAIGN',
  'menu.hangar': 'HANGAR',
  'menu.settings': 'SETTINGS',
  'menu.footerModels': 'F-16 · F-15 · Su-35 · A-10 · B-52 · EA-18G · AC-130 · F-117 · E-3',
  'menu.footerVersion': 'v3.0 · GHOST SQUADRON · 9 FLYABLE TYPES · {n} OPERATIONS',

  // ---- Mission select ----
  'ms.back': '◀ BACK',
  'ms.title': 'MISSION SELECT',
  'ms.countOps': '{n} OPERATIONS',
  'ms.codename': 'CODE NAME',
  'ms.time': '⏱ {time}',
  'ms.units': '⚑ {n} UNITS',
  'ms.objectives': '◈ {n} OBJECTIVES',
  'ms.sky': '▣ {sky}',
  'ms.weather': '☂ {weather}',
  'ms.map': '⌖ {map}',
  'ms.recommended': '◈ RECOMM: {cats}',

  // ---- Briefing ----
  'br.title': 'MISSION BRIEFING',
  'br.objectives': 'OBJECTIVES',
  'br.recommendedAircraft': 'RECOMMENDED AIRCRAFT',
  'br.environment': 'ENVIRONMENT',
  'br.sky': 'Sky',
  'br.weather': 'Weather',
  'br.map': 'Map',
  'br.selectAircraft': 'SELECT AIRCRAFT',
  'br.recommendedHint': '★ = RECOMMENDED FOR THIS MISSION · CLICK TO SWAP',
  'br.paintScheme': 'PAINT SCHEME',
  'br.selectedAircraft': 'SELECTED AIRCRAFT',
  'br.loadout': 'LOADOUT',
  'br.controls': 'CONTROLS · EXPERT MODE',
  'br.launch': '▶ LAUNCH MISSION',
  'br.launchHint': 'AIRCRAFT SELECTED ABOVE · VISIT HANGAR FROM MAIN MENU FOR 3D PREVIEW',

  // ---- Cinematic briefing sequence (2D map -> 3D tactical grid) ----
  'stbr.beat': 'BEAT',
  'stbr.threat': 'THREAT',
  'stbr.critical': 'CRITICALITY',
  'stbr.weapon': 'RECOMMENDED',
  'stbr.est': 'EST',
  'stbr.legend': 'IFF: SELF=CYAN · ALLY=BLUE · TARGET=RED · HVT=RING · EST=DIM AMBER',
  'stbr.mapView': '2D MAP',
  'stbr.gridView': '3D GRID',
  'stbr.toggleHint': 'TAB / CLICK TOGGLE VIEW',
  'stbr.ffwd': '⏩ FAST-FORWARD',
  'stbr.skip': '⏭ SKIP BRIEFING',
  'stbr.proceed': '▶ PROCEED',
  'stbr.hold': 'STAND BY · TACTICAL PICTURE HOLDING',
  'stbr.sitrep': 'SITREP',
  'stbr.friendly': 'FRIENDLY',
  'stbr.enemy': 'ENEMY',
  'stbr.targets': 'TARGETS',
  'stbr.nogl': 'NO TACTICAL RENDERER · TERMINAL ONLY',

  // ---- Controls reference grid ----
  'ctrl.pitch': 'W/S PITCH',
  'ctrl.roll': 'A/D ROLL',
  'ctrl.yaw': 'Q/E YAW',
  'ctrl.throttle': 'SHIFT/CTRL THROTTLE',
  'ctrl.gun': 'SPACE GUN / SIDE',
  'ctrl.missile': 'F FIRE MSL / EW',
  'ctrl.cycleWpn': 'V CYCLE WPN',
  'ctrl.flare': 'G FLARES',
  'ctrl.camera': 'Z CAMERA',
  'ctrl.freeLook': 'C FREE-LOOK',
  'ctrl.nextTgt': 'TAB NEXT TGT',
  'ctrl.lookback': 'R LOOK BACK',
  'ctrl.pause': 'P PAUSE',
  'ctrl.wingAtk': '1 WINGMAN ATK',
  'ctrl.wingCov': '2 WINGMAN COV',
  'ctrl.wingForm': '3 WINGMAN FORM',
  'ctrl.settings': '⚙ SETTINGS (PAUSE)',
  'ctrl.mouseWheel': 'MOUSE WHEEL ZOOM CAMERA · HIGH-G MANEUVERS GENERATE VAPOR CONES & CONTRAILS · STORMS CAUSE TURBULENCE & WIND SHEAR',

  // ---- HUD labels ----
  'hud.time': 'TIME',
  'hud.score': 'SCORE',
  'hud.wave': 'WAVE',
  'hud.speed': 'SPEED',
  'hud.kn': 'KN',
  'hud.thr': 'THR',
  'hud.energy': 'ENERGY',
  'hud.alt': 'ALT',
  'hud.ft': 'FT',
  'hud.dmg': 'DMG',
  'hud.hdg': 'HDG',
  'hud.gforce': 'G',
  'hud.stall': 'STALL',
  'hud.terrain': 'TERRAIN — PULL UP',
  'hud.lockProgress': 'LOCK {n}%',
  'hud.locked': '◆ LOCK ◆',
  'hud.incomingLock': '⚠ RADAR LOCK ⚠',
  'hud.wingman': 'WINGMAN',
  'hud.wingmanHint': '[1]ATK [2]COV [3]FORM [4]SUPP',
  'hud.reinforce': 'REINFORCE [4]',
  'hud.reinforceReady': 'READY',
  'hud.reinforceCooldown': '{n}s',
  'hud.reinforceEmpty': 'EMPTY',
  'hud.tacmap': 'TAC MAP · 14KM',
  'hud.wx': 'WX',
  'hud.wind': 'WIND {n}m/s',
  'hud.weapons': 'WEAPONS · {cat}',
  'hud.current': 'CURRENT: {wpn} [{n}]',
  'hud.sideChg': 'SIDE CHG',
  'hud.jammerChg': 'JAMMER CHG',
  'hud.tgt': 'TGT',
  'hud.dist': 'DIST {n}M · {a}°',
  'hud.cam': 'CAM: {mode}',
  'hud.objectivePrefix': '▸ ',

  // ---- Settings ----
  'set.back': '◀ BACK',
  'set.title': 'CONTROLS SETTINGS',
  'set.reset': 'RESET DEFAULTS',
  'set.axisInversion': 'AXIS INVERSION',
  'set.axisNormal': 'NORMAL',
  'set.axisInverted': 'INVERTED',
  'set.axisHint': 'INVERT PITCH = pull stick back = nose up (flight-sim style). NORMAL = push forward = nose down (arcade style).',
  'set.pressKey': 'PRESS KEY...',
  'set.footer': 'PRESS ESC TO CANCEL REBINDING · SETTINGS AUTO-SAVED TO BROWSER',
  'set.lang': 'LANGUAGE',
  'set.langEn': 'ENGLISH',
  'set.langZh': '中文',
  'set.cloud': 'CLOUD RENDERING',
  'set.cloudHint': 'Geometry = 3D polygonal clouds · Sprite = flat billboard clouds (cheaper, classic look)',
  'set.cloudGeo': 'GEOMETRY (3D)',
  'set.cloudSprite': 'SPRITE (BILLBOARD)',
  'set.cloudCov': 'CLOUD COVERAGE',
  'set.cloudCovHint': 'Scattered = isolated individual clouds · Mixed = some clusters · Overcast = merged cloud banks/sheets',
  'set.cloudCovScattered': 'SCATTERED',
  'set.cloudCovMixed': 'MIXED',
  'set.cloudCovOvercast': 'OVERCAST',
  'set.ssr': 'SCREEN-SPACE REFLECTIONS',
  'set.ssrHint': 'Real-time reflections on ocean, lakes, and wet terrain. Off = best framerate · On = cinematic quality (costs ~30% FPS)',
  'set.ssrOff': 'OFF (BETTER FPS)',
  'set.ssrOn': 'ON (CINEMATIC)',
  'set.ssrNote': '⚠ Applies on next mission start. Recommended only on dedicated GPUs.',
  'set.bloom': 'BLOOM (SUN / NIGHT GLOW)',
  'set.bloomHint': 'Cinematic glow on the sun, missile engines, explosions, and city lights. Strongest at night. Cheap — keep ON unless chasing max FPS.',
  'set.bloomOff': 'OFF (MAX FPS)',
  'set.bloomOn': 'ON (CINEMATIC)',
  'set.staticShadow': 'STATIC SCENE SHADOW',
  'set.staticShadowHint': 'Single shadow map for terrain + buildings. Cheap-ish. Gives the world solid grounding instead of flat-lit shapes.',
  'set.csm': 'CSM — PLAYER AIRCRAFT SELF-SHADOW',
  'set.csmHint': 'Cascaded Shadow Maps follow the camera (4 cascades x 2048) — denser shadow texels near the camera than the single static ortho map. WARNING: with the current terrain material this needs 17 texture units (> 16 limit), so the terrain shader fails and the ground disappears. Kept for A/B experiments only.',
  'set.virtualJoystick': 'VIRTUAL JOYSTICK (TOUCH)',
  'set.virtualJoystickHint': 'On-screen joystick + buttons for mobile/touch play. Auto-ON on touch devices. Left stick: pitch/roll · Right stick: yaw/throttle · FIRE hold = gun.',
  'set.vjOff': 'OFF (KEYBOARD)',
  'set.vjOn': 'ON (TOUCH)',
  'set.mobileMode': 'MOBILE PERFORMANCE MODE (60 FPS)',
  'set.mobileModeHint': 'Optimizes for smooth 60fps on phones: capped resolution with adaptive downscale, bloom/SSR/shadows off, sprite clouds. Defaults to OFF (desktop quality); auto-ON only on handheld devices (coarse pointer + small screen).',
  'set.mobileOff': 'OFF (DESKTOP QUALITY)',
  'set.mobileOn': 'ON (60 FPS)',
  'set.difficulty': 'DIFFICULTY',
  'set.difficultyHint': 'Lower difficulty = calmer enemies (longer cooldowns, slower locks, shorter radar range, fewer simultaneous attackers). Ground/naval units are always less aggressive.',
  'set.diffEasy': 'EASY',
  'set.diffNormal': 'NORMAL',
  'set.diffHard': 'HARD',
  'set.volume': 'VOLUME',
  'set.volumeHint': 'Master applies on next mission start. Music/SFX apply immediately.',
  'set.volumeMaster': 'MASTER',
  'set.volumeMusic': 'MUSIC',
  'set.volumeSfx': 'SFX',
  'set.volumeEngine': 'ENGINE',
  'set.volumeWind': 'AIRFLOW',
  'vj.edit': 'EDIT LAYOUT',
  'vj.save': 'SAVE',
  'vj.cancel': 'CANCEL',
  'vj.reset': 'DEFAULT',
  'vj.editHint': 'Drag controls to reposition. SAVE to keep, CANCEL to undo.',
  'set.shadowOff': 'OFF',
  'set.shadowOn': 'ON',
  'set.shadowNote': '⚠ Applies on next mission start. Recommended only on dedicated GPUs.',
  'set.csmNote': '⚠ Applies on next mission start. Most expensive quality option — disable on weaker GPUs.',
  'set.selfShadowSys': 'SELF-SHADOW SYSTEM',
  'set.selfShadowSysHint': 'How the player aircraft casts shadows onto itself (only when CSM/static are off).',
  'set.selfShadowPbr': 'PBR (NEW)',
  'set.selfShadowLegacy': 'LEGACY',
  'set.selfShadowNote': '⚠ Applies on next mission start. PBR fits the shadow frustum tightly to the airframe (no acne); Legacy is the old fixed-frustum light.',
  'set.textureQuality': 'TEXTURE QUALITY (PBR)',
  'set.textureQualityHint': 'Resolution tier + anisotropy of the PBR texture sets (aircraft/units/buildings).',
  'set.tqLow': 'LOW',
  'set.tqMedium': 'MEDIUM',
  'set.tqHigh': 'HIGH',
  'set.textureQualityNote': '⚠ Applies on next mission start. High = 1024² livery (KTX2-compressed when built), 16× aniso. Low halves VRAM usage.',
  'set.fpsCap': 'PC MAX FRAME RATE',
  'set.fpsCapHint': 'Cap the render rate to save GPU/CPU. Applies on next mission/hangar.',
  'set.fpsOff': 'OFF',
  'set.fpsCapNote': 'Uncapped runs at your display refresh rate. 30 = lowest load.',
  'set.pipeline': 'RENDER PIPELINE (EXPERIMENTAL)',
  'set.pipelineHint': 'Forward = classic forward rendering. Deferred = experimental G-Buffer pipeline (PBR layers lit in a fullscreen pass). Auto = WebGL2 → deferred, fallback forward.',
  'set.pipelineForward': 'FORWARD',
  'set.pipelineDeferred': 'DEFERRED',
  'set.pipelineAuto': 'AUTO',
  'set.pipelineNote': '⚠ Experimental. Deferred: no explosion point-lights / CSM cascades, single sun shadow. Applies on next mission start.',

  // ---- Settings action labels ----
  'act.pitchUp': 'PITCH UP (nose up)',
  'act.pitchDown': 'PITCH DOWN (nose down)',
  'act.rollLeft': 'ROLL LEFT',
  'act.rollRight': 'ROLL RIGHT',
  'act.yawLeft': 'YAW LEFT',
  'act.yawRight': 'YAW RIGHT',
  'act.throttleUp': 'THROTTLE UP',
  'act.throttleDown': 'THROTTLE DOWN',
  'act.brake': 'HIGH-G MANEUVER (HOLD)',
  'act.airbrake': 'AIRBRAKE (HOLD)',
  'act.emergencyBrake': 'EMERGENCY BRAKE (HOLD)',
  'act.aoaOverride': 'AoA LIMIT OVERRIDE (HOLD)',
  'act.fireGun': 'FIRE GUN',
  'act.fireMissile': 'FIRE MISSILE',
  'act.flare': 'DEPLOY FLARES',
  'act.cycleWeapon': 'CYCLE WEAPON',
  'act.cycleCamera': 'CYCLE CAMERA',
  'act.lookBack': 'LOOK BACK',
  'act.lookTarget': 'LOOK AT TARGET (HOLD)',
  'act.wingmanView': 'WINGMAN VIEW (CYCLE)',
  'act.missileView': 'MISSILE VIEW (J)',
  'act.cycleRadarRange': 'CYCLE RADAR ZOOM',
  'act.toggleRadarFilter': 'TOGGLE RADAR FILTER',
  'act.freeLook': 'FREE LOOK (HOLD)',
  'act.toggleSideView': 'SIDE VIEW (AC-130)',
  'act.gear': 'LANDING GEAR (X)',
  'act.nextTarget': 'NEXT TARGET',
  'act.wingmanAttack': 'WINGMAN: ATTACK',
  'act.wingmanCover': 'WINGMAN: COVER',
  'act.wingmanForm': 'WINGMAN: FORM UP',
  'act.callReinforcement': 'CALL REINFORCEMENTS',
  'act.togglePause': 'PAUSE',

  // ---- Settings group headers ----
  'grp.FLIGHT': 'FLIGHT',
  'grp.THROTTLE': 'THROTTLE',
  'grp.COMBAT': 'COMBAT',
  'grp.VIEW': 'VIEW',
  'grp.WINGMAN': 'WINGMAN',
  'grp.SYSTEM': 'SYSTEM',

  // ---- Pause overlay ----
  'pause.simPaused': 'SIMULATION PAUSED',
  'pause.title': 'PAUSED',
  'pause.resume': 'RESUME',
  'pause.settings': 'SETTINGS',
  'pause.abort': 'ABORT',
  'pause.hint': 'PRESS P TO RESUME',
  // === 联机对局内菜单 (per user request: 对战中谁也不能暂停) ===
  // 措辞刻意不用 PAUSED: 世界没有停, 只是菜单开着。
  'pause.mpSimRunning': 'MATCH IN PROGRESS',
  'pause.mpTitle': 'MENU',
  'pause.mpResume': 'BACK TO FIGHT',
  'pause.endMatch': 'END MATCH (HOST)',
  'pause.mpHint': 'ESC CLOSES THIS MENU — THE MATCH KEEPS RUNNING',

  // ---- Results screen ----
  'res.success': 'OPERATION SUCCESSFUL',
  'res.fail': 'MISSION FAILED',
  'res.complete': 'MISSION COMPLETE',
  'res.failed': 'MISSION FAILED',
  'res.score': 'SCORE',
  'res.kills': 'KILLS',
  'res.time': 'TIME',
  'res.continue': 'CONTINUE',

  // ---- Loading ----
  'loading.init': 'INITIALISING COMBAT SYSTEMS',
  'loading.standby': 'PLEASE STAND BY',

  // ---- GameApp / engine messages ----
  'msg.flareDeployed': 'FLARES DEPLOYED',
  'msg.mslEmpty': 'MSL EMPTY',
  'msg.lasmEmpty': 'LASM EMPTY',
  'msg.noLock': 'NO LOCK',
  'msg.noTarget': 'NO TARGET',
  'msg.noTargetSideArc': 'NO TARGET IN SIDE ARC',
  'msg.sideCannonRecharge': 'SIDE CANNON RECHARGING',
  'msg.jammerRecharge': 'JAMMER RECHARGING',
  'msg.sideCannonHit': 'SIDE CANNON → {name}',
  'msg.jammerDecoyed': 'JAMMER → {n} MISSILE(S) DECOYED',
  'msg.jammerPulse': 'JAMMER PULSE EMITTED',
  'msg.camSwitch': 'CAM: {mode}',
  'msg.wpnSwitch': 'WPN: {wpn}',
  'msg.paused': 'PAUSED',
  'msg.resumed': 'RESUMED',
  'msg.tgtSelect': 'TGT: {name}',
  'msg.wingAtk': 'WINGMAN: ENGAGE',
  'msg.wingCov': 'WINGMAN: COVER',
  'msg.wingForm': 'WINGMAN: FORM UP',
  'msg.missileInbound': 'MISSILE INBOUND!',
  'msg.bomberDown': 'BOMBER DOWN!',
  'msg.multiKill': 'MULTI-KILL x{n}!',
  'msg.enemyDestroyed': '{name} DESTROYED',
  'msg.allyLost': '{name} LOST!',
  'msg.aircraftLost': 'AIRCRAFT LOST',
  'msg.wingmanRejoined': '{name} REJOINED FORMATION',
  'msg.wingmanRTB': '{name} DAMAGED — RTB TO REPAIR',
  'msg.underAttack': '{name} UNDER ATTACK!',
  'msg.hit': 'HIT!',
  'msg.missionComplete': 'MISSION COMPLETE',
  'msg.missionFailed': 'MISSION FAILED',
  'msg.timeExpired': 'TIME EXPIRED',
  'msg.aircraftDestroyed': 'AIRCRAFT DESTROYED',
  'msg.allyLostObjective': 'ALLY LOST',
};

const zh: Record<string, string> = {
  // ---- Main menu ----
  'menu.tagline': '◆ 天际计划 ◆',
  'menu.subtitle': '空战模拟器 · 专家操控',
  'menu.campaign': '战役模式',
  'menu.hangar': '机库',
  'menu.settings': '设置',
  'menu.footerModels': 'F-16 · F-15 · Su-35 · A-10 · B-52 · EA-18G · AC-130 · F-117 · E-3',
  'menu.footerVersion': 'v3.0 · 幽灵中队 · 9 种机型 · {n} 个作战任务',

  // ---- Mission select ----
  'ms.back': '◀ 返回',
  'ms.title': '任务选择',
  'ms.countOps': '{n} 个任务',
  'ms.codename': '代号',
  'ms.time': '⏱ {time}',
  'ms.units': '⚑ {n} 个单位',
  'ms.objectives': '◈ {n} 项目标',
  'ms.sky': '▣ {sky}',
  'ms.weather': '☂ {weather}',
  'ms.map': '⌖ {map}',
  'ms.recommended': '◈ 推荐: {cats}',

  // ---- Briefing ----
  'br.title': '任务简报',
  'br.objectives': '目标',
  'br.recommendedAircraft': '推荐机型',
  'br.environment': '环境',
  'br.sky': '天空',
  'br.weather': '天气',
  'br.map': '地图',
  'br.selectAircraft': '选择机型',
  'br.recommendedHint': '★ = 本任务推荐机型 · 点击切换',
  'br.paintScheme': '涂装方案',
  'br.selectedAircraft': '已选机型',
  'br.loadout': '挂载',
  'br.controls': '操控 · 专家模式',
  'br.launch': '▶ 开始任务',
  'br.launchHint': '上方选择机型 · 在主菜单进入机库可查看 3D 预览',

  // ---- 电影式简报过场(2D 地图 → 3D 战术网格) ----
  'stbr.beat': '拍',
  'stbr.threat': '威胁',
  'stbr.critical': '关键度',
  'stbr.weapon': '建议武器',
  'stbr.est': '情报估计',
  'stbr.legend': '识别: 自己=青 · 友军=蓝 · 目标=红 · 高价值=解算环 · 估计=暗琥珀',
  'stbr.mapView': '2D 地图',
  'stbr.gridView': '3D 网格',
  'stbr.toggleHint': 'TAB / 点击切换视图',
  'stbr.ffwd': '⏩ 快进到态势图',
  'stbr.skip': '⏭ 跳过简报',
  'stbr.proceed': '▶ 简报结束',
  'stbr.hold': '待命 · 战术态势图留驻中',
  'stbr.sitrep': '态势',
  'stbr.friendly': '友军',
  'stbr.enemy': '敌军',
  'stbr.targets': '目标',
  'stbr.nogl': '无战术渲染器 · 仅终端',

  // ---- Controls reference grid ----
  'ctrl.pitch': 'W/S 俯仰',
  'ctrl.roll': 'A/D 滚转',
  'ctrl.yaw': 'Q/E 偏航',
  'ctrl.throttle': 'SHIFT/CTRL 油门',
  'ctrl.gun': 'SPACE 机炮 / 侧射炮',
  'ctrl.missile': 'F 发射导弹 / 电子战',
  'ctrl.cycleWpn': 'V 切换武器',
  'ctrl.flare': 'G 热焰弹',
  'ctrl.camera': 'Z 切换视角',
  'ctrl.freeLook': 'C 自由视角',
  'ctrl.nextTgt': 'TAB 下一个目标',
  'ctrl.lookback': 'R 后视',
  'ctrl.pause': 'P 暂停',
  'ctrl.wingAtk': '1 僚机攻击',
  'ctrl.wingCov': '2 僚机掩护',
  'ctrl.wingForm': '3 僚机编队',
  'ctrl.settings': '⚙ 设置 (暂停中)',
  'ctrl.mouseWheel': '鼠标滚轮缩放视角 · 高 G 机动产生凝结云与尾迹 · 暴风雨引发颠簸与风切变',

  // ---- HUD labels ----
  // ⚠ 这里是**任务已用时间**(mm:ss, 见 Hud.tsx 的 formatTime(hud.missionTime)), 不是时刻。
  //   旧文案只写"时间" ⇒ 实测被读成"现在 18:31"(以为光照时间不对)。改成"任务时间"消歧。
  'hud.time': '任务时间',
  'hud.score': '得分',
  'hud.wave': '波次',
  'hud.speed': '速度',
  'hud.kn': '节',
  'hud.thr': '油门',
  'hud.energy': '能量',
  'hud.alt': '高度',
  'hud.ft': '英尺',
  'hud.dmg': '损伤',
  'hud.hdg': '航向',
  'hud.gforce': 'G',
  'hud.stall': '失速',
  'hud.terrain': '地形 — 拉起!',
  'hud.lockProgress': '锁定 {n}%',
  'hud.locked': '◆ 已锁定 ◆',
  'hud.incomingLock': '⚠ 雷达锁定 ⚠',
  'hud.wingman': '僚机',
  'hud.wingmanHint': '[1]攻击 [2]掩护 [3]编队 [4]支援',
  'hud.reinforce': '支援 [4]',
  'hud.reinforceReady': '就绪',
  'hud.reinforceCooldown': '{n}s',
  'hud.reinforceEmpty': '已用尽',
  'hud.tacmap': '战术地图 · 14公里',
  'hud.wx': '天气',
  'hud.wind': '风速 {n}m/s',
  'hud.weapons': '武器 · {cat}',
  'hud.current': '当前: {wpn} [{n}]',
  'hud.sideChg': '侧炮能量',
  'hud.jammerChg': '干扰机能量',
  'hud.tgt': '目标',
  'hud.dist': '距离 {n}M · {a}°',
  'hud.cam': '视角: {mode}',
  'hud.objectivePrefix': '▸ ',

  // ---- Settings ----
  'set.back': '◀ 返回',
  'set.title': '操控设置',
  'set.reset': '重置默认',
  'set.axisInversion': '轴反向',
  'set.axisNormal': '正常',
  'set.axisInverted': '反向',
  'set.axisHint': '俯仰反向 = 拉杆 = 抬头（飞行模拟风格）. 正常 = 推杆 = 低头（街机风格）.',
  'set.pressKey': '请按键…',
  'set.footer': '按 ESC 取消重绑 · 设置自动保存到浏览器',
  'set.lang': '语言',
  'set.langEn': 'ENGLISH',
  'set.langZh': '中文',
  'set.cloud': '云朵渲染',
  'set.cloudHint': '几何体 = 3D 多边形云朵 · 贴片 = 平面贴图云（性能更好，经典外观）',
  'set.cloudGeo': '几何体（3D）',
  'set.cloudSprite': '贴片（布告板）',
  'set.cloudCov': '云朵覆盖',
  'set.cloudCovHint': '零散 = 独立单体云 · 混合 = 部分成簇 · 连片 = 云朵合并成片状云层',
  'set.cloudCovScattered': '零散',
  'set.cloudCovMixed': '混合',
  'set.cloudCovOvercast': '连片',
  'set.ssr': '屏幕空间反射',
  'set.ssrHint': '海面、湖泊、湿润地形的实时反射。关 = 最佳帧率 · 开 = 电影级画质（约损失30%帧率）',
  'set.ssrOff': '关闭（高帧率）',
  'set.ssrOn': '开启（电影级）',
  'set.ssrNote': '⚠ 下次任务开始时生效。建议仅在独立显卡上开启。',
  'set.bloom': '泛光（太阳/夜光）',
  'set.bloomHint': '为太阳、导弹尾焰、爆炸、城市灯火添加电影级辉光。夜晚最强。开销小，建议保持开启。',
  'set.bloomOff': '关闭（极限帧率）',
  'set.bloomOn': '开启（电影级）',
  'set.staticShadow': '场景静态阴影',
  'set.staticShadowHint': '为地形和建筑生成单一阴影贴图。开销较小。让世界有立体感而不是平面光照。',
  'set.csm': 'CSM — 玩家机体动态自阴影',
  'set.csmHint': '级联阴影贴图跟随相机（4 级 × 2048），近处纹素密度高于单张静态正交图。注意：当前地形材质下它要占 17 张纹理单元（上限 16）⇒ 地形着色器校验失败、地表会消失（2026-09-23 实测，详见 docs/shadow-pipeline.md §11）。仅留作 A/B 对照。',
  'set.virtualJoystick': '虚拟摇杆（触屏操控）',
  'set.virtualJoystickHint': '触屏设备上显示屏幕摇杆与按钮。触屏设备默认开启。左摇杆：俯仰/滚转 · 右摇杆：偏航/油门 · FIRE 按住=机炮。',
  'set.vjOff': '关闭（键盘）',
  'set.vjOn': '开启（触屏）',
  'set.mobileMode': '手机性能模式（60帧）',
  'set.mobileModeHint': '为手机流畅60帧优化：分辨率上限+自适应降级、关闭泛光/反射/阴影、贴片云。默认关闭（桌面画质）；只有手持设备（触屏+小屏）才自动开启。',
  'set.mobileOff': '关闭（桌面画质）',
  'set.mobileOn': '开启（60帧）',
  'set.difficulty': '难度',
  'set.difficultyHint': '难度越低敌人攻击欲望越低（冷却更长、锁定更慢、雷达范围更短、同时攻击者更少）。地面/海面单位始终较为消极。',
  'set.diffEasy': '简单',
  'set.diffNormal': '普通',
  'set.diffHard': '困难',
  'set.volume': '音量',
  'set.volumeHint': '主音量下次任务开始时生效。音乐/音效立即生效。',
  'set.volumeMaster': '主音量',
  'set.volumeMusic': '音乐',
  'set.volumeSfx': '音效',
  'set.volumeEngine': '引擎声',
  'set.volumeWind': '气流声',
  'vj.edit': '布局编辑',
  'vj.save': '保存',
  'vj.cancel': '取消',
  'vj.reset': '重置',
  'vj.editHint': '拖动控件调整位置。保存以生效，取消则还原。',
  'set.shadowOff': '关闭',
  'set.shadowOn': '开启',
  'set.shadowNote': '⚠ 下次任务开始时生效。建议仅在独立显卡上开启。',
  'set.csmNote': '⚠ 下次任务开始时生效。开销最大的画质选项 — 弱GPU建议关闭。',
  'set.selfShadowSys': '机体自阴影系统',
  'set.selfShadowSysHint': '玩家战机如何在自身上投射阴影（仅当 CSM/静态阴影都关闭时生效）。',
  'set.selfShadowPbr': 'PBR（新）',
  'set.selfShadowLegacy': '旧版',
  'set.selfShadowNote': '⚠ 下次任务开始时生效。PBR 把阴影视锥紧贴机体（无闪烁）；旧版是固定视锥光。',
  'set.textureQuality': '贴图质量（PBR）',
  'set.textureQualityHint': 'PBR 贴图集（战机/单位/建筑）的分辨率档位与各向异性过滤。',
  'set.tqLow': '低',
  'set.tqMedium': '中',
  'set.tqHigh': '高',
  'set.textureQualityNote': '⚠ 下次任务开始时生效。高 = 1024² 涂装（构建时压缩为 KTX2）+ 16× 各向异性；低档显存占用减半。',
  'set.fpsCap': 'PC 最大帧率限制',
  'set.fpsCapHint': '限制渲染帧率以降低 GPU/CPU 负载。下次任务/机库生效。',
  'set.fpsOff': '不限',
  'set.fpsCapNote': '不限 = 按显示器刷新率运行。30 = 负载最低。',
  'set.pipeline': '渲染管线（实验）',
  'set.pipelineHint': '前向 = 经典前向渲染。延迟 = 实验性 G-Buffer 管线（PBR 分层在全屏光照 Pass 中计算）。自动 = WebGL2 用延迟，旧设备回退前向。',
  'set.pipelineForward': '前向',
  'set.pipelineDeferred': '延迟',
  'set.pipelineAuto': '自动',
  'set.pipelineNote': '⚠ 实验功能。延迟模式下：爆炸点光源/CSM 级联不可用，仅单个太阳阴影。下次任务开始生效。',

  // ---- Settings action labels ----
  'act.pitchUp': '俯仰上（抬头）',
  'act.pitchDown': '俯仰下（低头）',
  'act.rollLeft': '左滚转',
  'act.rollRight': '右滚转',
  'act.yawLeft': '左偏航',
  'act.yawRight': '右偏航',
  'act.throttleUp': '加大油门',
  'act.throttleDown': '减小油门',
  'act.brake': '高G机动（按住）',
  'act.airbrake': '减速板（按住）',
  'act.emergencyBrake': '紧急减速板（按住）',
  'act.aoaOverride': '攻角限制解除（按住）',
  'act.fireGun': '机炮',
  'act.fireMissile': '发射导弹',
  'act.flare': '释放热焰弹',
  'act.cycleWeapon': '切换武器',
  'act.cycleCamera': '切换视角',
  'act.lookBack': '后视',
  'act.lookTarget': '注视敌人（按住）',
  'act.wingmanView': '僚机视角（循环切换）',
  'act.missileView': '导弹视角（J）',
  'act.cycleRadarRange': '切换雷达缩放',
  'act.toggleRadarFilter': '切换雷达过滤',
  'act.freeLook': '自由视角 (按住)',
  'act.toggleSideView': '侧炮视角 (AC-130)',
  'act.gear': '起落架收放 (X)',
  'act.nextTarget': '下一个目标',
  'act.wingmanAttack': '僚机: 攻击',
  'act.wingmanCover': '僚机: 掩护',
  'act.wingmanForm': '僚机: 编队',
  'act.callReinforcement': '召唤支援',
  'act.togglePause': '暂停',

  // ---- Settings group headers ----
  'grp.FLIGHT': '飞行',
  'grp.THROTTLE': '油门',
  'grp.COMBAT': '战斗',
  'grp.VIEW': '视角',
  'grp.WINGMAN': '僚机',
  'grp.SYSTEM': '系统',

  // ---- Pause overlay ----
  'pause.simPaused': '模拟已暂停',
  'pause.title': '已暂停',
  'pause.resume': '继续',
  'pause.settings': '设置',
  'pause.abort': '中止',
  'pause.hint': '按 P 继续',
  // === 联机对局内菜单 (per user request: 对战中谁也不能暂停) ===
  'pause.mpSimRunning': '对局进行中 · 世界未暂停',
  'pause.mpTitle': '菜单',
  'pause.mpResume': '回到战斗',
  'pause.endMatch': '结束本局(房主)',
  'pause.mpHint': '按 ESC 关闭菜单 · 对局继续运行',

  // ---- Results screen ----
  'res.success': '任务成功',
  'res.fail': '任务失败',
  'res.complete': '任务完成',
  'res.failed': '任务失败',
  'res.score': '得分',
  'res.kills': '击落',
  'res.time': '用时',
  'res.continue': '继续',

  // ---- Loading ----
  'loading.init': '正在初始化作战系统',
  'loading.standby': '请稍候',

  // ---- GameApp / engine messages ----
  'msg.flareDeployed': '已释放热焰弹',
  'msg.mslEmpty': '导弹耗尽',
  'msg.lasmEmpty': '对地导弹耗尽',
  'msg.noLock': '未锁定',
  'msg.noTarget': '无目标',
  'msg.noTargetSideArc': '侧射区无目标',
  'msg.sideCannonRecharge': '侧炮充能中',
  'msg.jammerRecharge': '干扰机充能中',
  'msg.sideCannonHit': '侧炮 → {name}',
  'msg.jammerDecoyed': '干扰 → {n} 枚导弹偏离',
  'msg.jammerPulse': '干扰脉冲已发射',
  'msg.camSwitch': '视角: {mode}',
  'msg.wpnSwitch': '武器: {wpn}',
  'msg.paused': '已暂停',
  'msg.resumed': '已恢复',
  'msg.tgtSelect': '目标: {name}',
  'msg.wingAtk': '僚机: 接敌',
  'msg.wingCov': '僚机: 掩护',
  'msg.wingForm': '僚机: 编队',
  'msg.missileInbound': '导弹来袭!',
  'msg.bomberDown': '轰炸机击落!',
  'msg.multiKill': '多杀 x{n}!',
  'msg.enemyDestroyed': '{name} 已摧毁',
  'msg.allyLost': '{name} 失踪!',
  'msg.aircraftLost': '战机损毁',
  'msg.wingmanRejoined': '{name} 已归队',
  'msg.wingmanRTB': '{name} 受损 — 撤离修理',
  'msg.underAttack': '{name} 遭到攻击!',
  'msg.hit': '命中!',
  'msg.missionComplete': '任务完成',
  'msg.missionFailed': '任务失败',
  'msg.timeExpired': '时间到',
  'msg.aircraftDestroyed': '战机被摧毁',
  'msg.allyLostObjective': '盟军单位损失',
};

const dictionaries: Record<Locale, Record<string, string>> = { en, zh };

// === Public API ============================================================

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(l: Locale) {
  if (l === currentLocale) return;
  currentLocale = l;
  writeStoredLocale(l);
  // Notify all subscribers — React components using useI18n() will re-render.
  for (const cb of listeners) {
    try { cb(); } catch { /* swallow */ }
  }
}

export function toggleLocale(): Locale {
  setLocale(currentLocale === 'en' ? 'zh' : 'en');
  return currentLocale;
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Translate a key, substituting {placeholder} tokens with values from `params`.
// Missing keys fall back to English, then to the key itself (so missing strings
// are visible in the UI but never crash the app).
export function t(key: string, params?: Record<string, string | number>): string {
  let raw = dictionaries[currentLocale]?.[key];
  if (raw === undefined) raw = en[key];
  if (raw === undefined) return key;
  if (!params) return raw;
  // Substitute {name} tokens.
  return raw.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = params[k];
    return v === undefined ? `{${k}}` : String(v);
  });
}
