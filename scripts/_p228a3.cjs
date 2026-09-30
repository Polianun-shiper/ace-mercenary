// 普通出击列表只列非剧情关卡(剧情关卡归 StorySelect, 两边不重复)
const fs = require('fs');
const p = 'src/components/game/Menus.tsx';
let s = fs.readFileSync(p, 'utf8');
function rep(a, b, label, all) {
  const n = s.split(a).length - 1;
  if (!all && n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  if (all) s = s.split(a).join(b); else s = s.replace(a, b);
  console.log('ok:', label, '(' + n + ')');
}
rep("export function MissionSelect({ onSelect, onBack }: { onSelect: (id: string) => void; onBack: () => void }) {\n  const t = useT();",
    "export function MissionSelect({ onSelect, onBack }: { onSelect: (id: string) => void; onBack: () => void }) {\n  const t = useT();\n  // 剧情关卡有自己的界面(StorySelect), 这里只列普通出击关卡 (per user request: 剧情单独搞关卡)\n  const sorties = useMemo(() => MISSIONS.filter((m) => !m.campaign), []);",
    'sorties list');
rep("{MISSIONS.map((m, i) => (", "{sorties.map((m, i) => (", 'mission list source');
rep("{t('ms.countOps', { n: MISSIONS.length })}", "{t('ms.countOps', { n: sorties.length })}", 'count labels (both)', true);
fs.writeFileSync(p, s);
