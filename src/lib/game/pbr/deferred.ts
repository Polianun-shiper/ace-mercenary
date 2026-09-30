// === 延迟渲染实验管线 (per user request: 设置里可选渲染管线) ===
// Hybrid deferred renderer:
//   Pass 1 — G-Buffer (MRT ×4): PBR materials write albedo / view-normal /
//            metallic-roughness-ao / emissive into a WebGLRenderTarget with
//            count=4 (three's WebGLState sets gl.drawBuffers automatically).
//            PBR objects live on camera LAYER 1 (disabled on layer 0) so the
//            forward composite pass only draws sky/water/clouds/particles.
//   Pass 2 — Lighting: fullscreen quad — sun (with shadow map) + hemisphere
//            ambient + fog approximation. Output is linear (the existing
//            composer's OutputPass applies tone mapping afterwards).
//   Pass 3 — Forward composite: layer-0 objects (sky, ocean, clouds, effects)
//            render on top of the lit color with autoClear=false.
//
// Known experimental limitations (documented, not bugs):
//   - No weapon point lights (muzzle flashes/explosions don't relight the
//     deferred surface — they still work fully in forward mode).
//   - CSM cascades not sampled (only the active single shadow map; CSM is
//     bypassed in deferred mode).
//   - Material-side lighting is still computed in the G-Buffer pass (the
//     result is discarded); the cost is acceptable for an experimental path.

import * as THREE from 'three';

const GBUFFER_COUNT = 4;

export type PipelineMode = 'forward' | 'deferred';

// Global flag so spawn-time code (buildAircraftMesh etc.) can place new PBR
// meshes on the deferred layer without an engine reference.
let deferredActive = false;
export function isDeferredActive(): boolean {
  return deferredActive;
}
export function setDeferredActive(b: boolean) {
  deferredActive = b;
}

// Camera layer reserved for G-Buffer (PBR) objects.
export const DEFERRED_LAYER = 1;

const LIGHT_QUAD_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

const LIGHT_QUAD_FRAG = `
#define PI 3.141592653589793
uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform sampler2D uMra;
uniform sampler2D uEmissive;
uniform sampler2D uDepth;
uniform mat4 uInvProj;
uniform vec3 uSunDir;          // view space
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uHemiSky;
uniform vec3 uHemiGround;
uniform vec3 uAmbient;
uniform float uAmbientIntensity;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uDebugView; // 0=lit, 1=albedo, 2=normal, 3=depth
// === IBL (per user request: 现代化光照) ===
uniform sampler2D uEnvMap;    // PMREM cube-uv (scene.environment)
uniform float uEnvIntensity;
uniform float uEnvTexelW;
uniform float uEnvTexelH;
uniform float uEnvMaxMip;
uniform mat3 uViewMat3;       // view -> world (normal/dir transform)
uniform vec3 uCamPos;         // camera world position (view-space origin)
// === 阴影 (per user request: P3) ===
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowEnabled;
uniform vec2 uShadowTexel;
// === 多点光源 (per user request: P3) ===
uniform vec3 uPointPos[8];
uniform vec3 uPointColor[8];
uniform float uPointRange[8];
uniform int uPointCount;
varying vec2 vUv;

// ---------- cube-uv PMREM sampling (self-contained, mirrors three) ----------
float getFace( vec3 dir ) {
  vec3 a = abs( dir );
  float face = -1.0;
  if ( a.x > a.z ) {
    face = a.x > a.y ? ( dir.x > 0.0 ? 0.0 : 3.0 ) : ( dir.y > 0.0 ? 1.0 : 4.0 );
  } else {
    face = a.z > a.y ? ( dir.z > 0.0 ? 2.0 : 5.0 ) : ( dir.y > 0.0 ? 1.0 : 4.0 );
  }
  return face;
}
vec2 getUV( vec3 dir, float face ) {
  vec2 uv;
  if ( face == 0.0 ) uv = vec2( dir.z, dir.y ) / abs( dir.x );
  else if ( face == 1.0 ) uv = vec2( -dir.x, -dir.z ) / abs( dir.y );
  else if ( face == 2.0 ) uv = vec2( -dir.x, dir.y ) / abs( dir.z );
  else if ( face == 3.0 ) uv = vec2( -dir.z, dir.y ) / abs( dir.x );
  else if ( face == 4.0 ) uv = vec2( -dir.x, dir.z ) / abs( dir.y );
  else uv = vec2( dir.x, dir.y ) / abs( dir.z );
  return 0.5 * ( uv + 1.0 );
}
vec3 bilinearCubeUV( vec3 dir, float mipInt ) {
  const float minMip = 4.0;
  const float minTile = 16.0;
  float face = getFace( dir );
  float filterInt = max( minMip - mipInt, 0.0 );
  mipInt = max( mipInt, minMip );
  float faceSize = exp2( mipInt );
  vec2 uv = getUV( dir, face ) * ( faceSize - 2.0 ) + 1.0;
  if ( face > 2.0 ) { uv.y += faceSize; face -= 3.0; }
  uv.x += face * faceSize;
  uv.x += filterInt * 3.0 * minTile;
  uv.y += 4.0 * ( exp2( uEnvMaxMip ) - faceSize );
  uv.x *= uEnvTexelW;
  uv.y *= uEnvTexelH;
  return texture2D( uEnvMap, uv ).rgb;
}
float roughnessToMip( float r ) {
  float mip = 0.0;
  if ( r >= 0.8 ) mip = ( 1.0 - r ) * ( -1.0 - -2.0 ) / ( 1.0 - 0.8 ) + -2.0;
  else if ( r >= 0.4 ) mip = ( 0.8 - r ) * ( 2.0 - -1.0 ) / ( 0.8 - 0.4 ) + -1.0;
  else if ( r >= 0.305 ) mip = ( 0.4 - r ) * ( 3.0 - 2.0 ) / ( 0.4 - 0.305 ) + 2.0;
  else if ( r >= 0.21 ) mip = ( 0.305 - r ) * ( 4.0 - 3.0 ) / ( 0.305 - 0.21 ) + 3.0;
  else mip = -2.0 * log2( 1.16 * r );
  return mip;
}
vec3 textureCubeUV( vec3 dir, float roughness ) {
  float mip = clamp( roughnessToMip( roughness ), -2.0, uEnvMaxMip );
  float mipF = fract( mip );
  float mipInt = floor( mip );
  vec3 c0 = bilinearCubeUV( dir, mipInt );
  if ( mipF == 0.0 ) return c0;
  vec3 c1 = bilinearCubeUV( dir, mipInt + 1.0 );
  return mix( c0, c1, mipF );
}
vec3 getIBLIrradiance( vec3 worldN ) {
  return PI * textureCubeUV( worldN, 1.0 ) * uEnvIntensity;
}
vec3 getIBLRadiance( vec3 worldReflect, float roughness ) {
  return textureCubeUV( worldReflect, roughness ) * uEnvIntensity;
}

// ---------- Cook-Torrance GGX ----------
float D_GGX( float a2, float ndh ) {
  float d = ndh * ndh * ( a2 - 1.0 ) + 1.0;
  return a2 / max( PI * d * d, 1e-5 );
}
float G_Smith( float a, float ndl, float ndv ) {
  float k = a * 0.5;
  return ndl / max( ndl * ( 1.0 - k ) + k, 1e-5 ) * ndv / max( ndv * ( 1.0 - k ) + k, 1e-5 );
}
vec3 F_Schlick( vec3 f0, float ndv ) {
  return f0 + ( 1.0 - f0 ) * pow( max( 1.0 - ndv, 0.0 ), 5.0 );
}

void main() {
  vec2 uv = vUv;
  vec3 albedo = texture2D( uAlbedo, uv ).rgb;
  vec3 viewN = normalize( texture2D( uNormal, uv ).xyz * 2.0 - 1.0 );
  float depth = texture2D( uDepth, uv ).r;
  // === Debug G-Buffer channels (per user request: 控制台 G-Buffer 通道) ===
  // 1=albedo 2=depth 3=normal 4=roughness 5=metalness 6=ao 7=emissive.
  if ( uDebugView > 1.5 ) { gl_FragColor = vec4( vec3( depth ), 1.0 ); return; }
  if ( uDebugView > 0.5 && uDebugView < 2.5 ) { gl_FragColor = vec4( albedo, 1.0 ); return; }
  if ( depth >= 1.0 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }
  vec4 clip = vec4( uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
  vec4 view = uInvProj * clip;
  vec3 viewPos = view.xyz / view.w;

  vec3 mra = texture2D( uMra, uv ).xyz;
  float metal = mra.x;
  float rough = clamp( mra.y, 0.045, 1.0 );
  float ao = mra.z;
  vec3 emissive = texture2D( uEmissive, uv ).rgb;

  // === Debug G-Buffer channels (channels 3-7, after mra/emissive sampled) ===
  if ( uDebugView > 6.5 ) { gl_FragColor = vec4( emissive, 1.0 ); return; }
  if ( uDebugView > 5.5 ) { gl_FragColor = vec4( vec3( ao ), 1.0 ); return; }
  if ( uDebugView > 4.5 ) { gl_FragColor = vec4( vec3( metal ), 1.0 ); return; }
  if ( uDebugView > 3.5 ) { gl_FragColor = vec4( vec3( rough ), 1.0 ); return; }
  if ( uDebugView > 2.5 ) { gl_FragColor = vec4( viewN * 0.5 + 0.5, 1.0 ); return; }

  vec3 V = normalize( -viewPos );
  float ndv = max( dot( viewN, V ), 1e-4 );
  vec3 f0 = mix( vec3( 0.04 ), albedo, metal );
  vec3 worldN = normalize( uViewMat3 * viewN );
  vec3 worldV = normalize( uViewMat3 * V );
  vec3 worldReflect = reflect( -worldV, worldN );

  // === IBL 环境 (per user request: P2 现代化光照) ===
  vec3 iblDiffuse = getIBLIrradiance( worldN ) * albedo * ( 1.0 - metal );
  float a = rough * rough;
  float a2 = a * a;
  vec3 iblSpec = getIBLRadiance( worldReflect, rough ) * ( f0 * ( 1.0 - a ) + a );

  // === 半球环境 + ambient ===
  vec3 hemi = mix( uHemiGround, uHemiSky, viewN.y * 0.5 + 0.5 ) * uAmbientIntensity + uAmbient;

  // === 太阳直射 (Cook-Torrance) + 阴影 ===
  vec3 L = normalize( uSunDir );
  float ndl = max( dot( viewN, L ), 0.0 );
  vec3 H = normalize( V + L );
  float ndh = max( dot( viewN, H ), 0.0 );
  float vdh = max( dot( V, H ), 1e-4 );
  float D = D_GGX( a2, ndh );
  float G = G_Smith( a, ndl, ndv );
  vec3 F = F_Schlick( f0, vdh );
  vec3 spec = D * G * F / max( 4.0 * ndv * ndl, 1e-4 );
  float shadow = 1.0;
  if ( uShadowEnabled > 0.5 ) {
    vec3 wp = uCamPos + uViewMat3 * viewPos;
    vec4 sc = uShadowMatrix * vec4( wp, 1.0 );
    vec3 ndc = sc.xyz / sc.w;
    vec2 suv = ndc.xy * 0.5 + 0.5;
    if ( suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0 && ndc.z < 1.0 ) {
      float sd = ndc.z * 0.5 + 0.5 - 0.0025;
      float s0 = texture2D( uShadowMap, suv ).x;
      float s1 = texture2D( uShadowMap, suv + uShadowTexel ).x;
      float s2 = texture2D( uShadowMap, suv + vec2( 0.0, uShadowTexel.y ) ).x;
      float s3 = texture2D( uShadowMap, suv + vec2( uShadowTexel.x, 0.0 ) ).x;
      shadow = ( step( sd, s0 ) + step( sd, s1 ) + step( sd, s2 ) + step( sd, s3 ) ) * 0.25;
    }
  }
  vec3 sun = ( albedo * ( 1.0 - metal ) + spec ) * uSunColor * uSunIntensity * ndl * shadow;

  // === 多点光源 (per user request: P3) ===
  vec3 pointLight = vec3( 0.0 );
  for ( int i = 0; i < 8; i++ ) {
    if ( i >= uPointCount ) break;
    vec3 toL = uPointPos[i] - viewPos;
    float dist = length( toL );
    vec3 pl = toL / max( dist, 1e-4 );
    float atten = max( 1.0 - dist / max( uPointRange[i], 1e-4 ), 0.0 );
    atten *= atten;
    float pndl = max( dot( viewN, pl ), 0.0 );
    vec3 pH = normalize( V + pl );
    float pndh = max( dot( viewN, pH ), 0.0 );
    float pvdh = max( dot( V, pH ), 1e-4 );
    vec3 pspec = D_GGX( a2, pndh ) * G_Smith( a, pndl, ndv ) * F_Schlick( f0, pvdh ) / max( 4.0 * ndv * pndl, 1e-4 );
    pointLight += ( albedo * ( 1.0 - metal ) + pspec ) * uPointColor[i] * pndl * atten;
  }

  vec3 color = emissive + ao * ( hemi * albedo + iblDiffuse + iblSpec + sun + pointLight );

  // === FogExp2 近似 ===
  float dist = length( viewPos );
  float fogF = 1.0 - exp( -uFogDensity * uFogDensity * dist * dist );
  color = mix( color, uFogColor, clamp( fogF, 0.0, 1.0 ) );

  gl_FragColor = vec4( color, 1.0 );
}`;

export class DeferredPipeline {
  gbuffer: THREE.WebGLRenderTarget;
  private lightMat: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private width: number;
  private height: number;
  private renderer: THREE.WebGLRenderer;
  private disposed = false;
  private quadGeo: THREE.BufferGeometry | null = null;
  // World-space sun direction — transformed to view space per frame in render()
  // (stored separately so it isn't re-transformed every frame).
  private sunDirWorld = new THREE.Vector3(0, 0, -1);

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.width = Math.max(1, Math.floor(renderer.domElement.width / 1));
    this.height = Math.max(1, Math.floor(renderer.domElement.height / 1));
    this.gbuffer = new THREE.WebGLRenderTarget(this.width, this.height, {
      count: GBUFFER_COUNT,
      // === UnsignedByteType MRT (per user request) ===
      // Float/HalfFloat color attachments need EXT_color_buffer_(half_)float
      // which is NOT guaranteed on WebGL2 — on the IAB/ANGLE it makes the
      // framebuffer incomplete and the G-Buffer silently renders black.
      // UnsignedByte RGBA ×4 is core WebGL2 (always works). Depth goes in a
      // separate native DepthTexture (24-bit, correct format).
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      depthTexture: new THREE.DepthTexture(this.width, this.height),
    });
    this.lightMat = new THREE.ShaderMaterial({
      vertexShader: LIGHT_QUAD_VERT,
      fragmentShader: LIGHT_QUAD_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uAlbedo: { value: null },
        uNormal: { value: null },
        uMra: { value: null },
        uEmissive: { value: null },
        uDepth: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uSunDir: { value: new THREE.Vector3(0, 0, -1) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSunIntensity: { value: 1 },
        uHemiSky: { value: new THREE.Color(0.4, 0.6, 1) },
        uHemiGround: { value: new THREE.Color(0.2, 0.15, 0.1) },
        uAmbient: { value: new THREE.Color(0, 0, 0) },
        uAmbientIntensity: { value: 0.5 },
        uFogColor: { value: new THREE.Color(0.8, 0.85, 0.9) },
        uFogDensity: { value: 0.00008 },
        uDebugView: { value: 0 },
        // === IBL (per user request: P2 现代化光照) ===
        uEnvMap: { value: null },
        uEnvIntensity: { value: 0.7 },
        uEnvTexelW: { value: 1 / 336 },
        uEnvTexelH: { value: 1 / 256 },
        uEnvMaxMip: { value: 6 },
        uViewMat3: { value: new THREE.Matrix3() },
        uCamPos: { value: new THREE.Vector3() },
        // === 阴影 (per user request: P3) ===
        uShadowMap: { value: null },
        uShadowMatrix: { value: new THREE.Matrix4() },
        uShadowEnabled: { value: 0 },
        uShadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
        // === 多点光源 (per user request: P3) ===
        uPointPos: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
        uPointColor: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()] },
        uPointRange: { value: [0, 0, 0, 0, 0, 0, 0, 0] },
        uPointCount: { value: 0 },
      },
    });
    // === 手写全屏 quad (per user request: 延迟模式修复) ===
    // position ↔ uv ↔ NDC 方向完全确定,不依赖 PlaneGeometry 的内部 UV
    // 约定:NDC y=-1(屏幕底部)↔ uv v=0 ↔ 采样纹理第一行。
    const quadGeo = new THREE.BufferGeometry();
    quadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0,  1, -1, 0,  1, 1, 0,  -1, 1, 0,
    ]), 3));
    quadGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0,  1, 0,  1, 1,  0, 1,
    ]), 2));
    quadGeo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    this.quad = new THREE.Mesh(quadGeo, this.lightMat);
    this.quadGeo = quadGeo;
    this.quad.frustumCulled = false;
  }

  setSize(w: number, h: number) {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.gbuffer.setSize(this.width, this.height);
  }

  /** Debug: 0=lit, 1=albedo, 2=normal, 3=depth. */
  setDebugView(mode: number) {
    this.lightMat.uniforms.uDebugView.value = mode;
  }

  /** Push the current sun/hemi/ambient/fog/env/shadow/point-light state into the lighting pass. */
  setEnvironment(opts: {
    sunDirWorld: THREE.Vector3;
    sunColor: THREE.Color;
    sunIntensity: number;
    hemiSky: THREE.Color;
    hemiGround: THREE.Color;
    ambient: THREE.Color;
    ambientIntensity: number;
    fogColor: THREE.Color;
    fogDensity: number;
    envMap?: THREE.Texture | null;
    envIntensity?: number;
    shadow?: { map: THREE.Texture; matrix: THREE.Matrix4 } | null;
    pointLights?: { pos: THREE.Vector3; color: THREE.Color; range: number }[];
  }) {
    const u = this.lightMat.uniforms;
    (u.uSunColor.value as THREE.Color).copy(opts.sunColor);
    u.uSunIntensity.value = opts.sunIntensity;
    this.sunDirWorld.copy(opts.sunDirWorld);
    (u.uHemiSky.value as THREE.Color).copy(opts.hemiSky);
    (u.uHemiGround.value as THREE.Color).copy(opts.hemiGround);
    (u.uAmbient.value as THREE.Color).copy(opts.ambient);
    u.uAmbientIntensity.value = opts.ambientIntensity;
    (u.uFogColor.value as THREE.Color).copy(opts.fogColor);
    u.uFogDensity.value = opts.fogDensity;
    // === IBL (per user request: P2) ===
    if (opts.envMap) {
      u.uEnvMap.value = opts.envMap;
      u.uEnvIntensity.value = opts.envIntensity ?? 0.7;
      const h = (opts.envMap.image as { height?: number } | undefined)?.height ?? 256;
      const maxMip = Math.log2(h) - 2;
      u.uEnvTexelH.value = 1 / h;
      u.uEnvTexelW.value = 1 / (3 * Math.max(Math.pow(2, maxMip), 7 * 16));
      u.uEnvMaxMip.value = maxMip;
    } else {
      u.uEnvMap.value = null;
    }
    // === 阴影 (per user request: P3) ===
    if (opts.shadow && opts.shadow.map) {
      u.uShadowMap.value = opts.shadow.map;
      (u.uShadowMatrix.value as THREE.Matrix4).copy(opts.shadow.matrix);
      const tw = (opts.shadow.map.image as { width?: number } | undefined)?.width ?? 2048;
      const th = (opts.shadow.map.image as { height?: number } | undefined)?.height ?? 2048;
      (u.uShadowTexel.value as THREE.Vector2).set(1 / tw, 1 / th);
      u.uShadowEnabled.value = 1;
    } else {
      u.uShadowEnabled.value = 0;
    }
    // === 多点光源 (per user request: P3) ===
    const posArr = u.uPointPos.value as THREE.Vector3[];
    const colArr = u.uPointColor.value as THREE.Color[];
    const rangeArr = u.uPointRange.value as number[];
    const lights = opts.pointLights ?? [];
    for (let i = 0; i < 8; i++) {
      if (i < lights.length) {
        posArr[i].copy(lights[i].pos);
        colArr[i].copy(lights[i].color);
        rangeArr[i] = lights[i].range;
      } else {
        rangeArr[i] = 0;
      }
    }
    u.uPointCount.value = Math.min(lights.length, 8);
  }

  /**
   * Render the scene deferred into `target` (renderer render target or null
   * for screen). Scene objects on DEFERRED_LAYER feed the G-Buffer; layer-0
   * objects (sky/water/clouds/effects) composite on top afterwards.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget | null) {
    const u = this.lightMat.uniforms;
    // Transform the (world-space) sun direction into view space for lighting.
    const sunDirView = this.sunDirWorld.clone().transformDirection(camera.matrixWorldInverse);
    (u.uSunDir.value as THREE.Vector3).copy(sunDirView);
    (u.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrix).invert();
    // view -> world matrix (for IBL normal/dir transform + shadow world pos).
    (u.uViewMat3.value as THREE.Matrix3).setFromMatrix4(camera.matrixWorld);
    (u.uCamPos.value as THREE.Vector3).copy(camera.position);
    // scene.environment (PMREM cube-uv) for IBL — bound once, sampled in shader.
    if (scene.environment) u.uEnvMap.value = scene.environment;

    // --- Pass 1: G-Buffer (PBR objects on layer 1) ---
    const prevLayers = camera.layers.mask;
    camera.layers.set(DEFERRED_LAYER);
    renderer.setRenderTarget(this.gbuffer);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    // --- Pass 2: lighting into target ---
    camera.layers.set(0);
    u.uAlbedo.value = this.gbuffer.textures[0];
    u.uNormal.value = this.gbuffer.textures[1];
    u.uMra.value = this.gbuffer.textures[2];
    u.uEmissive.value = this.gbuffer.textures[3];
    u.uDepth.value = this.gbuffer.depthTexture;
    renderer.setRenderTarget(target);
    renderer.clear(true, true, true);
    renderer.render(this.quad, this.ortho);

    // --- Pass 3: forward composite (layer 0) on top of the lit color ---
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(scene, camera);
    renderer.autoClear = autoClear;

    camera.layers.mask = prevLayers;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.gbuffer.dispose();
    this.lightMat.dispose();
    this.quadGeo?.dispose();
  }
}
