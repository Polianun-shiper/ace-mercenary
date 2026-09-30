# Phase D / E 已拍板决策（自动执行用，UTF-8）

> 用户已授权：「后面的阶段你不用我确认，你自己分辨来做完，我要睡觉了，让你自己持续运行」。
> 所以本文件里的决策**由 agent 代为拍板**，执行者照做即可，**不要再问用户**。
> 这份清单来自一次只读调查（未改任何文件），行号会随别的 agent 改动而漂移
> ⇒ **实施时一律用 grep 锚定字符串，不要信行号**。
> 前置阶段：Phase A（物理大气，Hillaire 2020 四张 LUT）→ Phase B（云光照/层内密度/云影/STBN）
> → Phase C（丁达尔光柱）→ **Phase D（世界尺度）** → **Phase E（度量一致性）**。
> D 与 E 可以合并在一个 agent 里做（改动高度重叠）。

## 0. 一句话结论

峰高 ×1.5（4320→6480）、地图 ×1.25（48600→60750）、**速度一律不动**；
**自定义/Gaea 地图（m13）本轮不动**；**武器/防空射程不动**，只放"感知类"距离；
**玩家机体尺寸统一到 AI 那张表**（顺带修掉三处尺度不一致）。

---

## 1. 四个拍板项（原调查列为"需用户决定"，现由 agent 定）

### D-R1：Gaea 自定义地图 —— **本轮不动**（保守）
- 源数据不在仓库里：`public/custom-maps/custom/manifest.json` 记的来源是 `F:/gaeaoutload/001(Gaea GUI PNG 四件套)`，而 F: 是**过期副本目录**，且重导需要 Gaea 工程 —— 我们做不到。
- 若只把 `terrain-tune.json` 的 `size` 从 48600 改成 60750 而不重导高度场，会让**整个 custom 地图的比例/遮罩/色图错位，m13 直接报废**（调查附录 C14）。
- ⇒ **m13 的 custom 地形保持 48600 / 4320 不变**，只改三个程序化地图（mountain / desert / archipelago）。
- ⚠ 执行者要在文档里**明确记下这个不一致**，并把它列为"需要用户醒来拍板"的项（有 Gaea 工程才能统一）。

### D-R4：云层 vs 新峰高 —— **选 A：只抬 takram 体积云**
- 矛盾：峰高 4320→**6480** 后，takram 云底 **4600 < 6480** ⇒ 云层整个埋进山体；而"云低于地形"正是历史上"**怎么都穿不了云**"的根因（见 `DEVELOPMENT.md` §286）。贴片云高空层下沿 5719 同样被戳穿。
- **决策：只抬 takram 层**（它在跑、是主路径）：
  - `skybound.cloudBaseM` 默认 **4600 → 7200**（峰顶 6480 之上，留 ~700m 余量）
  - `skybound.cloudTopM` 默认 **6500 → 9200**
  - `Math.max(baseM + 200, …)` → `Math.max(baseM + 800, …)`（否则 4 层的 `slot=span/4` 退化成 4 张薄片）
- **不动贴片云的高度**（`CLOUD_LOW/HIGH_BASE_HEIGHT`）：把贴片低层从 3019 抬到 7200 会让"低空山谷雾"的层次感消失（两层云都跑到 7000m 以上）。贴片云是兜底，戳穿山体只是远景观感问题，用户可用 `skybound.cloudBillboards=off` 整体关掉。
- 执行者要在 `engine.ts` 里那段「峰顶 4320m 会比云层高 → 主动接受的取舍」的注释**整段重写**成新数字（那段注释是仓库里唯一记录该决策的地方，留着旧前提会误导下一个 agent 改回去）。

### D-R5：波次坐标与 pullFactor —— **坐标 ×1.25 且 pullFactor 0.6 → 0.48**
- 机制：敌机实际出生点 = `startPos + (raw - startPos) * pullFactor`（`pullFactor` 当前 0.6），之后再硬夹到 ±13000。
- 若不补偿：任务坐标 ×1.25 ⇒ 实际首交战距 6000~9000m → **7500~11250m**，追平时间 +25%，而注释明确写着设计目标是"**30 秒内可交战**"。
- **决策：波次 XZ 坐标 ×1.25（保持图上相对位置与队形）+ pullFactor → 0.48（把实际交战距拉回原值）+ 硬夹 ±13000 → ±16250**（不跟就会被夹回 13km，波次挤成一条线）。
- `startPos` 也要 ×1.25（它是 pullFactor 的原点，不同步会破坏队形相对关系）。
- **只对 mountain / desert / archipelago / custom 关做**；ocean / city 关（m01/m02/m03/m04/m11/s01）一律不动（没有地形起伏、地图没变大）。

### D-R6：`startAltitude` 是否 ×1.5 —— **不动**
- `startAltitude` 是**绝对米制高度**，与地图 XZ 尺寸无关；`startSpeed` 更绝对不许动（速度前提）。
- 保持出生高度 ⇒ 玩家需要**爬升**进云，这是空战游戏的正常玩法；且当前 `cloudBaseM/cloudTopM` 是**绝对值**（不再锚定出生高度），所以不会互相牵动。
- ⇒ **所有 `startAltitude` / `startSpeed` / AI `altitude`（Y）一律不改**；只有 AI 的 XZ 坐标跟 D-R5 走。

### D-R7：射程 ×1.25 = 平衡改动 —— **只放"感知类"，不放"交战类"**
- 地图变大后，若所有射程都不动，会感觉"够不着"；但把所有射程都 ×1.25 等于**同时**让玩家更强（导弹先手更远）和更危险（地面防空更早锁定），净效果不可预测，而用户只授权了"世界变大、速度不变"。
- **决策（保守拆分）**：
  - **改（感知/态势）**：玩家雷达档 `RADAR_RANGES [4000,8000,14000] → [5000,10000,17500]`、`radarRangeMeters` 默认 8000→10000、`Hud.tsx` / `Radar.tsx` / `ui-preview` 的兜底与刻度文字、AI 索敌 `radarRange`（6000/4500/2600 → 7500/5600/3250）、`pickAirTarget` 兜底、预警机 `RADAR_RANGE 12000:6000 → 15000:7500`。
  - **不改（交战/平衡）**：玩家导弹 `lockRange` 三份拷贝（`engine.ts` 两张表 + `sp-weapons.ts`）、地面/舰载防空 `radarRangeMap`（sam/aa/artillery/bunker/radar_station/laser_aa）、`GUN_RANGE 1200`、主舰挂点射程。
- 理由：感知距离只影响"看得见多远"，交战距离直接改难度曲线；先只动前者，等用户实际飞过再决定后者。

---

## 2. 其余实施要点（照做）

### D1 地形（三个程序化地图）
| 地图 | size | segments（保持格距） | maxHeight | 其它必须同步 |
|---|---|---|---|---|
| mountain | 48600 → **60750** | 896/336 → **1120/420**（54.2m/格） | 4320 → **6480** | 注释里的 "size 48600 = ±24300"、"280 segments" 一起更新 |
| desert | 54000 → **67500** | 1024/320 → **1280/400**（52.2m/格） | 1080 → **1620** | 高速路端点 ±12000 → **±15000**；沙丘/绿洲/岩丘散布、山谷雾散布 ×1.25 |
| archipelago | 37800 → **47250** | 688/280 → **860/350**（54.7m/格） | 2430 → **3645** | **`islandRadius` 12150 → 15187.5**（不跟会让陆地占比上升）；`veg.spread` 12150 → 15187.5 |

- `environment.ts` 的 `chunkCount = max(4, min(19, round(size/2560)))` **不改公式**：60750/2560=23.7 被夹到 19 ⇒ 块宽 2558→**3197m**；`LOD0_COVER_TARGET 12.8e3` **不动**（反算出 radius 仍被夹到 2，LOD0 覆盖 16.0km，不会坏）。
- `SKIRT_DEPTH 3000` **不动**（它是"落到 y=-3000"，与峰高无关）。
- 编辑器默认值同步：`editor-params.ts` 三个地图的 size/segments/maxHeight（顺带把它 512 段与 engine 896 段的历史不一致对齐）+ `absBands` ×1.5 + `GaeaImportDialog` 默认 size + `gaea-import-decode` 样例 size + 两个 recipe json。
- 玩家可见文案：`missions.ts` m13 brief 里的「世界 48600m、峰顶 4320m」→「世界 60750m、峰顶 6480m」。

### D4 相机远近平面（**唯一真的需要改的深度相关字面量**）
- `camera-rig.ts`：`PerspectiveCamera(60, aspect, 1, 60000)` → **`(60, aspect, 2, 80000)`**。
  - far：60750 见方的对角 = **85.9km**，60000 本来就在裁远角 ⇒ 80000。
  - near：1 → 2 让 30km 处深度精度从 ~53.6m 改善到 ~26.8m（好一倍）。**不要超过 3**（cockpit 视角在座舱内，机体 22 单位、翼展 ±11，near 太大会裁掉座舱/前机身）。
- 其余从深度反算世界坐标的地方（`height-fog`、`clouds-takram` 的 `setDepthTexture`、`deferred`、投影贴花）**都通过矩阵/相机自动跟随，无需改**；但 `clouds-takram` 那条**必须目视验证**云被地形遮挡仍对齐（R3）。

### D6 其它距离（×1.25 或按语义）
- 植被：`vegMaxDist` 1200/2000/30000 → **1500/2500/37500**；块级剔除 `cut = 7200` → **9000**（否则块级先掐掉树，株级 30000 白设）。
- 林线：`terrainMaxH ?? 4320` → **6480**（不改会让林线停在新雪线之下 2000m，山腰全秃）。
- 植被铺开半径 `veg.spread` 7000 → **8750**，**同时把 count 提 ~1.56×** 补偿密度（收窄会掉 36% 密度，历史注释有实测记录）。
- 城市 `city.size` 14000 → **17500**；`blockSize` 600 → 750。
- 后燃器剔除 12000 → 15000；HUD 框显示距离 15000:12000 → 19000:15000。
- **不改**：`AIR_WARSHIP_ORBIT_R`（跟舰体尺寸不跟地图）、`DREADNOUGHT_ORBIT_R`、`GUN_RANGE`、雾参数（`startDistance/density/scaleHeight` 是"视距"标定，地图大了地平线更远，雾恰好补上）、云量（260/320 是密度预算）。
- `CLOUD_HIGH_SPREAD` 32000 → **40000**（高空层半径只覆盖新地图 53%，边缘会没云）；`CLOUD_LOW_SPREAD` 64000 保持（已 > 60750）。
- 太阳影正交盒 `sd 4000` / `lightFar 12000`：**先不改**；若实测发现峰顶没影子再提到 5000 / 14000。

### E1 机体尺寸（**决策：统一到 AI 表**，即 option A）
- 归一化口径：三个模型都把**最大维度缩到 10 单位**，而 F-16 最大维度 = 机长 15.03m ⇒ **1 单位 = 1.503m**。
  玩家 `meshScale 2.2` ⇒ 22 单位 = **33.07m = 真机的 2.2×**；AI `stats.scale 1.4` ⇒ 14 单位 = 21.04m = 1.4×。⇒ **玩家机比同型 AI 机大 1.571×**。
- **决策：玩家机尺寸改为"读 AI 那同一张表"**（`getAircraftStats(model).scale`），删掉 `engine.ts` 里按 category 的那张表（fighter 2.2 / attack 2.0 / bomber 1.8 / gunship 1.6 / awacs 1.7）。f16/f16c → **1.4**。
- 一同改（**必须**，否则尺寸不一致）：`models.ts` 的联机低模 `2.2 → 1.4`、`engine.ts` 剧情中队 `1.6 → 1.4`、`hangar.ts` 机库第四张尺度表 + `PREVIEW_SCALE 2 → 1.4`（连 `targetDist 38*PREVIEW_SCALE`、滚轮 14~90 一起）。
- **相机连带（必做）**：`sizeScale` 只由真实机长表驱动、不含 meshScale ⇒ 机体缩 1.571× 后后视相机也得近 1.571×，否则飞机会在画面里变小点。把 `meshScale/2.2` 折进 `sizeScale`，或把 `camera-rig.ts` 的 `11 → 7.0`；`far` 模式的硬编码 `35 → 22`；`sep/140 → sep/220`；`setSizeScale` 的 clamp 上限 `2.5 → 4.0`（B-52 的 48.5/15=3.23 会被夹）。
- 绝对偏移要缩 0.64×：`models.ts` 舵面的 `0.05/0.9/0.4/1.1`、`engine.ts` 枪口焰的 `-0.3/+0.5`；`GEAR_LEN` 若为常数也要复核（`_playerGroundOffset` 走几何实测，会自动跟）。
- 注意 `PLAYER_SIZE_M` 那张表**保持数值不变**（它是真实机长，只驱动相机取景）。
- **R10 的副作用（已接受）**：统一后玩家 B-52 从 1.8 → 0.9（视觉小一半）。这是"与 AI 一致"的必然结果，按 option A 接受。
- **R9 顺带修**：`aircraft-catalog.ts` 缺 `tu95`/`f16` 两个条目 ⇒ `getPlayerSpec('tu95')` 会回退到 F-16C 的 spec。这是独立既存 bug，顺手补上（AI 侧 `getAircraftStats` 有独立分支，不受影响）。

### E2 / E3 单位口径（**一行数值都不改**）
- `×3.28` 只在 HUD 一处（世界米 → HUD 英尺），语义正确。建议提成具名常量 `FT_PER_M = 3.28084` 并把 `engine.ts` 里 `test-flight-physics.ts` 的 `3.2808` 统一。
- 速度三重语义的**唯一正解**（把 `realMaxSpeed` 重定义为真 m/s = 节×0.5144、`WORLD_SPEED_SCALE 0.546 → 1.062`）**等于改速度** ⇒ 违反前提，**不做**。
- 只做三件小事：① `types.ts` 与 `engine.ts` 里 "knots / m/s" 的注释改成同一口径（说明数值沿用历史"节"量级但内部当 m/s 用，以免后人误改）；② `const speedKnots` → `speedDisplay`（名字是错的）；③ `Hud.tsx` 给速度数值**补一个单位标签**（高度那侧已有 `hud.ft`，速度侧缺，不对称）。

---

## 3. 执行者必须遵守的老规矩（复盘出来的）

1. `engine.ts` **正被别的 agent 改写** ⇒ 用 **grep 字符串锚定**，不要用行号；D/E 的动手时机排在 Phase A 收工之后。
2. 改完 `src/` 必须 `node scripts/build-single-html.mjs --dev` 重建 dist-test 才能探针（8898 是**静态服 dist-test**，不是热更）。
3. 验收基线：GL 错误 **10 条、全 warning、0 error、0 链接失败**；采样器峰值 **9/16**，上限 16，**绝不许给 three 材质加采样器**（地形已 14/16）。
4. 失败要 `try/catch` 优雅回退，不能打断整条后处理链。
5. 数值旋钮用 `readTuning(key, def, min, max)`。
6. 中文文档 GBK（PowerShell 追加），`DSH_HANDOFF.md` UTF-8。
7. 最后 `bash scripts/sync-builds.sh`；单文件上限 100MB（当前约 99.85MB）。
8. **只保证 forward 链**（用户：延迟模式几乎用不了）。
9. 四张截图 + GL 数字作为验收证据，结论要给数字，不许只说"已完成"。
