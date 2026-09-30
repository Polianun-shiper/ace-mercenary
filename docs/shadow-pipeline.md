# 关卡阴影管线（阴影源优先级 / 机体自阴影为什么"用不了"）

> 本文记录 2026-09 对关卡阴影系统的一次取证与定型。核心结论：
> **`AircraftSelfShadow` 与 legacy 的 `aircraftShadowLight` 都是 intensity = 0 的灯，
> 在 three 的前向管线里不产生任何可见阴影**；机体真正的自阴影来自
> `projected-shadow`（贴花式注入）。关卡默认已改为**静态正交平行光 + 贴花自阴影**。

## 1. 四个阴影源与优先级

| 源 | 开关（localStorage） | 默认 | 覆盖范围 | 更新 |
|---|---|---|---|---|
| **CSM**（级联，跟随相机） | `skybound.csm = on` | **off** | 相机视锥内 ±6000 | 每帧 |
| **静态正交太阳** `sunLight` | `skybound.staticShadow = on` | **on** | 玩家周围 ±4000 | 只渲一次（`autoUpdate=false`，玩家移动 >1000 单位才重渲） |
| **贴花投影** `projected-shadow` | `skybound.selfShadowMap = off` 才关 | **on** | 仅玩家机体 | 每帧（只渲机体，很便宜） |

优先级：`CSM > 静态正交`（`useCsm` → `useStatic`）。CSM 与静态正交互斥
（`useStatic = staticShadowEnabled && !useCsm`）。

**已彻底删除**（2026-09，连模块带设置项）：`src/lib/game/pbr/self-shadow.ts`
（`AircraftSelfShadow`）、legacy 的 `aircraftShadowLight`、以及设置面板里的
"机体自阴影系统(pbr/legacy)"选项（`skybound.selfShadow` / `skybound.selfShadowSystem`）、
玩家专属严格过滤（`applySelfShadowFilter`）。原因见 §2 —— 它们都是空操作，
只白占一张深度图和一个采样器。

## 2. 为什么那两盏"贴身自阴影灯"是空操作

`src/lib/game/pbr/self-shadow.ts` 的 `AircraftSelfShadow` 是
`new THREE.SpotLight(0xffffff, 0, …)`；`engine.ts` 里 legacy 路径是
`new THREE.DirectionalLight(sunColor, 0)`。两者都写着"intensity 0 —— 只负责投射阴影，
太阳光负责实际光照"。**这个想法在 three 的前向管线里不成立**：

```js
// three/src/renderers/webgl/WebGLLights.js:375
uniforms.color.copy( light.color ).multiplyScalar( light.intensity );   // intensity 0 ⇒ color 0
```
```glsl
// three/src/renderers/shaders/ShaderChunk/lights_fragment_begin.glsl.js:122
directLight.color *= ( directLight.visible && receiveShadow )
                     ? getShadow( spotShadowMap[ i ], … ) : 1.0;         // 0 × shadow = 0
```

阴影是**乘在这盏灯自己的颜色上**的。灯的颜色恒为 0 ⇒ 阴影乘出来还是 0 ⇒
**无论阴影贴图多精确都不产生任何变暗**。

代价却是实打实的：
- `AircraftSelfShadow.light.shadow.autoUpdate = true` → 每帧多渲一张 2048² 深度图；
- 给每个材质多加一个 `spotShadowMap` 采样器 —— 这正是当年 **"CSM + 机体自阴影并存"
  时爆 `MAX_TEXTURE_IMAGE_UNITS(16)`** 的来源（移除后两种模式采样器峰值都降到 **9/16**，
  链接失败从 6 条变成 **0 条**）。

修理方式：**直接删掉**（模块、字段、建造代码、每帧更新、`activeShadowLight` 的兜底、
`shadowres`/`shadowbias` 里针对它的分支、设置面板那一项、玩家专属严格过滤）。
`shadowres` 原本只作用于那盏灯和 CSM —— 也就是**从来没碰过静态正交太阳**，
而静态正交现在是默认源，所以顺手改成作用在"实际生效的源"上。
机体自阴影由 `projected-shadow` 提供（见 §3）。

## 3. 机体自阴影真正的工作方式：`projected-shadow`

`src/lib/game/projected-shadow.ts` —— 单张投影深度图 + 手动投影坐标，像"贴花"一样贴到机体表面：

- 正交相机（轴 = 太阳方向）只把**玩家机体**渲进深度图（不渲全场 ⇒ 便宜、不会被远山/云干扰）；
- 片元里用光空间投影矩阵算 uv，采样一次判断"这一点有没有被自己的其它部位挡住"；
> ⚠ **2026-09-22 补正（真 bug，已修）**：上面这套"贴花"其实**一直没生效**。
> `ProjectedShadow.update()` 渲深度图时，被注入的材质片元正在采样 `uPSxMap`，而那张
> `depthTexture` 正是本帧的**深度附件** ⇒ WebGL 判定为反馈回路 ⇒ 该次 draw 被丢弃并报
> **0x502 INVALID_OPERATION** ⇒ 深度图永远是清空值 ⇒ 片元里 `psxShadow()` 恒返回 1.0（判"亮"）
> ⇒ **机体自阴影完全不存在**（用户报"只有材质自身 N·L 自阴影"）。
> 以前只验了**状态**（`uPSxOn: 1`、注入材质数），没验**像素**，所以漏了。
> 修法：渲深度图**之前** `uPSxOn = 0`（着色器开头 `if (uPSxOn < 0.5) return 1.0;` 直接返回、
> 不采样）**并**把 `uPSxMap` 换成 1×1 白哑贴图，渲完恢复。修复后 A/B：机体 837 像素变化、
> max 55/255，两侧背景 0 变化，`gl.getError()` 恢复为空。详见 DEVELOPMENT.md §255.1。

- **注入点**：`#include <lights_fragment_end>` **之前**，只乘
  `reflectedLight.directDiffuse` / `directSpecular`（直接光累计项），
  **环境光 / IBL 一点不动** ⇒ 金属机身背光面不会被压成死黑，天光轮廓光保留。这是 PBR 正确的做法。

实证（`#autotest&mission=m01`，默认配置）：
```
projShadowOn: true   uPSxOn: 1   uPSxStrength: 0.85   injectedMats: 205 (玩家 210 个网格中的 199 个 cast+receive)
```

## 4. 跟随之光必须"量化"(2026-09 修：阴影一直闪)

静态正交太阳覆盖 ±4000，为了把纹素用在战区附近，它跟着玩家走。**但"跟随之光 +
只偶尔重渲贴图"这个组合本身就是闪烁的来源**：

- 旧实现每帧把灯和 target **连续**搬，阴影贴图却只在位移 >250 单位时重渲
  → 贴图是旧灯位的快照，而查表用的投影矩阵每帧都在动 ⇒ 全部阴影边缘持续游移，
  每 250 单位再跳一次新快照。巡航（约 490 单位/秒）下每秒跳约两次 = "一直闪"。
- **量化**修法：把灯的中心吸附到以 `(R, U, sunDir)` 为基、格距为 `step` 的三维格点上，
  只在**格号变化的那一帧**同时移动灯 + 重渲贴图。两次重渲之间灯位与深度基准完全不变
  ⇒ 投影矩阵恒定 ⇒ 阴影静止。
- `step = texel * round(256 / texel)`：既是整纹素（每次重渲纹素相位一致，边缘不抖），
  又给出可接受的滞后（机体在地面上的投影包含在这张图里，最大滞后 ≈ step/2 ≈ 128 单位）。
- ⚠ **三个轴都要量化。** 只量化贴图平面上的 R/U 不够：实测巡航方向几乎正对太阳方向的
  水平投影，位移主要落在 **sunDir 自身**那一轴（只量化 R/U 时锚点每帧仍漂移 ~104 单位）。
  沿视轴漂移不改横向对齐，却会整体平移深度比较基准（贴图深度是沿视轴存的）→ 整场忽明忽暗。
- 用**整数格号**比较（`bR/bU/bS`），不要用向量 `equals` —— 浮点噪声会让它每帧都判定"变了"
  从而每帧重渲。

实测（`#autotest&mission=m01`，250ms 采样灯位）：出现连续的 `移动量 = 0.00`，跨格时跳
236~348 单位（即 255.8 格距在 XZ 上的投影）。

## 5. 为什么机库的机体自阴影好看，关卡里为什么不能照抄

机库那边（`hangar.ts`）的太阳阴影相机：灯钉在 `sunPos*600`、target 在原点，**从不动**；
正交半宽 **90**、2048² ⇒ **0.088 单位/纹素**，20 米的机体跨约 230 个纹素 ⇒ 又清又稳。

关卡静态光是 ±4000 / 4096² ⇒ **1.95 单位/纹素**，机体只跨约 **10** 个纹素 ⇒ 又糊又在游移
（差 22 倍）。关卡不能把视锥收到 90 —— 那只能覆盖 180 米。

⇒ 关卡里的对应做法就是 **`projected-shadow` 贴花**：每帧把视锥紧贴机体拟合（和机库同一个
思路，只是动态的），所以它才是"机库那套"在关卡里的等价物。**它在设置里叫"投影贴花阴影"，
默认开**（只有显式 `off` 才关）。

## 6. 机库（烘焙资产）为什么必须换材质，而不是"放到别的图层"

> 踩过的坑，记住结论：**three 没有逐物体的灯光遮罩。**

`WebGLRenderer.projectObject` 里灯光的可见性判据是
`object.layers.test( camera.layers )` —— 拿的是**相机**的 layers，通过之后
`currentRenderState.pushLight( object )` 把灯推进**全局**光照状态，所有材质共享。
所以"把机库 `layers.set(1)` 让实时灯照不到它"这个做法**根本不成立**：机库照样被
太阳/天光/环境光照到，而且它 `receiveShadow = false`，那些光全是**无阴影**的
⇒ 整舱被冲成一片均匀的亮，烘焙出来的明暗对比全丢（表现就是"很亮但没有阴影"）。

正解是把烘焙资产的材质整批换成 **`MeshBasicMaterial`**（"完全烘焙"的语义）。
three r185 `meshbasic_frag` 的算式正好就是烘焙语义：

```glsl
indirectDiffuse  = lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;  // ← 有 1/π
indirectDiffuse *= diffuseColor.rgb;        // ← 再乘 albedo(map)
outgoingLight    = indirectDiffuse;         // ← 没有任何实时灯参与
```

即 `最终 = albedo × 烘焙光照 × intensity/π`，与 Blender 的 `albedo × irradiance/π` 一致。

三个必须注意的点：

1. **`lightMapIntensity` 要乘回 π，再乘一个曝光系数。** 那个 `RECIPROCAL_PI` 会把原值
   直接压暗 3.14 倍；而舱内照度物理上只有门口阳光带的约 1%（p99 归一化后），游戏曝光
   又是按户外白天定的 ⇒ 只乘 π 仍然整舱发黑。当前取 `Math.PI * 5`。阳光带会过曝到
   纯白 —— 那正是"从门口打进来的一束光"该有的样子。
2. **光照贴图按 sRGB 解码是对的**：`70_bake.py` 里 `colorspace_settings.name = "sRGB"`，
   写盘时做了 sRGB 编码，所以 three 侧必须 `colorSpace = SRGBColorSpace` 才是精确往返。
3. **灯具透镜要单独处理**（材质名 `HG_LampLens*`）：basic 没有 `emissive` 通道，
   也不能给它挂 lightMap（透镜处的烘焙值很小，乘上去会把"灯在亮"压成灰），
   直接用颜色表达发光。

## 7. 采样器预算

16 是 WebGL 的上限（`MAX_TEXTURE_IMAGE_UNITS`）。实测默认配置下**所有**已编译 program
的峰值是 **9/16**（`uPSxMap` + `map`/`aoMap`/`envMap`/`dfgLUT`/`directionalShadowMap`/
`normalMap`/`roughnessMap`/`metalnessMap`）。**腾出了 7 个余量。**

> ⚠ **2026-09-23 修正（这条以前是错的/不完整的）**：
> ① 地形材质的峰值现在是 **14/16**，不是 13/16（`uLayer0..3` + `uMask` + `uMacroTint` +
> `uVtxTex` + `bakeMap`/`aoMap`/`normalMap` + `directionalShadowMap` + `uPSxMap`…）。
> **真正顶到上限的是它，不是那些 9 张的普通 PBR 材质。**
> ② "CSM 模式下同为 9/16" 是**假象**：CSM 下超限的程序**链接失败**，
> `gl.getProgramParameter(prog, ACTIVE_UNIFORMS)` 对失败的程序返回 0 ⇒ 恰好把超限的那几个
> 挡在统计之外。只看这个数会得出"CSM 采样器没超"的错误结论（上一轮就是这么误判的）。
> 判据要看 **console 里的 `FRAGMENT shader texture image units count exceeds
> MAX_TEXTURE_IMAGE_UNITS(16)` + `VALIDATE_STATUS false`**，以及 `gl.getError() === 1282`。
> 见 §11。

## 8. 自动化测试的阴影配置

`#autotest` **强制出厂默认**（静态正交 on / CSM off）—— 以前它无条件写 `csm='on'`，
导致所有自动截图/GL 审计都在量 CSM 的行为，而不是玩家实机的行为，排查
"机体自阴影在关卡里用不了"时被误导了很久。
要专门验证 CSM 用 **`#autotest-csm`**（hash 含 `csm`），要强制静态用 **`#autotest-static`**。

> ⚠ **2026-09-23 修**：那三个分支的**值现在从 `DEFAULT_PRESET` 现读**
> （`preset.ts` 的 `factoryShadowMode()`），不再硬编码 —— 否则改了出厂默认而忘了同步这里，
> 自动测试量到的就是**旧行为**（历史上正是这么被误导的）。
> 另外 `#autotest-*` 写完立刻 `markPresetApplied()` 打版本戳：`PRESET_MIGRATIONS` 的判据是
> "当前值 == 旧默认值"，hash 想强制的值**恰好等于旧默认值时会被迁移改掉**
> （`csm: on → off` 那条就是 —— 这条曾把 `#autotest-csm` 静默吃掉）。
> 顺带：只改 fragment 的 `Page.navigate` **不会重载页面**，探针里同会话换配置必须在 URL 上
> 带 query（`?n=<tag>#...`），否则后一个配置量的还是前一个配置的场景（实测踩过）。

## 9. 预设与迁移

`src/lib/game/preset.ts` 的 `applyDefaultPreset()` 只在**键不存在**时写值，所以光改
`DEFAULT_PRESET` 对老存档无效；而无条件覆盖会踩掉用户手动改过的设置。
折中：`PRESET_VERSION` + `PRESET_MIGRATIONS` —— 只有当前值**仍等于旧预设默认值**
（即用户从没动过）才迁移。当前 `staticShadow: off → on`、`csm: on → off`（v1 → v2）。

## 10. 怎么自己验一遍

```bash
node node_modules/next/dist/bin/next dev -p 3000          # 或起 dist-single 的 serve-single
node scripts/_shadow-probe.mjs "http://127.0.0.1:3000/#autotest&mission=m01" --wait 22000
node scripts/_shadow-probe.mjs "http://127.0.0.1:3000/#autotest-csm&mission=m01" --wait 22000
node scripts/_shadow-probe.mjs "http://127.0.0.1:3000/#autotest-static&mission=m01" --wait 22000
```

探针一次报出：localStorage 开关、引擎实际标志、贴花注入材质数、那两盏空转灯是否被创建、
每个 program 的采样器用量与名字、着色器链接失败条数、`toggleShadowDebug('info')` 全文。

**判据**：`hasSelfShadowLight: false`、`projShadowOn: true`、`uPSxOn: 1`、
`[gl] 着色器/GL 错误 0 条`（可能混进来的 1 条是 D3D 的
`warning X4122: … double precision`，那是精度提示不是失败；另有两条与阴影无关的固定噪声：
`Uncaught SyntaxError: Unexpected token '<'`（某个 JSON 走了 SPA 兜底）与
`[GameApp] startMission() timed out after 8s`（无头机器慢时会出，不影响阴影判定））。
采样器峰值报 **14/16**（地形材质，静态与 CSM 都一样 —— 但 CSM 下这个数**不可信**，见 §7②）。

## 11. CSM 复测（2026-09-23）：**仍然爆采样器上限 ⇒ 默认继续关**（附实测数据）

### 11.1 被验的假设与结论

假设（本轮任务）："当年 CSM 爆 `MAX_TEXTURE_IMAGE_UNITS(16)` 是因为它和那盏
`intensity=0` 的机体自阴影灯并存；那盏灯**已被彻底删除**(§2)，采样器压力已释放
⇒ CSM 现在很可能可以开了"。

**复测结论：假设不成立，CSM 今天依然爆上限，而且爆得更"干净"——不是链接失败几个离屏材质，
而是地形着色器直接校验失败、地表整片消失。** 出厂默认保持**静态正交**（`skybound.csm = off`、
`skybound.staticShadow = on`）。CSM 开关保留在设置里（`skybound.csm`，`on`/`off`），
仅作 A/B 取证用，UI 提示已注明它会毁地表。

### 11.2 取证方法（可复现）

探针 `scripts/_csm-ab.mjs`（一个浏览器进程、三个配置、每个配置**整页重载**）：

```bash
node scripts/_csm-ab.mjs --mission m06 --out E:\ipbeifen2-dsh\tmp\csmab
# 3 个配置: #autotest(静态) / #autotest-csm / #autotest(复跑=噪声底)
```

每个配置内：等 `missionReady` → **收敛闸门**（每 2.5s 抓小图与上一张比，平均绝对差 < 0.35
才继续 —— 否则拿"贴图还没进显存"的画面去比，差异里全是加载进度：实测 CSM 首跑就是这样，
地表还是白的）→ `setPaused(true)` 冻结世界 → `__freezeCam(true)` → 把机体**摆到绝对位姿**
（各配置几何逐比特一致）→ 5 个固定机位取景（`near_air` 26 m 看机体 / `shadow_close`
正上方 95 m 看地面投影 / `near_ground` / `terrain_close` 2.5 km / `mid` 1.5 km）→
读相机 `matrixWorld`（证明各配置机位完全一致）、级联几何、采样器普查、
`renderer.render` 单帧成本。

图片度量：`scripts/_csm-sharp.mjs`（亮度梯度均值 / 梯度 >6 像素占比 / 相邻像素差）、
`scripts/_diffmap.mjs`（放大差分图）。

⚠ 两个方法论坑（都踩过）：
- **只改 fragment 的 `Page.navigate` 不会重载页面** ⇒ 同会话换配置必须带 query
  （`?n=<tag>#...`），否则后一个配置量的还是前一个配置。第一次跑就栽在这上面。
- CSM 模式下暂停会让 `scanCsmMaterials()`（每 15 帧一次，在 `update()` 里）停摆；
  异步换进来的材质（KTX2/MWAM 升级会换材质实例）拿不到 `USE_CSM` ⇒ 它按普通平行光走、
  把 4 盏 CSM 灯全加一遍（4× 阳光，整屏发白）。取景前要手动补扫一次。

### 11.3 硬数据

| 项目 | 静态正交（出厂默认） | CSM（4 级 × 2048） |
|---|---|---|
| 片元着色器校验 | **0 条失败** | **≥2~5 条 `VALIDATE_STATUS false`**，日志原文 `FRAGMENT shader texture image units count exceeds MAX_TEXTURE_IMAGE_UNITS(16)`，材质类型 `MeshStandardMaterial` |
| `gl.getError()` | `0` | `1282`（INVALID_OPERATION） |
| 画面 | 沙漠地形/跑道正常 | **地表整片消失**（截图里中间一块深蓝空洞 = 未绘制的区块，其余靠雾/天空充数） |
| 探针读到的采样器峰值 | **14/16**（地形，3 个 program） | "9/16" —— **假象**，超限的程序链接失败后 `ACTIVE_UNIFORMS` 返回 0（见 §7②） |
| `renderer.render` 中位（同机位 40 次） | **10.9 ms** | **14.9 ms**（+37%） |
| 级联 0 纹素密度 | 1.95 单位/纹素（±4000 / 4096²） | 0.87 单位/纹素（级联正交宽 1786 / 2048） |
| 级联 3 | — | 6.90 单位/纹素（宽 14132 / 2048，比静态**粗** 3.5×） |
| console err+warn | 21 warning / 1 异常 | 22 warning / 5 error+异常 |

**因果**：CSM 的 4 级级联 = 4 张 `directionalShadowMap`（静态路径只有 1 张）⇒ 每个受影材质
+3 张纹理单元：地形 14 → **17 > 16**。这正是 §7 那句"真正顶到上限的是地形材质"的由来。

**收益本来就有限**：级联 0 只比静态细 2.2 倍（0.87 vs 1.95），最远级联反而比静态**粗** 3.5 倍
（`maxFar=6000` ⇒ 最远一级正交宽 14132 单位）。即使采样器不爆，它换来的也只是
"近处细 2 倍 / 远处糊 3.5 倍"，与 §5 里机库那套 0.088 单位/纹素（差 22 倍）不是一个量级。

### 11.4 附带验掉的两条（负结果，别再重复做）

1. **收小静态正交盒没有收益。** 同会话把 `sunLight.shadow.camera` 从 ±4000 收到 ±2500
   （1.22 单位/纹素）、再收到 ±1800（0.88，与 CSM 级联 0 同量级）：同机位逐像素 mad =
   **1.07 / 1.07**（噪声底见下），锐度指标 `gradMean 5.184 → 5.183 / 5.183`、
   `gradHi% 21.15 → 21.13 / 21.14` —— **不可测**。地形浮雕阴影的边缘确实微微变了
   （`terrain_close` mad 1.66、5.4% 像素 >8），但**锐度不变** ⇒ 这张图的"糊"不是纹素密度
   限的（是 PCF 滤波 + 低太阳(22.2°)/雾/曝光限的）。结论：**不做该改动**（收益 0，覆盖范围变小）。
2. **"机体地面投影看不见" —— 未定论，但记录在案。** 同机位连拍的**噪声底** = mad 0.81 /
   p99 3（世界已暂停、相机已冻结，逐像素仍有 ~1~3/255 的时间性抖动）；关掉机体 199 个网格的
   `castShadow` + `shadow.needsUpdate` 后 mad **0.84**（= 噪声底）；整盏太阳阴影开关
   `sunLight.castShadow = false` 后 mad **1.23**，放大差分图显示变化集中在画面左下的
   **地形浮雕**（阴影边界清晰可辨），而机体投影应落的位置**没有变化**。
   ⇒ 这次取景下机体对地面阴影的贡献**低于测量噪声底**；整幅画面的太阳阴影也只影响约 1.3%
   的像素（06:50、太阳高度 22.2°、沙漠 + 强雾）。**要判"机体地面投影"必须换更强的取景**
   （更高太阳高度角 / 无雾场景 / 机体贴地），否则任何"阴影变清楚了"的说法都不可信。
   本轮因此**无法用"近处机体投影的锐度"判定 CSM 优劣** —— 真正的判据是它把地表打没了。

### 11.5 默认值与开关（最终）

- `DEFAULT_PRESET`：`skybound.staticShadow = 'on'`（不变）、`skybound.csm = 'off'`（不变）。
- 设置面板：`skybound.csm`（`on`/`off`）—— `Settings.tsx` 的 CSM 块 + `Menus.tsx` 的 CSM 行，
  文案已注明"会超采样器上限、地表会消失"。
- 近处机体阴影继续由 **projected-shadow 贴花**提供（§3，默认开，`skybound.selfShadowMap != 'off'`）。
- 自动化：`#autotest` = 出厂默认（**现读 `DEFAULT_PRESET`**，不再硬编码）；
  `#autotest-csm` = 强制 CSM；`#autotest-static` = 强制静态（新增）。


