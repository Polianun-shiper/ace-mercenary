# -*- coding: utf-8 -*-
# 僚机弱化（锁定6s/冷却9-12s/射程3000/机炮300m+0.3s）+ 对地攻击 + 伤害100 + 速度380
import io

# ================= engine.ts =================
p = 'src/lib/game/engine.ts'
s = io.open(p, encoding='utf-8').read()

# 1. 僚机锁定 4.0 → 6.0（僚机两处：radarRange 5000 上下文）
old = """      aiLockRequired: 4.0,
      radarRange: 5000,"""
new = """      // === Wingman lock slowed (per user request: 僚机只是补伤害的) ===
      // 4s → 6s — wingmen are slower on the trigger than enemy AI.
      aiLockRequired: 6.0,
      radarRange: 5000,"""
assert s.count(old) == 2, 'wingman lock sites'
s = s.replace(old, new)

# 2. 僚机导弹：射程 3500 → 3000、冷却 6-8 → 9-12
old = """        if (w.missileTimer <= 0 && w.aiLockTimer >= w.aiLockRequired && enemyDist < 3500 && enemyDist > 600 && dot > 0.95 && !playerLockBias) {
          // === Wingman cadence buffed (per user request: 僚机AI太弱) ===
          // 10-14s → 6-8s cooldown and 2500 → 3500m range so wingmen
          // contribute real fire support without stealing the player's
          // kill shot (playerLockBias still holds fire when the player
          // is engaged on the same target).
          w.missileTimer = 6 + Math.random() * 2;"""
new = """        if (w.missileTimer <= 0 && w.aiLockTimer >= w.aiLockRequired && enemyDist < 3000 && enemyDist > 600 && dot > 0.95 && !playerLockBias) {
          // === Wingman aggression toned down (per user request: 僚机只补伤害) ===
          // 9-12s cooldown, 3000m range — wingmen support, they don't
          // star. The player should be landing most kills.
          w.missileTimer = 9 + Math.random() * 3;"""
assert old in s, 'wingman missile'
s = s.replace(old, new)

# 3. 僚机机炮：射程 350 → 300、频率 0.18 → 0.3
old = """        if (w.muzzleTimer <= 0 && enemyDist < 350 && dot > 0.97 && !playerLockBias) {
          w.muzzleTimer = 0.18;"""
new = """        if (w.muzzleTimer <= 0 && enemyDist < 300 && dot > 0.97 && !playerLockBias) {
          // 0.18s → 0.3s cadence — fewer stray bullets (per user request).
          w.muzzleTimer = 0.3;"""
assert old in s, 'wingman gun'
s = s.replace(old, new)

# 4. 僚机对地攻击：目标选择（form fallback 后加地面目标）
old = """      } else {
        // form (default)
        targetPos = this.player.position.clone()
          .addScaledVector(this.playerForward, -slotDepth)
          .addScaledVector(this.playerRight, slotSide * slotLateral)
          .addScaledVector(this.playerUp, -1);
      }"""
new = """      } else {
        // form (default)
        targetPos = this.player.position.clone()
          .addScaledVector(this.playerForward, -slotDepth)
          .addScaledVector(this.playerRight, slotSide * slotLateral)
          .addScaledVector(this.playerUp, -1);
      }

      // === Wingman ground attack (per user request: 僚机以合理方式攻击地面单位) ===
      // When no air target is available, wingmen engage enemy GROUND units
      // within 3500m with missiles + strafing guns — reasonable CAS, still
      // at low aggression.
      let groundTarget: GroundUnit | null = null;
      if (!targetEnemy && (cmd === 'attack' || cmd === 'cover' || selfDefense)) {
        let bestG: GroundUnit | null = null;
        let bestGd = 3500;
        for (const u of this.groundUnits) {
          if (!u.alive || u.isAlly) continue;
          const d = u.position.distanceTo(w.position);
          if (d < bestGd) { bestGd = d; bestG = u; }
        }
        if (bestG) {
          groundTarget = bestG;
          targetPos = bestG.position.clone();
        }
      }"""
assert old in s, 'form target'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('engine ok')

# ================= weapons.ts =================
p = 'src/lib/game/weapons.ts'
s = io.open(p, encoding='utf-8').read()

# 1. 僚机导弹速度 420/460 → 380/420
old = """          ? (isWingmanMissile
              ? (m.type === 'LASM' ? 460 : 420)        // wingman: own cap
              : (m.type === 'LASM' ? 560 : 500))        // player: rebalanced cap"""
new = """          ? (isWingmanMissile
              // === Wingman missiles slowed (per user request: 僚机导弹太快) ===
              // 420/460 → 380/420 — slower than enemy low-tier (414) so
              // bandits can outrun wingman shots and the player stays the
              // primary killer.
              ? (m.type === 'LASM' ? 420 : 380)        // wingman: own cap
              : (m.type === 'LASM' ? 560 : 500))        // player: rebalanced cap"""
assert old in s, 'wingman speed'
s = s.replace(old, new)

# 2. 僚机导弹伤害 120 → 100（baseDmg）
old = """        const baseDmg = spDamage ?? (m.type === 'LASM' ? 180 : 120);"""
new = """        // === Wingman missile damage (per user request: 僚机伤害比AI导弹低) ===
        // 120 → 100 — below enemy missiles (120) so wingmen finish targets
        // the player softened instead of one-shotting them.
        const baseDmg = m.damagerKind === 'wingman'
          ? 100
          : (spDamage ?? (m.type === 'LASM' ? 180 : 120));"""
assert old in s, 'baseDmg'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('weapons ok')
