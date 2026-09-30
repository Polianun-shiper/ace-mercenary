// §250: Tab 切换目标强制"只在雷达圈内 + 射程内"的敌人之间进行
const fs = require('fs');
const E = 'src/lib/game/engine.ts';
let s = fs.readFileSync(E, 'utf8');

const a = `    const others = this.orderTargetsForCycle([...alive, ...(groundAlive as unknown as Enemy[])]);
    const peerList = this.orderTargetsForCycle(peers);
    const total = others.length + peerList.length;
    if (total === 0) return null;`;
if (!s.includes(a)) { console.error('anchor miss'); process.exit(1); }
const b = [
  '    // === 强制原则: 只在"雷达圈内 + 射程内"的敌人之间切换 (per user request) ============',
  '    // 雷达圈 = 机头前约 45 度锥(与 updateLock 的 0.7 cos 同源) + 当前武器的锁定距离。',
  '    // 圈外目标**一律不给机会**: 要么切到圈内目标, 要么原地不动(Tab 不生效), 而不是"圈外也能被翻到"。',
  '    const inRadarRing = (e: Enemy) => {',
  '      const to = e.position.clone().sub(this.player.position);',
  '      const d = to.length();',
  '      if (d > this.weaponLockRange()) return false;',
  '      if (d < 1) return true;',
  '      return to.multiplyScalar(1 / d).dot(this.playerForward) >= 0.7;',
  '    };',
  '    const others = this.orderTargetsForCycle([...alive, ...(groundAlive as unknown as Enemy[])]).filter(inRadarRing);',
  '    const peerList = this.orderTargetsForCycle(peers).filter(inRadarRing);',
  '    const total = others.length + peerList.length;',
  '    if (total === 0) return null;   // 圈内没有目标 => Tab 不切换(保持当前锁定)',
].join('\n');
s = s.replace(a, b);

const c = `  private cycleTarget() {
    const next = this.nextTargetInCycle();
    if (!next) return;`;
if (!s.includes(c)) { console.error('cycleTarget anchor miss'); process.exit(1); }
const d = [
  '  private cycleTarget() {',
  '    const next = this.nextTargetInCycle();',
  '    if (!next) {',
  '      // 雷达圈内没有可切换的目标 => 明确提示, 免得玩家以为 Tab 失灵',
  "      this.showMessage(getLocale() === 'zh' ? '雷达圈内无目标' : 'NO TARGET IN RADAR RING', 1.2);",
  '      return;',
  '    }',
].join('\n');
s = s.replace(c, d);

fs.writeFileSync(E, s);
console.log('ok: Tab 只在雷达圈+射程内切换, 且空圈给提示');
