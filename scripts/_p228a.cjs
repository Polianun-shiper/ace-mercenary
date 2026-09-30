// §228a: 剧情菜单入口 + StorySelect 界面 + GameApp 里的 story-select 相位
const fs = require('fs');
function patch(file, jobs) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [a, b, label] of jobs) {
    const n = s.split(a).length - 1;
    if (n !== 1) { console.error('miss(' + n + ') ' + file + ':', label); process.exit(1); }
    s = s.replace(a, b);
    console.log('ok:', label);
  }
  fs.writeFileSync(file, s);
}

const STORY_SELECT = `
/**
 * 正式版剧情菜单 (per user request: 在游戏菜单加上正式版剧情菜单, 单独搞关卡)。
 *
 * 与 MissionSelect(普通出击列表)分开: 这里只列 \`campaign\` 有值的关卡, 按关卡号排序,
 * 每一行是那关的剧情简介 + 目标 + 奖励; 点行进入原有 Briefing 流程(机型/僚机/挂载照旧)。
 * 视觉沿用终端语汇, 不引入新配色。
 */
export function StorySelect({ onSelect, onBack }: { onSelect: (id: string) => void; onBack: () => void }) {
  const t = useT();
  const story = useMemo(
    () => MISSIONS.filter((m) => typeof m.campaign === 'number').sort((a, b) => (a.campaign ?? 0) - (b.campaign ?? 0)),
    [],
  );
  return (
    <div className="crt-frame crt-flicker relative h-full w-full select-none overflow-hidden crt-font" style={{ background: 'var(--crt-bg)' }}>
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(180deg, rgba(255,176,0,0.05) 0%, rgba(0,0,0,0) 16%, rgba(0,0,0,0) 84%, rgba(255,176,0,0.03) 100%), radial-gradient(120% 80% at 50% 50%, rgba(255,176,0,0.035) 0%, rgba(0,0,0,0) 60%)',
          boxShadow: CRT_PWR_GLOW,
        }}
      />
      <div className="relative z-10 flex h-full w-full flex-col">
        <div
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-2.5 py-1.5"
          style={{ borderColor: 'var(--crt-line-strong)', background: 'linear-gradient(180deg, rgba(31,22,8,0.9) 0%, rgba(10,6,1,0.9) 100%)' }}
        >
          <button onClick={onBack} className="crt-key shrink-0 px-2.5 py-1 text-[10px]">◀ {t('ms.back')}</button>
          <span className="crt-data crt-text--hi crt-text--glow tracking-[0.3em]">
            {getLocale() === 'zh' ? '正式版剧情' : 'STORY CAMPAIGN'}
          </span>
          <span className="crt-label hidden sm:inline">· TAC-OS 3.11 · OPERATION BASTION</span>
          <span className="ml-auto flex items-center gap-2.5">
            <span className="crt-label hidden sm:inline">CLASS ■ TOP SECRET</span>
            <span className="flex items-center gap-1.5">
              <span className="tp-led animate-tp-breathe h-2 w-2" style={{ color: 'var(--crt-amber)' }} />
              <span className="crt-label">{story.length} {getLocale() === 'zh' ? '关' : 'OPS'}</span>
            </span>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
          {story.length === 0 && (
            <div className="crt-label p-4 text-center">{getLocale() === 'zh' ? '暂无剧情关卡' : 'NO STORY MISSIONS'}</div>
          )}
          {story.map((m) => (
            <button
              key={m.id}
              onClick={() => onSelect(m.id)}
              className="crt-panel mb-2 block w-full px-3 py-2 text-left transition-colors hover:bg-[rgba(255,176,0,0.08)]"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="crt-data crt-text--hi text-[15px] tracking-[0.18em]">
                  MISSION {String(m.campaign).padStart(2, '0')}
                </span>
                <span className="crt-data crt-text--glow text-[13px]">{m.codename}</span>
                <span className="crt-label">{m.title}</span>
              </div>
              <p className="crt-label mt-1.5 leading-relaxed" style={{ whiteSpace: 'normal' }}>{m.brief}</p>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                {m.objectives.map((o) => (
                  <span key={o.id} className="crt-label">◆ {o.label}</span>
                ))}
                <span className="crt-label">■ {m.map.toUpperCase()}</span>
                <span className="crt-label">■ {m.reward}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
`;

patch('src/components/game/Menus.tsx', [
  // ① ModeKey 扩一位
  ['type ModeKey = 0 | 1 | 2 | 3 | 4 | 5;', 'type ModeKey = 0 | 1 | 2 | 3 | 4 | 5 | 6;', 'ModeKey'],
  // ② MainMenu props 增加 onStory
  ['export function MainMenu({ onPlay, onHangar, onSettings, onMultiplayer }: { onPlay: () => void; onHangar: () => void; onSettings: () => void; onMultiplayer: () => void }) {',
   'export function MainMenu({ onPlay, onStory, onHangar, onSettings, onMultiplayer }: { onPlay: () => void; onStory: () => void; onHangar: () => void; onSettings: () => void; onMultiplayer: () => void }) {',
   'MainMenu props'],
  // ③ MODES 里插剧情入口(放在普通出击之后, 排第二)
  [`  { key: 'camp', glyph: '▶', label: label(t, 'menu.campaign'), sub: 'CAMPAIGN', run: onPlay },`,
   `  { key: 'camp', glyph: '▶', label: label(t, 'menu.campaign'), sub: 'CAMPAIGN', run: onPlay },
  // === 正式版剧情 (per user request: 在游戏菜单加上正式版剧情菜单, 单独搞关卡) ===
  // 与上面的普通出击分开: 这条进的是剧情专用界面(只列 campaign 关卡)。
  { key: 'story', glyph: '★', label: getLocale() === 'zh' ? '正式版剧情' : 'STORY CAMPAIGN', sub: 'OPERATION BASTION', run: onStory },`,
   'MODES story entry'],
  // ④ 依赖: 确认 useMemo / getLocale 已在该文件可用(它已经在用 t/useT 与 getLocale)
  ['export function MissionSelect({ onSelect, onBack }', STORY_SELECT + '\nexport function MissionSelect({ onSelect, onBack }', 'StorySelect component'],
]);

patch('src/components/game/GameApp.tsx', [
  // 相位
  ["type Phase = 'menu' | 'multiplayer' | 'mission-select' | 'hangar' | 'briefing' | 'loading' | 'playing' | 'results' | 'settings';",
   "type Phase = 'menu' | 'multiplayer' | 'mission-select' | 'story-select' | 'hangar' | 'briefing' | 'loading' | 'playing' | 'results' | 'settings';",
   'Phase type'],
  // 主菜单回调
  ['        <MainMenu\n          onPlay={() => setPhase(\'mission-select\')}',
   '        <MainMenu\n          onPlay={() => setPhase(\'mission-select\')}\n          onStory={() => setPhase(\'story-select\')}',
   'MainMenu onStory'],
  // 渲染剧情界面(与 mission-select 同一个 onSelect 流程: 选完进 briefing)
  [`      {phase === 'mission-select' && (
        <MissionSelect
          onSelect={(id) => { setMissionId(id); setPhase('briefing'); }}
          onBack={() => setPhase('menu')} />
      )}`,
   `      {phase === 'mission-select' && (
        <MissionSelect
          onSelect={(id) => { setMissionId(id); setPhase('briefing'); }}
          onBack={() => setPhase('menu')} />
      )}
      {/* 正式版剧情菜单 (per user request): 选完同样进 briefing, 机型/僚机/挂载流程不变 */}
      {phase === 'story-select' && (
        <StorySelect
          onSelect={(id) => { setMissionId(id); setPhase('briefing'); }}
          onBack={() => setPhase('menu')} />
      )}`,
   'render StorySelect'],
]);
console.log('§228a ok');
