// 生成探针脚本: 复用 _cloudwall-ab.mjs 的 harness(SETUP/度量/截图), 换成 §302 的 A/B 用例。
// 用法: node scripts/_mk-cover3d-probe.mjs
const fs = require('node:fs');
const p = 'scripts/_cloudwall-ab.mjs';
const s = fs.readFileSync(p, 'utf8');
const i = s.indexOf('const CASES = {');
if (i < 0) throw new Error('anchor missing');
let head = s.slice(0, i);

// ① 头部注释替换(说明这份探针是干什么的)
const HDR = [
  '#!/usr/bin/env node',
  '// === §302 3D 覆盖率 A/B 探针(off / on / unpatched, 同一会话冻结相机) ================',
  '//',
  '// 前身 = `_cloudwall-ab.mjs`(§300 的"切糕"度量): 这里**只换用例**, harness/机位/度量口径全部沿用,',
  '// 所以读数与 §300 那张表**可以直接对比**:',
  '//   · CAM1 = 云顶之上俯视 14°(相机 0/10600/-5515 → 看 12000/7600/-5515)',
  '//   · CAM3 = 云底之下 6900m 仰视 20°(用户投诉时的原始取景)',
  '//   · CAM-sun = 朝太阳看云边(亮边/背光凹缝)',
  '// 指标: 云带边界起伏 std / 竖直方差 / **逐朵圆顶(新增)** / 斑点(帧间 mad, hfCorr) / 帧时间 / 采样器+GL。',
  '//',
  '// ⚠ 每个用例都**显式复位**(层配置 + coverage + 三个 cover3d 旋钮), 不再有 §300 那种"黏性继承"。',
  '// 复跑: node scripts/_cover3d-ab.mjs [--only off,on] [--out E:\\ipbeifen2-dsh\\tmp\\cover3d]',
  '//       机位/关卡: --cam/--look(覆盖 CAM1)、--mission(默认 m06)、--nod 跳过诊断段。',
  'import { spawn } from \'node:child_process\';',
  'import { existsSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from \'node:fs\';',
  'import { tmpdir } from \'node:os\';',
  'import { join } from \'node:path\';',
  'import sharp from \'sharp\';',
].join('\n');

const OLD_HDR_END = "import sharp from 'sharp';";
const hdrIdx = head.indexOf(OLD_HDR_END);
if (hdrIdx < 0) throw new Error('header anchor missing');
head = HDR + head.slice(hdrIdx + OLD_HDR_END.length);

// ② 输出目录默认值改成 E:\ipbeifen2-dsh\tmp\cover3d
head = head.replace(
  "const OUT = flag('--out', 'E:\\\\ipbeifen2-dsh\\\\tmp\\\\cloudwall');",
  "const OUT = flag('--out', 'E:\\\\ipbeifen2-dsh\\\\tmp\\\\cover3d');",
);
if (!head.includes('tmp\\\\cover3d')) throw new Error('OUT 默认值没换成功');

// ③ 把 __domeStat(逐朵圆顶度量)插进 SETUP(在 __rtStruct 之前)
const DOME = [
  "  ' // === §302 新增判据: 逐朵圆顶 =================================================',",
  "  ' //  ① 顶部轮廓的\"弧状段数\": 逐列最上面的云像素(32px 分箱取中位) → 该序列的**局部极大个数**',",
  "  ' //     (整层平顶 ⇒ 0~1 个; 每朵各自圆顶 ⇒ 很多个)。附峰高(相对两侧)中位/b90。',",
  "  ' //  ② 云区**二维局部极大**个数(5x5 邻域最大 + 显著度 ≥0.015), 按云像素数归一 ⇒ 每千像素几个。',",
  "  ' // 两者都在 6 帧时域平均上量(压掉时域噪声 —— 噪点也会造出假峰)。',",
  "  ' window.__domeStat=(n)=>{ n=n||6;',",
  "  '   const acc=window.__readRT(); const RW=acc.RW, RH=acc.RH;',",
  "  '   const SL=new Float64Array(RW*RH), SA=new Float64Array(RW*RH);',",
  "  '   const add=(o)=>{ for(let q=0;q<RW*RH;q++){ SL[q]+=o.L[q]; SA[q]+=o.A[q]; } };',",
  "  '   add(acc); for(let k=1;k<n;k++) add(window.__readRT());',",
  "  '   const L=new Float64Array(RW*RH), A=new Float64Array(RW*RH); for(let q=0;q<RW*RH;q++){ L[q]=SL[q]/n; A[q]=SA[q]/n; }',",
  "  '   const all=Float64Array.from(L); const srt=Array.from(all).sort((p,q)=>p-q); const med=srt[srt.length>>1];',",
  "  '   const thr=Math.max(0.02, 1.6*med);',",
  "  '   // ---- ① 顶部轮廓 ----',",
  "  '   const top=new Int32Array(RW).fill(-1);',",
  "  '   for(let x=0;x<RW;x++){ for(let y=1;y<RH-1;y++){ const i=y*RW+x; if(A[i]>0.1&&L[i]>thr){ top[x]=y; break; } } }',",
  "  '   const bin=32, nb=Math.floor(RW/bin), hs=[];',",
  "  '   for(let b=0;b<nb;b++){ const v=[]; for(let x=b*bin;x<(b+1)*bin;x++){ if(top[x]>=0) v.push(top[x]); }',",
  "  '     if(v.length<8){ hs.push(null); continue; } v.sort((p,q)=>p-q); hs.push(RH-v[v.length>>1]); }',",
  "  '   let peaks=0, proms=[];',",
  "  '   for(let b=1;b<nb-1;b++){ if(hs[b]===null||hs[b-1]===null||hs[b+1]===null) continue;',",
  "  '     if(hs[b]>hs[b-1] && hs[b]>hs[b+1]){ peaks++; proms.push(Math.min(hs[b]-hs[b-1], hs[b]-hs[b+1])); } }',",
  "  '   proms.sort((p,q)=>p-q);',",
  "  '   const qp=(p)=>proms.length?+proms[Math.min(proms.length-1,Math.floor(p*proms.length))].toFixed(1):null;',",
  "  '   // ---- ② 云区二维局部极大 ----',",
  "  '   let lumPeaks=0, maskPix=0;',",
  "  '   for(let y=2;y<RH-2;y++) for(let x=2;x<RW-2;x++){ const i=y*RW+x;',",
  "  '     if(A[i]<=0.1) continue; maskPix++; if(L[i]<=thr) continue;',",
  "  '     let mx=-1e9, sum=0, cnt=0;',",
  "  '     for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++){ const v=L[i+dy*RW+dx]; if(v>mx) mx=v; sum+=v; cnt++; }',",
  "  '     if(L[i]>=mx-1e-9 && L[i]-(sum/cnt)>=0.015) lumPeaks++; }',",
  "  '   return {thr:+thr.toFixed(4), contourPeaks:peaks, contourBins:nb,',",
  "  '     contourPeakFree:peaks/Math.max(1,nb), peakPromMed:qp(0.5), peakPromP90:qp(0.9),',",
  "  '     lumPeaks, maskPix, lumPeaksPer1k:+(1000*lumPeaks/Math.max(1,maskPix)).toFixed(2)};',",
  "  ' };',",
].join('\n');

const INSERT_AT = "  ' // 时域平均 n 帧后再量结构(墙是结构, 噪点是时间性的 ⇒ 平均掉噪声再量\"幕墙\")',";
if (!head.includes(INSERT_AT)) throw new Error('domeStat 插入锚点没找到');
head = head.replace(INSERT_AT, DOME + '\n' + INSERT_AT);

// === 修一个度量 bug: 原探针的"6 帧平均"其实读的是**同一帧** ==========================
// `renderer.readRenderTargetPixels` 是同步读, 一次 `Runtime.evaluate` 里连续读 6 次读到的
// 是同一个已完成的帧(期间不会渲染新帧) ⇒ 所谓"平均"根本没起作用, 单帧噪声(1/16 时域上采样
// 的抖动相位)会原封不动进读数。实测同一份着色器(off 与 unp)的 竖直方差 能差 25%
// (0.689 vs 0.830) ⇒ 必须**跨真实帧**平均: 每次读之间 await 一个 ~70ms 的等待。
const PATCHES = [
  ["  ' window.__vertStat=(n)=>{ n=n||6;',", "  ' window.__vertStat=async(n)=>{ n=n||6;',"],
  ["  ' window.__rtStruct=(n)=>{ n=n||6;',", "  ' window.__rtStruct=async(n)=>{ n=n||6;',"],
  ["  ' window.__domeStat=(n)=>{ n=n||6;',", "  ' window.__domeStat=async(n)=>{ n=n||6;',"],
  ["  '   add(a0); for(let k=1;k<n;k++) add(window.__readRT());',",
    "  '   add(a0); for(let k=1;k<n;k++){ await window.__wait(70); add(window.__readRT()); }',"],
  ["  '   add(acc); for(let k=1;k<n;k++) add(window.__readRT());',",
    "  '   add(acc); for(let k=1;k<n;k++){ await window.__wait(70); add(window.__readRT()); }',"],
  ["  '   for(let k=1;k<n;k++){ add(window.__readRT()); }',",
    "  '   for(let k=1;k<n;k++){ await window.__wait(70); add(window.__readRT()); }',"],
  ["  '   rtStat:window.__rtStat(), struct:window.__rtStruct(6), vert:window.__vertStat(6), dome:window.__domeStat(6),',",
    "  '   rtStat:window.__rtStat(), struct:await window.__rtStruct(6), vert:await window.__vertStat(6), dome:await window.__domeStat(6),',"],
];
const tailPending = [];
for (const [a, b] of PATCHES) {
  if (head.includes(a)) head = head.replace(a, b);
  else tailPending.push([a, b]);
}

const TAIL = `
// === §302 用例 =================================================================
// 每个用例: 显式复位(层/覆盖率/cover3d 旋钮) ⇒ 切档 ⇒ 等重编译 ⇒ 量。
// mode: 'off'(注入但恒等) / 'on'(3D 覆盖率生效) / 'unpatched'(反向还原成库原文)
const resetAll = (o) => [
  '(async()=>{',
  ' const fx=window.__fx;',
  ' window.__setLayers(JSON.parse(JSON.stringify(window.__bands)));',
  ' fx.setCoverage(' + (o.cov === undefined ? 0.391 : o.cov) + ');',
  // mode='default' ⇒ **清掉**所有键(验证"出厂默认/键不存在"这一条真实路径)
  (o.mode === 'default'
    ? ' ["skybound.cloudCover3D","skybound.cloudCover3DK","skybound.cloudCover3DScale","skybound.cloudCover3DBias"].forEach((k)=>localStorage.removeItem(k));'
    : ' localStorage.setItem("skybound.cloudCover3DK", "' + (o.k === undefined ? 1 : o.k) + '");'
      + '\\n localStorage.setItem("skybound.cloudCover3DScale", "' + (o.scale === undefined ? 1.2 : o.scale) + '");'
      + '\\n localStorage.setItem("skybound.cloudCover3DBias", "' + (o.bias === undefined ? 0 : o.bias) + '");'
      + '\\n localStorage.setItem("skybound.cloudCover3D", "' + o.mode + '");'),
  ' window.__cover3d(' + (o.mode === 'default' ? 'undefined' : '"' + o.mode + '"') + ');',  // 立刻应用一次
  ' window.__place(); await window.__wait(' + (o.settle || 4200) + ');',
  ' window.__rtStat(); await window.__wait(500);',
  ' const st={mode:"' + o.mode + '", label:' + JSON.stringify(o.label || '') + ',',
  '   c3:window.__cover3d(), coverage:window.__eff.coverage,',
  '   rtStat:window.__rtStat(), struct:window.__rtStruct(6), vert:window.__vertStat(6), dome:window.__domeStat(6),',
  '   perf:await window.__ft(2500)};',
  ' window.__placeSun(); await window.__wait(700); st.sunView=window.__placeSun();',
  ' window.__placeBack(); await window.__wait(500);',
  ' return st;',
  '})()',
].join('\\n');

// ⚠ 顺序有讲究: 先跑 off/unpatched(基线), 再跑 on —— 中间任何一次重编译都不会污染前面的读数
//   (每个用例自己都复位 + 重新量)。
const CASES = {
  default: { mode: 'default',  label: 'default(清掉所有键 ⇒ 走出厂默认路径)' },
  off:   { mode: 'off',       label: 'off(注入保留但恒等透传)' },
  unp:   { mode: 'unpatched', label: 'unpatched(反向还原成库原文 —— 退路取证)' },
  on:    { mode: 'on',        label: 'on(bias=0, k=1)' },
  onS07: { mode: 'on', scale: 0.7, label: 'on + scale=0.7(出厂默认的上一版)' },
  onS04: { mode: 'on', scale: 0.4, label: 'on + scale=0.4(更大块的 3D 场)' },
  onBp15: { mode: 'on', bias: 0.15, label: 'on + bias=+0.15(挖得更狠)' },
  onBm15: { mode: 'on', bias: -0.15, label: 'on + bias=-0.15(更保守)' },
  onK05: { mode: 'on', k: 0.5, label: 'on + k=0.5(半强度)' },
  off2:  { mode: 'off',       label: 'off 复跑(噪声底)' },
  unp2:  { mode: 'unpatched', label: 'unpatched 复跑' },
};

async function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const port = 9900 + Math.floor(Math.random() * 90);
  const profileDir = mkdtempSync(join(tmpdir(), 'cover3d-'));
  const child = spawn(findBrowser(), [
    '--headless=new', '--use-gl=angle', '--use-angle=d3d11', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio',
    '--disable-gpu-vsync', '--disable-frame-rate-limit',
    \`--window-size=\${W},\${H}\`, \`--remote-debugging-port=\${port}\`,
    \`--user-data-dir=\${profileDir}\`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  try {
    let ver = null;
    for (let i = 0; i < 120 && !ver; i++) {
      try { const r = await fetch(\`http://127.0.0.1:\${port}/json/version\`); if (r.ok) ver = await r.json(); } catch { /* retry */ }
      if (!ver) await sleep(300);
    }
    if (!ver) throw new Error('DevTools 未就绪');
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('WS 失败')), { once: true }); });
    const cdp = new CDP(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p) => cdp.send(m, p, sessionId);
    await S('Page.enable'); await S('Runtime.enable');
    const logs = [];
    cdp.listeners.push((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        logs.push(\`[exception] \${d.text} \${d.exception?.description ?? ''}\`.trim().slice(0, 300));
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const t = msg.params.type;
        if (t === 'error' || t === 'warning' || (msg.params.args || []).some((a) => String(a.value ?? '').includes('[cover3d]'))) {
          logs.push(\`[\${t}] \` + (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300));
        }
      }
    });
    await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    const ev = async (expr, timeout) => {
      const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, timeout);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
      return r.result?.value;
    };
    const HASH = \`#autotest&desktop&takramclouds&atmosphere&mission=\${MISSION}\`;
    await S('Page.navigate', { url: \`\${BASE}?n=cover3d\${HASH}\` });
    console.log('[ready]', JSON.stringify(await ev(READY, 180000)));
    const setup = await ev(SETUP, 180000);
    console.log('[setup]', JSON.stringify(setup));
    const report = { when: new Date().toISOString(), cam: CAM, look: LOOK, mission: MISSION, setup, cases: {} };

    // 基线自检(注入状态 + GL) —— 在切任何档之前先看一眼
    const c3base = await ev('window.__cover3d()', 60000);
    report.cover3dBase = c3base;
    console.log('[cover3d 基线]', JSON.stringify(c3base));

    const only = ONLY ? ONLY.split(',').filter((c) => CASES[c]) : Object.keys(CASES);
    for (const key of only) {
      const c = CASES[key];
      console.log(\`\\n===== \${key}: \${c.label}\`);
      const st = await ev(resetAll({ mode: c.mode, k: c.k, scale: c.scale, bias: c.bias, label: c.label }), 180000);
      await sleep(300);
      const run = await captureRun(S, OUT, key, 7);
      await ev('(async()=>{ window.__placeBelow(); await window.__wait(1400); return true; })()', 60000);
      const runBelow = await captureRun(S, OUT, \`\${key}-below\`, 7);
      const belowDome = await ev('window.__domeStat(6)', 60000);
      const belowVert = await ev('window.__vertStat(6)', 60000);
      await ev('(async()=>{ window.__place(); await window.__wait(400); return true; })()', 60000);
      const rec = { desc: c.label, state: st, ...run, below: runBelow, belowDome, belowVert };
      report.cases[key] = rec;
      console.log(\`[模式]   \${JSON.stringify(st.c3.params)} | 材质=\${(st.c3.materials || []).map((m) => m.kind + ':' + (m.patched ? '注入' : '未注入') + '/' + (m.defined ? 'ON' : 'off')).join(' ')}\`);
      console.log(\`[俯视]   边界起伏 std: 顶=\${st.vert.hiStd}px 底=\${st.vert.loStd}px | 竖直方差=\${st.vert.vertVarRel} | 带厚=\${st.vert.bandPx}px\`);
      console.log(\`[圆顶]   轮廓峰数=\${st.dome.contourPeaks}/\${st.dome.contourBins} 箱 (峰高中位 \${st.dome.peakPromMed}px / p90 \${st.dome.peakPromP90}px) | 二维局部极大 \${st.dome.lumPeaks} 个(每千云像素 \${st.dome.lumPeaksPer1k})\`);
      console.log(\`[俯视-结构] 竖边占比99=\${st.struct.vwall99}% 竖边纵持续=\${st.struct.vpersistMed} 梯度p99=\${st.struct.p99} 云量=\${st.rtStat.maskFrac} 亮度p999=\${st.rtStat.lumP999}\`);
      console.log(\`[斑点]   截图 mad=\${run.meanMad} hfCorr=\${run.meanHfCorr} bigFrac=\${run.meanBigFrac} | RT 帧间差=\${st.rtStat.pairDiff} RT hfCorr=\${st.rtStat.hfCorr}\`);
      console.log(\`[仰视]   mad=\${runBelow.meanMad} hfCorr=\${runBelow.meanHfCorr} vwall99=\${runBelow.shot.gwall99}% | 边界起伏 顶=\${belowVert.hiStd}px 底=\${belowVert.loStd}px 竖直方差=\${belowVert.vertVarRel}\`);
      console.log(\`[仰视-圆顶] 轮廓峰数=\${belowDome.contourPeaks}/\${belowDome.contourBins} 二维局部极大/\千云像素=\${belowDome.lumPeaksPer1k}\`);
      console.log(\`[帧时间] \${JSON.stringify(st.perf)}\`);
    }

    report.samplers = await ev('window.__samp()', 60000);
    console.log('\\n[采样器/GL]', JSON.stringify(report.samplers));
    report.cover3dEnd = await ev('window.__cover3d()', 60000);
    report.glWarnProgram = logs.filter((l) => l.startsWith('[warning]') && l.includes('THREE.WebGLProgram')).length;
    report.warnOther = logs.filter((l) => l.startsWith('[warning]') && !l.includes('THREE.WebGLProgram'));
    report.exceptions = logs.filter((l) => l.startsWith('[exception]'));
    report.cover3dLogs = logs.filter((l) => l.includes('[cover3d]'));
    report.glSuspect = logs.filter((l) => /Link failed|Shader Error|VALIDATE_STATUS|GL_INVALID|INVALID_OPERATION|exceeds MAX_TEXTURE/i.test(l));
    console.log(\`\\n[gl] WebGLProgram warning=\${report.glWarnProgram} 其它warning=\${report.warnOther.length} 异常=\${report.exceptions.length} 可疑=\${report.glSuspect.length}\`);
    for (const l of report.glSuspect.slice(0, 6)) console.log('   !', l.slice(0, 240));
    for (const l of report.cover3dLogs.slice(0, 12)) console.log('   [c3]', l.slice(0, 220));
    for (const l of report.warnOther.slice(0, 8)) console.log('   [w]', l.slice(0, 180));

    writeFileSync(join(OUT, 'cover3d-ab.json'), JSON.stringify(report, null, 1));
    console.log('\\n[done]', join(OUT, 'cover3d-ab.json'));
    await S('Target.closeTarget', { targetId }).catch(() => {});
    ws.close();
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
  }
}
main().catch((e) => { console.error('[cover3d-ab] 失败:', e.message); process.exit(3); });
`;

let tailOut = TAIL;
for (const [a, b] of tailPending) {
  if (!tailOut.includes(a)) throw new Error('tail 补丁锚点没找到: ' + a.slice(0, 60));
  tailOut = tailOut.replace(a, b);
}
fs.writeFileSync('scripts/_cover3d-ab.mjs', head + tailOut);
console.log('written scripts/_cover3d-ab.mjs (tail 补丁 ' + tailPending.length + ' 处)');
