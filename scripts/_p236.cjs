// §236: 简报语音音量减半 + "海陆空同时最多 3 个敌方单位对玩家有攻击意图"
const fs = require('fs');
function rep(file, a, b, label, all) {
  let s = fs.readFileSync(file, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (!all && n !== 1) { console.error('miss(' + n + ') ' + file + ':', label); process.exit(1); }
  fs.writeFileSync(file, all ? s.split(a).join(b) : s.replace(a, b));
  console.log('ok:', label, all ? '(' + n + ')' : '');
}
const S = 'src/components/game/StoryBrief.tsx';
const E = 'src/lib/game/engine.ts';

// ① 简报语音减半
rep(S, `        audio = new Audio(assetUrl(line.voiceFile));
        audio.addEventListener('loadedmetadata', () => {`,
`        audio = new Audio(assetUrl(line.voiceFile));
        // === 简报语音音量减半 (per user request) ==============================
        // 本关配音整体抬过 ~3 倍(§230/§232), 简报里的旁白显得太冲 —— 这里单独压到 50%。
        // 只作用于简报界面这一处, 关卡内的电台语音不受影响。
        audio.volume = 0.5;
        audio.addEventListener('loadedmetadata', () => {`,
 '简报语音 0.5');

// ② 攻击意图配额: 4 -> 3, 并且海陆空一起算
rep(E, `      const MAX_PLAYER_ATTACKERS = 4;`,
`      const MAX_PLAYER_ATTACKERS = 3;   // per user request: 最多 3 个敌方单位同时咬玩家`,
 '空中配额 4->3');

rep(E, `  /** 当前武器的锁定距离(与 updateLock 里的表保持一致; 只是把那张表提出来复用)。 */`,
`  /**
   * 当前"正在攻击玩家"的敌方单位数 —— **海陆空一起算** (per user request)。
   * 空中单位用 e.intentPlayer(索敌时打的标记), 海面/地面单位用 u.intentPlayer(选中玩家当
   * 目标时打的标记), 两者合成一个总配额 3。
   */
  private playerAttackerCount(): number {
    let n = 0;
    for (const e of this.enemies) if (e.alive && !e.isAlly && e.intentPlayer) n++;
    for (const g of this.groundUnits) if (g.alive && !g.isAlly && g.intentPlayer) n++;
    return n;
  }

  /** 还有几个"咬玩家"的名额(0 = 满了)。 */
  private playerAttackerSlots(): number {
    return Math.max(0, MAX_PLAYER_ATTACKERS - this.playerAttackerCount());
  }

  /** 当前武器的锁定距离(与 updateLock 里的表保持一致; 只是把那张表提出来复用)。 */`,
 'playerAttackerCount/Slots');

rep(E, `      const MAX_PLAYER_ATTACKERS = 3;   // per user request: 最多 3 个敌方单位同时咬玩家
      let playerIntent = 0;
      for (const other of this.enemies) {
        if (other !== e && other.alive && !other.isAlly && other.intentPlayer) playerIntent++;
      }
      e.intentPlayer = e.intentPlayer === true;
      const intentSlots = MAX_PLAYER_ATTACKERS;`,
`      // 名额 = 3 减去"海陆空所有人里已经在咬玩家的数量"(自己不算, 因为自己会重挑)
      const intentSlots = this.playerAttackerSlots() + (e.intentPlayer ? 1 : 0);`,
 '空中配额改用统一计数');

// ③ 海面/地面单位: 名额满了就不选玩家; 没有友军可打 => 不选目标(待命巡航)
rep(E, `        const candidates: Enemy[] = u.isAlly ? this.enemies : [...this.wingmen, ...this.carriers.filter(c => c.alive)];
        // Player is always a valid target for enemy units.
        if (!u.isAlly && this.playerHp > 0) {`,
`        const candidates: Enemy[] = u.isAlly ? this.enemies : [...this.wingmen, ...this.carriers.filter(c => c.alive)];
        // === 玩家攻击意图的名额 (per user request: 海陆空一起算, 最多 3 个) =========
        // 名额用完 => 不再把玩家当候选, 于是它要么去打最近的友军/僚机(candidates 那条循环),
        // 要么(场上只有玩家时)选不出目标 => 不开火, 维持巡航, 等别人让出名额。
        const mayAttackPlayer = u.intentPlayer === true || this.playerAttackerSlots() > 0;
        // Player is always a valid target for enemy units.
        if (!u.isAlly && this.playerHp > 0 && mayAttackPlayer) {`,
 '地面单位玩家候选加名额');

rep(E, `      // Remember the chosen target for the far-AI skip frames above.
      if (bestTarget) u.targetId = bestTarget.id;`,
`      // Remember the chosen target for the far-AI skip frames above.
      if (bestTarget) u.targetId = bestTarget.id;
      // 记录/更新"我正在咬玩家"的标记(供上面那个总配额统计)
      if (!u.isAlly) u.intentPlayer = bestTarget?.id === -1;`,
 '地面单位意图标记');
rep(E, `  /** 已被拆掉的组件(网格已从舰体摘除, 不再参与开火) */
  compDetached?: boolean;`,
`  /** 已被拆掉的组件(网格已从舰体摘除, 不再参与开火) */
  compDetached?: boolean;
  /** true = 这个海面/地面单位的当前目标是玩家(用于"同时最多 3 个咬玩家"的总配额) */
  intentPlayer?: boolean;`,
 'GroundUnit.intentPlayer 字段');

// ④ 激光防空炮也守配额(它原来无条件优先玩家)
rep(E, `      if (u.type === 'laser_aa') {
        if (this.playerAlive && this.player.position.distanceTo(u.position) < 5000) {`,
`      if (u.type === 'laser_aa') {
        // 配额满了就不再优先咬玩家(激光炮也是"海陆空"之一), 转而打 bestTarget
        if (u.intentPlayer === true && this.playerAlive && this.player.position.distanceTo(u.position) < 5000) {`,
 '激光炮守配额');
