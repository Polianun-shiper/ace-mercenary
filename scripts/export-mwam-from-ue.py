# scripts/export-mwam-from-ue.py
#
# UE5.8 编辑器兜底导出:把 .uasset 里没有内嵌 PNG(提取脚本抠不出)的
# MWAM 贴图用 UE 官方导出器转成 PNG/TGA 落盘。
#
# 用法(两种都行,任选其一):
#   1. 打开 vngi1.uproject → 菜单 Edit > Editor Preferences 开 Python;
#      Python Console(Window > Developer Tools > Python)里粘贴:
#          exec(open(r"E:\ipbeifen2\scripts\export-mwam-from-ue.py").read())
#   2. 命令行(编辑器不打开,需项目可用):
#          UnrealEditor-Cmd.exe "G:\test1\vngi1\vngi1.uproject" \
#              -run=pythonscript -script="E:\ipbeifen2\scripts\export-mwam-from-ue.py"
#
# 产物写到 E:\ipbeifen2\textures-src\mwam\<layer>\<channel>.png|tga,
# 之后跑 node scripts/mwam-import.mjs 会统一缩放到 1024 + KTX2 编码。
# 无论导出成 .png 还是 .tga 都能被 sharp 解码,无需改 import 脚本。
import os
import sys
import unreal  # noqa: F401  (在 UE 编辑器内运行时才有此模块)

OUT_ROOT = r"E:\ipbeifen2\textures-src\mwam"

# (asset 路径, 层名, 通道)
ASSETS = [
    (r"/Game/MWLandscapeAutoMaterial/Textures/Ground/TEX_MWAM_Grass_col", "grass", "albedo"),
    (r"/Game/MWLandscapeAutoMaterial/Textures/Cover/TEX_MWAM_CoverRocks_col", "cover_rocks", "albedo"),
    (r"/Game/MWLandscapeAutoMaterial/Textures/Cover/TEX_MWAM_CoverRocks_nrm", "cover_rocks", "normal"),
    (r"/Game/MWLandscapeAutoMaterial/Textures/Extra/TEX_MWAM_Variation_msk", "variation", "mask"),
    (r"/Game/MWLandscapeAutoMaterial/Textures/Plants/TEX_MWAM_Grass_col", "plants_grass", "albedo"),
    (r"/Game/MWLandscapeAutoMaterial/Textures/Plants/TEX_MWAM_Grass_nrm", "plants_grass", "normal"),
]


def main():
    exported_any = False
    for asset_path, layer, channel in ASSETS:
        out_dir = os.path.join(OUT_ROOT, layer)
        os.makedirs(out_dir, exist_ok=True)
        asset = unreal.load_asset(asset_path)
        if asset is None:
            print("[skip] cannot load", asset_path)
            continue

        ok = False
        # 1) 首选:AssetExportTask 显式 PNG(5.x 有 TextureExporterPNG)
        try:
            task = unreal.AssetExportTask()
            task.set_editor_property("object", asset)
            task.set_editor_property("filename", os.path.join(out_dir, channel + ".png"))
            task.set_editor_property("selected", False)
            task.set_editor_property("replace_identical", True)
            task.set_editor_property("prompt", False)
            task.set_editor_property("automated", True)
            png_exporter = getattr(unreal, "TextureExporterPNG", None)
            if png_exporter is not None:
                task.set_editor_property("exporter", png_exporter())
            unreal.Exporter.run_asset_export_task(task)
            if os.path.exists(task.get_editor_property("filename")):
                print("[ok]", asset_path, "->", task.get_editor_property("filename"))
                exported_any = True
                ok = True
        except Exception as e:  # noqa: BLE001
            print("[warn] AssetExportTask failed:", e)

        # 2) 兜底:AssetTools.export_assets(默认导出器,可能是 .tga)
        if not ok:
            try:
                tools = unreal.AssetToolsHelpers.get_asset_tools()
                tools.export_assets([asset], out_dir)
                for f in os.listdir(out_dir):
                    base = os.path.splitext(f)[0]
                    if base == channel or base.endswith("_" + channel):
                        print("[ok]", asset_path, "->", os.path.join(out_dir, f))
                        exported_any = True
                        ok = True
                        break
            except Exception as e:  # noqa: BLE001
                print("[warn] export_assets failed:", e)
        if not ok:
            print("[FAIL]", asset_path)

    print("done." if exported_any else "nothing exported — check project paths / asset names")


if __name__ == "__main__":
    main()
