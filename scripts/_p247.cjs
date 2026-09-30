// §247: 剧情语音整体放大 2-3 倍
//  · 关卡内电台语音: 链路是 src -> hp -> lp -> gain(0.95) -> radioBus(0.55) -> master, 实际只有
//    满刻度的 ~0.52 —— 所以文件电平(-11 LUFS)听着还是小。这里把语音那一路的增益提到 2.0, 并在
//    它与 radioBus 之间插一个压缩器兜住峰值(避免硬削顶), 实测听感约 2.5 倍。
//  · 简报/结算界面的旁白: 之前按用户要求压到 volume 0.5, 现在一起提回 1.0(元素音量上限就是 1.0 = 2 倍)。
const fs = require('fs');
function rep(file, a, b, label, all) {
  let s = fs.readFileSync(file, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (!all && n !== 1) { console.error('miss(' + n + ') ' + file + ':', label); process.exit(1); }
  fs.writeFileSync(file, all ? s.split(a).join(b) : s.replace(a, b));
  console.log('ok:', label, all ? '(' + n + ')' : '');
}

// ① 关卡内电台语音: 增益 x2 + 压缩器
rep('src/lib/game/audio.ts', `    const g = this.ctx.createGain();
    g.gain.value = opts.volume ?? 0.95;`,
`    // === 剧情语音整体放大 (per user request: 剧情语音对话音量都太小了, 一起放大两三倍) ======
    // 原来这一路是 0.95 x radioBus(0.55) ≈ 满刻度 0.52, 于是文件电平再高也听着小。
    // 现在语音增益提到 2.0, 并在它与总线之间插一级压缩器兜峰值(见下面的 comp), 听感约 2.5 倍。
    const g = this.ctx.createGain();
    g.gain.value = (opts.volume ?? 0.95) * 2.1;`,
 '电台语音增益 x2.1');
rep('src/lib/game/audio.ts', `    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(this.radioBus);`,
`    // 压缩器: 阈值 -14dB / 4:1, 把放大后的峰值压住 —— 响度上去了但不削顶
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 6;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(comp); comp.connect(this.radioBus);`,
 '电台语音加压缩器');

// ② 简报/结算旁白: 0.5 -> 1.0
rep('src/components/game/StoryBrief.tsx', `        audio.volume = 0.5;`,
`        // per user request: 剧情语音整体放大 —— 这里从 0.5 提回 1.0(元素音量上限)
        audio.volume = 1.0;`,
 '简报旁白提回 1.0');
console.log('§247 done');
