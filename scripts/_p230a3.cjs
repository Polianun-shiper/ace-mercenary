// §230a(3): 两遍 loudnorm —— 单遍(dynamic)模式在短句上会欠冲(实测只到 -14.6 LUFS = 2 倍),
// 用户要 3-4 倍。两遍法: 先量出 measured_*, 再带这些参数跑一遍(linear=true) => 精确落在目标响度。
// 输入永远是备份原文件, 幂等; 目标 -10 LUFS / 真峰值 -1.5 dBTP(实测原始 -19.6 LUFS => 约 3.05 倍)。
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const FF = path.join('node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const SRC = path.join('public', 'audio', 'radio');
const BAK = path.join('.shots', 'radio-s01-orig');
const I = -10, TP = -1.5, LRA = 8;

function measure(file) {
  // 第一遍: 只测量, 输出 JSON 到 stderr
  const out = execFileSync(FF, ['-hide_banner', '-i', file, '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  return out;
}
function measureStderr(file) {
  // 注意: print_format=json 的 JSON 走的是 **stdout**(不是 stderr), 所以要接返回值。
  try {
    return execFileSync(FF, ['-hide_banner', '-i', file, '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (e) {
    // 极少数情况 ffmpeg 非零退出: 退回从 stderr 里抠 JSON
    return String(e.stdout ?? '') + String(e.stderr ?? '');
  }
}
const files = fs.readdirSync(BAK).filter((f) => f.endsWith('.mp3'));
let done = 0, failed = 0, skipped = 0;
for (const f of files) {
  const src = path.join(BAK, f);
  const dst = path.join(SRC, f);
  const tmp = path.join(SRC, '_tmp_ln.mp3');
  try {
    const raw = measureStderr(src);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) { skipped++; continue; }
    const j = JSON.parse(m[0]);
    const af = `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
    execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-af', af, '-ar', '22050', '-ac', '1', '-b:a', '64k', tmp], { stdio: 'pipe' });
    fs.renameSync(tmp, dst);
    done++;
  } catch (e) {
    failed++;
    if (failed <= 3) console.warn('fail', f, String(e).slice(0, 160));
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
  if (done % 30 === 0 && done > 0) console.log(`  ${done}/${files.length}`);
}
console.log(`完成 ${done}/${files.length}, 失败 ${failed}, 跳过 ${skipped}`);
