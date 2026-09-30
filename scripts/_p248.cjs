// §248: 单文件瘦身 —— 把大块资产挪到资产库(随行目录), 目标 dist-single/index.html <= 100MB
//  做法: 这些条目在 asset-library.json 里改成 inline:false(仍 copy:true / external:true):
//    · 电台语音目录 /audio/radio/  —— 用户明确允许把它放资产库(运行时走 assetUrl -> assets/audio/radio/*)
//    · 之前为"体积不再收着"恢复的 4 首历史曲子(未使用) —— 23MB 原始大小, 内联要 ~31MB base64
//    · 第一关的新天空盒 evening-046b.exr —— 13.8MB, 内联 ~18MB; 挪出去后 file:// 双击会回落到程序化天空
const fs = require('fs');
const P = 'src/lib/game/asset-library.json';
const j = JSON.parse(fs.readFileSync(P, 'utf8'));

function upsert(prefix, patch, note) {
  let e = j.entries.find((x) => x.prefix === prefix);
  if (!e) {
    e = { prefix, kind: 'audio', compress: '原样', copy: true, inline: false, external: true, note };
    j.entries.push(e);
    console.log('新增条目:', prefix);
  } else if (patch) {
    Object.assign(e, patch);
    if (note) e.note = note;
    console.log('更新条目:', prefix, JSON.stringify(patch));
  }
}

// ① 电台语音整目录 -> 资产库
upsert('/audio/radio/', {}, '');
{
  const e = j.entries.find((x) => x.prefix === '/audio/radio/');
  e.kind = 'radio-voices';
  e.compress = 'TTS 已压(22050Hz mono)';
  e.copy = true; e.inline = false; e.external = true;
  e.note = '剧情语音(含第一关敌我双方 + 过场槽): 体积优化时整体挪到资产库 —— 运行时音频走 assetUrl() 解析, '
    + '单文件版会去 assets/audio/radio/ 取, 所以功能不变、只省下内联的 base64。';
  console.log('ok: /audio/radio/ -> 资产库');
}

// ② 4 首历史曲子(未使用, 23MB) + 新导入的三首 -> 资产库
for (const f of ['music_alect', 'music_gaiuss', 'music_hangar', 'music_last_line']) {
  upsert('/audio/' + f + '.mp3', { inline: false, copy: true, external: true, kind: 'music-legacy-unused' },
    '历史曲目(当前没有任何关卡引用): 为单文件体积挪到资产库, 需要时再从 assets/ 取。');
}
for (const f of ['music_white_bird', 'music_briefing', 'sfx_shuttle_rumble']) {
  upsert('/audio/' + f + '.mp3', { inline: false, copy: true, external: true, kind: 'music-story' },
    '正式版剧情第一关的音乐/音效(White Bird / 简报曲 / 加力轰鸣): 挪到资产库以控制单文件体积; '
    + 'file:// 双击时这几首会取不到(静音/回落), http 部署(带 assets/)一切正常。');
}

// ③ 新天空盒 -> 资产库(仅随行)
upsert('/textures/sky/evening-046b.exr', { inline: false, copy: true, external: true, kind: 'sky-hdri' },
  '第一关的天空盒 13.8MB: 为体积改为**只随行不内联**。file:// 双击时读不到 => 引擎回落到程序化天空; '
  + 'http 部署(带 assets/)正常显示这张 HDRI。');

fs.writeFileSync(P, JSON.stringify(j, null, 2) + '\n');
console.log('§248 asset-library 调整完成');
