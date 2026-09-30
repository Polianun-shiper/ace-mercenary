// === English → 中文 value maps (per user request: 所有UI换中文) ===
// Mission data (missions.ts) ships English enum values (DAY/OCEAN/FIGHTER…).
// These maps translate the display values at render time; lookup helpers
// fall back to the raw value so unknown keys never show as blank.

export const SKY_ZH: Record<string, string> = {
  DAY: '白天', SUNSET: '黄昏', DAWN: '黎明', STORM: '风暴', NIGHT: '夜晚',
};

export const WEATHER_ZH: Record<string, string> = {
  CLEAR: '晴朗', CLOUDY: '多云', FOG: '大雾', STORM: '风暴', SNOW: '降雪',
};

export const MAP_ZH: Record<string, string> = {
  OCEAN: '海洋', CITY: '城市', MOUNTAIN: '山地', DESERT: '沙漠', ARCHIPELAGO: '群岛',
  CUSTOM: '新地形雪山', // === Gaea 导入槽 (per user request: m13 验证关) ===
};

export const CATEGORY_ZH: Record<string, string> = {
  fighter: '战斗机', attack: '攻击机', bomber: '轰炸机', ew: '电子战',
  gunship: '炮艇机', stealth: '隐身机', awacs: '预警机',
};

export const CAM_MODE_ZH: Record<string, string> = {
  CHASE: '追尾', COCKPIT: '座舱', EXTERNAL: '外部', FAR: '远距', SIDE: '侧射',
  MISSILE: '导弹视角', CINEMATIC: '击杀特写',
};

export const WINGMAN_CMD_ZH: Record<string, string> = {
  ATTACK: '攻击', COVER: '掩护', FORM: '编队',
};

export function zhValue(map: Record<string, string>, v: string): string {
  return map[v] ?? v;
}
