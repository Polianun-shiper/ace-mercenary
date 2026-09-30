# 资产库政策(新机体 / 贴图 / 地形贴图)

> 政策(用户要求): **今后导入的所有新机体、贴图、各种地形贴图, 一律先压缩, 再放进资产库文件夹。**

## 一条命令完成"压缩 + 入库 + 登记"

```powershell
# 单个文件
node scripts/import-asset.mjs D:\dl\f22.obj --as /models/f22/ --kind airframe

# 一整套(机体 + 贴图, 目录里全部文件)
node scripts/import-asset.mjs D:\dl\f22\* --as /models/f22/ --kind airframe

# 先看效果不写盘
node scripts/import-asset.mjs D:\dl\terrain\*.png --as /textures/terrain/city/ --dry-run

# 入库后立刻构建
node scripts/import-asset.mjs D:\dl\f22\* --as /models/f22/ --build
```

工具会:
1. **压缩**源文件(见下表), 只读源文件, 产物写进 `public/<库路径>`;
2. 把前缀**登记**进 `src/lib/game/asset-library.json`(`copy:true / inline:false / external:true`);
3. 打印下一步。

## 压缩规则

| 源类型 | 处理 | 说明 |
|---|---|---|
| `.obj .mtl .gltf .glb .bin .f32bin .json` | gzip -9 → `<name>.<ext>.gz` | 运行时用 pako.inflate 解回;文本模型常见 5× 以上 |
| `.png .jpg .jpeg .tif .tiff .bmp .webp` | sharp: 最长边 ≤ `--max`(默认 2048) + jpeg q88;有 alpha 自动转 webp q90 | 重编码省不到 12% 且没降分辨率 → **保留原图**(不为几个百分点付生成损失) |
| `.wav .mp3 .ogg .flac` | ffmpeg → mp3 128k | 无 ffmpeg 时原样入库并警告 |
| `.ktx2 .exr` | 原样 | 已压缩 / 需无损 |
| 其它 | 原样 + 警告 | 建议先转成上面的类型 |

地形贴图(Gaea / MWAM)另有专门管线: `scripts/gaea-*.mjs`(高度/色图/法线/AO)、
`scripts/mwam-import.mjs` + `scripts/ktx2-export.mjs`(KTX2 压缩套件)。导入完成后同样
按上面的方式登记前缀。

## 构建后资产在哪

```
dist-single/index.html     ← 上传这个(引擎 + UI)
dist-single/assets/...     ← 资产库文件夹: 新导入资产压缩后的副本(与 index.html 一起上传)
```

`--dev` 构建时镜像到 `dist-test/assets/`(配合 `node scripts/serve-test.mjs`)。

## 单文件自包含(离线双击)怎么办

新导入资产默认**不进**单文件(这正是"HTML 轻量 + 资产随行"的取舍)。需要一份
"双击就能玩"的自包含 HTML 时:

```powershell
node scripts/build-single-html.mjs --inline-library   # 库内资产全部内联(体积 +34% base64)
```

导入时加 `--inline` 也可以只把这一批资产内联。

## 单一真相源

`src/lib/game/asset-library.json` 同时被两边读取, 不允许再各写一份名单:

| 字段 | 含义 |
|---|---|
| `prefix` | 库内路径前缀(目录以 `/` 结尾) |
| `copy` | 构建时拷进 `<out>/assets/` |
| `inline` | 同时内联进单文件(`file://` 双击可用) |
| `external` | 运行时 `assetUrl()` 允许按 `assets` + path 解析 |

- 运行时: `src/lib/game/asset-url.ts` → `isExternalAsset()`
- 构建时: `scripts/build-single-html.mjs` → `collectLibraryFiles()`(并做
  "标了 inline 却没内联" 的一致性自检)

历史资产(F-16C / MiG-29 / mig29 贴图)保持 `inline:true`: 它们受"双击单文件必须能玩"
这条旧要求约束, 移出去会让 `file://` 直接失效。**政策只约束新导入的资产。**
## 附注: `--as` 的两种形式
- **目录**:`--as /models/f22/` —— 登记整目录, 目录内以后新增的文件都算库内资产。
- **单文件**:`--as /models/f22/f22.obj` —— 只登记这一个文件(用于"某个目录大部分已内联,
  只有新文件要走资产库"的情况)。具体条目优先于更宽的目录条目。