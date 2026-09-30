// §248 文档片段(UTF-8)
const fs = require('fs');
const secDev = `

---

## 第 248 轮: 单文件瘦身到 100MB 以内(把大块资产挪进资产库) (2026-09-19)

用户: "这个单文件体积怎么优化啊, 只要是单体文件不大于 100mb 就行, 可以分散各种资产在资产库, 包括剧情语音"。

### 248.1 结果

\`dist-single/index.html\` **140.1MB -> 76.1MB**(内联资产 57.1MB raw -> 55.1MB raw / 73.5MB base64, 内联文件数 349 -> 152),
随行资产库 \`dist-single/assets/\` 变成 **503 个文件 / 98MB**。**单文件已稳稳低于 100MB**。

### 248.2 挪走了什么(以及为什么它们最适合被挪)

| 资产 | 原来 | 现在 | 说明 |
| --- | --- | --- | --- |
| \`/audio/radio/\`(剧情语音目录, 475 个 mp3) | 内联 | **资产库** | 用户点名可以放资产库; 运行时音频本身走 \`assetUrl()\` 解析, 所以**不必改一行代码** |
| \`music_alect/gaiuss/hangar/last_line.mp3\` | 内联 | **资产库** | 之前为"体积不再收着"恢复的历史曲目, **当前没有任何关卡引用**(23MB, 内联要 ~31MB base64), 是本次最大的一块 |
| \`music_white_bird / music_briefing / sfx_shuttle_rumble\` | 内联 | **资产库** | 第一关的音乐/音效 |
| \`textures/sky/evening-046b.exr\`(13.8MB) | 内联 | **资产库** | 第一关的天空盒 |

做法只有一处: 在 \`asset-library.json\` 里把这些条目改成 \`inline:false\`(仍保留 \`copy:true / external:true\`)。
构建脚本本来就会"登记为 inline:false 的资产即使出现在 ASSETS 清单里也不内联", 并且 \`copy:true\` 的前缀会被
收集进 \`<out>/assets/\` —— 于是**不用改构建脚本、不用改游戏代码**, 只改了一张清单。

### 248.3 代价(必须知道)

- **file:// 双击单文件的场景**: 外部资产在 file:// 下读不到(历史结论: fetch/XHR 都被同源策略挡), 所以双击时
  剧情语音、第一关的音乐、以及那张新天空盒会**取不到**(引擎各自优雅回落: 语音降级成纯字幕、音乐静音、
  天空回落到程序化)。http 部署(上传 index.html **+ assets/ 目录**)一切正常。
- 这正是用户这次给的取舍: "只要单体文件不大于 100mb 就行, 可以分散各种资产在资产库" —— 体积优先。
- 想回到"完全自包含"也很简单: 把对应条目的 \`inline\` 改回 \`true\` 重新构建(或用 \`--inline-library\` 一键全内联)。

### 248.4 还可以继续瘦的地方(备用)

- 4K 历史天空盒 \`/textures/sky/evening.exr\`(11.9MB -> 内联 ~16MB): 挪出去能再省一截, 但它是"双击也要有天空"的
  历史硬要求, 所以这次没动。
- F-16C 机体 + 30 余张贴图(内联大头): 同样是历史硬要求(双击要有真实涂装), 这次没动。
- 有需要就从上面这两块继续挪, 每挪一块都只是改一行清单。
`;

const entryWl = `
## 2026-09-19 第 248 轮: 单文件瘦身 140.1MB -> 76.1MB(大块资产挪进资产库)

- **结果**: \`dist-single/index.html\` **140.1MB -> 76.1MB**(内联 349 -> 152 个文件), 随行资产库
  \`dist-single/assets/\` = **503 个文件 / 98MB**。单文件已稳低于 100MB。
- **挪走了**: ① \`/audio/radio/\`(剧情语音, 475 个 mp3) ② 四首**未被任何关卡引用**的历史曲目
  (alect/gaiuss/hangar/last_line, 23MB, 内联要 ~31MB base64 —— 本次最大一块) ③ 第一关的
  white_bird/briefing/加力轰鸣 ④ 新天空盒 evening-046b.exr(13.8MB)。
- **做法只有一处**: \`asset-library.json\` 里把这些条目的 \`inline\` 改成 false(copy/external 保留)。
  构建脚本本来就会"inline:false 的资产不内联、copy:true 的拷进 assets/", 所以**不用改构建脚本、不用改游戏代码**。
  电台语音的取用本来就走 \`assetUrl()\`, 挪库后无需改代码。
- **代价**: file:// 双击时外部资产读不到 => 剧情语音降级为纯字幕、第一关音乐静音、新天空盒回落程序化天空;
  http 部署(带 assets/ 目录)一切正常。这正是用户给的取舍(体积优先)。
  想恢复自包含: 把对应条目的 inline 改回 true 重新构建, 或 \`--inline-library\` 全内联。
- **还能再瘦**: 历史 4K 天空盒(11.9MB)与 F-16C 机体+贴图 —— 都是"双击也要有天空/真实涂装"的历史硬要求, 本次未动。
`;

const entryH = `
### §248 单文件瘦身: 140.1MB -> 76.1MB(把大块资产挪进资产库)

用户: "这个单文件体积怎么优化啊, 只要是单体文件不大于 100mb 就行, 可以分散各种资产在资产库, 包括剧情语音"。

**结果**: \`dist-single/index.html\` **140.1MB -> 76.1MB**(内联文件数 349 -> 152, 内联 raw 57.1 -> 55.1MB),
随行资产库 \`dist-single/assets/\` 变成 **503 个文件 / 98MB** —— 单文件稳稳低于 100MB。

**挪走的四类**(按收益排序):
1. \`/audio/radio/\`(剧情语音目录, **475 个 mp3**) —— 用户点名可以放资产库; 电台语音的取用本来就走
   \`assetUrl()\`, 所以挪库**不用改一行代码**。
2. \`music_alect / music_gaiuss / music_hangar / music_last_line.mp3\` —— 之前为"体积不再收着"恢复的历史曲目,
   **当前没有任何关卡引用**, 23MB 原始大小(内联要 ~31MB base64), 是本次最大的一块。
3. \`music_white_bird / music_briefing / sfx_shuttle_rumble\` —— 第一关的音乐与加力轰鸣。
4. \`textures/sky/evening-046b.exr\`(13.8MB) —— 第一关的天空盒。

**做法只有一处**: 把这些条目在 \`asset-library.json\` 里的 \`inline\` 改成 \`false\`(保留 \`copy:true / external:true\`)。
构建脚本本来就会"登记为 inline:false 的资产即使出现在 ASSETS 清单里也不内联", 并把 \`copy:true\` 的前缀收集进
\`<out>/assets/\` —— 于是**既不用改构建脚本, 也不用改游戏代码**, 只改了一张清单。

**代价(必须知道)**: file:// 双击单文件时外部资产读不到(历史结论: fetch/XHR 都被同源策略挡), 所以双击场景下
剧情语音会**降级成纯字幕**、第一关音乐**静音**、新天空盒**回落到程序化天空**; http 部署(上传 index.html **+ assets/ 目录**)
则一切正常。这正是用户这次给的取舍 —— 体积优先。想恢复自包含: 把对应条目的 \`inline\` 改回 \`true\` 重新构建,
或用 \`--inline-library\` 一次性全内联。

**还能继续瘦的备选**(本次未动, 都是历史硬要求): 4K 历史天空盒 \`evening.exr\`(11.9MB -> 内联 ~16MB)与
F-16C 机体 + 30 余张贴图。"双击也要有天空 / 真实涂装"这条规则一旦放弃, 每挪一块都只是改一行清单。
`;
fs.writeFileSync('.shots/_sec248_dev.md', secDev.split('\n').join('\r\n'), 'utf8');
fs.writeFileSync('.shots/_sec248_wl.md', entryWl, 'utf8');
fs.writeFileSync('.shots/_sec248_handoff.md', entryH, 'utf8');
console.log('§248 fragments written');
