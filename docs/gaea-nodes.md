# Gaea 2 学到的东西（从本机真实图里提取；官方链路实证）

来源：`F:/Gaea 2/Data/Autosaves/glacier_macro_2026-09-09_21-09-41.terrain`（66 节点，你保存过的图）

## `.terrain` 文件结构（读写要点）

- JSON；图在 `Assets.$values[0].Terrain.Nodes`，每个节点形如 `{ $type, Name, Ports.$values, Modifiers }`
- **连线藏在端口自身**：`Ports.$values[i].Record = { From: 源节点id, To: 本节点id, FromPort, ToPort }`
- 端口 `Type` 常见：`PrimaryIn, Required` / `PrimaryOut` / `In` / `Mask`（遮罩口）
- 节点可带 `RenderIntentOverride`（如 `Color`）—— 决定该节点按**颜色**还是**高度**处理

## 这张图用到的节点（统计）

- ? ×65
- Vertical ×1

## 连线（完整邻接表）

```
Combine#525  --In-->  Combine#110
Tint#476  --Input2-->  Combine#110
Combine#212  --In-->  Combine#112
Glacier#989  --Input2-->  Combine#112
Sandstone#315  --In-->  Craggy#157
TextureBase#545  --In-->  SatMap#200
Vertical#355  --In-->  Combine#212
DriftNoise#639  --Input2-->  Combine#212
Rivers#556  --In-->  Adjust#215
Sandstone#315  --In-->  Combine#267
Craggy#157  --Input2-->  Combine#267
DataExtractor#782  --Mask-->  Combine#267
Erosion2#459  --In-->  Sandstone#315
Combine#598  --In-->  Weathering#322
GroundTexture#484  --Height-->  Weathering#322
Sandstone#315  --In-->  TextureBase#332
Combine#607  --In-->  SatMap#349
Glacier#989  --In-->  Vertical#355
Combine#804  --In-->  ColorErosion#392
Lake#910  --Height-->  ColorErosion#392
Debris#462  --In-->  SatMap#395
MultiFractal#249  --In-->  Combine#409
LinearGradient#494  --Input2-->  Combine#409
Weathering#322  --In-->  Combine#431
Snow#948  --Input2-->  Combine#431
ColorErosion#392  --In-->  Combine#437
SatMap#395  --Input2-->  Combine#437
Debris#462  --Mask-->  Combine#437
Lake#910  --In-->  Adjust#444
Combine#510  --In-->  Erosion2#459
Combine#267  --In-->  Debris#462
Flow#966  --Emitter-->  Debris#462
Combine#112  --In-->  Tint#476
Lake#910  --In-->  GroundTexture#484
Combine#409  --In-->  Combine#510
Ridge#813  --Input2-->  Combine#510
Combine#431  --In-->  Combine#525
Weathering#758  --Input2-->  Combine#525
Glacier#989  --Mask-->  Combine#525
ColorErosion#984  --In-->  ColorErosion#527
RadialGradient#339  --Height-->  ColorErosion#527
Glacier#989  --In-->  TextureBase#545
Debris#462  --In-->  Rivers#556
RadialGradient#537  --Headwaters-->  Rivers#556
Sandstone#315  --In-->  Fold#563
Snow#589  --In-->  Flow#587
RadialGradient#944  --Precipitation-->  Flow#587
Snow#948  --In-->  Snow#589
LinearGradient#998  --SnowMap-->  Snow#589
Glacier#989  --In-->  GroundTexture#596
Combine#437  --In-->  Combine#598
SlopeBlur#725  --Input2-->  Combine#598
Adjust#842  --Mask-->  Combine#598
Fold#563  --In-->  Combine#607
TextureBase#332  --Input2-->  Combine#607
Snow#589  --In-->  Combine#608
Snow#948  --Input2-->  Combine#608
Lake#910  --In-->  SatMap#692
SatMap#756  --In-->  SlopeBlur#725
Perlin#768  --Guide-->  SlopeBlur#725
Adjust#444  --In-->  Combine#733
Adjust#215  --Input2-->  Combine#733
Flow#587  --Input3-->  Combine#733
Combine#733  --In-->  SatMap#756
ColorErosion#527  --In-->  Weathering#758
GroundTexture#596  --Height-->  Weathering#758
Sandstone#315  --In-->  DataExtractor#782
GroundTexture#596  --In-->  LightX#802
Combine#110  --Texture-->  LightX#802
SatMap#692  --In-->  Combine#804
SatMap#349  --Input2-->  Combine#804
DataExtractor#782  --Mask-->  Combine#804
Combine#733  --In-->  Adjust#842
Rivers#556  --In-->  Lake#910
GroundTexture#484  --In-->  Snow#948
Combine#267  --In-->  Flow#966
SatMap#200  --In-->  ColorErosion#984
GroundTexture#596  --Height-->  ColorErosion#984
Snow#589  --In-->  Glacier#989
Combine#608  --Reference-->  Glacier#989
Glacier#989  --In-->  NormalsOut#999
Glacier#989  --In-->  AOOut#1000
Glacier#989  --In-->  Unreal#1001
Glacier#989  --In-->  HeightmapExport#1002
Combine#110  --In-->  ColorExport#1003
NormalsOut#999  --In-->  NormalsExport#1004
AOOut#1000  --In-->  AOExport#1005
Glacier#989  --In-->  Forest#1006
Forest#1006  --In-->  ForestMaskExport#1007
```

## 节点可读参数

```
Combine#110 :: Mode=Add
Combine#112 :: Mode=Multiply
Craggy#157 :: Seed=2912
SatMap#200 :: LibraryItem=200, Bias=-0.072750896, Enhance=None, Saturation=-0.24423514, Lightness=0.48457292
Combine#212 :: Mode=Multiply
Adjust#215 :: Autolevel=true
MultiFractal#249 :: Size=0.23973657, FeatureSize=0.18886001, FractalGain=0.3581565, Seed=16336, Variation=-1.479254, VariationContrast=0.11488039, Damping=0.82646304, Bias=0.37854943
Sandstone#315 :: Passes=3, Spacing=0.25273687, Convexity=0.6083254, Direction=89, Seed=570641024
Weathering#322 :: Scale=0.019324455, Creep=0.056349464, WashedOut=true, Dirt=0.03686262, Darker=true
TextureBase#332 :: Seed=1537432448, Version=3
SatMap#349 :: LibraryItem=377, Bias=-0.3120692
Vertical#355 :: Type=Vertical, Falloff=1
ColorErosion#392 :: TransportDistance=2, SedimentDensity=1, Blend=1, ColorHold=1, Seed=266675360
SatMap#395 :: Library=Sand, LibraryItem=97, Bias=0.30139655, Saturation=-0.7041247
Combine#409 :: Mode=Add
Combine#431 :: Mode=Max
Adjust#444 :: Equalize=true
Erosion2#459 :: Duration=14.476795, Downcutting=0.17327054, ErosionScale=2994.207, Seed=5464, CoarseSedimentsDischargeAmount=1, CoarseSedimentsDischargeAngle=14.637057, Version=2
Debris#462 :: DebrisAmount=8000, Friction=0.20639817, Seed=12107, RenderStillRocks=true, Version=3
GroundTexture#484 :: Strength=0.024204584
LinearGradient#494 :: Direction=129, Edge=Clip
Combine#510 :: Mode=Add
ColorErosion#527 :: TransportDistance=1.5812099, SedimentDensity=0.53962326, Blend=0.8533615, ColorHold=0.89428383, LaminarFlow=true, Seed=41461
RadialGradient#537 :: Scale=0.62981486, X=0.43594998, Y=0.42535
TextureBase#545 :: Slope=0.42854822, Scale=0.3817798, Soil=0.43829164, Patches=0.69746673, Chaos=0.71500486, Seed=58825, Version=3
Rivers#556 :: Water=0.99756414, Width=0.50209486, Depth=0.21614161, Downcutting=0.03296525, Headwaters=3982, Seed=1133587328
Fold#563 :: Folds=4.777673
Flow#587 :: FlowLength=1, FlowVolume=0, Seed=32043
Snow#589 :: Duration=0.97028255, Intensity=1, SettleThaw=0.9756081, SnowLine=0.07388763, SlipOffAngle=50.9094, AdheredSnowMass=24.225882, ModelScale=9.730869
Combine#608 :: Mode=Difference
DriftNoise#639 :: Seed=37206
SatMap#692 :: LibraryItem=169, Bias=0.101500206
SlopeBlur#725 :: Intensity=0.047979455, Iterations=2
Combine#733 :: Mode=Max
SatMap#756 :: Library=Blue, LibraryItem=104, Bias=0.113664, Enhance=None, Rough=Med
Weathering#758 :: Scale=0.042708673, Creep=0.7734654, Darker=true
Perlin#768 :: Seed=897005376
LightX#802 :: SunAzimuth=80.40721, SunElevation=27.169535, AngularDiameter=1.8674895, Quality=Ultra, Exposure=1.0901886, SunIntensity=1.2078596, AmbientIntensity=0.9974018, AirDensity=0.59207535, Haze=0.3543358
Ridge#813 :: Scale=0.6117246, Height=1.4767781, Definition=0.548027, Seed=14234
Lake#910 :: Precipitation=6.966548, SmallLakes=1, FloodControl=false, WaterFloor=0.442189, ShoreSize=1, AltitudeBias=0.9927017, SizeBias=0.8102446, Version=2
RadialGradient#944 :: Scale=0.40967476, X=0.39895, Y=0.57265
Snow#948 :: Intensity=0.24589463, SettleThaw=0.68249524, MeltType=Directional, Melt=0.2704974, MeltRemnants=0.22745286, Direction=185, SnowLine=0.11286132, SlipOffAngle=14.170834, AdheredSnowMass=6.9739156, ModelScale=4.125203
Flow#966 :: FlowLength=1, FlowVolume=0.49090615, Seed=46539
ColorErosion#984 :: TransportDistance=1.8580527, SedimentDensity=0.89428383, Blend=0.4967522, ColorHold=1, LaminarFlow=true, Diffusion=0.41545403, Seed=25924
Glacier#989 :: Scale=0.16352712, Scale2=0.28629425, Thickness=0.9858568, Breakage=0.98197466, RoughEdges=true, Seed=45150, Chipped=true, SecondaryBreakage=true, DiagonalBreakage=true, DiagonalBreakageDirection=5, FlowBreakage=true, Extreme=true, FlowBreakageDepth=0.07987155, Substructure=true
LinearGradient#998 :: Direction=145
Forest#1006 :: Seed=7771, Version=2
```

## 结论（给我们的图当范式）

- 官方上色链路在本机图上被实证：**TextureBase → SatMap → ColorErosion**（SatMap 用了 5 个不同区域/风格）；
- 塑形用 **Adjust / Ridge / Craggy / Sandstone / Weathering / Fold / SlopeBlur / DriftNoise** 这类分层加工，而不是一层噪声拍平；
- 出口是 **HeightmapExport / ColorExport / NormalsExport / AOExport / ForestMaskExport**（可直接对应我们管线的 高度/基础色/法线/AO/植被遮罩 五张图）；
- `Combine ×14` 说明"分区域用 Mask 口合并"是这套图的核心手法（每个细节层都带 `Mask` 端口）。
