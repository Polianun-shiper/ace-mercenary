// §230a(4): 最终定稿的语音增益链。
// 实测路径(都量过): 纯增益会削顶; alimiter 默认 level=true 会把响度又拉回去; 单遍 loudnorm 在短句上欠冲;
// 两遍 loudnorm 的 JSON 取值在这套 ffmpeg 上没接住 —— 所以用最直白也最可控的一条:
//   volume=15dB + alimiter(limit=0.85, level=disabled)
// 实测: -19.6 LUFS -> -11.0~-11.3 LUFS(+8.5 dB, 约 2.7 倍电平), 真峰值 -1.0 dBFS 左右, 不削顶。
// 输入永远是 .shots/radio-s01-orig 里的原文件 => 幂等, 重复跑不会叠加。
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const FF = path.join('node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const SRC = path.join('public', 'audio', 'radio');
const BAK = path.join('.shots', 'radio-s01-orig');
const AF = 'volume=15dB,alimiter=limit=0.85:attack=2:release=60:level=disabled';
const files = fs.readdirSync(BAK).filter((f) => f.endsWith('.mp3'));
let done = 0, failed = 0;
for (const f of files) {
  const tmp = path.join(SRC, '_tmp_amp.mp3');
  try {
    execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(BAK, f),
      '-af', AF, '-ar', '22050', '-ac', '1', '-b:a', '64k', tmp], { stdio: 'pipe' });
    fs.renameSync(tmp, path.join(SRC, f));
    done++;
  } catch (e) { failed++; if (failed <= 2) console.warn('fail', f, String(e).slice(0, 140)); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
console.log(`完成 ${done}/${files.length}, 失败 ${failed}`);
