# -*- coding: utf-8 -*-
# 阶段 1：types.ts + sp-weapons.ts + weapons.ts（NKV 类型/武器表/盲飞期）
import io

# ================= types.ts =================
p = 'src/lib/game/types.ts'
s = io.open(p, encoding='utf-8').read()

old = """export type WeaponType ="""
assert old in s
# 找到 WeaponType 定义并加 NKV
import re
m = re.search(r"export type WeaponType = (.*?);", s, re.S)
assert m, 'weapontype'
wt = m.group(1)
assert "'CLB'" in wt
new_wt = wt.replace("'CLB'", "'CLB' | 'NKV'")
s = s[:m.start()] + "export type WeaponType = " + new_wt + ";" + s[m.end():]

# WeaponState 加 NKV 可选字段
old = """  HVG?: number;
  CLB?: number;"""
new = """  HVG?: number;
  CLB?: number;
  NKV?: number;"""
assert old in s, 'weaponstate'
s = s.replace(old, new)

# HudState 加 gunImpactScreen + nukeFlash
old = """  sideCannonImpact?: { x: number; y: number; radius: number } | null;"""
assert old in s, 'hudstate anchor'
# 找 HudState 里 bombImpactScreen 定义
m2 = re.search(r"bombImpactScreen[^;]*;", s)
assert m2, 'bombImpactScreen'
new_block = m2.group(0) + """
  // === Gun/HVG straight-line impact predictor (per user request: 炮类落点指示器) ===
  gunImpactScreen?: { x: number; y: number; radius: number } | null;
  // === Nuke white flash (per user request: NKV 战术核弹) ===
  nukeFlash?: number;"""
s = s[:m2.end()] + new_block + s[m2.end():]

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('types ok')

# ================= sp-weapons.ts =================
p = 'src/lib/game/sp-weapons.ts'
s = io.open(p, encoding='utf-8').read()

# SP_WEAPONS 加 NKV（在 CLB 条目后）
old = """    aceCombatName: '灵感来自 SOD / 集束炸弹',
    color: '#ffcc44',
  },
];"""
new = """    aceCombatName: '灵感来自 SOD / 集束炸弹',
    color: '#ffcc44',
  },
  // === NKV 战术核弹 (per user request: 新武器·仅玩家·12发·3km爆炸) ===
  {
    type: 'NKV',
    code: 'NKV',
    name: '战术核弹',
    range: 0,        // 直飞空爆
    damage: 99999,   // 3km 内秒杀
    agility: 0,
    speed: 400,
    ammo: 12,
    lockType: 'none',
    pros: '战术核弹：3km 爆炸范围，范围内敌方单位瞬间消灭',
    cons: '数量极少（12 发），注意与友军保持距离',
    aceCombatName: '灵感来自战术核航弹',
    color: '#ff8844',
  },
];"""
assert old in s, 'sp weapons'
s = s.replace(old, new)

# ALL_LOADABLE_WEAPONS 加 NKV
old = """  // Main weapons first
  'MSL', 'LASM', 'BDL', 'FLR',"""
new = """  // Main weapons first
  'MSL', 'LASM', 'BDL', 'FLR', 'NKV',"""
assert old in s, 'loadable'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('sp-weapons ok')

# ================= weapons.ts =================
p = 'src/lib/game/weapons.ts'
s = io.open(p, encoding='utf-8').read()

# Missile 接口加 blindT / isNuke
old = """  age: number;               // seconds since launch"""
new = """  age: number;               // seconds since launch
  // === Flare blind period (per user request: 箔条容易干扰导弹) ===
  // After losing lock to flares, the missile flies blind for this many
  // seconds before it may re-acquire a target — otherwise flares were
  // useless because the missile re-locked instantly.
  blindT?: number;
  // === Nuke warhead (per user request: NKV 战术核弹) ===
  isNuke?: boolean;"""
assert old in s, 'missile fields'
s = s.replace(old, new)

# 目标获取前检查盲飞期（在 "Target acquisition" 段）
old = """      // Target acquisition
      if (m.target && !m.target.alive) m.target = null;"""
new = """      // Target acquisition
      if (m.target && !m.target.alive) m.target = null;
      // === Flare blind period (per user request) ===
      // While blind, don't re-acquire a target — the missile just flies
      // straight. Also forces nuke warheads to fly straight.
      if ((m.blindT ?? 0) > 0) {
        m.blindT = (m.blindT ?? 0) - dt;
        m.target = null;
        // Straight-line cruise while blind (no guidance).
        m.speed = Math.min(m.speed + dt * 150, (m as any).isNuke ? 400 : 280);
        m.velocity.normalize().multiplyScalar(m.speed);
        _prev.copy(m.group.position);
        m.group.position.addScaledVector(m.velocity, dt);
        m.group.lookAt(_tmp.copy(m.group.position).add(m.velocity));
        m.life -= dt;
        m.age += dt;
        if ((m as any).isNuke) {
          // Nuke: airburst after 1.5s of straight flight (or terrain contact).
          if (m.age >= 1.5 || m.group.position.y < 5) {
            m.dead = true;
            m.hit = true;
            m.reportedHit = true;
            (m as any).nukeReady = true; // engine detonates it
          }
        }
        continue;
      }"""
assert old in s, 'blind acquire'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('weapons ok')
