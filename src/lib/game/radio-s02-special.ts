// === 第二关补充台词：王牌中队「隼」/ 空中战舰 / 预警机炮弹倒计时 =====================
// 用户要求（原话）: "那有没有他们的台词，没有就加25个台词和预警机提醒炮弹到达倒计时"
//   · 王牌中队(3× Su-35, 最后一阶段围绕轰炸机编队进场)+ 公频挑衅   14 条
//   · 中型空中战舰(走廊西侧巡逻 + 每 50s 一发空爆弹)               6 条
//   · 预警机「穹顶」空爆弹到达倒计时(3/2/1 秒 + 命中/脱离)          5 条
// 语音仍是占位符(voiceSpeaker), 复用现有音色集合。
import type { Line } from './radio-s02-script';

/** 本补充模块新增的说话人 → [显示代号, side, voiceSpeaker] */
export const CAST2: Record<string, ['awacs' | 'ally' | 'enemy', string, string]> = {
  穹顶: ['awacs', '穹顶', 'awacs'],        // 预警机(指挥): 只报倒计时与命中
  隼1: ['enemy', '隼1', 'enemy1'],         // 王牌长机(死盯山雀)
  隼2: ['enemy', '隼2', 'enemy2'],
  隼3: ['enemy', '隼3', 'enemy1'],
  铁砧: ['enemy', '铁砧', 'enemy2'],       // 空中战舰的射击指挥
};

/** 王牌中队 + 公频挑衅(最后一阶段进场后连播) */
export const ACE: Line[] = [
  ['隼1', '鹫中队，久仰。我们是隼。你们炸的那座金库，是我们老板的。',
    'Vulture flight, we have heard of you. We are Hayabusa. That vault you hit belonged to our employer.'],
  ['隼1', '三号僚机(山雀)交给我。你们谁都别管他。',
    'The number three — Chickadee — is mine. Nobody interfere.'],
  ['隼2', '队长，我看他们护航队挺像样。要不要先打个招呼？',
    'Lead, their escorts look decent. Shall we say hello first?'],
  ['隼3', '招呼什么？直接咬住那架掉队的运输机。',
    'Why bother. Just clamp onto that straggling transport.'],
  ['明', '隼中队来了！这下他们完了！我押的赔率要翻倍了！',
    'Hayabusa is in! They are finished! My odds are doubling!'],
  ['阿武', '别高兴太早，先看他们能不能撑过五分钟。',
    'Do not celebrate yet. Let us see if they last five minutes.'],
  ['隼1', '关西的朋友，闭嘴。你们把行情做坏了，我们还得替你们擦屁股。',
    'West friends, quiet. You wrecked the market and we clean up after you.'],
  ['阿岛', '……连隼中队都这么说话。这仗到底给谁打的啊。',
    '...Even Hayabusa talks like that. Whose war is this anyway.'],
  ['隼2', '别管那些。编队护航机，出来单挑。',
    'Ignore them. Escort fighters — come out and dance.'],
  ['城', '隼中队，你们的王牌是拿命换的。我的人拿的是工资。',
    'Hayabusa, your ace status is paid in lives. My people are paid in salary.'],
  ['隼1', '工资？那你们更该走。死了可没人给你们发抚恤金。',
    'Salary? Then you should leave. Nobody pays death benefits for hired guns.'],
  ['凯', '哎，这话说得跟真的一样。你们老板给你发多少钱啊？',
    'Hey, that sounded almost sincere. How much does your boss pay you?'],
  ['隼3', '闭嘴，杂鱼。',
    'Shut up, small fry.'],
  ['胖虎', '哈！被叫杂鱼了！来啊，看看谁先掉下去！',
    'Hah! We are small fry now! Come on, let us see who drops first!'],
];

/** 空中战舰(每发空爆弹 + 命中的挑衅) */
export const SHIP: Line[] = [
  ['铁砧', '这里是铁砧。护航机在我射界里。装填完毕。',
    'This is Anvil. Escorts are inside my firing arc. Loaded.'],
  ['铁砧', '一发空爆弹，三秒后落点。跑吧。',
    'One airburst, impact in three seconds. Run.'],
  ['铁砧', '想靠机动躲？我的弹是算好的。',
    'Try dodging? The shell is already solved.'],
  ['铁砧', '你们的机体比你们值钱。别浪费。',
    'Your airframes are worth more than you are. Do not waste them.'],
  ['铁砧', '我船体受损，射击效率下降。请求护航。',
    'Hull damaged, fire rate degraded. Requesting cover.'],
  ['铁砧', '本舰弃守。这片天交给隼中队。祝各位好运。',
    'Abandoning station. The sky is Hayabusa\'s. Good luck to you all.'],
];

/** 预警机「穹顶」: 空爆弹到达倒计时(3/2/1 秒 + 命中/脱离) */
export const WARN: Line[] = [
  ['穹顶', '空爆弹出膛，三秒后到达。立刻离开锁定位置！',
    'Airburst away. Impact in three. Get off the lock now!'],
  ['穹顶', '两秒。',
    'Two.'],
  ['穹顶', '一秒。',
    'One.'],
  ['穹顶', '命中。鹫中队，检查损伤。',
    'Impact. Vulture flight, check damage.'],
  ['穹顶', '脱离成功，弹着点空了。干得漂亮。',
    'Clean break, impact zone empty. Good flying.'],
];
