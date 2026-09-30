# 备忘 / Backlog（ACE·SKY）— 未做完与待拍板的事

> 这份文件是**待办清单**：每条都写到"下一个接手的人能直接开工"的颗粒度。
> 与 `DSH_HANDOFF.md`（已完成工作的交接）分工：这里是**还没做的**。
> 最后更新：2026-09-24（§320 天顶门控 + 去噪实测那一轮之后）。

---

## 1. 能量空战 AI（§309/§315 已落地一半）

- [ ] **僚机接同一套**：`updateWingmen` 仍是旧街机转弯（`forward.lerp` + 速度钉 maxSpeed + 纯视觉滚转）。
      敌机已走 `applyEnergyAi`（`engine.ts`，开关 `skybound.aiEnergy`）。僚机要接的话：
      ① 抄 `applyEnergyAi` 的调用形态（`EnergyFighter` 实例挂在单位上）；
      ② 僚机有编队/跟随指令（form/attack/cover/disperse/rtb），**只在 attack/cover/disperse 用能量 AI**，
      form/rtb 保持"礼貌跟随"（否则僚机不肯回编队）。
- [ ] **场景 C（被咬尾 / 迎头劣势）还形不成解算**：实测 60s 内最小距离 946m、不超调、能量保留 115%，
      即"能守不能攻"。需要再加一层：剪刀（scissors）→ 判断对手冲过头 → **反扣时机**。
      现有 `reverse` 只是"朝对手方向拉"，缺"等他冲过去再转"的时机判断。
- [ ] **定 AI 手感默认值**（等用户实测）：现 `AI_TUNING_DEFAULT` = maxG 8.5 / 角点速度 62%maxSpeed /
      推力 13 m/s² / 寄生阻力 5e-5 / 诱导阻力 0.2 / 滚转倍率 1.9 / 滞后距离 520m / 迎角 3.5°。
      现场旋钮：`ai g|corner|thrust|drag|induced|roll|lag|aoa <v>`（每帧读）。
- [ ] **归档对局测试**：`tmp/ai-sim.ts`（旧 vs 新的确定性对局，esbuild 打包后 node 跑）值得移到 `scripts/`
      并写进文档；现在它在 tmp 里，随时可能被清理。

## 2. CPU 四条优化（§308/§314 已定量，未做）

- [ ] **`updateProjectedShadow` 的 2048² 离屏（§318 新发现）**：**视向无关地每帧付 ~3.5ms**
      （游戏内 `gpup` 实测 `·机体自阴影RT`），而且**降到 1024² 只省 ~0.2ms** ⇒ 它主要不是被像素填充卡的，
      而是**机体那几百个小 draw 的提交/固定开销**。对策方向：按需（只在机体可见/近距离时渲染）、
      或把机体在自阴影 RT 里合并成更少的 draw（合并材质/按 LOD 用低模）。

实测（真窗口 1600×900，35fps，每帧 ~30ms）：

- [ ] **GTAO 6.4ms** ← 收益最大。forward 链下 three 的 GTAOPass **自己再渲一遍整个场景**拿法线+深度。
      两条路：① 把延迟管线设为默认（deferred 下它吃现成 G-Buffer，零额外几何通道）；
      ② 让 GTAO 复用主通道的法线/深度（需要我们自己出 G-Buffer，改动大）。
- [ ] **`emitHud` 2.8ms/帧**：现在每帧重建 DOM/文本 ⇒ 改成"数值变化才写"（缓存上一帧的字符串）。
- [ ] **`updateTerrainStreaming` 3.1ms/帧**：地形流式更新，可做预算/节流（每 N 帧或按距离优先级）。
- [ ] **场景渲染 pass 9.7ms**：这是 draw call **提交**开销（几百个小 draw），根治要合批
      （植被、地面单位最肥）。改动最大，收益也最不确定 —— 先量 `renderer.info` 的 draw call 数再说。

## 3. 体积云（§316 空间滤波 / §319-§320 门控 + 去噪，剩下这些）

- [ ] **天顶门控的那个"机制未定位"**（§320）：库主 march 的退出条件是 `rayDistance > rayNearFar.y-rayNearFar.x`
      （`maxRayDistance` uniform 在 `clouds.frag:751` 夹过 far），按说 400m 的 ray 配 `minStepSize 50m` 八步就该退出，
      但实测**迭代上限 500 时确实烧 17.93ms**（压到 2 就是 0.55ms）⇒ 那 500 次没被距离提前终止。
      怀疑 `structuredSampling` 的空域跳过路径不按 `rayDistance` 退出。**不影响结论**（压迭代数就够），
      但定位了就能在"相机在云层之上、但视锥仍够得到一点云"的中间地带也省下这笔钱。
- [ ] **背光暗云的云边"串珠"**（§320 已证明不是欠采样/不是滤波参数/不是源侧旋钮）：
      9 倍 march 像素串珠数不变、所有结构旋钮 <=3% ⇒ 是**密度/细节模型自身的世界尺度结构**。
      目前唯一的"解法"是 `vcloud spatial soft 0..1`（涂抹，880 -> 704 个 1px 离群，代价边缘 p99 -29%）。
      真正的解法要动密度场本身（例如把 shape-detail 的高频在**世界尺度**上带限，或换一套更平滑的侵蚀函数）——
      属"云算法再升级"级别，建议与 `docs/backlog.md` §3 的"覆盖率通道"一起做。
- [ ] **B3 省掉那遍 resolve**（§316 暂缓的一步）：现在空间路径**不读** resolve 的输出，但库的
      `cloudsPass.update()` 仍然每帧跑一遍全屏 resolve + swapBuffers（白付钱）。
      做法：包住 `cloudsPass.update`，空间路径下跳过 resolve；`outputBuffer` 会变成陈旧值
      （我们已不读它，但光柱的 shadow-length 通道与 `vcloud tup` 诊断要重新确认一遍）。
      收益未量：先用 `_gpuprof.mjs` 量出 resolve 那一遍多少 ms 再决定值不值得。
      ⚠ 注意 §320 的教训：**量内层必须先关掉 `gpup`**（WebGL2 禁止嵌套查询，会双向污染读数）。
- [ ] **把 3D 覆盖率 / 光柱 shadow-length 也纳入同一套空间滤波**（§316 只做了颜色/不透明度通道）。
- [ ] **deferred 成默认后**：云、GTAO、投影自阴影可以共享同一套法线/深度，省掉各自的几何/深度通道。
- [ ] **`cloudResScale` 与空间滤波的联合标定**：现在默认 1（march 1/4 边长）。
      §320 实测：**march 像素数 9 倍变化对云 pass GPU 时间几乎无影响**（1.16 -> 1.3ms），
      而迭代数是线性成本 ⇒ 想省就压 `steps`，想细就提分辨率**几乎免费**（上限受 fill/带宽影响，未测顶）。
- [ ] **空间路径的边缘锐度**：实测比时域路径软约 12~15%（平均梯度 0.0090 vs 0.0102）。
      想更锐就 `vcloud spatial taps 4`（十字核）；也可以只对**云边**用窄核、对云内部用宽核。
      ⚠ 但 §320 的扫描说明：**往"松"的方向调权重(sharp/range/spread)会显著变噪**，现有默认是局部最优。

## 4. TAA（几何抗锯齿）—— 仍在队尾

- 与 §316 的云"无历史"路线**不冲突**：云不再需要 TAA，但**几何（机体边缘/栏杆/植被）仍需要**。
- 若之后上 TAA，注意运动矢量质量：本项目机体/地形都是程序化运动，矢量要自己出。

## 5. 设置面板 UI（旋钮已经存在，只是没进界面）
现在这些只能通过 localStorage / 关卡内控制台调：

- [x] **云参数的"调试滑条面板"已做**（§321）：控制台 `tuner` / `vcloud ui` / URL `#tuner` / **F2**，
      39 个滑条 + 20 个开关，拖动立刻生效，含单项复位/全部复位/导出改动。旋钮表在
      `src/lib/game/cloud-knobs.ts`（单一事实来源，控制台那 6 张表都从它派生）。
- [ ] **玩家侧"画质档"面板仍未做**：上面那个是**调试**面板（默认不存在，要 `tuner` 才出现）。
      玩家能看到的画质设置（低/中/高 + 云/阴影开关）还没进 `Settings.tsx`；可直接复用
      `cloud-knobs.ts` 的描述表 + `engine.setCloudKnob / setCloudFlag`。
- [ ] AI：`ai` 全套（energy on/off + 8 个手感常数）。
- [ ] 图形：`pcss`（接触硬化阴影）、`gtao`（半径/强度）、`cover3d`（3D 覆盖率）、`shafts`、`godrays`。
- [ ] 界面语言：设置项要跟 `i18n.ts` 一起加（中英双语），别写死中文。
      （调试面板与调试控制台目前是**故意**硬编码中文的 —— 它们是开发工具，没进 i18n。）

## 6. 待拍板（需要你决定，不是我能定的）

- [ ] **Gaea 自定义地图（m13）**：按新世界尺度（峰高 ×1.5、XZ ×1.25）重导网格，还是接受旧网格？
      （数据源在 `terrain-tune.json` + `.f32bin`，重导需要你对齐一次。）
- [ ] **Phase E2/E3 单位口径**：HUD 高度是英尺、世界是米；速度同一个数既是节又当 m/s。
      统一方案要出，但**速度数值本身不动**（你已定）。
- [ ] **体积云规矩是否要进设置面板**（cov ≤0.75 / dens ≤0.2 / shape 0.4 / 两个阴影默认关）——
      做成"玩家可见的画质档"，还是保持隐藏的构建级约束？

## 7. 工程债 / 已知坑（别重复踩）

- [ ] `godRaysPass` **从未被 dispose**（`engine.ts` 里只有字段引用，没有 `dispose()` 调用）——
      换关/重进会泄漏一个材质 + FullScreenQuad。
- [ ] 单文件产物 100MB 上限：`--slim` / `--no-4k-sky` 可回收 ~15MB；若要内联云贴图会涨到 ~120MB。
- [ ] **探针三坑**（都写进过文档，这里再列一次）：
      ① headless 下 `cancelAnimationFrame(e.raf)` 之后 `Page.captureScreenshot` 会一直返回**同一张 stale 帧**
         ⇒ 截图类探针**不要停 RAF**（`paused` 分支本来每帧就 render）；
      ② `renderer.info.render.frame` / `.calls` 在 composer 下每个 pass 都自增/重置，
         **不能当帧数/draw call 数**；
      ③ **跑探针前先确认 8898 的 serve-test 在跑**（挂了的表现是"页面里没有 `__engine` 也没有任何异常"，
         很容易白查半天）。
- [ ] **探针第四坑（§320 新增，代价最大的一条）**：**WebGL2 禁止嵌套 timer query**。
      开着 `gpup` 时内层再加 `beginQuery/endQuery` ⇒ INVALID_OPERATION，**而且外层 gpup 的读数一起被污染**
      （本轮第一版把云 pass 读成 0.00ms）。写法：内层包装带总开关（`_stgattr.mjs` 的 `window.__tOn`），
      两种测量**互斥**。
- [ ] **探针第五坑（§320 新增，会白屏级误判）**：着色器**编译失败不抛异常**（three 只往 console 打一行），
      表现是**整帧全黑**。所以任何动 GLSL 的探针都该顺手量一下**画面平均亮度**（§320 就是靠它发现
      compMat 编译失败，亮度 0.0012）。游戏里已加体检(program 没链上 => 退回时域路径 + 警告)。
- [ ] **§335 遗留（s02《洞川撤退》的占位与缺口）**：
  - 地图是占位（`map:'city'`）；正式"狭长走廊"地图到位后要重设 `s02Circle` 与敌机进场方位。
  - 轰炸机与运输机共用 B-52 网格（仓库没有运输机模型），运输机靠 0.82 缩放 + 换色区分。
  - 没有评级系统 ⇒ 剧本的"未完成断后 ⇒ 评级下降"用 -5000 分表示。若要做真评级，落点是
    `endMission()` 的 payload（`engine.ts` 的 score/stats）与 `Results`/`Results3D` 四行表。
  - s02 的结算/简报仍是**普通** Results：`Results3D.tsx:766`、`StoryBrief.tsx:141`、`engine.ts` 的
    `storyMission` getter 都是 `id === 's01'` 门控 —— 要享受 s01 那套 3D 结算就得改成 `campaign` 判定。
  - `MissionObjective.type` 的 `'survive'` 仍然**只声明未实现**（`'reach'` 已在 §335 实现）。
    同样坑：未实现的 type 会让 `allDone` 恒真 ⇒ 进关 1 秒通关。加新 type 时务必同步 `checkObjectives`。
  - 隼3"不躲空爆弹"未专门实现；阶段 3/4 的"残存敌机转火护航机"由兜底分支等效实现。
- [ ] **探针第六坑（§321 观察到，已定案真因）**：探针里始终有 `Uncaught SyntaxError: Unexpected
      token '<'`。真因见 `DEVELOPMENT.md` §107.5：产物里的**第三方脚本**
      `<script src="https://vibe.lumigrav.space/sdk/v3/vibehub.js">`，**无外网时该请求返回 HTML**，
      于是被当 JS 解析。与本轮任何改动无关，不用再查（`Network.enable` 抓 4xx 为 0 就是因为
      这个请求成功返回了 200 的 HTML）。
- [ ] **文档编码债（§333 发现）**：`DEVELOPMENT.md` 是**混合编码** —— 前 200 KB 是 **UTF-8**
      （文件头/早期章节），之后是 **GBK**（历次用 `Encoding(936)` 追加的 §300+ 都是 GBK）。
      症状：用 GBK 打开头部 905 处乱码（`涓€鍙ヨ瘽` 这种），而用 UTF-8 打开正文乱码。
      另外 UTF-8 段本身有**历史性丢字节**（约 2758 处"非 ASCII 字节后紧跟 `?`"，如
      `EF BC 9F`(？) 被啃成 `EF BC 3F`）—— 用 `F:\ipbeifen2-dsh\DEVELOPMENT.md`(9月21日快照)
      对照可证：那时就已是 `EF BF BD 3F`，**不是本轮改出来的**（`DEVELOPMENT.md` 未入 git，
      所以没有版本可回滚）。待办：一次性统一成 GBK（或 UTF-8），丢字节处按上下文补回来。
      ⚠ 顺带记两个编码操作坑：(1) 别用 bash heredoc 生成含中文的 `.ps1` 再直接跑 —— bash 写的是
      UTF-8 字节、PowerShell 按 GBK 解析源码，中文字面量全成乱码（§333 第一版整段写坏，重写）；
      正确做法是中文正文写 UTF-8 文件 → `iconv -f UTF-8 -t GBK` → **纯 ASCII** 的 PowerShell
      用 `ReadAllBytes/WriteAllBytes` 拼接。(2) 用 `ReadAllLines(GBK)+WriteAllLines` 做替换时，
      整份文件会被重新编码一遍：UTF-8 段里**不是合法 GBK 的字节会变成 `?`**（信息不可逆），
      所以改混合编码文件只该做**字节级**截断/追加，别整文件解码重写。
- [ ] t00 正对背光山体的机位仍偏暗（地形区 34/255）：补偿是全局常数，现场 `atmo exp <v>` 可调。
- [ ] `trim/`、`tmp/` 下的探针与中间产物会越堆越多，定期清（`tmp/` 已在 gitignore 里则无妨）。
