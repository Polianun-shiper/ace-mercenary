// §243 文档片段(UTF-8)
const fs = require('fs');
const secDev = `

---

## 第 243 轮: 友军战舰环绕半径进射程 / MiG-29 尾焰缩小 / 过场改用独立相机 (2026-09-19)

### 243.1 友军战舰"只绕不打"的根因: 环绕半径在射程之外

主舰近 10 公里长, 而我方轻型舰原来的环绕半径是按 \`collideR x 1.9\` 算的(6 公里以上),
挂点射程只有 5200 —— 炮口够不到目标, 于是看起来"围着转却不开火"。
两处修正:
- 轻型舰**挂点射程 5200 -> 9000**(巨舰就得配长手);
- 环绕半径改成受**自己射程**约束: \`clampOrbit(目标) = max(目标 collideR x 0.62 + 600, min(collideR x 1.25, 自己射程 x 0.72))\`
  —— 既不会切进舰体, 也一定落在射程内。
实测: 5 艘友军战舰的 \`orbitR = 3744\`(射程 9000), 当时与主舰的实际距离 2573~4336m, **全在射程内**。

### 243.2 MiG-29 的尾焰小两圈

它的喷口比 F-16 粗, 同一套自动测量出来的火焰偏大 —— 主玩家机若为 MiG-29, 给尾焰组整体乘 **0.6**
(\`playerAfterburner.scale.multiplyScalar(0.6)\`), 观感约"小两圈"。只影响该机型, 想再微调改这个系数。

### 243.3 过场改用**独立相机**(不再动玩家相机)

之前是"帧末覆盖玩家相机的位姿" —— 用户要求改成独立相机。现在:
- 新增 \`cineCamera\`(懒创建, 与玩家相机同 fov/aspect/near/far);
- \`activeCamera()\` 返回当前该用哪台(过场 = cineCamera, 其余 = 玩家追尾相机);
- **后处理 pass 也一起切**: \`_camPasses\` 在建合成器时收集所有 \`camera === 玩家相机\` 的 pass,
  过场开始时统一指向 cineCamera, 结束时切回 —— 否则主渲染仍走玩家相机, 运镜根本看不见。
- 触发点: \`startIntroCutscene()\` / \`startCrashCutscene()\` 里调 \`setCinematicCameras(true)\`,
  过场结束或目标消失时切回。
**踩坑**: 第一版把 \`setCinematicCameras(true)\` 放在创建 cineCamera **之前**(相机是懒创建的) ->
切过去的是 null, 探针实测 \`passCameras: ['player','player','player']\`、\`renderPassIsCine: false\`(运镜不可见);
抽出 \`ensureCineCamera()\` 并在切换前调用后, 实测 \`passCameras: ['cine','cine','cine']\`、
\`renderPassIsCine: true\`, 同时玩家相机仍在原地(\`playerCamDist 13\` / \`cineCamDist 13041\`)。

### 验收

| 检查项 | 结果 |
| --- | --- |
| 友军环绕 | \`orbitR 3744\` vs 射程 9000; 与主舰实际距离 2573~4336m, 全部在射程内 |
| 轻型舰射程 | 挂点 5200 -> 9000 |
| MiG-29 尾焰 | 整组 x0.6 |
| 过场相机 | 独立 \`cineCamera\`; \`passCameras\` 与主 RenderPass 全部切到它; 玩家相机不受影响 |
`;

const entryWl = `
## 2026-09-19 第 243 轮: 友军环绕进射程 / MiG-29 尾焰缩小 / 过场独立相机

- **友军"只绕不打"的根因**: 环绕半径按 \`collideR x 1.9\`(6km+)算, 而挂点射程只有 5200 => 够不到。
  修法: ① 轻型舰挂点射程 5200 -> **9000**; ② 环绕半径受自己射程约束
  (\`max(目标 collideR x 0.62 + 600, min(collideR x 1.25, 射程 x 0.72))\`)。
  实测 orbitR 3744、与主舰距离 2573~4336m, 全在射程内。
- **MiG-29 尾焰小两圈**: 主玩家机为 MiG-29 时给尾焰组 \`x0.6\`(只影响该机型)。
- **过场改用独立相机**: 新增 \`cineCamera\` + \`activeCamera()\` + \`_camPasses\`(收集引用玩家相机的后处理 pass),
  过场开始把 pass 相机统一指向 cineCamera、结束切回。踩坑: 第一版在创建相机**之前**切换 => 切了 null,
  探针实测三道 pass 仍指玩家相机、主 RenderPass 也没切(运镜看不见); 抽出 \`ensureCineCamera()\` 先建后切,
  实测 \`passCameras ['cine','cine','cine']\` / \`renderPassIsCine true\`, 玩家相机原地不动。
`;

const entryH = `
### §243 友军环绕半径进射程 / MiG-29 尾焰缩小 / 过场改用独立相机

**友军"只绕不打"的根因**: 主舰近 10 公里长, 而我方轻型舰的环绕半径按 \`collideR x 1.9\` 算(6km+),
挂点射程只有 5200 => 炮口够不到目标, 看起来"围着转却不开火"。两处修正:
① 轻型舰**挂点射程 5200 -> 9000**; ② 环绕半径改由**自己射程**约束 ——
\`clampOrbit(目标) = max(目标 collideR x 0.62 + 600, min(collideR x 1.25, 自己射程 x 0.72))\`
(既不切进舰体, 也一定落在射程内)。实测 5 艘友军战舰 \`orbitR = 3744\`(射程 9000), 与主舰实际距离
2573~4336m, **全部在射程内**。

**MiG-29 尾焰小两圈**: 它的喷口比 F-16 粗, 自动测量出来的火焰偏大 —— 主玩家机为 MiG-29 时给尾焰组整体乘
**0.6**(\`playerAfterburner.scale.multiplyScalar(0.6)\`), 只影响该机型。

**过场改用独立相机(不再动玩家相机)**: 之前是"帧末覆盖玩家相机位姿", 现在
① 新增 \`cineCamera\`(懒创建, 与玩家相机同 fov/aspect/near/far); ② \`activeCamera()\` 决定当前该用哪台
(过场 = cineCamera, 其余 = 玩家追尾相机); ③ **后处理 pass 一起切** —— 建合成器时收集所有
\`camera === 玩家相机\` 的 pass 存进 \`_camPasses\`, 过场开始统一指向 cineCamera、结束切回
(不切的话主渲染仍走玩家相机, 运镜根本看不见)。
**踩坑**: 第一版把切换放在创建 cineCamera **之前**(相机懒创建) => 切过去的是 null, 探针实测
\`passCameras: ['player','player','player']\`、\`renderPassIsCine: false\`; 抽出 \`ensureCineCamera()\` 先建后切,
实测 \`passCameras: ['cine','cine','cine']\`、\`renderPassIsCine: true\`, 而玩家相机原地不动
(\`playerCamDist 13\` / \`cineCamDist 13041\`)。
`;
fs.writeFileSync('.shots/_sec243_dev.md', secDev.split('\n').join('\r\n'), 'utf8');
fs.writeFileSync('.shots/_sec243_wl.md', entryWl, 'utf8');
fs.writeFileSync('.shots/_sec243_handoff.md', entryH, 'utf8');
console.log('§243 fragments written');
