// §230a: 把本关新配音的 133 条语音整体放大 ~11 dB(约 3.5 倍), 带限幅防削顶。
// 背景: 实测新配音 -19.6 LUFS、旧台词 -18.3 LUFS —— 文件本身并不比历史资产小多少,
// 但用户听感就是"太小", 所以按他的要求直接抬 3-4 倍; 峰值原本 -3.2 dBFS, 直接 +11 dB 会削顶,
// 因此串一个 alimiter(limit=0.89 ≈ -1 dBFS) 兜住瞬态。
// 原文件先备份到 .shots/radio-s01-orig/ (可随时还原)。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const FF = path.join('node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const SRC = path.join('public', 'audio', 'radio');
const BAK = path.join('.shots', 'radio-s01-orig');
const GAIN_DB = 11;
const LIMIT = 0.89;

const files = fs.readdirSync(SRC).filter((f) => f.startsWith('story_s01_') && f.endsWith('.mp3'));
fs.mkdirSync(BAK, { recursive: true });
console.log(`处理 ${files.length} 个文件, 增益 +${GAIN_DB} dB, 限幅 ${LIMIT}`);

let done = 0, skipped = 0;
for (const f of files) {
  const src = path.join(SRC, f);
  const bak = path.join(BAK, f);
  if (!fs.existsSync(bak)) fs.copyFileSync(src, bak);
  const tmp = path.join(SRC, '_tmp_amp.mp3');
  try {
    execFileSync(FF, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', bak,
      '-af', `volume=${GAIN_DB}dB,alimiter=limit=${LIMIT}`,
      '-ar', '22050', '-ac', '1', '-b:a', '64k',
      tmp,
    ], { stdio: 'pipe' });
    fs.renameSync(tmp, src);
    done++;
  } catch (e) {
    skipped++;
    if (skipped <= 3) console.warn('失败:', f, String(e).slice(0, 200));
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
  if (done % 25 === 0 && done > 0) console.log(`  已处理 ${done}/${files.length}`);
}
console.log(`完成: ${done} 个已放大, ${skipped} 个失败; 原始文件备份在 ${BAK}`);
