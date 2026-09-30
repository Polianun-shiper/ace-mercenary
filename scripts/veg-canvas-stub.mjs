// === 植被验证用的极简 Canvas2D 桩 (verification harness, not shipped) ===
// 只实现 environment.ts 植被图集路径真正用到的子集:
//   fillStyle / fillRect, beginPath / moveTo / lineTo / closePath / arc / fill,
//   strokeStyle / lineWidth / moveTo / quadraticCurveTo / stroke,
//   createLinearGradient / createRadialGradient(对象), getImageData / putImageData,
//   imageSmoothingEnabled, drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh)
// 像素格式:RGBA8。fillRect 用 source-over 混合(alpha<1 时近似),其余矢量
// 图元按"实体色块"近似(对白键/裁剪判定足够:只要非白像素落在预期区域)。

class StubImageData {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
}

class StubGradient {
  constructor(kind) { this.kind = kind; this.stops = []; this._c = 'rgba(0,0,0,1)'; }
  addColorStop(pos, color) { this.stops.push({ pos, color }); }
  _resolve() {
    // 取中间 stop 的颜色作为近似(仅用于验证非白判定)
    const s = this.stops[Math.floor(this.stops.length / 2)] || { color: 'rgba(0,0,0,1)' };
    return s.color;
  }
}

function parseColor(v) {
  if (typeof v !== 'string') return { r: 255, g: 0, b: 255, a: 1 };
  const s = v.trim();
  if (s[0] === '#') {
    const hex = s.slice(1);
    const n = hex.length === 3
      ? [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)]
      : [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    return { r: n[0], g: n[1], b: n[2], a: 1 };
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p.length > 3 ? p[3] : 1 };
  }
  if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  return { r: 128, g: 128, b: 128, a: 1 };
}

class StubCtx {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000000';
    this.strokeStyle = '#000000';
    this.lineWidth = 1;
    this.imageSmoothingEnabled = true;
    this.globalAlpha = 1;
    this._path = [];
    this._cur = null;
  }
  createLinearGradient() { return new StubGradient('linear'); }
  createRadialGradient() { return new StubGradient('radial'); }
  beginPath() { this._path = []; this._cur = null; }
  moveTo(x, y) { this._cur = [x, y]; this._path.push([x, y]); }
  lineTo(x, y) { this._cur = [x, y]; this._path.push([x, y]); }
  quadraticCurveTo(cx, cy, x, y) { void cx; void cy; this._cur = [x, y]; this._path.push([x, y]); }
  closePath() {}
  arc(cx, cy, r) {
    // 16 边形近似圆
    for (let i = 0; i <= 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      this._path.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  _color() {
    const v = this.fillStyle;
    if (v instanceof StubGradient) return parseColor(v._resolve());
    return parseColor(v);
  }
  _strokeColor() {
    const v = this.strokeStyle;
    if (v instanceof StubGradient) return parseColor(v._resolve());
    return parseColor(v);
  }
  _blendPx(x, y, c, alphaScale = 1) {
    const cv = this.canvas;
    if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return;
    const i = (y * cv.width + x) * 4;
    const a = Math.max(0, Math.min(1, c.a * alphaScale * this.globalAlpha));
    const d = cv._data;
    d[i] = d[i] * (1 - a) + c.r * a;
    d[i + 1] = d[i + 1] * (1 - a) + c.g * a;
    d[i + 2] = d[i + 2] * (1 - a) + c.b * a;
    d[i + 3] = Math.min(255, d[i + 3] + a * 255);
  }
  _fillPolygon(pts, c) {
    if (pts.length < 3) return;
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    for (const p of pts) {
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
    }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(this.canvas.height - 1, Math.ceil(maxY));
    const x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(this.canvas.width - 1, Math.ceil(maxX));
    for (let y = y0; y <= y1; y++) {
      const xs = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[j], b = pts[i];
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const sx = Math.max(x0, Math.floor(xs[k])), ex = Math.min(x1, Math.ceil(xs[k + 1]));
        for (let x = sx; x <= ex; x++) this._blendPx(x, y, c);
      }
    }
  }
  fill() { if (this._path.length) this._fillPolygon(this._path, this._color()); }
  stroke() {
    const c = this._strokeColor();
    const lw = Math.max(1, Math.round(this.lineWidth));
    for (let i = 0; i + 1 < this._path.length; i++) {
      const [ax, ay] = this._path[i], [bx, by] = this._path[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      for (let s = 0; s <= steps; s++) {
        const x = ax + ((bx - ax) * s) / steps;
        const y = ay + ((by - ay) * s) / steps;
        const h = Math.floor(lw / 2);
        for (let dy = -h; dy <= h; dy++) for (let dx = -h; dx <= h; dx++) this._blendPx(Math.round(x) + dx, Math.round(y) + dy, c);
      }
    }
  }
  fillRect(x, y, w, h) {
    const c = this._color();
    const x0 = Math.max(0, Math.floor(Math.min(x, x + w)));
    const y0 = Math.max(0, Math.floor(Math.min(y, y + h)));
    const x1 = Math.min(this.canvas.width - 1, Math.ceil(Math.max(x, x + w)));
    const y1 = Math.min(this.canvas.height - 1, Math.ceil(Math.max(y, y + h)));
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) this._blendPx(xx, yy, c);
  }
  clearRect(x, y, w, h) {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.canvas.width, Math.ceil(x + w)), y1 = Math.min(this.canvas.height, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const i = (yy * this.canvas.width + xx) * 4;
      this.canvas._data[i] = 0; this.canvas._data[i + 1] = 0;
      this.canvas._data[i + 2] = 0; this.canvas._data[i + 3] = 0;
    }
  }
  drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (sx === undefined) { sx = 0; sy = 0; sw = src.width; sh = src.height; dx = 0; dy = 0; dw = src.width; dh = src.height; }
    const sd = src._data;
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const ssx = Math.min(src.width - 1, Math.floor(sx + (x * sw) / dw));
        const ssy = Math.min(src.height - 1, Math.floor(sy + (y * sh) / dh));
        const si = (ssy * src.width + ssx) * 4;
        const dxx = Math.round(dx + x), dyy = Math.round(dy + y);
        if (dxx < 0 || dyy < 0 || dxx >= this.canvas.width || dyy >= this.canvas.height) continue;
        const di = (dyy * this.canvas.width + dxx) * 4;
        const a = sd[si + 3] / 255;
        const d = this.canvas._data;
        d[di] = d[di] * (1 - a) + sd[si] * a;
        d[di + 1] = d[di + 1] * (1 - a) + sd[si + 1] * a;
        d[di + 2] = d[di + 2] * (1 - a) + sd[si + 2] * a;
        d[di + 3] = Math.min(255, d[di + 3] + sd[si + 3]);
      }
    }
  }
  getImageData(x, y, w, h) {
    const out = new StubImageData(w, h);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const sx = x + xx, sy = y + yy;
        const o = (yy * w + xx) * 4;
        if (sx < 0 || sy < 0 || sx >= this.canvas.width || sy >= this.canvas.height) continue;
        const i = (sy * this.canvas.width + sx) * 4;
        out.data[o] = this.canvas._data[i];
        out.data[o + 1] = this.canvas._data[i + 1];
        out.data[o + 2] = this.canvas._data[i + 2];
        out.data[o + 3] = this.canvas._data[i + 3];
      }
    }
    return out;
  }
  putImageData(img, x, y) {
    for (let yy = 0; yy < img.height; yy++) {
      for (let xx = 0; xx < img.width; xx++) {
        const sx = x + xx, sy = y + yy;
        if (sx < 0 || sy < 0 || sx >= this.canvas.width || sy >= this.canvas.height) continue;
        const i = (sy * this.canvas.width + sx) * 4;
        const o = (yy * img.width + xx) * 4;
        this.canvas._data[i] = img.data[o];
        this.canvas._data[i + 1] = img.data[o + 1];
        this.canvas._data[i + 2] = img.data[o + 2];
        this.canvas._data[i + 3] = img.data[o + 3];
      }
    }
  }
}

class StubCanvas {
  constructor() { this._w = 1; this._h = 1; this._data = new Uint8ClampedArray(4); this._ctx = null; }
  get width() { return this._w; }
  set width(v) { this._w = Math.max(1, v | 0); this._realloc(); }
  get height() { return this._h; }
  set height(v) { this._h = Math.max(1, v | 0); this._realloc(); }
  _realloc() { this._data = new Uint8ClampedArray(this._w * this._h * 4); }
  getContext(kind) {
    if (kind !== '2d') return null;
    if (!this._ctx) this._ctx = new StubCtx(this);
    return this._ctx;
  }
}

export function installCanvasStub() {
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return new StubCanvas();
      return {};
    },
  };
  globalThis.HTMLCanvasElement = StubCanvas;
  globalThis.ImageData = StubImageData;
  globalThis.self = globalThis;
}

export { StubCanvas };
