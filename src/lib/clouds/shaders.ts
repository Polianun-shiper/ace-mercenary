/**
 * Volumetric Cloud Shaders
 * =====================================================================
 * 体积云 GLSL 着色器集合。本文件只导出字符串常量，由
 * `volumetric-cloud-pass.ts` 包装成 ShaderPass 注入 EffectComposer。
 *
 * 设计取舍：
 *   - 不实现独立的 sky / composite pass，因为现有渲染管线已经有
 *     AtmosphericSky + Three.js 主渲染。我们仅作为「云覆盖层」
 *     后处理 pass 存在：读取 tDiffuse (已渲染的场景)，在上面
 *     混合体积云，输出到下一 pass (Bloom 等)。
 *   - 深度遮挡 (uDepthOn=1 时)：由宿主每帧把场景渲进带 DepthTexture
 *     的低清 RT 并传入 —— 还原「相机到遮挡面(山体/机体)距离」后
 *     截断光线步进 tFar：山挡云、云不穿地。无深度输入 (uDepthOn=0)
 *     时退化为旧行为 (云无限延伸)。
 *   - MAX_STEPS / MAX_LIGHT_STEPS 由 ShaderMaterial.defines 注入，
 *     作为编译时常量让 GLSL 循环可被驱动优化。
 */

// ─── 顶点着色器 (全屏 quad, 透传 UV) ─────────────────────
export const CLOUD_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// ─── 噪声基础 (3D Simplex + FBM) ─────────────────────────
export const NOISE_GLSL = /* glsl */ `
// 3D Simplex 噪声 — Ashima Arts (MIT)
vec4 permute(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2  C = vec2(1.0/6.0, 1.0/3.0);
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 =   v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );

  vec3 x1 = x0 - i1 + 1.0 * C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;

  i = mod(i, 289.0);
  vec4 p = permute( permute( permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 1.0/7.0;
  vec3  ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

// 4 倍频 FBM — 细节与性能的平衡
float fbm4(vec3 p){
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++){
    v += a * snoise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}
`;

// ─── 体积云片元着色器 ───────────────────────────────────
//
// 输入:
//   tDiffuse       已渲染的场景颜色 (sky + terrain + aircraft)
//   uInvProjection 逆投影矩阵 (用于从 UV 反推视线方向)
//   uInvView        逆视图矩阵
//   uCameraPos      相机世界坐标
//   uSunDir         太阳方向 (单位向量, 世界空间)
//   uSunColor       太阳颜色 (HDR, 可 >1)
//   uAmbientColor   环境光颜色 (云内阴影区染色)
//   uSunIntensity   太阳强度倍数
//   uTime           时间 (秒)
//   uCoverage       云覆盖率 0..1
//   uDensity        密度倍数 0..2
//   uWindSpeed      风速 0..1
//   uCloudBottom    云层底部世界 Y
//   uCloudTop       云层顶部世界 Y
//   uResolution     渲染分辨率 (像素)
//   uTerrainDepth   场景深度贴图 (低清深度 RT;uDepthOn=1 时启用)
//   uInvViewProj    相机矩阵世界 × 逆投影 (深度反投影用)
//   uDepthOn        0=无深度 (云不遮挡, 旧行为); 1=按深度截断 (山挡云)
//
//   MAX_STEPS / MAX_LIGHT_STEPS 由 ShaderMaterial.defines 注入
//
// 输出: vec4(rgb, 1.0) — 体积云混合后的最终颜色
//
export const CLOUD_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform mat4  uInvProjection;
uniform mat4  uInvView;
uniform mat4  uInvViewProj;
uniform vec3  uCameraPos;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uAmbientColor;
uniform float uSunIntensity;
uniform float uTime;
uniform float uCoverage;
uniform float uDensity;
uniform float uWindSpeed;
uniform float uCloudBottom;
uniform float uCloudTop;
uniform vec2  uResolution;
uniform sampler2D uTerrainDepth;
uniform float uDepthOn;

const float EXTINCTION = 0.014;

${NOISE_GLSL}

// ---- Henyey-Greenstein 相位函数 ----
float henyeyGreenstein(float g, float cosT){
  float g2 = g * g;
  return (1.0 - g2) / pow(max(0.0001, 1.0 + g2 - 2.0 * g * cosT), 1.5);
}

// 双叶相位: 前向散射 + 银边后向散射
float phaseFunction(float cosT){
  float forward = henyeyGreenstein(0.65, cosT);
  float back    = henyeyGreenstein(-0.35, cosT);
  return mix(forward, back, 0.45);
}

// Beer-Powder 定律 — 边缘粉效应
float beerPowder(float d){
  return exp(-d) * (1.0 - exp(-2.0 * d));
}

// 多层高度剖面: 层云(底) + 积云(中) + 卷云(顶)
float heightProfile(float h){
  float stratus = smoothstep(0.0, 0.15, h)  * smoothstep(0.42, 0.22, h);
  float cumulus = smoothstep(0.12, 0.32, h) * smoothstep(0.88, 0.55, h);
  float cirrus  = smoothstep(0.60, 0.82, h) * smoothstep(1.05, 0.92, h);
  return stratus * 0.35 + cumulus * 1.0 + cirrus * 0.28;
}

// 采样程序化云密度场
float sampleDensity(vec3 p){
  float h = (p.y - uCloudBottom) / max(0.0001, uCloudTop - uCloudBottom);
  float hp = heightProfile(h);
  if (hp <= 0.0) return 0.0;

  // 风偏移
  vec3 wind = vec3(uTime * uWindSpeed * 35.0,
                   uTime * uWindSpeed * 4.0,
                   uTime * uWindSpeed * 22.0);
  p += wind;

  vec3 q = p * 0.0008;
  // 主形状 (4 倍频 FBM)
  float n = fbm4(q) * 0.5 + 0.5;
  // 高频细节侵蚀
  float erode = snoise(q * 4.5 + 11.0) * 0.5 + 0.5;
  n = mix(n, n * erode, 0.4);

  float cloud = smoothstep(1.0 - uCoverage, 1.0 - uCoverage * 0.5, n);
  cloud *= hp;
  cloud *= uDensity;
  return clamp(cloud, 0.0, 1.0);
}

// 与云层板 [bottom, top] 求交
vec2 intersectCloudSlab(vec3 ro, vec3 rd){
  if (abs(rd.y) < 1e-4) return vec2(-1.0);
  float tB = (uCloudBottom - ro.y) / rd.y;
  float tT = (uCloudTop    - ro.y) / rd.y;
  float tNear = min(tB, tT);
  float tFar  = max(tB, tT);
  if (tFar < 0.0) return vec2(-1.0);
  tNear = max(tNear, 0.0);
  if (tFar <= tNear) return vec2(-1.0);
  return vec2(tNear, tFar);
}

// 读深度贴图还原「相机到遮挡面(山体等)的直线距离」。
// 无深度输入 / 深度=1.0 (天空等未写深度像素) → 返回无穷 (不截断)。
float readTerrainDistance(vec2 uv, vec3 ro){
  if (uDepthOn < 0.5) return 1e9;
  float depth = texture2D(uTerrainDepth, uv).r;
  if (depth >= 1.0) return 1e9;
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = uInvViewProj * ndc;
  vec3 worldPos = world.xyz / world.w;
  return length(worldPos - ro);
}

// 朝太阳方向步进 (光步), 返回两项:
//   x = 直射光 (Beer-Powder 边缘粉效应)
//   y = 各向同性多次散射近似 (ISO_SCATTER_ALBEDO 吸收)
vec2 lightMarchDual(vec3 p, float stepSize){
  float densityAccum = 0.0;
  for (int j = 0; j < MAX_LIGHT_STEPS; j++){
    vec3 lp = p + uSunDir * stepSize * (float(j) + 0.5);
    densityAccum += sampleDensity(lp) * stepSize;
  }
  float d = densityAccum * EXTINCTION;
  float direct = beerPowder(d);
  const float ISO_SCATTER_ALBEDO = 0.9;
  const float ISO_ATTEN_K        = 0.3;
  float isotropic = ISO_SCATTER_ALBEDO * (1.0 - exp(-ISO_ATTEN_K * max(d, 0.0)));
  return vec2(direct, isotropic);
}

// 主光线步进穿过云体积 (tMax=地形/遮挡距离, 深度截断远端)
// 返回 vec4(scattered, transmittance) — scattered 为 HDR 散射光,
// transmittance 为透射率 (1=完全透明, 0=完全不透明)
vec4 raymarchClouds(vec3 ro, vec3 rd, float tMax){
  vec2 span = intersectCloudSlab(ro, rd);
  if (span.x < 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  // 遮挡面比云 slab 入口还近 → 整条视线上的云都被山挡住 (山挡云核心)
  if (tMax <= span.x) return vec4(0.0, 0.0, 0.0, 1.0);
  float tFar = min(span.y, tMax);

  float dist = tFar - span.x;
  float stepSize = dist / float(MAX_STEPS);

  // 抖动第一步减少条带
  float jitter = fract(sin(dot(vUv * uResolution, vec2(12.9898, 78.233))) * 43758.5453);

  float transmittance = 1.0;
  vec3  scattered = vec3(0.0);

  for (int i = 0; i < MAX_STEPS; i++){
    if (transmittance < 0.005) break;

    float t = span.x + stepSize * (float(i) + jitter);
    vec3  p = ro + rd * t;

    float density = sampleDensity(p);
    if (density <= 0.001) continue;

    // 光步双项: 直射 (下限 0.18 防深处纯黑) + 各向同性多次散射
    vec2  le     = lightMarchDual(p, stepSize * 2.5);
    float direct = max(le.x, 0.18);
    float iso    = le.y;
    float cosT  = dot(rd, uSunDir);
    float phase = phaseFunction(cosT);

    // 高度环境光 — 提高地板值防止底部纯黑
    float h = (p.y - uCloudBottom) / max(0.0001, uCloudTop - uCloudBottom);
    float ambient = mix(0.42, 0.7, h);

    const float ISO_PHASE = 0.0796;
    vec3 sunTerm       = uSunColor * uSunIntensity * direct * phase;
    vec3 isotropicTerm = uSunColor * uSunIntensity * iso * ISO_PHASE * 12.0;
    vec3 ambientTerm   = uAmbientColor * ambient;
    vec3 luminance     = sunTerm + isotropicTerm + ambientTerm;

    float ext = density * stepSize * EXTINCTION;
    transmittance *= exp(-ext);
    scattered += (1.0 - exp(-ext)) * transmittance * luminance;
  }

  // 深度环境光补偿 — 防止远处云内纯黑
  float remainingOpacity = 1.0 - transmittance;
  if (remainingOpacity > 0.01) {
    vec3 deepAmbient = uAmbientColor * 0.6 + uSunColor * uSunIntensity * 0.12;
    scattered += deepAmbient * remainingOpacity * transmittance;
    // 硬性地板: 即使透射率近零也显示暗灰
    scattered = max(scattered, deepAmbient * 0.35 * remainingOpacity);
  }

  return vec4(scattered, transmittance);
}

void main(){
  // 重建世界空间视线方向
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 rayClip = vec4(ndc, -1.0, 1.0);
  vec4 rayEye  = uInvProjection * rayClip;
  rayEye = vec4(rayEye.xy, -1.0, 0.0);
  vec4 rayWorld = uInvView * rayEye;
  vec3 rayDir   = normalize(rayWorld.xyz);

  // 地形/遮挡深度截断: 山体挡在云前则本像素不画云 (uDepthOn=1 时生效)
  float terrainDist = readTerrainDistance(vUv, uCameraPos);
  vec4 clouds = raymarchClouds(uCameraPos, rayDir, terrainDist);

#ifdef CLOUD_RAW_OUTPUT
  // 纯云输出模式 (宿主 Pass 自行合成): 散射 rgb + 透射率 alpha
  gl_FragColor = vec4(clouds.rgb, clouds.a);
#else
  // 旧式单 pass 覆盖模式: 直接与已渲染场景混合输出
  vec3 scene = texture2D(tDiffuse, vUv).rgb;
  vec3 finalColor = mix(clouds.rgb, scene, clouds.a);
  gl_FragColor = vec4(finalColor, 1.0);
#endif
}
`;
