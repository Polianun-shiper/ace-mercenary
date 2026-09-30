#!/usr/bin/env python3
# scripts/gen-evening-2k.py
#
# 生成 2K 版黄昏 HDRI(equirect 4K → 2K,2×2 box 平均降采样)——
# 用于单文件 HTML 的本地 file:// 兼容模式:file:// 下浏览器禁止 fetch 外置
# EXR,只有内联 data URI 读得到;2K 版 ~3MB(base64 ~4MB)能压进 100MB 单文件,
# 4K 版(~12MB→base64 16MB)会把 HTML 顶过平台上限。
#
# Usage: python scripts/gen-evening-2k.py
# 输入: public/textures/sky/evening.exr (4K,与 F: zip 内 _HDR.exr 同源)
# 输出: public/textures/sky/evening-2k.exr (2048x1024, half RGB)
import sys
from pathlib import Path

import numpy as np

try:
    import OpenEXR
    import Imath
except ImportError:
    sys.exit("need: pip install numpy OpenEXR Imath")

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "textures" / "sky" / "evening.exr"
OUT = ROOT / "public" / "textures" / "sky" / "evening-2k.exr"

f = OpenEXR.InputFile(str(SRC))
hdr = f.header()
dw = hdr["dataWindow"]
W, H = dw.max.x - dw.min.x + 1, dw.max.y - dw.min.y + 1
print(f"src {W}x{H}")

HALF = Imath.PixelType(Imath.PixelType.HALF)
chan_map = hdr["channels"]  # {name: Channel}
names = [c for c in ("R", "G", "B") if c in chan_map]
if not names:
    sys.exit(f"no RGB channels in {SRC}: {list(chan_map)}")

def load(name: str) -> np.ndarray:
    raw = f.channel(name, HALF)
    return np.frombuffer(raw, dtype=np.float16).reshape(H, W).astype(np.float32)

rgb = np.stack([load(c) for c in names], axis=-1)  # H x W x C
print("loaded", rgb.shape, "max", float(rgb.max()), "mean", float(rgb.mean()))

# 2x2 box average (equirect box avg is fine for sky backgrounds)
h2, w2 = H // 2, W // 2
rgb2 = (
    rgb[0::2, 0::2] + rgb[0::2, 1::2] + rgb[1::2, 0::2] + rgb[1::2, 1::2]
) / 4.0
rgb2 = rgb2.astype(np.float16)
print("downsampled", rgb2.shape)

out_hdr = OpenEXR.Header(w2, h2)
out_hdr["compression"] = Imath.Compression(Imath.Compression.ZIP_COMPRESSION)
out_hdr["channels"] = {c: Imath.Channel(HALF) for c in names}
out = OpenEXR.OutputFile(str(OUT), out_hdr)
payload = {}
for i, c in enumerate(names):
    payload[c] = rgb2[..., i].tobytes()
out.writePixels(payload)
out.close()
print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB)")
