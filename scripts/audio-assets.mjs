// === 单文件内联音频清单(单一真相源) ======================================
// 为什么单独一个文件: 这份清单以前在 build-single-html.mjs 与 compress-audio.mjs
// 里各写了一份, 结果**漂移**了 —— 压缩脚本还在压 music_hangar/alect/gaiuss/
// last_line(早已删除的曲子), 而新增的 music_mgs_*/music_vitoze/用户导入 wav
// 从来没被压过。于是"320kbps → 128kbps"这一步实际上长期是空转。
//
// 现在两边都 import 这一份: 新增音频只改这里。
//
// 路径相对 public/, 不带前导斜杠; 构建脚本会加 '/' 前缀, 压缩脚本会拼 public/。

/** 音乐(长音频): 128kbps 立体声就足够, 是压缩收益最大的一类。 */
export const MUSIC_FILES = [
  // ⚠️ MGS 两曲已移除 (per user request: 关卡内只留 VITOZE 一首)。
  // 从这份清单删掉 = 不再 base64 内联进单文件(省约 9MB), 也不再参与压缩。
  'music_online_menu.mp3',
  // ⚠️ VITOZE 移出内联 (per 单文件体积: 给第一关天空盒 + 475 条剧情语音腾地方)。
  // 它自从 COMBAT_TRACKS 改成 White Bird 之后**零引用**(music.ts 的注释也写明
  // "VITOZE 不再被关卡引用"); 文件仍留在 public/audio/, 想挂回主菜单/其它相位
  // 就把它加回这份清单。内联它 = 白白 4.13MB(5.5MB base64)。
  // === 体积不再收着: 之前为瘦身删掉的曲子全部放回并内联 (per user request) ==========
  // 这 4 首是从 git 恢复回来的历史曲目(alect/gaiuss/hangar/last_line), 现在重新随行 + 内联。
  'music_alect.mp3',
  'music_gaiuss.mp3',
  'music_hangar.mp3',
  'music_last_line.mp3',
  // === 正式版剧情第一关的音乐 (per user request) ==============================
  // white_bird = 关卡战斗曲(这一关专属); music_briefing = 3D 简报界面; rumble = 主舰末阶段开加力的轰鸣
  'music_white_bird.mp3',
  'music_briefing.mp3',
  // === 第二关专属两曲 (§367) =================================================
  // 它们之前**不在这份清单里** ⇒ 压缩脚本从没管过 ⇒ 一直是 320kbps 立体声
  // (22.3MB, 内联进单文件约 29.8MB base64)。320k 对战斗音乐是浪费, 降到 96k
  // 听感基本无差(与其它曲子一致)。
  'music_s02_pipeline.mp3',
  'music_s02_three_kind.mp3',
];

/**
 * 音效/环境(mp3)。短促, 多数本来就不大 —— 压缩脚本会按"没省到 15% 就保留原文件"
 * 的规则自动跳过已经够小的文件。
 */
export const SFX_MP3_FILES = [
  'afterburner.mp3',
  // 主舰最后阶段开加力的轰鸣(transport-space 前半段, 用户给的素材)
  'sfx_shuttle_rumble.mp3',
  'sfx_explosion_large.mp3',
  'sfx_bomb_drop.mp3',
  'sfx_explosion_destroy.mp3',
  'sfx_explosion2.mp3',
  'sfx_missile_rack.mp3',
  'sfx_cannon_105mm.mp3',
  'sfx_cannon_40mm.mp3',
  'sfx_gun_25mm.mp3',
  'sfx_thunder.mp3',
  'sfx_sonic_boom.mp3',
  'amb_rain_storm.mp3',
];

/**
 * 用户导入的 wav(未压缩 PCM, 单文件里最"亏"的一类)。
 * 处理方式: **保持 WAV 格式**(代码路径与扩展名都不变), 只做单声道 + 降采样,
 * 体积直接砍到 1/3 左右; 引擎侧 decodeAudioData 无感。
 */
export const WAV_FILES = [
  'engine_throttle.wav',
  'sfx_gun_burst.wav',
  'sfx_lock_on.wav',
  'sfx_player_hit.wav',
  'sfx_radar_lock.wav',
  'sfx_missile_launch.wav',
  'sfx_missile_player.wav',
  'airflow.wav',
  'sfx_weapon_switch.wav',
];

/** 电台语音目录(相对 public/); 逐句 TTS, 单声道 56kbps 足够。 */
export const RADIO_DIR = 'audio/radio';

/** 构建脚本用的绝对清单(带前导斜杠, 去重)。 */
export const INLINE_AUDIO = [
  ...new Set([
    ...MUSIC_FILES,
    ...SFX_MP3_FILES,
    ...WAV_FILES,
  ]),
].map((f) => `/audio/${f}`);
