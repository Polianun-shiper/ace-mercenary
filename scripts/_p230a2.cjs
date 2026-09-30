// §230a(2): 把本关 133 条语音整体做**响度归一化**, 输入永远是备份的原文件 => 这一步幂等。
//
// 走过的弯路(都实测过):
//   ① 纯增益 volume=+11dB: 样本峰值从 -3.2 顶到 +0 dBFS 以上 => 解码削顶;
//   ② volume=+17dB + alimiter(limit=0.80): 过推太多, 限幅器几乎一直在压 => 整体响度又被压回 -19 LUFS,
//      等于白干(限幅器不是增益);
//   ③ 现在的做法: loudnorm 直接给目标响度 —— 原始 -19.6 LUFS, 目标 -10 LUFS(约 +9.6 dB = 3.05 倍),
//      真峰值封在 -1.5 dBTP, 稳定可复现。
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const FF = path.join('node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const SRC = path.join('public', 'audio', 'radio');
const BAK = path.join('.shots', 'radio-s01-orig');
const LOUDNORM = 'loudnorm=I=-10:TP=-1.5:LRA=8';
const files = fs.readdirSync(BAK).filter((f) => f.endsWith('.mp3'));
let done = 0, failed = 0;
for (const f of files) {
  const tmp = path.join(SRC, '_tmp_amp.mp3');
  try {
    execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(BAK, f),
      '-af', LOUDNORM, '-ar', '22050', '-ac', '1', '-b:a', '64k', tmp], { stdio: 'pipe' });
    fs.renameSync(tmp, path.join(SRC, f));
    done++;
  } catch (e) { failed++; if (failed <= 2) console.warn('fail', f, String(e).slice(0, 120)); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
console.log(`完成 ${done}/${files.length}, 失败 ${failed}`);
