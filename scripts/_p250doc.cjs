// §250 文档片段(UTF-8)
const fs = require('fs');
const secDev = `

---

## 第 250 轮: 剧情语音不内联(单文件 71.1MB) + Tab 只在雷达圈内切换 (2026-09-19)

### 250.1 剧情语音不内联

按用户要求把 \`/audio/radio/\`(475 条剧情语音)改回 \`inline: false\`(仍 \`copy: true\` 随行)。
音乐(White Bird / 简报曲 / 加力轰鸣)保持内联 —— 也就是"**音乐进单文件、语音走资产库**"。
单文件: 85.3MB -> **71.1MB**(内联 154 个文件 / 51.4MB raw)。
代价(与上轮一致, 只是范围缩小到语音): 只上传 index.html 时剧情语音降级为**纯字幕**, 音乐与机体不受影响;
把 \`index.html + assets/\` 一起传则语音正常。

### 250.2 Tab 切换目标: 强制"只在雷达圈内 + 射程内"的敌人之间切

之前是"圈内优先、圈外垫底"(圈外仍能被翻到); 用户要求**强制只在圈内**:
"切换只会选择他们而不会留机会给雷达圈外的"。
- 判定 \`inRadarRing(e)\` = 距离 <= 当前武器锁定距离(\`weaponLockRange()\`) **且**
  落在机头前约 45 度锥内(\`dot(playerForward) >= 0.7\`, 与 \`updateLock\` 同源);
- \`nextTargetInCycle()\` 在目标列表上**先 filter 再轮转** —— 圈外的目标不参与轮转;
- 圈内一个都没有 => 返回 null => **Tab 不切换**(保持当前锁定), 并提示"雷达圈内无目标"
  (免得玩家以为按键失灵);
- \`computeNextTargetId()\`(雷达上的 NE 提示)复用同一个函数, 所以提示与实际切换结果永远一致。

**实测**(探针): 把所有敌机摆到玩家**正后方 6km**(圈外)后连按 10 次 Tab => **切换 0 次**;
再把一架摆到机头前 1.5km(圈内) => 按一次就切到它(\`switchedToInRing: true\`)。

### 验收

| 检查项 | 结果 |
| --- | --- |
| 单文件体积 | 85.3 -> **71.1MB**(语音不内联; 音乐仍内联) |
| 圈外切换 | 圈外 10 次 Tab => 切换 0 次 |
| 圈内切换 | 圈内 1 架 => 一次切到 |
| 空圈提示 | 提示"雷达圈内无目标" |
`;

const entryWl = `
## 2026-09-19 第 250 轮: 剧情语音不内联(单文件 71.1MB) + Tab 只在雷达圈内切换

- **语音不内联**: \`/audio/radio/\`(475 条)改回 \`inline:false\`(仍随行); 音乐保持内联
  => 单文件 85.3 -> **71.1MB**(内联 154 文件 / 51.4MB raw)。代价: 只传 index.html 时语音降级为纯字幕,
  音乐与机体不受影响; 带 assets/ 部署语音正常。
- **Tab 强制只在雷达圈内切换**: 新增 \`inRadarRing(e)\`(距离 <= 当前武器锁定距离 且 落在机头前约 45 度锥,
  与 updateLock 的 0.7 cos 同源), \`nextTargetInCycle()\` **先 filter 再轮转**; 圈内为空 => Tab 不切换 +
  提示"雷达圈内无目标"; NE 提示复用同一函数所以永远一致。
  实测: 敌人全在圈外(正后方 6km)连按 10 次 => 切换 0 次; 圈内放一架 => 一次切到。
`;

const entryH = `
### §250 剧情语音不内联(单文件 71.1MB) + Tab 只在雷达圈内切换

**剧情语音不内联**: 按用户要求把 \`/audio/radio/\`(475 条)改回 \`inline: false\`(仍 \`copy: true\` 随行),
音乐(White Bird / 简报曲 / 加力轰鸣)**保持内联** —— 即"音乐进单文件、语音走资产库"。
单文件 85.3MB -> **71.1MB**(内联 154 个文件 / 51.4MB raw)。代价: 只上传 index.html 时剧情语音降级为
**纯字幕**(音乐与机体不受影响); \`index.html + assets/\` 一起传则语音正常。

**Tab 切换目标改成强制"只在雷达圈内 + 射程内"**: 之前是"圈内优先、圈外垫底"(圈外仍能被翻到),
用户要求"切换只会选择他们而不会留机会给雷达圈外的"。实现:
- \`inRadarRing(e)\` = 距离 <= 当前武器锁定距离(\`weaponLockRange()\`) **且** 落在机头前约 45 度锥内
  (\`dot(playerForward) >= 0.7\`, 与 \`updateLock\` 同一判据);
- \`nextTargetInCycle()\` 对目标列表**先 filter 再轮转** —— 圈外目标不参与;
- 圈内一个都没有 => 返回 null => **Tab 不切换**(保持当前锁定), 并提示"雷达圈内无目标"(免得以为按键失灵);
- \`computeNextTargetId()\`(雷达上的 NE 提示)复用同一个函数, 提示与实际切换永远一致。

**实测**(探针): 把所有敌机摆到玩家正后方 6km(圈外)后连按 10 次 Tab => **切换 0 次**;
再把一架摆到机头前 1.5km(圈内) => 按一次即切到它(\`switchedToInRing: true\`)。
`;
fs.writeFileSync('.shots/_sec250_dev.md', secDev.split('\n').join('\r\n'), 'utf8');
fs.writeFileSync('.shots/_sec250_wl.md', entryWl, 'utf8');
fs.writeFileSync('.shots/_sec250_handoff.md', entryH, 'utf8');
console.log('§250 fragments written');
