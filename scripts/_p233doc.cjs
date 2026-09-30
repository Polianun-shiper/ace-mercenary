// §233 文档片段(UTF-8): GBK 两份用 PowerShell 936 追加, 交接文件插在 §232 之前
// 注意: GBK 编不了 ◀(U+25C0) ▶(U+25B6) ⇒ ✓ ✗ ± ², 一律 ASCII。
const fs = require('fs');

const secDev = `

---

## 第 233 轮: 体积不再收着(把删掉的素材与音乐放回) + 机库飞机上移 + 关卡内改播 White Bird (2026-09-19)

用户: "先不管体积了, 之前因为体积没有做的都放进去, 包括各种素材及音乐; 然后把机库内的飞机往上移动一些;
然后关卡内就不播放通用音乐了(vitzone), 直接用之前导入的 whitebird 音乐"。

### 233.1 把"因为体积被删掉"的素材放回

- 查了一遍工作区: 真正因为瘦身被**从工作区删掉**的是 5 个音频 —— \`music_alect.mp3\`(5.6MB)、
  \`music_gaiuss.mp3\`(6.9MB)、\`music_hangar.mp3\`(3.9MB)、\`music_last_line.mp3\`(7.2MB)、
  \`sfx_missile_launch.mp3\`(39 字节 —— 它本来就是个占位空文件)。它们都还在 git HEAD 里, 这一轮全部
  \`git checkout\` 恢复回 \`public/audio/\`, 并把 4 首曲子登记进 \`scripts/audio-assets.mjs\` 的 \`MUSIC_FILES\`
  (于是构建会内联 + 压缩) —— 也就是"放进去"。
- 主舰的原始 FBX(39.8MB)也恢复成随行上传(\`copy:true\`): 它现在是运行时的**第二兜底**(主路径是
  可内联的 \`bastion.obj.gz\` + \`bastion_albedo.jpg\`), 体积不再收着就一起发。
- 顺手确认了另外两条构建自检警告(\`/models/MiG-29\`、\`/textures/veg/\`)只是"目录级条目没有逐个列进 ASSETS"
  的写法问题: 实际产物里 MiG-29 机体与 mig29 贴图(30 处)、veg 贴图(6 处)都已经在清单/数据里 —— 不是漏发。
- 单文件体积会明显变大(4 首曲子约 23MB 直接进 base64), 这是用户明确接受的取舍。

### 233.2 关卡内改播 White Bird

\`music.ts\` 的 \`COMBAT_TRACKS\` 从 VITOZE 换成 **White Bird** —— 于是**所有关卡**的战斗音乐都是 White Bird,
VITOZE 不再被关卡引用(文件仍留着, 主菜单/其它相位想用随时挂回)。上一轮加的 \`useStoryCombat\` 仍然有效
(剧情关本来就固定 White Bird, 现在等于是全局统一), 不需要再区分。

### 233.3 机库飞机上移

\`hangar.ts\` 新增 \`HANGAR_LIFT = 9\`(米), 三处"机体落位"(\`group.position.y\`)都改用它。起因是上一轮把预览
放大 2 倍之后, 原来"坐在甲板上"的高度显得太贴地 —— 抬起来一点让机腹/起落架更好看, 观感上约等于把人抬到胸口。
实测截图: 机体明显悬在甲板上方, 机库场景(照明/划线/货箱/锥桶/工作台)未被影响。

### 233.4 验收

| 检查项 | 结果 |
| --- | --- |
| 恢复的音频 | 4 首曲子 + 1 个 SFX 回到 public/audio, 曲子已进内联清单 |
| 战斗音乐 | \`COMBAT_TRACKS = [music_white_bird.mp3]\`(VITOZE 不再被引用) |
| 主舰 FBX | 恢复 \`copy:true\`(随行上传, 作为第二兜底) |
| 机库上移 | \`HANGAR_LIFT = 9\`, 三处落位统一, 截图 \`.shots/hangar-lift.png\` |
| 单文件体积 | 明显上涨(4 首曲子约 23MB) —— 用户已明确"先不管体积" |

截图: \`.shots/hangar-lift.png\`(飞机悬在甲板上方, 2 倍大小)。
`;

const entryWl = `
## 2026-09-19 第 233 轮: 体积不再收着 + 机库飞机上移 + 关卡内改播 White Bird

- **把为体积删掉的素材放回**: 工作区里真被删的是 5 个音频(alect/gaiuss/hangar/last_line 四首曲子 +
  sfx_missile_launch), 全在 git HEAD 里, 已 \`git checkout\` 恢复, 四首曲子登记进 audio-assets 内联清单。
  主舰原始 FBX(39.8MB)也恢复随行(copy:true, 作为运行时的第二兜底; 主路径仍是可内联的 obj.gz + jpg)。
  另两条构建自检警告(MiG-29 / veg)确认只是"目录级条目不逐个列 ASSETS"的写法问题, 产物里都在。
- **关卡内改播 White Bird**: \`COMBAT_TRACKS\` 由 VITOZE 换成 White Bird => 所有关卡统一播它, VITOZE 不再被引用。
- **机库飞机上移**: \`hangar.ts\` 新增 \`HANGAR_LIFT = 9\`(米), 三处机体落位统一使用(起因: 预览放大 2 倍后
  原来"坐甲板"的高度太贴地)。截图 \`.shots/hangar-lift.png\`。
- 体积换内容, 用户已明确接受(单文件因 4 首曲子涨约 23MB 级别的 base64)。
`;

const entryH = `
### §233 体积不再收着(素材与音乐放回) + 机库飞机上移 + 关卡内改播 White Bird

用户: "先不管体积了, 之前因为体积没有做的都放进去, 包括各种素材及音乐; 然后把机库内的飞机往上移动一些;
然后关卡内就不播放通用音乐了(vitzone), 直接用之前导入的 whitebird 音乐"。

**放回被删的素材**: 核对工作区后发现真正为体积删掉的是 5 个音频 —— \`music_alect/gaiuss/hangar/last_line.mp3\`
(5.6/6.9/3.9/7.2MB)与 \`sfx_missile_launch.mp3\`(39 字节, 本来就是占位空文件); 它们都还在 git HEAD 里,
已全部 \`git checkout\` 恢复到 \`public/audio/\`, 并把 4 首曲子登记进 \`scripts/audio-assets.mjs\` 的 \`MUSIC_FILES\`
(构建内联 + 压缩)。主舰原始 FBX(39.8MB)也恢复 \`copy:true\` 随行 —— 它是运行时的第二兜底(主路径是可内联的
\`bastion.obj.gz\` + \`bastion_albedo.jpg\`)。另外两条构建自检警告(\`/models/MiG-29\`、\`/textures/veg/\`)核对下来
只是"目录级条目没有逐个列进 ASSETS"的写法问题: 产物里 MiG-29 机体/贴图(30 处)与 veg 贴图(6 处)都在清单里, 不是漏发。
代价: 单文件因 4 首曲子直接涨约 23MB 级别的 base64 —— 用户已明确"先不管体积"。

**关卡内改播 White Bird**: \`music.ts\` 的 \`COMBAT_TRACKS\` 由 VITOZE 换成 **White Bird**, 于是所有关卡的战斗音乐
都统一成 White Bird, VITOZE 不再被关卡引用(文件保留)。上一轮加的 \`useStoryCombat()\` 仍有效(剧情关本来就固定
White Bird, 现在等于全局统一)。

**机库飞机上移**: \`hangar.ts\` 新增 \`HANGAR_LIFT = 9\`(米), 三处机体落位(\`group.position.y\`)统一改用它 ——
上一轮把预览放大 2 倍后, 原来"坐在甲板上"的高度显得太贴地, 抬起来让机腹/起落架更好看。截图 \`.shots/hangar-lift.png\`
显示机体明显悬在甲板上方, 机库场景(照明/划线/货箱/锥桶/工作台)不受影响。
`;

fs.writeFileSync('.shots/_sec233_dev.md', secDev.split('\n').join('\r\n'), 'utf8');
fs.writeFileSync('.shots/_sec233_wl.md', entryWl, 'utf8');
fs.writeFileSync('.shots/_sec233_handoff.md', entryH, 'utf8');
console.log('§233 fragments written');
