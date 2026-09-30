import ZAI, { VisionMessage } from 'z-ai-web-dev-sdk';
import fs from 'fs';

async function analyze(imagePath: string, prompt: string) {
  try {
    const zai = await ZAI.create();
    const buf = fs.readFileSync(imagePath);
    const b64 = buf.toString('base64');
    const mime = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const messages: VisionMessage[] = [
      { role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
      ] }
    ];
    const response = await zai.chat.completions.createVision({
      model: 'glm-4.6v',
      messages,
      thinking: { type: 'disabled' }
    });
    const reply = response.choices?.[0]?.message?.content;
    console.log(`\n=== ${imagePath} ===\n`);
    console.log(reply ?? JSON.stringify(response, null, 2));
  } catch (err: any) {
    console.error('Vision chat failed:', err?.message || err);
  }
}

const prompt1 = "请详细描述这张游戏截图：1) 天空中的云层是什么样子（颜色、密度、形状、视觉风格、是否真实有体积感）2) HUD/UI元素有哪些 3) 地形/海面是什么样的 4) 视角/飞机姿态如何 5) 整体画面氛围如何？";

const prompt2 = "请详细描述这张游戏截图：1) 当前云层渲染有什么问题 2) HUD界面元素 3) 飞机姿态、视角、地形、敌人位置 4) 性能/卡顿迹象 5) 任何视觉异常";

(async () => {
  await analyze("/home/z/my-project/upload/QQ20260708-200101.png", prompt1);
  await analyze("/home/z/my-project/upload/QQ20260711-134319.png", prompt2);
})();
