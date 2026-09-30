# -*- coding: utf-8 -*-
"""
ACE/SKY 地形烘焙导出器 (Blender 侧)
===========================================================================
把 Blender 里搭好的地形场景烘成游戏能直接吃的一套贴图 + 一份 sidecar JSON。

本文件的模块文档 = **Blender 导出约定(规则)**。游戏端不猜、不做启发式;
凡是约定都能在 sidecar 里显式声明,由 `scripts/blender-pack.mjs` 校验并
归一化。违反约定的数据会被 packer 拒绝,而不是变成"看着怪但说不出哪错"的画面。

---------------------------------------------------------------------------
一、世界空间与朝向(最容易错的部分)
---------------------------------------------------------------------------
游戏世界: 右手系, **Y 轴朝上**, 米。地形平面覆盖 X/Z ∈ [-size/2, +size/2]。
Blender  : 右手系, Z 轴朝上。
本脚本统一按下面的转换把游戏坐标放进 Blender:
      游戏 (X, Y, Z)  →  Blender (X, -Z, Y)
即 blender_x = game_x, blender_y = -game_z, blender_z = game_y 。
该转换保持右手性(不是镜像),所以法线的绕序/切向不会翻转。

---------------------------------------------------------------------------
二、世界域 UV 与"行 0 = 世界 −Z"
---------------------------------------------------------------------------
游戏侧所有世界域贴图(色图 / 遮罩 / 法线 / 烘焙图)共用同一套 UV:
      u = (worldX + size/2) / size
      v = (worldZ + size/2) / size        ← 纹理行 0 对应 worldZ = -size/2
(见 src/lib/game/pbr/terrain-v2.ts 的 uv2 写入与 layered-terrain.ts 的
 (vWorldPos.xz + uMaskHalf) * uMaskInvSize —— 两者逐位一致。)

在 Blender 里图像 v=0 是**最下面一行**,而存成 PNG 后文件的第一行是 v=1,
所以烘到 UV 上的映射是:
      uv.x = (worldX + size/2) / size
      uv.y = 1 - (worldZ + size/2) / size
加上"俯视正交相机、相机上方向 = blender +Y"的渲染布局(本脚本默认),
产出的 PNG 就是游戏约定: 第 0 行 = −Z、第 0 列 = −X。**无需任何旋转/镜像。**

如果你改用别的布局(自定义相机/旋转过的场景),请在 `--flip-*`/`--rot` 里
如实声明 —— packer 会按声明归一化,并在 sidecar 里记录,不会静默错位。

---------------------------------------------------------------------------
三、通道契约(打包烘焙图 bakeMap,单张 RGBA)
---------------------------------------------------------------------------
    R = AO          环境光遮蔽,1 = 无遮挡          线性数据(不做 sRGB)
    G = GI          间接光/天光弹射系数,1 = 全天空  线性数据
    B = 太阳可见度  1 = 见太阳,0 = 被山体挡住       线性数据
    A = 保留(255)   未来: 湿度/雪线/泡沫掩码
游戏消费方式(src/lib/game/pbr/layered-terrain.ts):
    · R 交给 three 内置 aoMap 管线(强度 = material.aoMapIntensity)
    · G 乘在间接光上(强度 uBakeGI,默认 1)
    · B 乘在直接光上(强度 uBakeShadow,缺省 0 —— 实时阴影已在跑,开之前
      请确认不会双重变暗)
**因此三张通道图必须是线性数据**: 存 PNG 时 color space 用 Non-Color,
不要做 sRGB 编码,也不要让 Blender 的 Film/View Transform 参与
(本脚本用 FILMIC/Standard? → 用 'Standard' 且 exposure 0,保证 1:1)。
AO/GI/太阳都是 0..1 的乘数,不是"颜色"。

---------------------------------------------------------------------------
四、另外几张图(与通道图分开输出,便于单独迭代)
---------------------------------------------------------------------------
    normal.png   切线空间法线(与色图同世界域,1:1);游戏按 channel 2 采样
    color.png    可选: 地表基础色(**sRGB 编码**,这是唯一的颜色图)
    height*.png  可选: 高度灰度(黑=低/白=高),或直接复用 f32bin

---------------------------------------------------------------------------
五、用法
---------------------------------------------------------------------------
无头命令行(推荐,可进 CI):
    blender -b -P tools/blender/skyace_terrain_bake.py -- \
        --height  public/custom-maps/custom/heights.f32bin \
        --size 48600 --max-height 4320 \
        --res 2048 --samples 256 \
        --sun-elevation 38 --sun-azimuth 145 \
        --out bake/blender

GUI: 本脚本注册了 "烘焙并导出地形" 面板按钮(需要已选中一个网格 + 一个
     图像纹理节点;或直接用 --height 走无头路径)。

产物(全部写进 `--out`):
    bake_ao.png / bake_gi.png / bake_sun.png / normal.png / [color.png]
    height.f32bin(与输入同域,便于游戏直接换用)
    bake.json   ← sidecar,packer 的唯一依据
"""

import json
import math
import os
import struct
import sys

# ---------------------------------------------------------------------------
# Blender 环境
# ---------------------------------------------------------------------------
try:
    import bpy
    import bmesh
    from mathutils import Vector
    _IN_BLENDER = True
except Exception:  # 允许在无 Blender 的环境里被 import 做静态检查
    bpy = None
    bmesh = None
    Vector = None
    _IN_BLENDER = False

CHANNELS = ("ao", "gi", "sun")


# ---------------------------------------------------------------------------
# 参数解析
# ---------------------------------------------------------------------------
def parse_args(argv):
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
    opts = {
        "height": None,
        "size": 48600.0,
        "max_height": 4320.0,
        "res": 2048,
        "samples": 256,
        "sun_elevation": 38.0,
        "sun_azimuth": 145.0,
        "sun_strength": 4.0,
        "sky_strength": 1.0,
        "out": "bake/blender",
        "flip_x": False,
        "flip_y": False,
        "rot": 0,
        "skip_normal": False,
        "skip_color": False,
        "only": "",
    }
    i = 0
    while i < len(argv):
        a = argv[i]
        nxt = argv[i + 1] if i + 1 < len(argv) else None

        def num(default):
            return float(nxt) if nxt is not None else default

        if a == "--height":
            opts["height"] = nxt
        elif a == "--size":
            opts["size"] = num(opts["size"])
        elif a == "--max-height":
            opts["max_height"] = num(opts["max_height"])
        elif a == "--res":
            opts["res"] = int(num(opts["res"]))
        elif a == "--samples":
            opts["samples"] = int(num(opts["samples"]))
        elif a == "--sun-elevation":
            opts["sun_elevation"] = num(opts["sun_elevation"])
        elif a == "--sun-azimuth":
            opts["sun_azimuth"] = num(opts["sun_azimuth"])
        elif a == "--sun-strength":
            opts["sun_strength"] = num(opts["sun_strength"])
        elif a == "--sky-strength":
            opts["sky_strength"] = num(opts["sky_strength"])
        elif a == "--out":
            opts["out"] = nxt
        elif a == "--flip-x":
            opts["flip_x"] = True
        elif a == "--flip-y":
            opts["flip_y"] = True
        elif a == "--rot":
            opts["rot"] = int(num(0))
        elif a == "--skip-normal":
            opts["skip_normal"] = True
        elif a == "--skip-color":
            opts["skip_color"] = True
        elif a == "--only":
            opts["only"] = (nxt or "")
        i += 2 if (nxt is not None and not nxt.startswith("--")) else 1
    return opts


# ---------------------------------------------------------------------------
# 高度场读写(游戏格式: float32 LE,米,行主序,cy=0 在 −size/2 一侧)
# ---------------------------------------------------------------------------
def read_f32bin(path, expect_res=None):
    with open(path, "rb") as f:
        raw = f.read()
    n = len(raw) // 4
    vals = struct.unpack("<%df" % n, raw[: n * 4])
    if expect_res:
        if n != expect_res * expect_res:
            raise ValueError(
                "高度包尺寸不符: %d 个 float,期望 %d×%d" % (n, expect_res, expect_res)
            )
        res = expect_res
    else:
        res = int(math.sqrt(n))
        if res * res != n:
            raise ValueError("高度包不是正方形(%d 个 float)" % n)
    return res, vals


def write_f32bin(path, vals):
    with open(path, "wb") as f:
        f.write(struct.pack("<%df" % len(vals), *vals))


# ---------------------------------------------------------------------------
# 场景搭建
# ---------------------------------------------------------------------------
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def build_terrain_mesh(res, size, heights, name="SKYACE_TERRAIN"):
    """按游戏约定建网格: 顶点 = (blender_x, blender_y, blender_z) = (gx, -gz, h)。

    UV 按第二节的规则写入,保证烘出来的图就是世界域、行 0 = −Z。
    为避免 2048² = 419 万顶点把 Blender 拖死,网格按 `res` 逐格建;若太大,
    建议先降 res 烘一张再放大(packer 会做双线性放大并告警)。
    """
    half = size / 2.0
    cell = size / (res - 1)
    mesh = bpy.data.meshes.new(name)
    verts = [None] * (res * res)
    for j in range(res):
        gz = -half + j * cell
        for i in range(res):
            gx = -half + i * cell
            h = heights[j * res + i]
            verts[j * res + i] = (gx, -gz, h)
    faces = []
    for j in range(res - 1):
        for i in range(res - 1):
            a = j * res + i
            b = a + 1
            c = a + res
            d = c + 1
            faces.append((a, c, b))
            faces.append((b, c, d))
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)

    uv = mesh.uv_layers.new(name="WorldUV")
    data = uv.data
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            vi = mesh.loops[li].vertex_index
            gx, gz_blender_y, _h = verts[vi]
            gz = -gz_blender_y
            data[li].uv = ((gx + half) / size, 1.0 - (gz + half) / size)
    return obj


def build_world(sky_strength=1.0):
    """天光: 用 Nishita 天空纹理当纯环境光(与游戏 atmospheric-sky 同族模型)。

    注意: 世界只作为**间接光的来源**。太阳是独立灯,便于单独烘 B 通道。
    """
    world = bpy.data.worlds.new("SKYACE_SKY")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    sky = nt.nodes.new("ShaderNodeTexSky")
    # ⚠ Blender 5.2 把 NISHITA 拆成 SINGLE_/MULTIPLE_SCATTERING(旧枚举已移除) ⇒
    #   这里按"从新到旧"逐个尝试, 全部失败也不让烘焙硬崩(天空只是烘焙环境, 不是主角)。
    for _st in ("MULTIPLE_SCATTERING", "SINGLE_SCATTERING", "NISHITA", "HOSEK_WILKIE", "PREETHAM"):
        try:
            sky.sky_type = _st
            print(f"    [bake] 天空类型 {_st}")
            break
        except Exception:
            continue
    bg.inputs["Strength"].default_value = sky_strength
    nt.links.new(sky.outputs[0], bg.inputs[0])
    nt.links.new(bg.outputs[0], out.inputs[0])
    return world


def build_sun(elevation_deg, azimuth_deg, strength):
    """太阳: 与游戏 sky preset 的方向一致(仰角/方位角,度)。"""
    light_data = bpy.data.lights.new("SKYACE_SUN", type="SUN")
    light_data.energy = strength
    light_data.angle = math.radians(0.53)  # 太阳视角直径,阴影边缘不硬切
    obj = bpy.data.objects.new("SKYACE_SUN", light_data)
    bpy.context.collection.objects.link(obj)
    elev = math.radians(elevation_deg)
    azim = math.radians(azimuth_deg)
    # 太阳光的 -Z 方向 = 光线方向;把灯本体转成"从该仰角/方位照下来"
    obj.rotation_euler = (
        math.pi / 2.0 - elev,   # 从水平面抬起
        0.0,
        azim,
    )
    return obj


def ensure_bake_image(name, res, colorspace="Non-Color"):
    img = bpy.data.images.new(name, res, res, alpha=False, float_buffer=False)
    img.colorspace_settings.name = colorspace
    return img


def add_image_node(obj, img):
    """烘焙目标: 物体必须有材质,且材质里有一个选中状态的图像纹理节点。

    === 关键: 基础色强制纯白 ===
    Blender 的 DIFFUSE 烘焙结果 = 基础色 × 辐照度。我们要的是"光"而不是"材质
    颜色",所以把 Principled 的 Base Color 置成 (1,1,1)、Roughness=1、
    Metallic=0,让结果等价于"纯白漫反射面接收到的光",这样 packer 才不用
    去猜材质反照率。
    """
    mat = obj.data.materials[0] if obj.data.materials else None
    if mat is None:
        mat = bpy.data.materials.new("SKYACE_BAKE")
        mat.use_nodes = True
        obj.data.materials.append(mat)
    nt = mat.node_tree
    for n in nt.nodes:
        if n.type == "BSDF_PRINCIPLED":
            n.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1.0)
            n.inputs["Roughness"].default_value = 1.0
            n.inputs["Metallic"].default_value = 0.0
            for slot in ("Specular IOR Level", "Specular"):
                if slot in n.inputs:
                    n.inputs[slot].default_value = 0.0
                    break
    for n in list(nt.nodes):
        if n.type == "TEX_IMAGE":
            nt.nodes.remove(n)
    node = nt.nodes.new("ShaderNodeTexImage")
    node.image = img
    nt.nodes.active = node
    node.select = True
    return mat


def bake_pass(obj, img, bake_type, **kw):
    add_image_node(obj, img)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = kw.pop("samples", scene.cycles.samples)
    scene.render.bake.use_pass_direct = kw.pop("use_pass_direct", False)
    scene.render.bake.use_pass_indirect = kw.pop("use_pass_indirect", False)
    scene.render.bake.use_pass_color = kw.pop("use_pass_color", False)
    scene.render.bake.margin = kw.pop("margin", 16)
    scene.render.bake.use_clear = True
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.bake(type=bake_type)
    return img


def export_image(img, path, colorspace):
    """把烘焙结果落盘。数据图(Non-Color)不能走 sRGB 编码。"""
    img.colorspace_settings.name = colorspace
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main(opts):
    if not _IN_BLENDER:
        raise SystemExit("本脚本需要在 Blender 内运行: blender -b -P <本文件> -- ...")

    out_dir = opts["out"]
    os.makedirs(out_dir, exist_ok=True)
    res = int(opts["res"])
    size = float(opts["size"])

    if opts["height"]:
        src_res, heights = read_f32bin(opts["height"])
        if src_res != res:
            print("[warn] 高度包 %d² 与 --res %d 不一致:按最近邻重采样" % (src_res, res))
            heights = resample_nearest(heights, src_res, res)
    else:
        raise SystemExit("必须给 --height(游戏 f32bin)或从 GUI 调用")

    reset_scene()
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = int(opts["samples"])
    scene.cycles.use_denoising = True
    # === GPU + 降噪 (per user request) =======================================
    # 用户明确要求 Cycles 用 GPU 并开降噪。降噪本来就开了(上面一行); 这里补 device,
    # 并在没有可用 GPU 时**自动退回 CPU**(不能让烘焙直接失败)。
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'CUDA'      # 这台机器是 GTX 1080(NVIDIA)
        prefs.get_devices()
        gpu = [d for d in prefs.devices if d.type == 'CUDA']
        if gpu:
            for d in prefs.devices:
                d.use = (d.type == 'CUDA')
            scene.cycles.device = 'GPU'
            print(f'    [bake] GPU: {[d.name for d in gpu]} (降噪 OIDN)')
        else:
            scene.cycles.device = 'CPU'
            print('    [bake] 没找到 CUDA 设备 ⇒ 退回 CPU(会慢很多)')
    except Exception as e:
        print(f'    [bake] GPU 设置失败({e}) ⇒ CPU')
    # 输出必须 1:1(任何 view transform / exposure 都会污染数据通道)
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 15

    obj = build_terrain_mesh(res, size, heights)
    build_world(opts["sky_strength"])
    sun = build_sun(opts["sun_elevation"], opts["sun_azimuth"], opts["sun_strength"])
    # 相机: 俯视正交,上方向 = blender +Y(→ 产出即为游戏约定,见文件头第二节)
    cam_data = bpy.data.cameras.new("SKYACE_TOP")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = size
    cam_data.clip_start = 1.0
    cam_data.clip_end = size * 4.0
    cam = bpy.data.objects.new("SKYACE_TOP", cam_data)
    bpy.context.collection.objects.link(cam)
    cam.location = (0.0, 0.0, float(opts["max_height"]) + size * 0.1)
    cam.rotation_euler = (0.0, 0.0, 0.0)   # 看向 -Z,上方向 = +Y
    scene.camera = cam

    only = opts["only"]

    def want(ch):
        return (not only) or (ch in only)

    written = {}

    # --- AO(R) ---
    if want("ao"):
        img = ensure_bake_image("SKYACE_AO", res)
        # AO 只关心几何遮蔽: 关掉太阳,只留天光,否则太阳直射会污染遮蔽判断
        sun.hide_render = True
        bake_pass(obj, img, "AO", samples=min(int(opts["samples"]), 128))
        sun.hide_render = False
        p = os.path.join(out_dir, "bake_ao.png")
        export_image(img, p, "Non-Color")
        written["ao"] = "bake_ao.png"
        print("[ok] AO →", p)

    # --- GI 间接光(G): albedo 临时置 1,只吃间接 → 再按 p95 归一 ---
    if want("gi"):
        img = ensure_bake_image("SKYACE_GI", res)
        sun.hide_render = True
        bake_pass(
            obj, img, "DIFFUSE",
            samples=int(opts["samples"]),
            use_pass_direct=False, use_pass_indirect=True, use_pass_color=False,
        )
        sun.hide_render = False
        p = os.path.join(out_dir, "bake_gi_raw.png")
        export_image(img, p, "Non-Color")
        written["gi_raw"] = "bake_gi_raw.png"
        print("[ok] GI(未归一) →", p, "  ← packer 会按 p95 归一成 0..1")

    # --- 太阳可见度(B): 只留太阳、只烘 direct → 纯投影因子 ---
    if want("sun"):
        img = ensure_bake_image("SKYACE_SUN", res)
        bg = bpy.context.scene.world.node_tree.nodes["Background"]
        sky_saved = bg.inputs["Strength"].default_value
        bg.inputs["Strength"].default_value = 0.0   # 关天光:直射通道不受间接污染
        light_saved = sun.data.energy
        sun.data.energy = 1.0
        bake_pass(
            obj, img, "DIFFUSE",
            samples=max(16, int(opts["samples"]) // 4),
            use_pass_direct=True, use_pass_indirect=False, use_pass_color=False,
        )
        bg.inputs["Strength"].default_value = sky_saved
        sun.data.energy = light_saved
        p = os.path.join(out_dir, "bake_sun_raw.png")
        export_image(img, p, "Non-Color")
        written["sun_raw"] = "bake_sun_raw.png"
        print("[ok] 太阳可见度(未归一) →", p)

    # --- 法线 ---
    if want("normal") and not opts["skip_normal"]:
        img = ensure_bake_image("SKYACE_NRM", res, colorspace="Non-Color")
        p = os.path.join(out_dir, "normal.png")
        bake_pass(obj, img, "NORMAL", samples=16)
        export_image(img, p, "Non-Color")
        written["normal"] = "normal.png"
        print("[ok] 法线 →", p)

    # --- 基础色(可选,sRGB) ---
    if want("color") and not opts["skip_color"]:
        img = ensure_bake_image("SKYACE_COL", res, colorspace="sRGB")
        p = os.path.join(out_dir, "color.png")
        bake_pass(obj, img, "DIFFUSE", samples=16, use_pass_direct=False,
                  use_pass_indirect=False, use_pass_color=True)
        export_image(img, p, "sRGB")
        written["color"] = "color.png"
        print("[ok] 基础色 →", p)

    # --- 高度导出(与输入同域,便于游戏直接换用) ---
    write_f32bin(os.path.join(out_dir, "height.f32bin"), heights)

    sidecar = {
        "format": "skyace-terrain-bake",
        "version": 1,
        "blender": bpy.app.version_string,
        "world": {
            "size": size,
            "maxHeight": float(opts["max_height"]),
            "resX": res,
            "resY": res,
        },
        # --- 约定声明:packer 按这些字段归一化,不做猜测 ---
        "convention": {
            "upAxis": "Y",
            "row0": "-Z",
            "col0": "-X",
            "uv": "u=(x+size/2)/size, v=(z+size/2)/size",
            "transform": {
                "rot": int(opts["rot"]),
                "flipX": bool(opts["flip_x"]),
                "flipY": bool(opts["flip_y"]),
            },
            "channelColorspace": "Non-Color",
            "channels": {"R": "ao", "G": "gi", "B": "sun", "A": "reserved"},
        },
        "sun": {
            "elevationDeg": float(opts["sun_elevation"]),
            "azimuthDeg": float(opts["sun_azimuth"]),
            "strength": float(opts["sun_strength"]),
        },
        "files": written,
        "notes": [
            "bake_gi_raw.png / bake_sun_raw.png 是未归一的线性结果",
            "packer 会把 gi 按 p95 归一、把 sun 按 (raw/N·L) 去调制后截断到 0..1",
        ],
    }
    sp = os.path.join(out_dir, "bake.json")
    with open(sp, "w", encoding="utf-8") as f:
        json.dump(sidecar, f, ensure_ascii=False, indent=2)
    print("[ok] sidecar →", sp)
    return 0


def resample_nearest(vals, src_res, dst_res):
    out = [0.0] * (dst_res * dst_res)
    for j in range(dst_res):
        sj = min(src_res - 1, int(j * src_res / dst_res))
        for i in range(dst_res):
            si = min(src_res - 1, int(i * src_res / dst_res))
            out[j * dst_res + i] = vals[sj * src_res + si]
    return out


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    sys.exit(main(parse_args(list(sys.argv))))
