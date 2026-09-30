// §233: 体积不再收着 —— 把之前为体积删掉的素材/音乐放回并按需要内联;
//       关卡内不再播通用曲(VITOZE), 直接用 White Bird; 机库飞机整体上移。
const fs = require('fs');
function rep(file, a, b, label, all) {
  let s = fs.readFileSync(file, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (!all && n !== 1) { console.error('miss(' + n + ') ' + file + ':', label); process.exit(1); }
  fs.writeFileSync(file, all ? s.split(a).join(b) : s.replace(a, b));
  console.log('ok:', label, all ? '(' + n + ')' : '');
}

// ① 音乐清单: 把 git 里恢复回来的 4 首曲子登记为内联素材
rep('scripts/audio-assets.mjs', `  'music_online_menu.mp3',
  'music_vitoze.mp3',`, `  'music_online_menu.mp3',
  'music_vitoze.mp3',
  // === 体积不再收着: 之前为瘦身删掉的曲子全部放回并内联 (per user request) ==========
  // 这 4 首是从 git 恢复回来的历史曲目(alect/gaiuss/hangar/last_line), 现在重新随行 + 内联。
  'music_alect.mp3',
  'music_gaiuss.mp3',
  'music_hangar.mp3',
  'music_last_line.mp3',`, '音乐清单补 4 首');

// ② 关卡内只播 White Bird(不再用 VITOZE 当通用战斗曲)
rep('src/lib/game/music.ts', `// === 关卡战斗音乐: **只留这一首** (per user request: 把关卡内长音乐去掉只剩这个音乐) ===
// 之前是 MGS 两曲 + VITOZE 的随机池; 现在池里只有 VITOZE AERIAL DEFENSE ——
// 进任务必播它, 不再随机到别的长曲。文件也已换成用户给的完整版(8.7MB)。
// 注: MGS 两曲不再被引用, 但文件仍在 public/audio/ 里; 要彻底删文件需同时改
// scripts/audio-assets.mjs 与 scripts/report-inline-assets.mjs 的清单。
const COMBAT_TRACKS = [
  assetUrl('/audio/music_vitoze.mp3'),
] as const;`,
`// === 关卡战斗音乐: **White Bird** (per user request: 关卡内不播通用音乐, 直接用 White Bird) =====
// 之前池里是 VITOZE AERIAL DEFENSE(通用战斗曲); 用户要求关卡内改播 White Bird, 所以这里
// 直接把它当**唯一**战斗曲 —— 所有关卡都播它, VITOZE 不再被关卡引用(文件仍留着, 主菜单/其它
// 相位想用随时可以再挂回去)。
const COMBAT_TRACKS = [
  assetUrl('/audio/music_white_bird.mp3'),
] as const;`, '战斗曲改成 White Bird');

// ③ 主舰 FBX 放回随行(体积不再收着, 它是运行时的第二兜底)
rep('src/lib/game/asset-library.json', `"prefix": "/models/airship/bastion.fbx",`, `"prefix": "/models/airship/bastion.fbx",`, 'noop');
JSON;

// ④ 机库飞机整体上移(×2 预览之后原来那股"贴地"感更明显)
rep('src/lib/game/hangar.ts', `      group.position.y = 0;
      // 油门/加力演示(与 MiG-29 相同:机库开关控制火焰可见性)`,
`      // === 飞机整体上移 (per user request: 机库内的飞机往上移动一些) ================
      // 预览放大 2 倍之后, 原来"坐在甲板上"的高度显得太贴地 —— 抬起来一点, 也让机腹/起落架
      // 更好看。单位与世界一致(米级), 观感上约等于把人抬到胸口高度。
      group.position.y = HANGAR_LIFT;
      // 油门/加力演示(与 MiG-29 相同:机库开关控制火焰可见性)`, 'f16c 上移');
rep('src/lib/game/hangar.ts', `      group.position.y = 0;`, `      group.position.y = HANGAR_LIFT;`, 'mig29/其它上移', true);
