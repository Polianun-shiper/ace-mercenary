// §229b: radio.ts 追加"简报/结算"台词 + 界面用的取词接口
//  - 事件: story_s01_brief_01..06 / story_s01_debrief_01..04(中英 + 占位语音)
//  - 导出 S01_BRIEF / S01_DEBRIEF(按顺序) 与 storyLineInfo()(简报/结算界面渲染字幕用)
const fs = require('fs');
const p = 'src/lib/game/radio.ts';
let s = fs.readFileSync(p, 'utf8');
function rep(a, b, label) {
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  s = s.replace(a, b);
  console.log('ok:', label);
}

// ① 事件联合里加 10 个新事件
rep(`| 'story_s01_rand_control'`,
`| 'story_s01_rand_control'
  // === 正式版剧情第一关: 简报 / 结算台词 (per user request: 简报和结算都有台词, 语音是占位符) ===
  // 这两组不在关卡里播, 而是由菜单的 3D 简报界面 / 3D 结算界面按顺序显示(见 storyLineInfo)。
  | 'story_s01_brief_01' | 'story_s01_brief_02' | 'story_s01_brief_03'
  | 'story_s01_brief_04' | 'story_s01_brief_05' | 'story_s01_brief_06'
  | 'story_s01_debrief_01' | 'story_s01_debrief_02'
  | 'story_s01_debrief_03' | 'story_s01_debrief_04'`,
 'event union += brief/debrief');

// ② LINES 表里加对应台词(挂在随机池那条后面)
const randPool = s.indexOf("'story_s01_rand_control':");
if (randPool < 0) { console.error('rand pool anchor missing'); process.exit(1); }
// 找到该 key 对应数组的结尾 '],' (第一个出现的 ] 之后跟 ,)
const arrEnd = s.indexOf('],', randPool);
if (arrEnd < 0) { console.error('rand pool end missing'); process.exit(1); }
const insertAt = arrEnd + 2;
const BRIEF_BLOCK = `
  // === 正式版剧情第一关: 简报台词(6 句, 菜单 3D 简报界面按顺序显示) ===
  // 语音是占位符(用户要求本轮不生成配音): /audio/radio/story_s01_brief_0N-0.mp3 不存在时界面只显示字幕。
  'story_s01_brief_01': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '这里是预警机·鹰。简报开始。', en: 'This is AWACS Eagle. Briefing begins.', voice: 'This is AWACS Eagle. Briefing begins.' },
  ],
  'story_s01_brief_02': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '目标: 敌方空中战舰「堡垒」。长度一点三公里, 六个面挂满武器。', en: 'Target: the enemy air warship Bastion. Thirteen hundred meters long, weapons on all six faces.', voice: 'Target: the enemy air warship Bastion. Thirteen hundred meters long, weapons on all six faces.' },
  ],
  'story_s01_brief_03': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '它会分阶段换装: 先是机炮与导弹, 然后是激光阵列, 最后露出四个核心模块。', en: 'It swaps its loadout in phases: guns and missiles first, then laser arrays, and finally four exposed core modules.', voice: 'It swaps its loadout in phases: guns and missiles first, then laser arrays, and finally four exposed core modules.' },
  ],
  'story_s01_brief_04': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '打完当前阶段的全部挂点, 它才会进入下一阶段。别浪费弹药。', en: 'Only when every hardpoint of the current phase is destroyed will it advance. Do not waste ordnance.', voice: 'Only when every hardpoint of the current phase is destroyed will it advance. Do not waste ordnance.' },
  ],
  'story_s01_brief_05': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '四个核心全毁, 这艘船才会掉下来。在那之前, 它不会。', en: 'The ship goes down only when all four cores are destroyed. Not before.', voice: 'The ship goes down only when all four cores are destroyed. Not before.' },
  ],
  'story_s01_brief_06': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '空域归你。别让护卫机咬住你的尾巴。', en: 'The airspace is yours. Do not let the escorts get on your tail.', voice: 'The airspace is yours. Do not let the escorts get on your tail.' },
  ],
  // === 结算台词(4 句) ===
  'story_s01_debrief_01': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '堡垒坠海。任务完成。', en: 'Bastion is down in the sea. Mission complete.', voice: 'Bastion is down in the sea. Mission complete.' },
  ],
  'story_s01_debrief_02': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '战果确认中……干净利落。', en: 'Confirming battle damage... clean work.', voice: 'Confirming battle damage... clean work.' },
  ],
  'story_s01_debrief_03': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '撤出空域, 返航。油钱记你账上。', en: 'Egress the airspace and RTB. Fuel is on your tab.', voice: 'Egress the airspace and RTB. Fuel is on your tab.' },
  ],
  'story_s01_debrief_04': [
    { speaker: '预警机·鹰', side: 'awacs', voiceSpeaker: 'awacs', text: '这只是第一关。后面还有更硬的东西等着你。', en: 'That was only mission one. Harder things are waiting.', voice: 'That was only mission one. Harder things are waiting.' },
  ],
`;
s = s.slice(0, insertAt) + BRIEF_BLOCK + s.slice(insertAt);

// ③ 导出简报/结算顺序 + 取词接口
rep(`export const S01_RANDOM_CONTROL: RadioEvent;`,
`export const S01_RANDOM_CONTROL: RadioEvent;`,
 'noop');
fs.writeFileSync(p, s);
console.log('§229b(1/2) ok');
