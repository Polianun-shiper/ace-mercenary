// §242 文档片段(UTF-8)
const fs = require('fs');
const secDev = `

---

## 第 242 轮: 关卡内实时过场运镜(开场 / 坠落) + 过场台词占位槽 (2026-09-19)

用户: "加上关卡内剧情的实时过场动画, 刚进关卡先运镜展示敌方 boss 和它周围的轻型空中战舰, 然后预留过场动画台词位,
然后在打完最后一阶段时空中战舰坠落时也给个运镜"。

### 242.1 做法: 不改相机模块, 帧末覆盖位姿

相机照旧由 CameraRig 更新; 新增的过场控制器在**同一帧稍后**把相机的 position/quaternion/fov 覆盖掉,
播完(或目标消失)自动交还 —— 所以不需要给相机模块加模式, 也不会污染追尾视角的逻辑。
镜头由"镜头表"驱动(按 elapsed 时间分段, 段内用 lerp/slerp 平滑, 不做硬切):

- **开场运镜** \`startIntroCutscene()\`(进关 2.5 秒后触发, 全长 17 秒):
  ① 远景环绕主舰(半径 1.5 倍半长、视高 1.6 倍半高, fov 48)展示体量 ->
  ② 贴着舰体由艉向艏掠过(fov 60) ->
  ③ 环绕主舰周围**最近的轻型空中战舰**(半径 900、高 320) ->
  ④ 拉回玩家身后一帧后交还。
- **坠落运镜** \`startCrashCutscene()\`(主舰开始坠落 1.8 秒后触发, 14 秒): 侧后远景跟拍下坠(前 8 秒)
  -> 拉近仰视舰体 -> 直到接近触地交还。
- 过场期间 HUD 画**上下黑边** + "CINEMATIC" 小字(\`HudState.cinematic\` -> \`Hud.tsx\` 渲染),
  字幕照常显示。

**实测**(产物内探针): 进关 3.5 秒后 \`cine.kind = 'intro'\`、\`cineLetterbox = true\`;
相机到主舰的距离随时间从 ~17.9km 收敛到 **3.5km**(掠过/环绕段), 镜头确实在动、不是原地。
(坠落运镜走的是同一套控制器, 未单独跑长流程验证 —— 触发点在 \`startBossFall()\` 之后 1.8 秒。)

### 242.2 过场台词占位槽

\`radio.ts\` 新增 **10 个占位事件**(开场 6 + 坠落 4, id \`story_s01_cine_intro_01..06\` / \`story_s01_cine_crash_01..04\`),
文本写成 \`［过场台词位·开场 01］待填写\`(英文 \`[CINEMATIC SLOT · INTRO 01] TO BE WRITTEN\`), 语音没有 mp3 =>
运行时只显示字幕。导出 \`S01_CINEMATIC: Record<'intro'|'crash', RadioEvent[]>\`, 由过场控制器按整组顺序播。
**要填内容不用改代码**: 改 \`LINES\` 里对应条目的 \`text\`/\`en\` 就行, 想配音再把
\`/audio/radio/<id>-0.mp3\` 放进去即可。

### 验收

| 检查项 | 结果 |
| --- | --- |
| 开场运镜 | 进关 2.5s 触发, 17 秒四段镜头(环绕 -> 掠过 -> 环绕轻型舰 -> 交还) |
| 相机确实被接管 | 实测 \`cine.kind='intro'\` / \`letterbox=true\` / 相机到主舰距离 17.9km -> 3.5km |
| 坠落运镜 | \`startBossFall()\` 后 1.8 秒触发, 14 秒跟拍 |
| 黑边 | \`hud.cinematic\` -> Hud.tsx 上下黑边 + CINEMATIC 标识 |
| 台词槽 | 10 个占位事件(开场 6 + 坠落 4)+ \`S01_CINEMATIC\` 导出, 改文本即可填 |
`;

const entryWl = `
## 2026-09-19 第 242 轮: 关卡内实时过场运镜(开场/坠落) + 过场台词占位槽

- **做法**: 不改相机模块 —— 过场控制器在相机更新**之后**覆盖 position/quaternion/fov, 播完自动交还。
  镜头表按 elapsed 分段、段间 lerp/slerp 平滑。
- **开场运镜**(进关 2.5s 起, 17 秒): 远景环绕主舰看体量 -> 贴着舰体由艉向艏掠过 ->
  环绕主舰周围最近的轻型空中战舰 -> 拉回玩家身后交还。
- **坠落运镜**(主舰开始坠落 1.8s 起, 14 秒): 侧后远景跟拍下坠 -> 拉近仰视舰体 -> 接近触地交还。
- **黑边**: 新增 \`HudState.cinematic\`, Hud.tsx 画上下黑边 + CINEMATIC 小字, 字幕照常。
- **过场台词占位槽**: radio.ts 新增 10 个占位事件(开场 6 + 坠落 4, 文本"［过场台词位·…］待填写"),
  导出 \`S01_CINEMATIC\`, 由过场控制器整组顺序播。填内容只改 text/en(想配音再加 mp3), 不用改代码。
- 实测: 进关 3.5s 后 \`cine.kind='intro'\` / \`letterbox=true\`; 相机到主舰距离 17.9km -> 3.5km(镜头在动)。
  坠落运镜同一套控制器, 未跑完整长流程单独验证。
`;

const entryH = `
### §242 关卡内实时过场运镜(开场 / 坠落) + 过场台词占位槽

用户: "加上关卡内剧情的实时过场动画, 刚进关卡先运镜展示敌方 boss 和它周围的轻型空中战舰, 然后预留过场动画台词位,
然后在打完最后一阶段时空中战舰坠落时也给个运镜"。

**做法**: **不改相机模块** —— 相机照旧由 CameraRig 更新, 新增的过场控制器在**同一帧稍后**覆盖
position/quaternion/fov(段间 lerp/slerp, 不硬切), 播完或目标消失就自动交还, 于是追尾视角的逻辑不受影响。
镜头由"镜头表"(每段: 时长 + 目标 + 环绕参数)驱动。

**开场运镜** \`startIntroCutscene()\`(进关 2.5 秒后触发, 全长 17 秒): ① 远景环绕主舰
(半径 1.5 倍半长、视高 1.6 倍半高, fov 48)展示体量 -> ② 贴着舰体由艉向艏掠过(fov 60) ->
③ 环绕主舰周围**最近的轻型空中战舰**(半径 900、高 320) -> ④ 拉回玩家身后一帧后交还。
**坠落运镜** \`startCrashCutscene()\`(主舰开始坠落 1.8 秒后触发, 14 秒): 侧后远景跟拍下坠(前 8 秒)
-> 拉近仰视舰体 -> 接近触地交还。过场期间 HUD 画**上下黑边** + "CINEMATIC" 小字(新增 \`HudState.cinematic\`,
由 \`Hud.tsx\` 渲染), 字幕照常显示。

**过场台词占位槽**: \`radio.ts\` 新增 **10 个占位事件**(开场 6 + 坠落 4, id \`story_s01_cine_intro_01..06\` /
\`story_s01_cine_crash_01..04\`), 文本是 \`［过场台词位·开场 01］待填写\`(英文 \`[CINEMATIC SLOT · INTRO 01] TO BE WRITTEN\`),
语音无 mp3 => 运行时只显示字幕; 导出 \`S01_CINEMATIC: Record<'intro'|'crash', RadioEvent[]>\` 由过场控制器整组顺序播。
**填内容不用改代码**: 改 \`LINES\` 里对应条目的 \`text\`/\`en\`, 想配音再把 \`/audio/radio/<id>-0.mp3\` 放进去即可。

**实测**(产物内探针): 进关 3.5 秒后 \`cine.kind = 'intro'\`、\`cineLetterbox = true\`; 相机到主舰的距离随时间
从 ~17.9km 收敛到 **3.5km**(掠过/环绕段)—— 镜头确实在动。坠落运镜走同一套控制器, 触发点在
\`startBossFall()\` 之后 1.8 秒, 本轮未单独跑完整长流程验证。
`;
fs.writeFileSync('.shots/_sec242_dev.md', secDev.split('\n').join('\r\n'), 'utf8');
fs.writeFileSync('.shots/_sec242_wl.md', entryWl, 'utf8');
fs.writeFileSync('.shots/_sec242_handoff.md', entryH, 'utf8');
console.log('§242 fragments written');
