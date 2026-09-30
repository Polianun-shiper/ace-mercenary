# Gaea .terrain Schema 盘点(自动生成)

> 扫描目录:C:/Users/Administrator/AppData/Local/Programs/QuadSpinner/Gaea 2/Examples(58 个示例)

## 根级键
- $id ×57
- Assets ×57
- Id ×57
- Branch ×57
- Metadata ×57

## 节点类型(前 30)

| 类型 | 次数 | 常见参数字段 |
|---|---|---|
| Erosion2, Gaea.Nodes | 64 | Downcutting、ErosionScale、Seed、SuspendedLoadDischargeAmount、BedLoadDischargeAmount、CoarseSedimentsDischargeAmount、Name、Duration、CoarseSedimentsDischargeAngle、NodeSize、Shape、ShapeSharpness、ShapeDetailScale、Enable、DirectionalPrecipitation、Direction、RainShadow、Version |
| ? | 57 | 0 |
| SatMap, Gaea.Nodes | 51 | Library、LibraryItem、Name、Bias、Reverse、NodeSize、Enhance、Rough、Range |
| Combine, Gaea.Nodes | 51 | PortCount、Ratio、Mode、Name、NodeSize、RenderIntentOverride、GraphIndex、Enhance |
| Sandstone, Gaea.Nodes | 35 | Passes、Spacing、Chaos、Seed、Chipped、Name、NodeSize、Convexity、Tilt、Direction、Intensity、Iterations、Chipping |
| ColorErosion, Gaea.Nodes | 32 | TransportDistance、SedimentDensity、Blend、Seed、Name、ColorHold、FlowVolume、Diffusion |
| Weathering, Gaea.Nodes | 25 | Scale、Creep、Dirt、Name、RenderIntentOverride、Amount、WashedOut、Darker、Inverse |
| TextureBase, Gaea.Nodes | 20 | Scale、Seed、Version、Name、Slope、Soil、Chaos、Patches、NodeSize、Peaks、Enhance |
| Mountain, Gaea.Nodes | 18 | Seed、Name、Scale、Height、Style、Bulk、ReduceDetails、X、Y |
| Adjust, Gaea.Nodes | 17 | Autolevel、Strong、Name、NodeSize、RenderIntentOverride、Shaper、Invert、Drop、Multiply、Equalize |
| Outcrops, Gaea.Nodes | 17 | Seed、Height、Name、NodeSize、Rotation、Strata、Shape、Variations、Density、Chipped、Size |
| Stratify, Gaea.Nodes | 15 | Spacing、Shape、Seed、Name、Direction、Intensity、TiltAmount、Octaves、NodeSize、RenderIntentOverride |
| Ridge, Gaea.Nodes | 9 | Height、Definition、Seed、Name |
| RadialGradient, Gaea.Nodes | 9 | Scale、Name、NodeSize、GraphIndex、X、Y、Height |
| Debris, Gaea.Nodes | 7 | DebrisAmount、Friction、Restitution、Size、Seed、Name、AmountMultiplier、Shape、Version |
| Mixer, Gaea.Nodes | 6 | PortCount、Layer1、Layer2、Layer3、Layer4、Layer5、Layer6、Layer7、Layer8、Layer9、Layer10、Layer11、Layer12、Layer13、Layer14、Layer15、Version、Name |
| Crumble, Gaea.Nodes | 6 | Name、Duration、Strength、Horizontal、Edge、Downcutting、NodeSize |
| Trees, Gaea.Nodes | 5 | TreeCount、TreeSize、Seed、Patches、DeadFlow、Chaos、Version、Name、DilateTreeStamp、AvoidTrees、Random、SimulationBias、Trim、Health、Slope、Altitude、AltitudeFalloff、CustomInfluence |
| Canyon, Gaea.Nodes | 5 | Valley、Depth、Seed、Name、Style、Scale、Slot、Surrounding、StructualWarp、DetailWarp |
| Rivers, Gaea.Nodes | 5 | Water、Width、Depth、RiverValleyWidth、Headwaters、Seed、Name、Downcutting、RenderSurface |
| MountainSide, Gaea.Nodes | 5 | Seed、Name、Scale、Detail、Style |
| Craggy, Gaea.Nodes | 5 | Size、Depth、Shape、Seed、Name |
| Fold, Gaea.Nodes | 5 | Waveform、Folds、Name、RenderIntentOverride、NodeSize、Symmetric |
| Height, Gaea.Nodes | 4 | Range、Falloff、Name |
| Shade, Gaea.Nodes | 4 | SunAzimuth、SunElevation、Sunlight、SoftShadows、Name、SaveDefinition、ShadeBias、RenderStyle、ReflectedLight |
| Slump, Gaea.Nodes | 4 | Scale、Seed、Name |
| File, Gaea.Nodes | 4 | FileName、RelativePath、IsRGB、Name、NodeSize |
| GroundTexture, Gaea.Nodes | 4 | Name、Strength、Coverage、Density |
| Snow, Gaea.Nodes | 4 | Duration、Intensity、SettleThaw、Melt、SlipOffAngle、AdheredSnowMass、ModelScale、Seed、Name、MeltType、SnowLine、NodeSize |
| Cellular3D, Gaea.Nodes | 4 | Gap、JitterX、JitterY、ScaleX、ScaleY、Seed、Version、Name、Size、JitterZ、ScaleZ |

## 输出/网格/变量类节点

### File, Gaea.Nodes

- ColorErosion with Bitmaps.terrain :: File — keys: FileName、RelativePath、IsRGB、Name
- Complex Scene - Debris.terrain :: File — keys: FileName、RelativePath、IsRGB、Name、NodeSize
- Complex Scene - Debris.terrain :: File — keys: FileName、RelativePath、IsRGB、Name、NodeSize
- Technical - Using Switch.terrain :: File — keys: Name
