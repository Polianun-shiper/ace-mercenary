// §240 文档片段(UTF-8)
const fs = require('fs');
const secDev = `

---

## 第 240 轮: 我方(盟友)剧情台词上线 —— 119 句 + 触发接线 (2026-09-19)

用户: "怎么第一关只有敌人的剧情台词, 我们队友的剧情台词还没搞, 这个也是一样放入游戏内并给语音留下占位符" + 全部台词。

### 240.1 台词数据

\`radio.ts\` 新增 **119 个事件**(id \`story_s01_ally_<block>_<nn>\`), 一句一个事件, 与敌方那套完全同构:
\`side: 'ally'\`; \`voiceSpeaker\` 按角色分档(指挥/管制 基石·穹顶·竖琴·哨兵 = \`ally1\`, 机组呼号
游隼·山雀·夜枭·长弓1·铁锤1·盾牌1 = \`ally2\`); \`text\` 中文逐字, \`en\`/\`voice\` 为英文翻译。
新增导出 **\`S01_ALLY_BLOCKS\`**(20 组, 与用户给的段落一一对应):
s0_open(11) · s1_open(10) · s1_first(5) · s1_half(6) · s1_last(5) · s2_open(9) · s2_half(6) · s2_last(5) ·
s3_open(10) · s3_charge(4) · s3_laser1(3) · s3_anvil1(4) · s3_anvil2(3) · s3_lasers_clear(5) ·
s4_open(9) · s4_core1(4) · s4_core2(3) · s4_core3(3) · s4_core4(8) · s5_fall(6)。
占位清单追加到 \`download/radio_lines_s01_placeholders.md\`(新增"我方/盟友台词"一节, 明确标注语音仍是占位符:
没有 mp3, 运行时 radio 自动降级为"只显示字幕")。

### 240.2 触发接线(engine.ts)

与敌方那套并排, 新增两个入口 \`playS01AllyBlock(整组按顺序)\` / \`playS01AllyNext(逐句取下一句)\`,
并接到这些时机上:
- **开场**: 敌方 s0 那组播完之后 14 秒起播 \`s0_open\`(错开, 免得两句抢话筒);
- **阶段切换**: 进入阶段 n 时(延迟 2.6 秒, 且校验还在该阶段)播 \`s1_open\`/\`s2_open\`/\`s3_open\`/\`s4_open\`;
- **战果推进**: 本阶段**首杀**(\`s1_first\`)、**过半**(\`s1_half\`/\`s2_half\`)、**最后一个**(\`s1_last\`/\`s2_last\`);
  阶段 3 另有 **第一门激光被毁**(\`s3_laser1\`)与 **4 门激光全清**(\`s3_lasers_clear\`);
  阶段 4 按**核心模块摧毁数**播 \`s4_core1..4\`;
- **激光充能**: 阶段 3 里第一门激光开始充能时播 \`s3_charge\`(之后 25 秒最多再提醒一次);
- **轻型舰坠毁**: 第 1 艘 / 第 2 艘 → \`s3_anvil1\` / \`s3_anvil2\`;
- **坠落**: 主舰开始坠落时播敌方的 \`s5_fall\`(原有), 12 秒后接我方的 \`s5_fall\`。
所有"只播一次"的段落都用 \`bossAllyFlags\` 去重, 充能提醒有 \`bossChargeCallT\` 节流。

实测(产物内, 探针记录 \`radio.trigger\` 调用): 进入阶段 1 后我方 \`s1_open\` 的 10 句按顺序开始播;
打掉第 1 个挂点 → \`ally_s1_first\`(块内索引 1); 打掉 8 个 → \`ally_s1_half\`(索引 1);
同一时间敌方 \`s1_mount\` 等也在推进 —— 敌我两条线并行、互不干扰(radio 一次只播一句, 按队列排)。

### 验收

| 检查项 | 结果 |
| --- | --- |
| 台词数据 | 119 事件 / 20 组, 中文逐字 + 英文翻译, 与敌方同构 |
| 触发 | 开场 / 阶段 / 首杀 / 过半 / 收尾 / 激光 / 核心 / 轻型舰 / 坠落 全部接上 |
| 实测 | 阶段 1 播 \`s1_open\` 全组; 首杀 → \`s1_first\`; 过半 → \`s1_half\`; 敌方线同时推进 |
| 语音 | 占位符(无 mp3 => 只显示字幕), 清单已追加 |
`;

const entryWl = `
## 2026-09-19 第 240 轮: 我方(盟友)剧情台词 119 句 + 触发接线

- **台词数据**: radio.ts 新增 119 事件(一句一个事件, id \`story_s01_ally_<block>_<nn>\`), \`side: 'ally'\`,
  \`voiceSpeaker\` 分档(基石/穹顶/竖琴/哨兵 = ally1; 游隼/山雀/夜枭/长弓1/铁锤1/盾牌1 = ally2),
  中文逐字 + 英文翻译; 新增导出 \`S01_ALLY_BLOCKS\`(20 组: s0_open / s1_open / s1_first / s1_half / s1_last /
  s2_open / s2_half / s2_last / s3_open / s3_charge / s3_laser1 / s3_anvil1 / s3_anvil2 / s3_lasers_clear /
  s4_open / s4_core1..4 / s5_fall)。占位清单追加到 download/radio_lines_s01_placeholders.md
  (明确语音仍是占位符: 无 mp3, 运行时降级为纯字幕)。
- **触发接线**: 新增 \`playS01AllyBlock\`/\`playS01AllyNext\`, 接到: 开场(敌方那组后 14 秒) / 阶段切换
  (1/2/3/4 各一组) / 首杀 / 过半 / 收尾 / 激光被毁与全清 / 核心模块逐个 / 激光充能(25 秒节流) /
  轻型舰 1·2 艘坠落 / 坠落(敌方后 12 秒)。"只播一次"用 \`bossAllyFlags\` 去重。
- 实测: 进入阶段 1 我方 \`s1_open\` 10 句按顺序起播; 打掉第 1 个挂点 -> \`ally_s1_first\`; 8 个 -> \`ally_s1_half\`;
  敌方线同时推进 —— 敌我并行、radio 单句队列不冲突。
`;

const entryH = `
### §240 我方(盟友)剧情台词上线(119 句) + 触发接线

用户: "怎么第一关只有敌人的剧情台词, 我们队友的剧情台词还没搞, 这个也是一样放入游戏内并给语音留下占位符"
(附全部台词: 基石/游隼/山雀/夜枭/长弓1/铁锤1/盾牌1/竖琴/哨兵/穹顶 等)。

**台词数据**: \`radio.ts\` 新增 **119 个事件**(id \`story_s01_ally_<block>_<nn>\`, 一句一个事件), 与敌方那套完全同构:
\`side: 'ally'\`; \`voiceSpeaker\` 分两档(指挥/管制 基石·穹顶·竖琴·哨兵 = \`ally1\`, 机组呼号
游隼·山雀·夜枭·长弓1·铁锤1·盾牌1 = \`ally2\`); \`text\` 中文逐字 + \`en\`/\`voice\` 英文翻译。
新增导出 **\`S01_ALLY_BLOCKS\`**(20 组, 与用户段落一一对应): s0_open(11) · s1_open(10) · s1_first(5) · s1_half(6) ·
s1_last(5) · s2_open(9) · s2_half(6) · s2_last(5) · s3_open(10) · s3_charge(4) · s3_laser1(3) · s3_anvil1(4) ·
s3_anvil2(3) · s3_lasers_clear(5) · s4_open(9) · s4_core1(4) · s4_core2(3) · s4_core3(3) · s4_core4(8) · s5_fall(6)。
占位清单追加到 \`download/radio_lines_s01_placeholders.md\`(新增"我方/盟友"一节, 标注语音仍是**占位符**:
无 mp3, 运行时 radio 自动降级成"只显示字幕" —— 与用户"给语音留下占位符"一致)。

**触发接线**(engine.ts, 与敌方那套并排): 新增 \`playS01AllyBlock(整组按顺序)\` / \`playS01AllyNext(逐句)\`,
接到: ① **开场** —— 敌方 s0 那组播完后 14 秒起播 \`s0_open\`; ② **阶段切换** —— 进入阶段 n 时(延迟 2.6s 并校验仍在
该阶段)播 \`s1_open\`/\`s2_open\`/\`s3_open\`/\`s4_open\`; ③ **战果推进** —— 本阶段首杀(\`s1_first\`)、过半
(\`s1_half\`/\`s2_half\`)、最后一个(\`s1_last\`/\`s2_last\`), 阶段 3 另有第一门激光被毁(\`s3_laser1\`)与 4 门全清
(\`s3_lasers_clear\`), 阶段 4 按核心模块摧毁数播 \`s4_core1..4\`; ④ **激光充能** —— 阶段 3 首次充能时说 \`s3_charge\`
(之后 25 秒最多再提醒一次, \`bossChargeCallT\` 节流); ⑤ **轻型舰坠毁** —— 第 1/2 艘 → \`s3_anvil1\`/\`s3_anvil2\`;
⑥ **坠落** —— 原有敌方 \`s5_fall\` 之后 12 秒接我方 \`s5_fall\`。所有"只播一次"段落用 \`bossAllyFlags\` 去重。

**实测**(产物内探针记录 \`radio.trigger\`): 进入阶段 1 后我方 \`s1_open\` 十句按顺序起播; 打掉第 1 个挂点 →
\`ally_s1_first\`(块内索引 1); 打掉 8 个 → \`ally_s1_half\`(索引 1); 同时敌方 \`s1_mount\` 等也在推进 ——
敌我两条线并行, radio 一次只播一句、按队列排, 不会互相覆盖。
`;
fs.writeFileSync('.shots/_sec240_dev.md', secDev.split('\n').join('\r\n'), 'utf8');
fs.writeFileSync('.shots/_sec240_wl.md', entryWl, 'utf8');
fs.writeFileSync('.shots/_sec240_handoff.md', entryH, 'utf8');
console.log('§240 fragments written');
