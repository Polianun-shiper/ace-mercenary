// Generate a clean Markdown long list of all radio lines, written to
// download/radio_lines_longlist.md (relative to the repo root).
// Used so the user can browse the full 台词清单 (per-line voice plan) that
// feeds the IndexTTS2.5 batch dubbing (scripts/export-radio-voices.ts).

import { getRadioVoicePlan } from '../src/lib/game/radio';
import * as fs from 'fs';
import * as path from 'path';

// Run from the repo root — root == cwd.
const repoRoot = process.cwd();
const outPath = path.join(repoRoot, 'download', 'radio_lines_longlist.md');

const lines = getRadioVoicePlan();

// Group by event
const grouped: Record<string, typeof lines> = {};
for (const l of lines) {
  if (!grouped[l.event]) grouped[l.event] = [];
  grouped[l.event].push(l);
}

let out = '# ACE/SKY 无线电台词长清单\n\n';
out += `共 ${lines.length} 条台词，覆盖 ${Object.keys(grouped).length} 个无线电事件。\n\n`;
out += '**配音**：由 IndexTTS2.5 本地合成中文语音，音频文件按 `public/audio/radio/<lineId>.mp3` 命名，运行时逐句整句播放（不抢播）。\n\n';
out += '| 字段 | 含义 |\n|------|------|\n| lineId | 稳定标识符（事件-池序号，即音频文件名） |\n| speaker | 呼号 |\n| role | 音色分类（player / ally1 / ally2 / enemy1 / enemy2 / awacs） |\n| category | 播放优先级（story / alert / normal） |\n| text | 台词原文（字幕 = 朗读文本） |\n\n';
out += '---\n\n';

const eventDesc: Record<string, string> = {
  mission_start: '任务开始',
  target_acquired: '锁定目标',
  missile_launch: '玩家发射导弹',
  enemy_missile_launch: '敌方发射导弹',
  kill_fighter: '击落敌方战斗机',
  kill_bomber: '击落敌方轰炸机',
  multi_kill: '多杀连击',
  ally_down: '友军被击落',
  player_hit: '玩家被击中',
  missile_warning: '导弹来袭警告',
  low_hp: '低血量警告',
  stall_warning: '失速警告',
  mission_complete: '任务完成',
  mission_failed: '任务失败',
  no_target: '无目标',
  weapon_empty: '武器耗尽',
  engage: '敌方交战',
  disengage: '敌方脱离',
  taunt: '敌方嘲讽',
  bogey_dopple: '敌机接近',
  wingman_attack: '僚机攻击',
  wingman_cover: '僚机掩护',
  wingman_form: '僚机归队',
  wingman_kill: '僚机击落敌机',
  wingman_hit: '僚机被击中',
  weather_warning: '天气警告',
  missile_miss: '导弹未命中',
  splash_call: '击落确认',
  story_t00_intro: 'T-00 剧情·开场简报',
  story_t00_engage: 'T-00 剧情·交火',
  story_t00_laser1: 'T-00 剧情·摧毁 1 号激光炮',
  story_t00_laser3: 'T-00 剧情·摧毁 3 号激光炮',
  story_t00_laser5: 'T-00 剧情·防空全清',
  story_t00_radar_down: 'T-00 剧情·雷达站殉爆',
  story_t00_ace_enter: 'T-00 剧情·王牌登场',
  story_t00_ace_engage: 'T-00 剧情·王牌攻击准备',
  story_t00_ace_strain: 'T-00 剧情·王牌机动过载',
  story_t00_ace_kill1: 'T-00 剧情·击落 1 架王牌',
  story_t00_ace_kill5: 'T-00 剧情·击落 5 架王牌',
  story_t00_end: 'T-00 剧情·任务收尾',
};

for (const event of Object.keys(grouped)) {
  out += `## ${event} — ${eventDesc[event] ?? event}\n\n`;
  out += '| lineId | speaker | role | category | text |\n';
  out += '|--------|---------|------|----------|------|\n';
  for (const l of grouped[event]) {
    // Escape pipes in text
    const text = l.text.replace(/\|/g, '\\|');
    out += `| \`${l.id}\` | ${l.speaker} | ${l.role} | ${l.category} | ${text} |\n`;
  }
  out += '\n';
}

fs.writeFileSync(outPath, out, 'utf-8');
console.log(`Written ${lines.length} lines to ${outPath}`);
