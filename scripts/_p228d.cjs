// §228d: 阶段 4 的结束条件是"4 个核心模块全毁"(不是 16 个挂点全毁) —— 任务书写得很明确
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
let s = fs.readFileSync(p, 'utf8');
const a = `    // === 阶段推进: 16 个挂点全部击毁(核心阶段 = 4 个核心模块全毁) ===
    const allGone = mounts.length > 0 && mounts.every((m) => !m.alive || m.compDetached);`;
const b = `    // === 阶段推进条件 ===
    // 阶段 1..3: 本阶段 16 个挂点全部击毁; 阶段 4: **4 个核心模块**全毁即可(护卫武器不必清光)
    const coreIdx = (u2: GroundUnit) => this.boss!.airComponents?.[u2.compIndex ?? -1]?.kind === 'core';
    const allGone = this.bossStage >= 4
      ? (mounts.filter(coreIdx).length > 0 && mounts.filter(coreIdx).every((m) => !m.alive || m.compDetached))
      : (mounts.length > 0 && mounts.every((m) => !m.alive || m.compDetached));`;
if (s.split(a).length - 1 !== 1) { console.error('miss'); process.exit(1); }
fs.writeFileSync(p, s.replace(a, b));
console.log('stage4 core-only condition');
