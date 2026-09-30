// §249 文档片段(UTF-8)
const fs = require('fs');
const secDev = `

---

## 第 249 轮: 音乐/语音放回内联(上传网站后听不到声音的问题) + 单文件 85.3MB (2026-09-19)

用户: "上传到网站里运行时, 正式版第一关的音乐没有播放, 应该把音乐放进去的"。

### 249.1 原因与处理

上一轮(§248)为压体积把 \`music_white_bird\` / \`music_briefing\` / \`sfx_shuttle_rumble\` 与整个
\`/audio/radio/\` 都挪进了资产库 —— 只要网站**没有一起上传 \`assets/\` 目录**, 这些就只能静默取不到
(音乐不播、语音降级成纯字幕)。用户明确要求"音乐要放进去", 所以:
- \`music_white_bird.mp3\` / \`music_briefing.mp3\` / \`sfx_shuttle_rumble.mp3\` -> **改回 inline: true**;
- \`/audio/radio/\`(475 个剧情语音)也一并改回 **inline: true**(同一次部署里它们同样取不到);
- 两首剧情曲顺手用 ffmpeg 重编码到 **128kbps**(white_bird 9.3MB -> 4.5MB, briefing 5.5MB -> 2.8MB,
  原件备份在 \`.shots/audio-orig/\`)—— 这也是构建本来就该做的压缩档位, 音质足够而体积省一半。

### 249.2 为了守住 100MB, 这轮把历史 4K 天空盒也挪出去了

加上音乐与语音后单文件一度到 **100.5MB**(超了 0.5MB)。于是把**历史** 4K 天空盒
\`/textures/sky/evening.exr\`(11.9MB -> 内联约 16MB)改成只随行不内联 —— 它是内联资产里最大的一块。

**最终**: \`dist-single/index.html\` = **85.3MB**(内联 628 个文件 / 62.1MB raw),
随行资产库 6 个文件(两套天空盒 + 第一关 FBX 等)。

### 249.3 现在的取舍地图(重要)

| 内容 | 位置 | 只上传 index.html 时 |
| --- | --- | --- |
| 剧情音乐(White Bird / 简报曲 / 加力轰鸣) | **内联** | 正常播放 |
| 剧情语音(475 条, 敌我双方 + 过场槽) | **内联** | 正常播放 |
| 第一关天空盒 \`evening-046b.exr\` | 随行 | 回落程序化天空 |
| 历史天空盒 \`evening.exr\`(m13/t00 用) | 随行 | 回落程序化天空 |
| F-16C 机体 + 涂装 / 主舰 obj 等 | 内联 | 正常 |
| 4 首未被引用的历史曲子 | 随行 | 无所谓(没有关卡引用) |

也就是说: **"声音/机体"这类会被立刻察觉的东西现在都在单文件里**; 只剩"天空盒"这一项需要 \`assets/\`。
如果希望第一关的天空盒也进单文件, 单文件会到约 104MB(超 4MB), 那就得再往外挪一块同等大小的东西
(例如 F-16C 的贴图包)。要么就照部署提示把 \`index.html + assets/\` 一起上传(推荐, 也是发布流程本来的要求)。
`;

const entryWl = `
## 2026-09-19 第 249 轮: 音乐/语音放回内联 + 单文件 85.3MB

- **问题**: 上一轮(§248)为压体积把剧情音乐与整个 \`/audio/radio/\` 挪进了资产库 —— 网站若**没一起上传
  \`assets/\` 目录**, 音乐就不播、语音降级为纯字幕。用户要求"音乐要放进去"。
- **处理**: \`music_white_bird\` / \`music_briefing\` / \`sfx_shuttle_rumble\` 与 \`/audio/radio/\`(475 条语音)
  全部改回 **inline: true**; 两首剧情曲顺手用 ffmpeg 重编码到 **128kbps**
  (white_bird 9.3 -> 4.5MB, briefing 5.5 -> 2.8MB; 原件备份 \`.shots/audio-orig/\`)。
- **为守住 100MB**: 把**历史** 4K 天空盒 \`evening.exr\`(内联约 16MB)改成只随行不内联。
- **最终**: \`dist-single/index.html\` = **85.3MB**(内联 628 文件 / 62.1MB raw), 随行 6 个文件。
- **取舍地图**: 单文件里现在有"会被立刻察觉的"声音与机体; 只剩天空盒两项需要 \`assets/\`。
  若要把第一关天空盒也塞进单文件 => 约 104MB(超 4MB), 就得再往外挪一块同等大小的资产。
`;

const entryH = `
### §249 音乐/语音放回内联(网站听不到声音) + 单文件 85.3MB

用户: "上传到网站里运行时, 正式版第一关的音乐没有播放, 应该把音乐放进去的"。

**原因**: 上一轮(§248)为压体积把 \`music_white_bird\` / \`music_briefing\` / \`sfx_shuttle_rumble\` 与整个
\`/audio/radio/\` 都挪进了资产库 —— 只要网站**没有一起上传 \`assets/\` 目录**, 这些运行时都取不到
(音乐静默、语音降级成纯字幕)。

**处理**(用户要求"音乐要放进去"):
- \`music_white_bird.mp3\` / \`music_briefing.mp3\` / \`sfx_shuttle_rumble.mp3\` -> 改回 \`inline: true\`;
- \`/audio/radio/\`(**475 条剧情语音**)也一并改回内联(同一次部署里它们同样取不到);
- 两首剧情曲顺手重编码到 **128kbps**(white_bird 9.3 -> 4.5MB, briefing 5.5 -> 2.8MB;
  原件备份在 \`.shots/audio-orig/\`)—— 这正是构建本来的压缩档位, 音质够用而体积省一半。

**为守住 100MB**: 加上音乐与语音后单文件一度到 **100.5MB**(超 0.5MB), 于是把**历史** 4K 天空盒
\`/textures/sky/evening.exr\`(11.9MB -> 内联约 16MB, 内联资产里最大的一块)改成只随行不内联。

**最终**: \`dist-single/index.html\` = **85.3MB**(内联 628 个文件 / 62.1MB raw), 随行资产库 6 个文件
(两套天空盒 + 第一关的主舰 FBX 等)。

**现在的取舍地图**: 单文件里已经有"会被立刻察觉的"东西 —— 剧情音乐、475 条剧情语音、F-16C 机体与涂装、
主舰模型; 只剩**天空盒**两项在 \`assets/\`: 第一关的 \`evening-046b.exr\` 与 m13/t00 用的历史 \`evening.exr\`
(只上传 index.html 时这两关回落程序化天空, 其它一切正常)。
若要把第一关天空盒也塞进单文件 => 单文件约 **104MB**(超 4MB), 那就得再往外挪一块同等大小的资产(例如 F-16C 贴图包);
推荐做法仍是照部署提示把 \`index.html + assets/\` 一起上传。
`;
fs.writeFileSync('.shots/_sec249_dev.md', secDev.split('\n').join('\r\n'), 'utf8');
fs.writeFileSync('.shots/_sec249_wl.md', entryWl, 'utf8');
fs.writeFileSync('.shots/_sec249_handoff.md', entryH, 'utf8');
console.log('§249 fragments written');
