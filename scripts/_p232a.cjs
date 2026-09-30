// §232a: 语音增益"补齐"版 —— 用户后来补录的 brief/debrief 等文件没走过增益(所以又变小了)。
// 做法: 对 public/audio/radio 下**当前所有** story_s01_*.mp3:
//   · 没有备份的 -> 先把当前文件备份进 .shots/radio-s01-orig(当作"原始素材")
//   · 有备份的   -> 一律从备份重新编码(幂等, 重复跑不会叠加增益)
// 增益链与 §230 定稿一致: volume=15dB + alimiter(limit=0.85, attack=2, release=60, level=disabled)
// 实测: 原始 -19.6 LUFS -> -11.0~-11.3 LUFS(+8.5 dB, 听感约 3 倍), 真峰值 -1.0 dBFS 不削顶。
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const FF = path.join('node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const SRC = path.join('public', 'audio', 'radio');
const BAK = path.join('.shots', 'radio-s01-orig');
const AF = 'volume=15dB,alimiter=limit=0.85:attack=2:release=60:level=disabled';
fs.mkdirSync(BAK, { recursive: true });
const files = fs.readdirSync(SRC).filter((f) => f.startsWith('story_s01_') && f.endsWith('.mp3'));
let amplified = 0, backedUp = 0, failed = 0;
for (const f of files) {
  const src = path.join(SRC, f);
  const bak = path.join(BAK, f);
  if (!fs.existsSync(bak)) { fs.copyFileSync(src, bak); backedUp++; }
  const tmp = path.join(SRC, '_tmp_amp.mp3');
  try {
    execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-i', bak, '-af', AF,
      '-ar', '22050', '-ac', '1', '-b:a', '64k', tmp], { stdio: 'pipe' });
    fs.renameSync(tmp, src);
    amplified++;
  } catch (e) {
    failed++;
    if (failed <= 3) console.warn('fail', f, String(e).slice(0, 120));
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
  if (amplified % 40 === 0 && amplified > 0) console.log(`  ${amplified}/${files.length}`);
}
console.log(`完成: 共 ${files.length} 条, 放大 ${amplified}, 新备份 ${backedUp}, 失败 ${failed}`);
