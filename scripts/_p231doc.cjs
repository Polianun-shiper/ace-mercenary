// §231 文档片段(UTF-8): GBK 两份用 PowerShell 936 追加, 交接文件插在 §230 之前
// 注意: GBK 编不了 ◀(U+25C0) ▶(U+25B6) ⇒ ✓ ✗ ± ², 一律用 ASCII。
const fs = require('fs');

const secDev = `

---

## 第 231 轮: 音乐三首 / AI 低模 / TAB 与四机配额 / 末阶段加力逃离 / 舵面斜边铰链 / 主舰真用上 FBX / 简报动画 (2026-09-19)

用户一次性提了十件事, 逐条落地如下。

### 231.1 音乐: White Bird(关卡曲) + Briefing(简报曲) + 加力轰鸣

- 三份素材入库: \`public/audio/music_white_bird.mp3\`(9.3MB)、\`music_briefing.mp3\`(5.5MB)、
  \`sfx_shuttle_rumble.mp3\`(0.7MB), 并登记进 \`scripts/audio-assets.mjs\`(构建会内联并按 128kbps 压缩)。
- \`music.ts\`: \`TrackName\` 增加 \`'briefing'\`; 新增 \`useStoryCombat(true/false)\` —— 剧情第一关**固定播 White Bird**,
  其它关卡仍走原来的随机池; 新增 \`playShuttleRumble(seconds)\`(克隆元素、从头播、到点停, 不参与 4 秒自动回收)。
- 挂钩: \`startMission\` 里 \`useStoryCombat(this.isS01)\`; GameApp 在 \`story-brief\` 相位切 \`setTrack('briefing', 900)\`,
  离开简报回主菜单曲。

### 231.2 AI 单位全部低模 + TAB 优先级 + 同时最多 4 个敌机咬玩家

- **AI 全低模**: \`spawnEnemyFromWave\` 不再吃 \`geomCache\` 里的玩家级模型(F-16C 那是 36MB 的 OBJ), 改成
  \`{ ...baseInfo, geometry: getLowGeometry(model) }\`(每机型共享一份约 300 面的低模)。实测敌机几何顶点数
  **64**(低模)而不是上万。玩家机路径不受影响。
- **TAB 目标优先级**(per user request: 最高优先级在雷达锁定圈之内, 且优先近的): \`orderTargetsForCycle\` 现在先算
  "在锁定圈内"(距离 <= 当前武器锁定距离, 且落在机头前 45 度锥里, 与 \`updateLock\` 的 0.7 cos 同源),
  **圈内按距离由近到远排最前**, 圈外维持原来的"屏幕中心优先 + 距离微调"。新增 \`weaponLockRange()\` 复用那张表。
- **同时最多 4 个敌机有攻击玩家的意图**: 新增 \`Enemy.intentPlayer\`, 索敌时先统计当前"咬玩家"的同伴数量,
  配额(4)用完就**转向最近的友军/僚机**(不再是"锁不上玩家就挂机")。实测 16 架敌机在场时 \`intentPlayer\` 正好 4。

### 231.3 末阶段开加力、轰鸣、加速逃离 + 巨量伤害不消失爆炸

- \`DREADNOUGHT_SPEED\` 新增 \`escape: 210\`(阶段 4 目标速度, 原来是 25 的"边打边滑"); \`DreadnoughtMotionState\`
  新增 \`burn\`, 阶段 4 置位。
- 引擎侧: 一检测到 \`burn\` 且还没点火, 就在舰艉建一组尾焰(\`buildAfterburner\` + \`setAfterburner(grp, 1)\`)、
  播一次 \`playShuttleRumble(9)\`(transport-space 前半段的低频轰鸣)、并提示"堡垒点燃后燃器 · 正在加速脱离战场";
  之后由加力音量继续维持视觉。
- **主舰受巨量伤害不"模型消失 + 爆炸"**: 通用阵亡/坠落路径本来就排除了主舰, 这一轮再加一道血量托底
  (\`if (u.boss && u.hp < 1) u.hp = 1\`), 于是它掉血只会拆挂点, 唯一收场仍是"四个剧情阶段走完 -> 惯性坠落"。

### 231.4 机库预览 x2 / 4AAM-4AGM 挂载量 / 偏航舵斜边铰链

- **机库预览放大 2 倍**(per user request): \`hangar.ts\` 新增 \`PREVIEW_SCALE = 2\`, 机体缩放与相机距离、缩放范围
  一起乘 2(只放机体不拉相机就会被裁掉)。\`PrepBay\` 用的同一个 viewer, 所以战斗准备也一起变大。
- **4AAM 挂载量 12 -> 24**(per user request), 4 目标齐射从 3 轮变成 6 轮。
- **偏航舵铰链改成斜边**(per user request: 旋转轴不是底下那条直的, 是紧邻舵面的斜边):
  \`models.ts setupHinge\` 现在用**最远点对**量出舵面最长方向当铰链方向(后掠垂尾上这条线自然是斜的),
  再把**前缘顶点投影到该直线**得到铰链点(正好落在紧邻舵面的斜边上), 并把轴写进 \`mesh.userData.hingeAxis\`;
  引擎驱动舵面时优先用四元数绕该轴转(没有该字段的老路径仍走 \`rotation.y\`)。
  **实测: F-16C 偏航舵铰链轴 = (-0.003, 0.713, -0.701), 相对竖直倾斜 44.5 度**(改之前是 (0,1,0) 竖直)。
  第一版我按"y 分带量前缘"算, 探针实测倾角 0 —— F-16C 的 OBJ 面片并不沿坐标轴排布, 所以换成最远点对才稳。

### 231.5 主舰真的用上这个模型了(而且 file:// 也行)

用户反馈"boss 还是用原来的模型": 根因是 39.8MB 的 FBX 当时登记为**只随行不内联**, file:// 双击(或只传 index.html)
读不到就回退程序化舰体。这一轮把 FBX **转成可内联的小资产**:
- \`scripts/bastion-to-obj.mjs\`: 在 Node 里用 FBXLoader + OBJExporter 导出 \`bastion.obj\`(24480 v / 8160 面, 3.79MB)
  -> gzip \`bastion.obj.gz\` (0.72MB, 5.24x) + \`bastion.mtl\`;
- 贴图在**浏览器里**抽出来(4096 内嵌图 -> 画到 2048 画布 -> JPEG)得到 \`bastion_albedo.jpg\`(0.73MB);
- \`loadBastionModel()\` 现在走 **OBJ + MTL + JPEG**(与 F-16C 同一套 obj-gzip/图片管线), FBX 降级为第二兜底、
  程序化舰体最后兜底; \`bossFbxSource\` 取值 \`'obj' | 'fbx' | 'procedural'\`;
- 资产库把这四个文件登记为 \`inline:true\`(并加进构建 ASSETS), 原 39.8MB 的 FBX 改成 \`copy:false\`(不再随行, 省 39.8MB 上传)。
- 实测: 开发态 \`bossFbxSource = 'obj'\`、舰长 3894.1 米; **file:// 双击产物同样 \`'obj'\`**(这条才是用户要的)。

### 231.6 简报动画: 复杂变换 + 敌我位置

\`Briefing3D\` 的 3D 场景改成 32 秒循环的四阶段编排(单一时钟 + 缓动):
1. 建立镜头(海面网格 + 距离圈 + 星野, 相机下降推近) ->
2. 目标揭示(低空掠过舰体 + 机身滚转, 舰体偏航亮出侧舷并放大 14%, 一道扫描面从艏到艉扫过两遍 + 三道等高环跟随) ->
3. 战术展开(相机拉高到近似俯视, fov 38->55, **11 个标记**错峰弹入并脉冲) ->
4. 回收(标记淡出, 相机回到 3/4 英雄角, 无缝循环)。
标记体系: 我方 3 个(玩家 + 2 僚机, 蓝/青 \`#5ad2ff\`/\`#8fe8ff\` 雪佛龙), 敌方 8 个(主舰 \`#ff3b1f\` 大双环 + 十字,
6 架护航 \`#ff6a2c\` 菱形绕着旗舰缓慢公转, 2 艘轻型舰 \`#ffb000\` 括号方框), 每个标记都有引线与标签,
屏幕尺寸恒定(按距离与 fov 换算)。实测 draw call 35.5(建立)/ 51.7(战术峰值), 都在 80 以内。
顺带修掉一个隐藏 bug: 相机关键帧轨只复制了一个环绕点, 29-32 秒段读到 undefined -> NaN 相机 -> 每循环黑屏 3 秒。

### 231.7 验收与风险

| 检查项 | 结果 |
| --- | --- |
| 敌机几何 | 顶点数 64(低模), 不再是玩家级模型 |
| TAB 优先级 | 锁定圈内(距离 + 45 度锥)优先, 圈内近的优先, 圈外维持原规则 |
| 四机配额 | 16 架在场时 \`intentPlayer\` = 4(超出者转向友军/僚机) |
| 偏航舵铰链 | 轴 (-0.003, 0.713, -0.701), 倾斜 44.5 度 |
| 主舰模型 | \`bossFbxSource: 'obj'\`, 舰长 3894.1 米; **file:// 同样 'obj'** |
| 简报动画 | 4 阶段循环 + 11 个敌我标记; 4 张阶段截图 |
| 音乐 | White Bird(剧情关卡) / Briefing(简报相位) / 轰鸣(末阶段点火) |

截图: \`.shots/brief-3d-01-establish.png\` / \`-02-reveal-scan.png\` / \`-03-tactical.png\` / \`-04-return.png\`、
\`.shots/bastion-obj.png\` / \`bastion-file.png\`。

**必须提醒的体积风险**: 单文件 \`dist-single/index.html\` 现在是 **119.1 MB / 113.6 MiB**, 距离用户提过的 120MB
上限只剩 ~1MB。其中这一轮的净增只有约 2MB(OBJ.gz 0.97MB + 贴图 0.97MB base64), 另外 ~10.7MB 是新加的三首音频。
要继续加内容就得先瘦身: \`node scripts/build-single-html.mjs --no-4k-sky\`(4K 天空盒改走随行, 省约 15MB)是最快的一刀。
`;

const entryWl = `
## 2026-09-19 第 231 轮: 音乐三首 / AI 低模 / TAB 与四机配额 / 加力逃离 / 舵面斜边铰链 / 主舰真用 FBX / 简报动画

用户一次提了十件事。落地:

- **音乐**: 三份素材入库(White Bird 关卡曲 / Briefing 简报曲 / transport-space 前半段当加力轰鸣), 登记进
  audio-assets(构建内联+压缩)。\`music.ts\` 新增 \`'briefing'\` 轨道与 \`useStoryCombat()\`, 剧情关卡固定播 White Bird,
  简报相位播 Briefing; 新增 \`playShuttleRumble(seconds)\`。
- **AI 全低模**: \`spawnEnemyFromWave\` 改用 \`getLowGeometry\`(实测敌机顶点 64, 原来是玩家级上万面)。
- **TAB 优先级**: \`orderTargetsForCycle\` 先判"在雷达锁定圈内"(当前武器锁定距离 + 机头 45 度锥, 与 updateLock 同源),
  圈内**按距离由近到远**排最前, 圈外维持屏幕中心优先。
- **四机配额**: 新增 \`Enemy.intentPlayer\`; 索敌时统计咬玩家的同伴, 配额 4 用完就**转向最近友军/僚机**。
  实测 16 架在场 intentPlayer = 4。
- **末阶段加力逃离**: \`DREADNOUGHT_SPEED.escape = 210\`(原 25), 运动状态新增 \`burn\`; 引擎在舰艉建尾焰
  (buildAfterburner/setAfterburner) + 播一次轰鸣 + 提示"正在加速脱离战场"。
- **巨量伤害不消失爆炸**: 主舰血量托底(\`hp < 1 -> 1\`), 掉血只拆挂点, 唯一收场仍是四阶段走完后的惯性坠落。
- **机库预览 x2**: \`hangar.ts\` 的 \`PREVIEW_SCALE = 2\`, 机体 + 相机距离 + 缩放范围一起乘 2(PrepBay 同享)。
- **4AAM 挂载量 12 -> 24**。
- **偏航舵斜边铰链**: setupHinge 用**最远点对**求铰链方向 + 前缘顶点投影定铰链点, 轴写进 \`userData.hingeAxis\`,
  引擎用四元数绕它驱动。实测 F-16C 舵面轴 (-0.003, 0.713, -0.701) 倾斜 **44.5 度**(改前竖直 0 度)。
  (第一版按 y 分带量前缘得 0 度 —— F-16C 的面片不沿坐标轴排布, 换最远点对才稳。)
- **主舰真用 FBX**: 39.8MB FBX 转成可内联小资产 —— \`bastion.obj\`(24480v/8160 面, 3.79MB) -> gzip 0.72MB +
  浏览器里抽贴图并降到 2048 得 \`bastion_albedo.jpg\`(0.73MB); \`loadBastionModel()\` 走 OBJ+MTL+JPEG, FBX 降级第二兜底;
  资产库 inline:true, 原 FBX copy:false(省 39.8MB 上传)。实测开发态与 **file:// 双击产物都是 \`'obj'\`**, 舰长 3894.1 米。
- **简报动画**: \`Briefing3D\` 改成 32 秒四阶段编排(建立 -> 低空掠过+扫描面 -> 俯视战术图 -> 回收循环),
  **11 个敌我标记**(我方 3 蓝青雪佛龙 / 敌方主舰红大双环 + 6 护航菱形 + 2 轻型舰括号框), 带引线标签、屏幕尺寸恒定;
  draw call 35.5 / 51.7。顺带修掉相机关键帧环绕点缺失导致的每循环 3 秒 NaN 黑屏。
- 风险: \`dist-single/index.html\` = **119.1MB**, 距 120MB 上限只剩 ~1MB; 再要加内容先跑 \`--no-4k-sky\`(省约 15MB)。
`;

const entryH = `
### §231 音乐三首 / AI 低模 / TAB 与四机配额 / 末阶段加力逃离 / 舵面斜边铰链 / 主舰真用 FBX / 简报动画

用户一次提了十件事, 全部落地并实测:

**音乐**: \`public/audio/music_white_bird.mp3\`(关卡曲)、\`music_briefing.mp3\`(简报曲)、\`sfx_shuttle_rumble.mp3\`(加力轰鸣)
入库并登记进 \`scripts/audio-assets.mjs\`。\`music.ts\` 的 \`TrackName\` 加 \`'briefing'\`; 新增 \`useStoryCombat(on)\`
(剧情第一关固定 White Bird, 其它关卡仍走随机池)与 \`playShuttleRumble(seconds)\`(克隆元素、播满一段、到点停)。
挂钩: \`startMission\` -> \`useStoryCombat(this.isS01)\`; GameApp 在 \`story-brief\` 相位 \`setTrack('briefing', 900)\`。

**AI 全低模**: \`spawnEnemyFromWave\` 不再用 \`geomCache\` 的玩家级模型, 改成 \`{ ...baseInfo, geometry: getLowGeometry(model) }\`。
实测敌机几何顶点 **64**(原来是上万面的 OBJ)。玩家机路径不变。

**TAB 目标优先级** (用户: 最高优先级在雷达锁定圈之内, 且优先近的): \`orderTargetsForCycle\` 先判"在锁定圈内"
(距离 <= 当前武器锁定距离, 且落在机头前 45 度锥, 与 \`updateLock\` 的 0.7 cos 同源), **圈内按距离由近到远排最前**,
圈外维持"屏幕中心优先 + 距离微调"。新增 \`weaponLockRange()\` 复用那张距离表。

**同时最多 4 个敌机咬玩家**: 新增 \`Enemy.intentPlayer\`; 索敌时先数一遍当前咬玩家的同伴, 配额(4)用完就
**转向最近的友军/僚机**(而不是挂机)。实测 16 架在场时 \`intentPlayer\` = 4。

**末阶段开加力 + 轰鸣 + 加速逃离**: \`DREADNOUGHT_SPEED.escape = 210\`(原 25 的"边打边滑"), 运动状态新增 \`burn\`(阶段 4 置位);
引擎检测到点火的那一帧在舰艉建一组尾焰(\`buildAfterburner\` + \`setAfterburner(grp, 1)\`)、播一次 \`playShuttleRumble(9)\`
(transport-space 前半段)、并提示"堡垒点燃后燃器 · 正在加速脱离战场"; 之后由加力状态维持视觉。

**巨量伤害不消失爆炸**: 通用阵亡/坠落路径本就排除主舰, 这轮再加血量托底 \`if (u.boss && u.hp < 1) u.hp = 1\` ——
掉血只会拆挂点, 唯一收场仍是"四个剧情阶段走完 -> startBossFall() 的惯性坠落"。

**机库预览 x2**: \`hangar.ts\` 新增 \`PREVIEW_SCALE = 2\`, 机体缩放 / 相机距离 / 缩放范围一起乘 2(只放大机体不拉相机就会被裁掉);
PrepBay 用同一个 viewer 所以战斗准备同享。**4AAM 挂载量 12 -> 24**(4 目标齐射 3 轮 -> 6 轮)。

**偏航舵铰链 = 紧邻舵面的斜边**: \`models.ts setupHinge\` 用**最远点对**求出舵面最长方向当铰链方向(后掠垂尾上这条线自然倾斜),
再把**前缘顶点投影到该直线**得到铰链点(正好在斜边上), 并把轴写进 \`mesh.userData.hingeAxis\`; 引擎驱动舵面时优先用
四元数绕该轴(无该字段仍走老的 \`rotation.y\`)。**实测 F-16C 舵面轴 (-0.003, 0.713, -0.701) = 相对竖直倾斜 44.5 度**
(改之前是 (0,1,0))。踩坑: 第一版按 y 分带量前缘(探针实测 0 度) —— F-16C 的 OBJ 面片不沿坐标轴排布, 换最远点对才稳。

**主舰真用上这个模型(用户报"还是用原来的")**: 根因是 39.8MB FBX 当时**只随行不内联**, file:// 双击读不到就回退程序化舰体。
这轮把 FBX 转成可内联的小资产: \`scripts/bastion-to-obj.mjs\`(Node: FBXLoader + OBJExporter)导出 \`bastion.obj\`
(24480 v / 8160 面, 3.79MB) -> gzip \`bastion.obj.gz\` 0.72MB(5.24x) + \`bastion.mtl\`; 贴图在**浏览器里**从内嵌图抽出、
降到 2048 存 \`bastion_albedo.jpg\` 0.73MB。\`loadBastionModel()\` 改走 OBJ + MTL + JPEG(与 F-16C 同一套管线),
FBX 降级为第二兜底、程序化舰体第三兜底; \`bossFbxSource\` = \`'obj' | 'fbx' | 'procedural'\`。资产库把这三个文件登记 \`inline:true\`,
原 FBX 改 \`copy:false\`(省 39.8MB 上传)。**实测开发态与 file:// 双击产物都是 \`'obj'\`, 舰长 3894.1 米**。

**简报动画(复杂变换 + 敌我位置)**: \`Briefing3D\` 的 3D 场景改成 32 秒无缝循环的四阶段编排 ——
建立镜头(海面网格 + 距离圈 + 星野, 相机下降推近) -> 目标揭示(低空掠过舰体 + 滚转, 舰体亮出侧舷并放大 14%,
扫描面从艏到艉扫两遍 + 三道等高环) -> 战术展开(相机拉高 fov 38->55, **11 个标记**错峰弹入并脉冲) -> 回收循环。
标记: 我方 3(玩家 + 2 僚机, 蓝/青雪佛龙)、敌方 8(主舰红大双环 + 十字, 6 护航菱形绕旗舰公转, 2 轻型舰括号方框),
都带引线标签、屏幕尺寸恒定。实测 draw call 35.5(建立)/51.7(战术峰值)。顺带修掉关键帧环绕点缺失导致的
"每循环 3 秒 NaN 相机黑屏"。

**风险(必须知道)**: \`dist-single/index.html\` 现在 **119.1MB / 113.6MiB**, 距 120MB 上限只剩约 1MB。
本轮净增只有约 2MB(OBJ.gz + 贴图), 另 ~10.7MB 是三首新音频。再要加东西先瘦身:
\`node scripts/build-single-html.mjs --no-4k-sky\`(4K 天空盒走随行, 省约 15MB)是最快的一刀。
截图: \`.shots/brief-3d-01..04*.png\`、\`.shots/bastion-obj.png\`、\`.shots/bastion-file.png\`。
`;

fs.writeFileSync('.shots/_sec231_dev.md', secDev.split('\n').join('\r\n'), 'utf8');
fs.writeFileSync('.shots/_sec231_wl.md', entryWl, 'utf8');
fs.writeFileSync('.shots/_sec231_handoff.md', entryH, 'utf8');
console.log('§231 fragments written');
