import * as THREE from 'three';

// === 资产读取(file:// 与 http 都能用) =====================================
// 为什么需要这个: 浏览器在 **file:// 下禁止 fetch()**(同源策略), 于是
//   · 外置资产库(assets/...)读不到 → "TypeError: Failed to fetch"
//   · 打包成单文件时 fetch('data:...') 又是可以的
// 而 `XMLHttpRequest` 对**同目录文件**是放行的(file:// 可以读同源文件)。
// 所以统一走 XHR: 单文件(data URI)、本地双击(file://)、网站(http)三种环境
// 用同一条代码路径, 不需要按协议分支。
//
// 注意 XHR 的 responseType:
//   · 'text'  → 文本(OBJ / MTL)
//   · 'arraybuffer' → 二进制(.gz、贴图字节)
export function fetchAssetBuffer(url: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    // 诊断: 把完整 URL(含前缀)带进错误信息 —— 之前只报 "Event" 无法定位是
    // 路径拼错、协议被拒还是 data URI 太长。
    const shown = url.length > 120 ? `${url.slice(0, 90)}…(${url.length} chars)` : url;
    let xhr: XMLHttpRequest;
    try {
      xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
    } catch (e) {
      reject(new Error(`XHR open failed for ${shown}: ${String(e)}`));
      return;
    }
    xhr.onload = () => {
      // file:// 下 status 可能是 0 但 data 有效(成功);只有明确 >=400 才算失败。
      if (xhr.status >= 400) {
        reject(new Error(`HTTP ${xhr.status} for ${shown}`));
        return;
      }
      if (!xhr.response) {
        reject(new Error(`empty response for ${shown} (status ${xhr.status})`));
        return;
      }
      resolve(xhr.response as ArrayBuffer);
    };
    xhr.onerror = () => reject(new Error(`XHR network error for ${shown}`));
    xhr.ontimeout = () => reject(new Error(`XHR timeout for ${shown}`));
    try {
      xhr.send();
    } catch (e) {
      reject(new Error(`XHR send threw for ${shown}: ${String(e)}`));
    }
  });
}

/** 读文本(OBJ/MTL)。内部: 先按 arraybuffer 取, 再按 UTF-8 解码 ——
 *  比 responseType='text' 更可控(避免默认编码差异把中文注释解坏)。 */
export async function fetchAssetText(url: string): Promise<string> {
  const buf = await fetchAssetBuffer(url);
  return new TextDecoder('utf-8').decode(new Uint8Array(buf));
}

/**
 * 用 `<img>` 载入图片资产(file:// 下唯一可用的方式)。
 *
 * 为什么不能再用 `THREE.TextureLoader`: three r185 的 Loader 走 **fetch**
 * (`FileLoader` → fetch), 而浏览器在 `file://` 下禁止 fetch —— 双击单文件时
 * 贴图加载会抛出**裸 Event**, 一路冒泡到模型加载的 catch, 于是 MiG-29 / F-16C
 * 全部"加载失败"并回退程序化低模。而 `<img>` 读同目录文件是**允许**的
 * (实测: IMG OK 512x512 / XHR FAIL), 所以图片一律走这条路。
 *
 * `crossOrigin` 不设: 同目录相对路径无需 CORS, 设了反而在 file:// 下更易失败。
 */
export function loadImageTexture(
  url: string,
  srgb: boolean,
): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const t = new THREE.CanvasTexture(img);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.needsUpdate = true;
      resolve(t);
    };
    img.onerror = () => reject(new Error(`image load failed: ${url.slice(0, 80)}`));
    img.src = url;
  });
}
