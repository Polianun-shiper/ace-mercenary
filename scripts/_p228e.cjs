// §228e: 主舰触地消失时, 残余的护卫挂点也要一起摘掉(否则它们会作为孤儿单位留在锁定列表里)
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
let s = fs.readFileSync(p, 'utf8');
const a = `            // 母舰消失 ⇒ 残余组件一并清除(否则雷达/锁定列表里会留下飘在空中的挂件)
            if (u.airComponentUnits) {
              for (const cu of u.airComponentUnits) if (!cu.compDetached) this.detachAirComponent(cu, true);
            }`;
const b = `            // 母舰消失 ⇒ 残余组件一并清除(否则雷达/锁定列表里会留下飘在空中的挂件)
            if (u.airComponentUnits) {
              for (const cu of u.airComponentUnits) if (!cu.compDetached) this.detachAirComponent(cu, true);
            }
            // 主舰「堡垒」的 16 个挂点是独立列表(bossMountUnits), 同样要清 ——
            // 阶段 4 的护卫武器可能还剩几个没打掉, 不清就会变成飘在空中的孤儿目标。
            if (u.boss) {
              for (const cu of this.bossMountUnits) if (!cu.compDetached) this.detachAirComponent(cu, true);
              this.bossMountUnits = [];
            }`;
if (s.split(a).length - 1 !== 1) { console.error('miss'); process.exit(1); }
fs.writeFileSync(p, s.replace(a, b));
console.log('boss fall cleans guard mounts');
