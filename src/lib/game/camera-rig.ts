import * as THREE from 'three';
import type { CameraMode } from './types';
import { readTuning } from './tuning';

// Smooth follow chase cam with look-ahead, FOV kick on speed, multiple modes,
// mouse-wheel zoom, and inertia-based drag/weight feel during maneuvers.
// === 相机"跟不上"的误差阈值 (per fix: 高负载下相机滞后) ===
// 单位是世界距离(机体尺度约 10)。超过 SOFT 开始提高跟随刚度, 到 HARD 时
// 因子抬到 1.0(瞬时贴合)。正常飞行手感不变, 只在真被拉开时救回来。
// ⚠️ 已废弃(不再生效): 相机瞬移补救已删除, 见 update() 里的"速度前馈"注释。
const CAM_SNAP_SOFT = 6;
const CAM_SNAP_HARD = 18;
/**
 * === 鼠标操控模式(新相机)的隐形视野球**默认**偏移 (per user request) ===
 * 语义: 视野球 = 相机永远注视的那个点(世界坐标, 相对机体位置的固定偏移, 不随机体旋转)。
 * x = 世界右, y = **世界上**, z = 世界后 (world units; 机体尺度约 10)。
 *
 * 为什么 y 取**正**(球在机体上方): 球是相机的注视点, 所以球永远落在画面正中;
 * 机体相对球在**下方** → 机体出现在画面**中下方**。y 取负则机体被顶到画面上方 ——
 * 这正是之前写反的那次(用户反馈"应该在视野中下方, 不是上方")。
 * 角度量级: 45° 的机头方向下, 相机距球 42, 偏移 5 约等于 6.8°, 即机体偏离画面中心
 * 约 7°(垂直 FOV 60° 的 23%)——"中下方"是轻微下移, 不是贴底。
 *
 * 机库里的"视野中心"滑杆调的就是这个值, 两边必须用同一个默认值(以前机库缺省 {0,0,0}
 * 且挂载即回写, 会把引擎的默认值悄悄抹掉), 所以这里导出共享。
 */
export const CAM_BALL_DEFAULT = { x: 0, y: 5, z: 0 };
export class CameraRig {
  /**
   * 机体速度(世界单位/秒) —— 相机跟随的**前馈**输入。
   * 引擎每帧 setFollowVelocity(playerVelocity) 喂进来; 为零则退化为纯平滑跟随。
   */
  private followVel = new THREE.Vector3();
  /** 偏移平滑用的临时向量(避免每帧分配)。 */
  private _tmpOffA = new THREE.Vector3();
  private _tmpOffB = new THREE.Vector3();
  private _tmpLookWorld = new THREE.Vector3();
  /** 设置跟随前馈速度(见 followVel 注释)。 */
  setFollowVelocity(v: THREE.Vector3) { this.followVel.copy(v); }
  camera: THREE.PerspectiveCamera;
  private current: CameraMode = 'chase';
  private lookBack = false;

  // Smoothed state
  private pos = new THREE.Vector3(0, 0, 0);
  private look = new THREE.Vector3(0, 0, 0);
  private up = new THREE.Vector3(0, 1, 0);
  private fov = 60;
  private shakeT = 0;
  private shakeAmt = 0;

  // Zoom — multiplier on base distance. Wheel-adjustable.
  // 0.6 = close, 1.0 = default, 2.4 = far.
  // === Tighter default zoom (per user request) ===
  // Previous default 1.0 placed the player aircraft too small in frame.
  // The user wants the wingspan to occupy ~60-65% of horizontal screen
  // width (typical air-combat chase-cam framing). Default 0.72 produces
  // ~62% wingspan coverage at FOV 60 — matching the reference screenshot.
  private zoomMult = 0.72;
  private zoomMultTarget = 0.72;

  // === Trailing scale (per user request: 相机拖尾最大范围可调) ===
  // Multiplier on the drag/swing terms (35/18/maxLag). 1.0 = current feel,
  // lower = camera glued to the player (more stable), higher = more swing.
  private lagScale = 1;

  // === Follow speed (per user request: 拖曳/回正速度可调) ===
  // Multiplier on the camera's position/look lerp rates (the drag-recovery
  // speed). The aircraft's own inertia never touches this — it's purely a
  // camera feel setting. 1.0 = fast responsive base, higher = snappier.
  private followSpeed = 1.0;

  // === Look-at-target (per user request: R 注视敌人) ===
  // World position the camera should keep centred while the target-cam key
  // is held (Ace Combat-style). null = normal chase look-ahead.
  private targetLook: THREE.Vector3 | null = null;

  // === Wingman view (per user request: B 切换僚机视角) ===
  // World data of the wingman currently being watched; null = normal view.
  // The camera chases the wingman like a chase cam so you can see what the
  // teammates are actually doing.
  private wingmanCam: { pos: THREE.Vector3; forward: THREE.Vector3; up: THREE.Vector3 } | null = null;

  // Drag/weight feel — we maintain a velocity term for the camera offset
  // so it lags behind rapid changes in aircraft orientation.
  // === Attitude low-pass for the chase/far offset basis (per user request:
  // 相机跟手机体抖) ===
  // 机体姿态(尤其攻角限制器贴边时)存在几 Hz 的微小抖动,若直接拿当帧
  // forward/up 构建相机 offset,拖尾项(×42/×22)会把它放大成可见的
  // "机体往后闪/发抖"。这里把构建相机 offset 用的姿态基做一阶低通
  // (锚点仍用当帧 playerPos,飞机绝不滑走),高频抖被滤掉、宏观转弯保留。
  private static readonly BASIS_RATE = 20; // s⁻¹;cutoff ≈ 3.2Hz
  /** 速度感: 满速时机位额外后退的世界单位(加速稍微拉远 / 减速拉近)。两种操控模式共用。 */
  private static readonly SPEED_PULL = 2.2;
  private camFwd = new THREE.Vector3(0, 0, 1);
  private camUp = new THREE.Vector3(0, 1, 0);
  private camRight = new THREE.Vector3(1, 0, 0);
  private prevCamFwd = new THREE.Vector3(0, 0, 1);
  private prevCamUp = new THREE.Vector3(0, 1, 0);
  // The camera's offset relative to player, in player local space — smoothly lerped.
  private camOffsetLocal = new THREE.Vector3(0, 6, -22);
  // Velocity for spring-based smoothing (camera position spring)
  private camVel = new THREE.Vector3();

  // === 帧率一致的指数平滑 (per user request: 高刷/波动帧率下跟手) ===
  // 旧实现用每帧固定 lerp 因子:144Hz 下收拢速度是 60Hz 的 2.4 倍,
  // 帧率波动时会一快一慢地"追上/落后",像机体往后闪。换算成每秒速率:
  // rate = -ln(1-f)·60,再按实际 dt 指数积分 —— 60Hz 行为不变,其它帧率一致。
  private static frameToDt(f: number, dt: number): number {
    if (f >= 1) return 1;
    if (f <= 0) return 0;
    return 1 - Math.exp(Math.log(1 - f) * dt * 60);
  }

  // missile cam
  private missileFollow: THREE.Object3D | null = null;
  private missileFollowUntil = 0;

  // cinematic kill cam
  private cinematicUntil = 0;
  private cinematicPos = new THREE.Vector3();
  private cinematicLook = new THREE.Vector3();

  // === Free-look state (per user request) ===
  // While freeLook is active, the camera decouples from the aircraft's
  // orientation. Instead of tracking playerForward + playerUp directly, the
  // camera uses the player's BASE orientation plus a yaw/pitch offset that
  // the mouse controls. The mouse position is mapped to a yaw range of
  // ±yawMax (radians) and pitch range of ±pitchMax.
  private freeLookActive = false;
  private freeLookYaw = 0;     // current yaw offset (radians)
  private freeLookPitch = 0;   // current pitch offset (radians)
  private static readonly FREE_LOOK_YAW_MAX = Math.PI * 0.65;   // ±117°
  private static readonly FREE_LOOK_PITCH_MAX = Math.PI * 0.30; // ±54°
  // Smoothed camera yaw/pitch applied each frame so the look motion doesn't
  // jump when the mouse position changes.
  private freeLookYawSmooth = 0;
  private freeLookPitchSmooth = 0;

  // === Mouse-aim camera (per user request: 鼠标瞄准独立浮游相机) ===
  // The mouse-aim control mode uses its OWN camera system — NOT the chase
  // cam. A level, world-space third-person view with the aircraft floating
  // near the frame centre. The view direction is set ENTIRELY by the engine
  // (plane horizontal heading + aim-ring yaw/pitch offsets); the camera
  // NEVER rolls with or derives from the airframe's bank/pitch attitude.
  // null = mouse-aim camera inactive (the normal modes run).
  private mouseAimDir: THREE.Vector3 | null = null;
  private mouseAimDirBuf = new THREE.Vector3();

  // === Camera frame-centre offsets (per user request: 机库调视野中心) ===
  // The aircraft's view-centre position, tuned in the hangar — separate for
  // the mouse-aim camera ("new") and the traditional cameras ("old").
  // x/y = screen-centre fractions of half-screen (-1..1); z = depth along
  // the camera look (world units; positive = closer).
  private frameCenterNew = { x: 0, y: 0, z: 0 };
  private frameCenterOld = { x: 0, y: 0, z: 0 };
  // === Mouse-aim view-centre micro-float (per user request: 视野中心微浮动) ===
  // 0..1. The mouse-aim camera's position/look LERP factor (how tightly it
  // tracks the view-centre ball). 0 = LOCKED (lerp 1.0 — the camera snaps to
  // the ball, never drifts from the aircraft at speed); 1 = floaty (lerp 0.5 —
  // the old chasing feel). Set from skybound.maFloat at mission start.
  private mouseAimFloat = 0;
  private tmpFrameF = new THREE.Vector3();
  private tmpFrameR = new THREE.Vector3();
  private tmpFrameU = new THREE.Vector3();
  private tmpFrameWU = new THREE.Vector3(0, 1, 0);

  // === AC-130 side-firing view (per user request) ===
  // When active, the camera is positioned at the port-side gunport
  // looking outward (perpendicular to the aircraft's forward axis).
  // The player can drag the mouse to aim the 105mm howitzer visually.
  // Unlike free-look, this drag does NOT auto-recenter — the camera
  // stays where the player puts it, even if the aircraft leaves the FOV.
  //
  // === Drag range limit REMOVED (per user request) ===
  // The previous ±99° yaw / ±58° pitch cone clamp has been removed. The
  // player can now drag freely through a full 360° orbit — no max-angle
  // clamp, no auto-snap-back. If the aircraft leaves the FOV that's the
  // player's choice; nothing pulls the camera back.
  private sideViewActive = false;
  /**
   * 侧炮"自由机位"标志 (per user request: 侧炮机位可在战斗准备前界面二选一)。
   * true = 已进侧炮, 但**相机模式不动** —— 相机继续由鼠标操控驾驶(自由视角), 炮口照样跟操控环。
   */
  private sideViewFree = false;
  /**
   * 侧炮视线方向(世界单位向量) —— 由引擎按**操控环**每帧喂入。
   * 非空时, 侧视机位的注视点取它(而不是相机自己的拖拽偏移) ⇒
   * "相机固定在机体下方、视线由操控环引导"与炮弹方向完全一致(看哪打哪)。
   */
  private sideAimOverride: THREE.Vector3 | null = null;
  /** 设置/清除侧炮视线来源。null = 恢复相机自己的拖拽瞄准。 */
  setSideViewAimDir(dir: THREE.Vector3 | null) {
    if (!dir) { this.sideAimOverride = null; return; }
    if (!this.sideAimOverride) this.sideAimOverride = new THREE.Vector3();
    this.sideAimOverride.copy(dir);
  }
  // Current drag offset (yaw, pitch) in radians, applied on top of the
  // base side-view direction (which is fixed at -playerRight).
  private sideViewYaw = 0;
  private sideViewPitch = 0;
  // Smoothed versions for gentle camera motion.
  private sideViewYawSmooth = 0;
  private sideViewPitchSmooth = 0;
  // Sensitivity — drag across half the viewport width = ~120° of yaw.
  // Tuned so the player can sweep the full 360° in ~3 swipes.
  private static readonly SIDE_VIEW_YAW_SENS = Math.PI * 1.1;
  // === Pitch sensitivity raised (per user request: AC130侧炮上下移动困难) ===
  // 0.65π → 1.15π — vertical aim now matches horizontal responsiveness so
  // the gunner can slew the barrel up/down easily.
  private static readonly SIDE_VIEW_PITCH_SENS = Math.PI * 1.15;
  // When side view first activates, we initialize the mouse-origin so the
  // first frame doesn't accumulate a huge delta from the last pointer pos.
  private sideViewPointerInit = false;
  private sideViewLastPointerX = 0;
  private sideViewLastPointerY = 0;

  // Current G-load passed in by engine each frame for camera effects
  private gForce = 1;
  // === 机动量(多轴): 平滑姿态基的帧间角速率(rad/s) (per user request: 相机响应要支持多轴叠加) ===
  // 只用 gForce 判定"是否在机动"是**单轴**的: 过载几乎只由拉杆(俯仰)产生, 纯滚转/纯偏航
  // 时 |gForce−1| ≈ 0 ⇒ 相机始终用"回正"的慢速率跟随, 看起来像相机只响应俯仰。
  // 现在把低通姿态基(见 update 里的 camFwd/camUp)的帧间角速率也接进来, 与过载项取 max 融合:
  // 滚转/偏航/俯仰**任一轴**在动都能进入"快跟随", 回正仍走慢速率。
  private _mvrRateFwd = 0;
  private _mvrRateUp = 0;
  // Current speed (0..1 of max) for ambient turbulence intensity
  private speedT = 0;
  // Ambient turbulence phase trackers — continuous Perlin-like wobble
  private turbPhaseX = 0;
  private turbPhaseY = 0;
  private turbPhaseZ = 0;
  // Per-frame small drift in phase to give organic, non-repeating motion
  private turbDriftX = 0.7;
  private turbDriftY = 1.1;
  private turbDriftZ = 0.9;

  constructor(aspect: number) {
    // === Phase D: near/far 跟着世界尺度走 (决策 D4) ============================
    // far: mountain 图 60750 见方 ⇒ **对角 = 85.9km**。原来的 60000 会把地图的对角
    //      裁掉(从一角朝另一角看, 远角直接消失) ⇒ 80000(> 85.9km)。
    // near: 1 → 2 让 30km 处的深度精度从 ~53.6m 改善到 ~26.8m(好一倍), 云遮挡/
    //      高度雾/投影贴花都按深度反算世界坐标, 精度翻倍直接受益。
    //      **不要超过 3**: cockpit 视角在座舱内部(机体 ~14 单位、翼展 ±7), near 太大会
    //      把座舱/前机身裁掉。
    // 其余"从深度反算世界坐标"的地方(height-fog / clouds-takram 的 setDepthTexture /
    // 投影贴花)都通过矩阵/相机自动跟随, 无需改。
    this.camera = new THREE.PerspectiveCamera(60, aspect, 2, 80000);
    this.camera.position.set(0, 1500, -100);
  }

  setMode(m: CameraMode) {
    this.current = m;
    // Reset side-view pointer init whenever we enter/leave side mode so the
    // first frame in side mode doesn't snap to a stale mouse position.
    if (m === 'side') {
      this.sideViewActive = true;
      this.sideViewPointerInit = false;
    } else {
      this.sideViewActive = false;
    }
  }

  cycleMode(): CameraMode {
    const order: CameraMode[] = ['chase', 'far', 'cockpit'];
    // === Don't include 'side' in the normal cycle (per user request) ===
    // 'side' is only reachable via the dedicated CapsLock toggle. If we're
    // currently in 'side' mode, cycleMode drops back to 'chase' first.
    const idx = order.indexOf(this.current === 'missile' || this.current === 'cinematic' || this.current === 'side' ? 'chase' : this.current);
    this.current = order[(idx + 1) % order.length];
    this.sideViewActive = this.current === 'side';
    return this.current;
  }

  getMode(): CameraMode {
    return this.current;
  }

  // === Side-view toggle (per user request: CapsLock for AC-130) ===
  // Toggles between the current standard camera mode and the side-firing
  // gunport view. When entering side view, the previous mode is saved so
  // toggling back restores it (instead of always dropping to 'chase').
  private preSideMode: CameraMode = 'chase';
  toggleSideView(): CameraMode {
    if (this.current === 'side') {
      // Restore previous mode (or chase if invalid).
      this.current = this.preSideMode === 'side' ? 'chase' : this.preSideMode;
      this.sideViewActive = false;
      this.sideViewFree = false;   // 两条路径混用时不留残余
    } else {
      this.preSideMode = this.current;
      this.current = 'side';
      this.sideViewActive = true;
      this.sideViewFree = false;   // 固定机位优先(与自由机位互斥)
      this.sideViewPointerInit = false;
      // Reset drag offsets so we start fresh looking straight out the gunport.
      this.sideViewYaw = 0;
      this.sideViewPitch = 0;
      this.sideViewYawSmooth = 0;
      this.sideViewPitchSmooth = 0;
    }
    return this.current;
  }

  isSideViewActive(): boolean {
    // 自由机位下相机模式不是 side, 但侧炮依然算"已激活"(开火/指示器/挂起鼠标操控都看这个)。
    return this.sideViewFree || (this.sideViewActive && this.current === 'side');
  }

  /** 是否处于"侧炮·自由机位"。(HUD/引擎用它区分机位语义) */
  isSideViewFree(): boolean { return this.sideViewFree; }

  /**
   * 进入"侧炮·自由机位": 只把侧炮置为激活, **不切换相机模式** ——
   * 相机继续由鼠标操控(updateMouseAim)驱动, 于是玩家在侧炮里仍能自由看/转。
   * 与 toggleSideView() 的区别只在这里; 退出走 exitSideViewFree()。
   */
  enterSideViewFree(): CameraMode {
    this.sideViewFree = true;
    this.sideViewActive = true;
    this.sideViewPointerInit = false;
    this.sideViewYaw = 0;
    this.sideViewPitch = 0;
    this.sideViewYawSmooth = 0;
    this.sideViewPitchSmooth = 0;
    return this.current;
  }

  /** 退出"侧炮·自由机位"(相机模式本来就没动, 这里只清标志)。 */
  exitSideViewFree(): CameraMode {
    this.sideViewFree = false;
    this.sideViewActive = false;
    return this.current;
  }

  // === Side-view aim direction (per user request: AC-130 FPS炮手视角) ===
  // Returns the current gunner aim direction in side view — the same base
  // look vector + smoothed drag offsets the camera uses, so the shell and
  // the crosshair agree exactly. Only meaningful while side view is active.
  // === Camera-relative basis (per user request: 炮基本坐标系换成相机) ===
  // Same horizontal-gimbal math as the camera: yaw around world-up, pitch
  // around the level right axis — the aircraft's bank/pitch never fights
  // the mouse.
  getSideViewAim(
    out: THREE.Vector3,
    playerRight: THREE.Vector3,
    playerUp: THREE.Vector3,
    playerForward: THREE.Vector3,
  ): THREE.Vector3 {
    const base = playerRight.clone().multiplyScalar(-1)
      .addScaledVector(playerUp, -0.5)
      .addScaledVector(playerForward, 0.15);
    const fwdH = new THREE.Vector3(playerForward.x, 0, playerForward.z);
    if (fwdH.lengthSq() < 1e-6) fwdH.set(0, 0, 1);
    fwdH.normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const horizRight = new THREE.Vector3().crossVectors(fwdH, worldUp).normalize();
    const qYaw = new THREE.Quaternion().setFromAxisAngle(worldUp, this.sideViewYawSmooth);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(horizRight, this.sideViewPitchSmooth);
    base.applyQuaternion(qYaw).applyQuaternion(qPitch);
    return out.copy(base).normalize();
  }

  // === Side-view mouse drag (per user request: 去掉拖曳范围限制) ===
  // Called every frame while side view is active. The pointer (x, y) is in
  // viewport pixels; we accumulate the delta since the last call into
  // sideViewYaw / sideViewPitch. NO clamp — the player can orbit freely.
  // The camera does NOT auto-snap back; even if the aircraft leaves the
  // FOV the camera stays where the player left it.
  updateSideViewDrag(pointerX: number, pointerY: number, vw: number, vh: number) {
    if (!this.sideViewActive) return;
    if (!this.sideViewPointerInit) {
      this.sideViewLastPointerX = pointerX;
      this.sideViewLastPointerY = pointerY;
      this.sideViewPointerInit = true;
      return;
    }
    // Delta since last frame, normalized to viewport size.
    const dx = (pointerX - this.sideViewLastPointerX) / Math.max(1, vw);
    const dy = (pointerY - this.sideViewLastPointerY) / Math.max(1, vh);
    this.sideViewLastPointerX = pointerX;
    this.sideViewLastPointerY = pointerY;
    // Yaw: mouse right = look further right (positive yaw).
    // Pitch: mouse down = look further down (positive pitch — inverted from
    // screen-y because in 3D, looking down is a negative pitch around right).
    // We use the natural mapping: drag down → camera pitches down.
    // NO CLAMP — drag accumulates without bound. The player can spin the
    // camera a full 360° if they want (e.g. to look behind the gunship).
    this.sideViewYaw += dx * CameraRig.SIDE_VIEW_YAW_SENS;
    this.sideViewPitch += dy * CameraRig.SIDE_VIEW_PITCH_SENS;
  }

  setLookBack(b: boolean) { this.lookBack = b; }

  // === Free-look control (per user request) ===
  // `setFreeLook(true, mouseX, mouseY)` enables free-look mode and points
  // the camera at the given screen-normalised mouse position. The mouse
  // coordinates are in pixels relative to the viewport — we map them to
  // yaw/pitch offsets internally.
  // `setFreeLook(false, _, _)` disables free-look and snaps back to the
  // chase view (smoothed by the existing camera spring).
  setFreeLook(active: boolean, mouseX: number, mouseY: number, vw: number, vh: number) {
    this.freeLookActive = active;
    if (!active) {
      // Releasing the key — let the smoothed offset decay back to 0 (so
      // the camera glides back to the chase view rather than snapping).
      // The update() method already lerps freeLookYawSmooth → freeLookYaw,
      // so we just need to set the target back to 0 here.
      this.freeLookYaw = 0;
      this.freeLookPitch = 0;
      return;
    }
    // Normalise mouse position to [-1, +1] from the screen centre.
    // Clamp to keep the look direction bounded to the visible area.
    const nx = THREE.MathUtils.clamp((mouseX / Math.max(1, vw)) * 2 - 1, -1, 1);
    const ny = THREE.MathUtils.clamp((mouseY / Math.max(1, vh)) * 2 - 1, -1, 1);
    // Yaw: mouse right = look right (positive yaw).
    // Pitch: mouse up = look up (negative pitch because screen y is inverted).
    this.freeLookYaw = nx * CameraRig.FREE_LOOK_YAW_MAX;
    this.freeLookPitch = -ny * CameraRig.FREE_LOOK_PITCH_MAX;
  }

  isFreeLookActive(): boolean {
    return this.freeLookActive;
  }

  // === Mouse-aim camera direction (per user request: 独立浮游相机) ===
  // Sets the world-space view direction the mouse-aim camera looks along.
  // Pass null to restore the normal per-mode cameras. The engine feeds this
  // every frame (smoothed aim-ring direction) — the camera poses itself
  // behind the plane along this line, always level to the world.
  setMouseAimDir(v: THREE.Vector3 | null) {
    if (v) this.mouseAimDirBuf.copy(v).normalize();
    this.mouseAimDir = v ? this.mouseAimDirBuf : null;
  }

  // === Frame-centre offsets from settings (per user request: 机库调视野中心) ===
  setFrameOffsets(newCam: { x: number; y: number; z: number }, oldCam: { x: number; y: number; z: number }) {
    // Defensive copies — the engine's objects must never be mutated or
    // replaced behind our back.
    this.frameCenterNew = { x: newCam.x, y: newCam.y, z: newCam.z };
    this.frameCenterOld = { x: oldCam.x, y: oldCam.y, z: oldCam.z };
  }

  // === Mouse-aim view-centre micro-float (per user request) ===
  // 0 = LOCKED to the view-centre ball (no drift at speed); 1 = floaty.
  setMouseAimFloat(v: number) {
    this.mouseAimFloat = Math.max(0, Math.min(1, v));
  }

  setAspect(a: number) {
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  followMissile(obj: THREE.Object3D, duration: number) {
    this.missileFollow = obj;
    this.missileFollowUntil = performance.now() / 1000 + duration;
  }

  // === Cancel missile view early (per user request: 引爆后自动回复) ===
  // The engine calls this when the viewed missile detonates so the camera
  // snaps back to the chase view immediately instead of waiting out the
  // follow duration.
  cancelMissileFollow() {
    this.missileFollow = null;
  }

  triggerCinematic(targetPos: THREE.Vector3, playerPos: THREE.Vector3, duration = 2.2) {
    // Position camera to the side of player looking at the exploding target
    const dir = targetPos.clone().sub(playerPos);
    const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    this.cinematicPos.copy(playerPos).addScaledVector(side, 35).add(new THREE.Vector3(0, 8, 0));
    this.cinematicLook.copy(targetPos);
    this.cinematicUntil = performance.now() / 1000 + duration;
    this.current = 'cinematic';
  }

  addShake(amount: number) {
    // === Per user request ===
    // Hit shakes should NOT stack. Each new hit REPLACES the current shake
    // (rather than adding to it), and the duration is short (0.3s) so the
    // view recovers quickly. This stops the camera from spiraling into
    // chaos when the player is taking continuous damage.
    this.shakeAmt = Math.min(1.0, amount);
    this.shakeT = 0.3;
  }

  // Mouse wheel zoom adjustment. Each wheel tick changes zoom by ~0.05-0.08.
  // `wheel` is positive for "scroll up" (zoom in).
  // === 灵敏度降低 (per user request: 滚轮缩放灵敏度太高) ===
  // step 0.12→0.05(每格 ~0.08 而非 ~0.2),触控板细滚更平缓;全程
  // (0.22-2.6)约 30 格。
  zoom(wheel: number) {
    if (Math.abs(wheel) < 0.01) return;
    // Normalize typical browser wheel (deltaY ≈ ±100 per notch)
    // === 灵敏度再降为三分之一 (per user request: 滚轮缩放灵敏度降为 1/3) ===
    // 原 ±0.05/格 → ±0.0167/格(全程 0.22~2.6 约 70 格, 细滚更可控)。
    const ZOOM_STEP_PER_NOTCH = 0.05 / 3;
    const step = wheel > 0 ? -ZOOM_STEP_PER_NOTCH : ZOOM_STEP_PER_NOTCH;
    // Allow very close zoom for cinematic near-shots.
    this.zoomMultTarget = THREE.MathUtils.clamp(this.zoomMultTarget + step * Math.min(2, Math.abs(wheel) / 60), 0.22, 3.4);
  }

  getZoom(): number {
    return this.zoomMult;
  }

  // === Set zoom from settings (per user request: 飞机屏幕占比可调) ===
  // Directly overwrites both smoothed and target values so the camera
  // doesn't animate from the 0.72 default on mission start. The in-mission
  // mouse wheel still overrides temporarily; the setting re-applies next
  // mission (engine reads localStorage at construction).
  setZoomTarget(v: number) {
    this.zoomMult = v;
    this.zoomMultTarget = v;
  }

  // === Set trailing scale from settings (per user request: 拖尾可调) ===
  // === 关卡内屏占比归一 (per user request: 以 F-16 为标准, 机体大的拉远一点) =========
  // 各机型的**机身尺寸不同**(MiG-29 比 F-16 长/宽一圈), 而机位距离原来是固定的 11×zoomMult
  // ⇒ 大体型机在同样距离下占屏更大。这里按"机体实测包围盒最长边 / F-16 的同一量"给一个
  // 比例, 把所有机位几何量(距离/高度/注视前瞻)一起缩放 ⇒ **屏占比一致**。
  // 引擎在装配机体后测量并调用 setSizeScale()。
  //
  // === Phase E1: 机体统一缩小 1.571× ⇒ 机位常数同步 ×0.6364 =========================
  // E1 把玩家机尺寸统一到 AI 那张表(f16 meshScale 2.2 → 1.4, 即**缩小 1.571×**)。
  // 尺寸表(PLAYER_SIZE_M)是**真实机长**, 只反映机型之间的相对大小, **没有**跟着缩
  // ⇒ 本文件里所有"绝对世界单位"的机位常数都必须自己 ×1.4/2.2 = **0.6364**, 否则
  // 相机不动而机体变小 ⇒ 飞机在画面里明显变小、取景跑掉。
  // 换算(原值 → 新值, 全部 0.6364×):
  //   chase 基准距离 11 → **7.0** / 基准高度 0.9 → **0.57** / 硬下限 6 → **3.8**
  //   注视前瞻 (16+speedT·6) → **(10.2+speedT·3.8)** / 注视抬高 1.545+speedT·0.28 → **0.98+speedT·0.18**
  //   目标框取景 sep/140 → **sep/220**(140×1.571) 及其高度补偿 +3 → **+1.9**
  //   far 模式 35 → **22** / 6.17 → **3.93** / 前瞻 30 → **19.1**
  //   cockpit 座舱机位 2.2 上 / 3.0 前 → **1.4 上 / 1.91 前**(机体只有 14 单位长了)
  // 注意: **拖尾/机动滑移**那几项(×14/×7.3/maxLag)是世界单位的"甩开量", 属于手感标定、
  // 用户反复调过多轮(见 §253/§260~§264) ⇒ 本次**刻意不动**(代价: 机动时画面被甩开的
  // 幅度相对机身会略大一点, 观感偏"更灵", 不是 bug)。
  private sizeScale = 1;
  // clamp 上限 2.5 → 4.0: B-52 的 48.5/15 = 3.23 原来会被夹到 2.5(取景被压缩);
  // 现在按真实机长给足, 大机体才能拿到正确的"拉远量"。
  setSizeScale(k: number) { this.sizeScale = Math.max(0.5, Math.min(4.0, k || 1)); }
  getSizeScale(): number { return this.sizeScale; }

  // === 机动滑移: 机动时机体在画面里偏移, 影响消失后自动弹回 (per user request) ========
  // 用户要的观感: 鼠标模式按**机翼上方向(坡度)**把机体在画面里"左右下"推得比原来明显;
  // 键盘模式**上仰机动**时机体在画面里向下偏移; 两种模式影响消失后都自动弹回。
  //
  // 为什么用**姿态**当驱动量(而不是姿态角速率): 速率在 60fps 下噪声很大, 低通不够就会抖 ——
  // 那是另一种"看着更差"; 而姿态本身平滑, 且**机身回到水平时驱动量自然归零** ⇒
  // "消除影响后回弹"不需要任何状态机/计时器, 这是最省事也最稳的做法。
  // 再叠一层**非对称一阶跟随**: 入位快(0.10s, 机动一压下去机体立刻被甩出去)、
  // 回弹慢(0.45s, 松杆后缓缓回到画面中央) —— 手感上就是"惯性滑移"。
  private shiftX = 0;          // 屏幕方向的偏移比例(-1..1, 已含 mag)
  private shiftY = 0;
  private _shiftBank = 0;      // 低通后的坡度(滚转瞬间不抖)
  private _shiftPitch = 0;
  // §365 键盘模式滑移的"重量感": 二阶跟踪的速度项(鼠标模式不用这两个)
  private _shiftBankV = 0;
  private _shiftPitchV = 0;
  private _shiftGV = 0;
  private _shiftR = new THREE.Vector3();
  private _shiftU = new THREE.Vector3();
  private _shiftF = new THREE.Vector3();
  private _shiftOff = new THREE.Vector3();
  /** 键盘模式的拖尾位移(纯平移用, 位置与注视点各加一份) */
  private _kbDrag = new THREE.Vector3();
  private _shiftUp0 = new THREE.Vector3(0, 1, 0);
  // === 有符号过载的推导用 (per user request: 上下滑移由正负 g 值控制) ==============
  // 引擎的 gForce 是**无符号**的(1 + |ω×v|/g, 恒 ≥ 1), 分不出拉杆/推杆 ⇒ 这里自己补符号。
  private _prevPlayerFwd = new THREE.Vector3();
  private _gTmp = new THREE.Vector3();
  /** 机头转向在机体上方轴上的**连续**投影(−1..1): +1 纯拉杆, −1 纯推杆, 0 平飞/纯滚转。 */
  private _gSign = 0;
  /** 低通后的有符号过载偏置(不自然感的来源之一: 直接用瞬时值会在换杆瞬间"跳")。 */
  private _shiftG = 0;

  /** 每帧更新滑移量。bankK/pitchK = -1..1 的姿态量; mag = 幅度(鼠标模式更大);
   *  gSigned = 带符号的过载偏置((gForce−1)×符号), 正 = 拉杆(正G), 负 = 推杆(负G)。 */
  /**
   * §365 (per user request: "让键盘操作模式的上下左右视角滑移变得更有重量感")
   * 一阶低通 ⇒ **二阶弹簧跟踪**: 先加速、再被阻尼拉住, 末尾有一点余量才收住 ——
   * 这就是"重"的来源(一阶滞后只有"慢", 没有"惯性")。
   *   τ(秒)越大越沉; ζ<1 略欠阻尼(轻微过冲, 手感有分量), ζ=1 临界阻尼不过冲。
   * 显式积分的稳定性: dt 钳在 1/20 以内(ω·dt ≈ 0.17), 不会发散。
   */
  private _springTrack(cur: number, vel: number, target: number, dt: number, tau: number, zeta: number): [number, number] {
    const d = Math.min(Math.max(dt, 1e-4), 1 / 20);
    const v = vel + ((target - cur) / (tau * tau) - (2 * zeta / tau) * vel) * d;
    let x = cur + v * d;
    let vv = v;
    if (Math.abs(target - x) < 1e-4 && Math.abs(vv) < 1e-3) { x = target; vv = 0; }   // 收敛后钉住, 免得一直微微抖
    return [x, vv];
  }

  private updateManeuverShift(dt: number, bankK: number, pitchK: number, upY: number, mag: number, gSigned: number) {
    // §365: 键盘模式 ⇒ 二阶弹簧(重量感); 鼠标模式 ⇒ 保持原一阶低通(用户明确"鼠标模式不要动")。
    const kbMode = !this.mouseAimDir;
    const tauShift = readTuning('skybound.kbShiftTau', 0.34, 0.05, 1.5);
    const zetaShift = readTuning('skybound.kbShiftZeta', 0.72, 0.4, 1.6);
    if (kbMode) {
      const [b2, bv] = this._springTrack(this._shiftBank, this._shiftBankV, bankK, dt, tauShift, zetaShift);
      this._shiftBank = b2; this._shiftBankV = bv;
      const [p2, pv] = this._springTrack(this._shiftPitch, this._shiftPitchV, pitchK, dt, tauShift, zetaShift);
      this._shiftPitch = p2; this._shiftPitchV = pv;
    } else {
      const kB = 1 - Math.exp(-Math.max(dt, 1e-4) / 0.18);
      this._shiftBank += (bankK - this._shiftBank) * kB;
      this._shiftPitch += (pitchK - this._shiftPitch) * kB;
    }
    // === 屏幕方向约定: **实测** (per 2026-09 探针, 见 docs/handoff §260) ==========
    // 在 applyManeuverShift 里 _shiftOff = upv * (-shiftY * halfH * 1.6) 加到相机位置上,
    // 视线方向不变 ⇒ 相机下移 ⇒ 机体在画面里**往上**走。实测(钉住 shiftY 读机体 NDC):
    //   shiftY = +0.4 → NDC y +1.37 (出画面上边)   shiftY = −0.4 → NDC y −1.66
    //   shiftX = +0.4 → NDC x +0.85 (画面右侧)
    // ⇒ **shiftX>0 = 机体偏右, shiftY>0 = 机体偏上**。下面所有符号都按这个来。
    // 左右轴(两种模式共用): 坡度 → 横向滑移。上下轴在下面按模式分开算。
    const tgtX = THREE.MathUtils.clamp(this._shiftBank, -1, 1);
    let tgtY: number;
    if (this.mouseAimDir) {
      // === 鼠标模式: 已定稿, 一个字节不动 (per user: "鼠标操控模式的已经搞好了不要动了") ===
      tgtY = THREE.MathUtils.clamp(this._shiftBank * 0.45 + this._shiftPitch, -1, 1);
      // 倒飞时"向上的滑移"必须极轻微 (per user request)。
      // 判据用**机翼上方向在世界 Y 上的分量**(upY): 正 = 正常(机翼朝上), 负 = 倒飞。
      const invK = THREE.MathUtils.clamp(-upY, 0, 1);          // 0 = 正常, 1 = 完全倒飞
      if (tgtY < 0) tgtY *= (1 - 0.88 * invK);
    } else {
      // === 键盘模式 Y 轴: **上下(航迹在世界里的弯曲) + 左右自带的向下** 两者**叠加** ========
      // 用户修正(按时间顺序):
      //   ① 上下不受机翼朝上的角度控制, 由 G 值决定  ② 方向反了 + 要低通/软饱和(不自然)
      //   ③ 带坡度带 G 负载时左右自带一份向下(与坡度**正负/角度**无关, 两侧都向下)
      //   ④ 上下**叠加**在左右之上(不是二选一)
      //   ⑤ "我想要物理以什么角度都以正确的滑移方向为准" ⇒ 参照系由**机体上方**改成**世界竖直**
      //      (见 update() 里 _gSign 的推导): 载荷只在正飞时与世界竖直一致, 倒飞时相反 —— 这就是
      //      "只有倒飞时方向才对"的根因。改用世界竖直后, 正飞/倒飞/侧立/垂直爬升一律正确。
      const gYSlope = readTuning('skybound.kbGY', 0.12, 0, 0.6);
      // 左右那份的向下偏置也跟着横向幅度一起降到 1/4(0.45 → 0.1125), 保持"左右下"的对角比例。
      const latDownAmp = readTuning('skybound.kbLatDown', 0.1125, 0, 1);
      // 低通: 与姿态同一族的一阶跟随, 换杆时竖直方向是"滑过去"而不是"跳过去"。
      // §365: 上下轴与左右同一族手感 —— 也走二阶弹簧, 时间常数比左右长 20%
      // (纵向的"下沉/上浮"本来就该比横向迟钝一点)。
      const [g2, gv] = this._springTrack(this._shiftG, this._shiftGV, gSigned, dt, tauShift * 1.2, zetaShift);
      this._shiftG = g2; this._shiftGV = gv;
      // tanh 软饱和: 大 G 时渐近到 ±1, 不会像线性+clamp 那样在 ~6.6G 撞上限后纹丝不动。
      const gY = Math.tanh(this._shiftG * gYSlope);
      const bankW = THREE.MathUtils.smoothstep(Math.abs(this._shiftBank), 0.02, 0.12);
      const gLoadW = THREE.MathUtils.smoothstep(Math.abs(gSigned), 0.05, 0.35);
      const latDown = -latDownAmp * bankW * gLoadW;
      tgtY = THREE.MathUtils.clamp(gY + latDown, -1, 1);
    }
    const active = Math.abs(tgtX) + Math.abs(tgtY) > 0.05;
    const tau = active ? 0.10 : 0.45;   // 入位快 / 回弹慢
    const k = 1 - Math.exp(-Math.max(dt, 1e-4) / tau);
    // === 两个轴用**各自的幅度** (per user request: "左右滑移幅度降为四分之一") ==========
    // 用户要的是"左右"变小, 不是"上下"变小 —— 而上下现在还要**叠加**上去, 所以绝不能跟着一起缩:
    // 若两轴共用一个 mag, 把左右降到 1/4 会把 G 驱动的上下也一起压成 1/4(等于把刚做好的效果抹掉)。
    // 基准 mag = 键盘 0.065(0.13 的一半) / 鼠标 0.21; 左右轴再乘 1/4 ⇒ 键盘左右上限 0.01625。
    const xScale = this.mouseAimDir ? 1 : 0.25;
    this.shiftX += (tgtX * mag * xScale - this.shiftX) * k;
    this.shiftY += (tgtY * mag - this.shiftY) * k;
  }

  /**
   * 把滑移量施加为**相机相对机体的位置位移**(纯平移)。
   *
   * === 为什么必须是平移, 不是挪注视点 (per user request) ==========================
   * 用户原话: "不要依靠相机本身的旋转, 是机体在镜头内的视野的屏幕位置左右下发生较大偏移,
   * 相机不需要怎么旋转 —— 改相机相对于机体的相对位置来实现屏幕内机体位置的位移"。
   * 挪注视点 = 相机**转**, 画面里所有东西都跟着转(地平线会斜/晃), 那是"相机在动"的观感 ✗;
   * 把**同一个偏移量同时加到相机位置与注视点** = 相机姿态完全不变、只有它的**站位**挪了
   * ⇒ 视线方向不变, 而机体在画面里的位置整体平移 ✓ 这正是"相机不怎么转、机体在画面里移动"。
   */
  private applyManeuverShift(pos: THREE.Vector3, look: THREE.Vector3, fwd: THREE.Vector3, dist: number, fovDeg: number) {
    if (Math.abs(this.shiftX) < 1e-4 && Math.abs(this.shiftY) < 1e-4) return;
    const halfH = dist * Math.tan(THREE.MathUtils.degToRad(fovDeg * 0.5));
    const rgt = this._shiftR.crossVectors(fwd, this._shiftUp0);
    if (rgt.lengthSq() < 1e-8) rgt.set(1, 0, 0); else rgt.normalize();
    const upv = this._shiftU.crossVectors(rgt, fwd);
    // 偏移方向: 机体要往"左/右下"去 ⇒ 相机(与注视点)整体往**反方向**平移。
    // 1.6 = 屏幕可见位移比滑移量本身更明显(用户要的"较大偏移"), 量级由 mag 决定。
    this._shiftOff.set(0, 0, 0)
      .addScaledVector(rgt, -this.shiftX * halfH * 1.6)
      .addScaledVector(upv, -this.shiftY * halfH * 1.6);
    // ★ 两者等量平移 ⇒ 视线方向严格不变(相机不旋转)。
    pos.add(this._shiftOff);
    look.add(this._shiftOff);
  }

  /** 诊断/探针用: 当前滑移量(屏幕比例)。 */
  getManeuverShift(): { x: number; y: number } { return { x: this.shiftX, y: this.shiftY }; }

  setLagScale(v: number) {
    this.lagScale = v;
  }

  // === Set follow speed (per user request: 镜头跟随/回正速度可调) ===
  setFollowSpeed(v: number) {
    this.followSpeed = v;
  }

  // === Set look-at-target world position (per user request: R 注视敌人) ===
  setTargetLook(v: THREE.Vector3 | null) {
    this.targetLook = v;
  }

  // === Set the wingman being watched (per user request: B 僚机视角) ===
  setWingmanCam(v: { pos: THREE.Vector3; forward: THREE.Vector3; up: THREE.Vector3 } | null) {
    this.wingmanCam = v;
  }

  update(
    dt: number,
    playerPos: THREE.Vector3,
    playerForward: THREE.Vector3,
    playerUp: THREE.Vector3,
    playerRight: THREE.Vector3,
    speed: number,
    maxSpeed: number,
    gForce = 1,
  ) {
    const now = performance.now() / 1000;
    let desiredPos = new THREE.Vector3();
    let desiredLook = new THREE.Vector3();
    let desiredUp = playerUp.clone();
    let desiredFov = 60;

    // Smooth zoom (frame-rate independent, same as the position/look lerps)
    this.zoomMult = THREE.MathUtils.lerp(
      this.zoomMult,
      this.zoomMultTarget,
      CameraRig.frameToDt(0.18, dt > 0 ? Math.min(dt, 0.33) : 1 / 60),
    );
    // Save current G for shake amplification
    this.gForce = gForce;
    // 每帧清零: 只有真正在算拖尾的那个分支(chase/far)会重新写入 —— 其余模式
    // (机舱/侧炮/鼠标操控/电影)不参与"机动快跟随"的融合, 免得用上一帧的残留值。
    this._mvrRateFwd = 0;
    this._mvrRateUp = 0;
    // Save current speed ratio for ambient turbulence
    this.speedT = THREE.MathUtils.clamp(speed / maxSpeed, 0, 1);

    // === Wingman view — highest priority (per user request: B 僚机视角) ===
    // Chase the watched wingman like a chase cam so you can see exactly what
    // the teammates are doing.
    if (this.wingmanCam) {
      const w = this.wingmanCam;
      desiredPos.copy(w.pos).addScaledVector(w.forward, -13 * this.zoomMult).addScaledVector(w.up, 4 * this.zoomMult);
      desiredLook.copy(w.pos).addScaledVector(w.forward, 24);
      desiredFov = 60;
      desiredUp.copy(w.up);
    }

    // Cinematic override
    if (this.current === 'cinematic' && now < this.cinematicUntil) {
      // Orbit slowly around target
      const t = (this.cinematicUntil - now) / 2.2;
      const angle = (1 - t) * Math.PI * 0.6;
      const dir = this.cinematicLook.clone().sub(this.cinematicPos).normalize();
      const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
      const orbitCenter = this.cinematicLook.clone();
      const radius = 45;
      desiredPos.copy(orbitCenter).addScaledVector(side, Math.cos(angle) * radius).add(new THREE.Vector3(0, 10 + Math.sin(angle) * 6, 0));
      desiredPos.addScaledVector(dir, -Math.sin(angle) * radius);
      desiredLook.copy(this.cinematicLook);
      desiredFov = 50;
    } else if (this.current === 'cinematic') {
      // End cinematic — return to chase
      this.current = 'chase';
    }

    // Missile cam override
    if (this.missileFollow && now < this.missileFollowUntil) {
      const m = this.missileFollow;
      const back = m.position.clone().addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(m.quaternion), 6);
      desiredPos.copy(back).add(new THREE.Vector3(0, 1.5, 0));
      desiredLook.copy(m.position);
      desiredFov = 75;
    } else if (this.missileFollow) {
      this.missileFollow = null;
      this.current = 'chase';
    }

    // === Mouse-aim camera — free 360° orbit, level, WORLD-fixed view centre ===
    // (per user request: 相机盯着机体视野中心隐形球, 机体怎么转不告诉相机,
    //  隐形球相对世界空间不旋转, 只位置跟着机体跑)
    // The camera orbits the ring-controlled view direction around a 3D VIEW
    // CENTRE = the aircraft position + a WORLD-FIXED offset (the hangar-tuned
    // invisible ball, x/y/z in world units). The ball does NOT rotate with
    // the aircraft — only its position follows. The camera ALWAYS looks at
    // the ball, level to the world; nothing else rotates it. Transient views
    // (wingman/cinematic/missile) take priority.
    const noTransientView = this.current !== 'cinematic'
      && !(this.missileFollow && now < this.missileFollowUntil)
      && !this.wingmanCam;
    if (this.mouseAimDir && noTransientView) {
      const maDir = this.mouseAimDir;
      const fc = this.frameCenterNew;
      // Camera distance responds to the cameraSize setting / wheel zoom
      // (zoomMult): bigger size = closer (larger plane). Normalised to the
      // default 0.72 so the base 42 stays the default framing.
      // === 与键盘模式同一套构图 (per user request: 同步新缩放与视角角度) =============
      // 原来 MA_DIST = 42×(zoomMult/0.72)(默认 ≈ 58~66) —— 比键盘模式的 11×zoomMult(≈12.6)
      // 远得多, 两个模式看到的机体大小差好几倍。现在统一成 11×zoomMult。
      // === 速度感同步 (per user request: 加速稍微拉远/减速拉近) ==================
      // 与键盘模式同一个 SPEED_PULL, 免得两个模式的"速度手感"不一致。
      const speedTMa = THREE.MathUtils.clamp(speed / maxSpeed, 0, 1);
      // Phase E1: 11 → 7.0 / 硬下限 6 → 3.8(机体缩小 1.571×, 见 setSizeScale 上方注释)
      const MA_DIST = THREE.MathUtils.clamp((7.0 * this.zoomMult + speedTMa * CameraRig.SPEED_PULL) * this.sizeScale, 3.8, 160);
      // 俯角同步: 键盘模式是"相机比机体高 0.9×zoomMult"; 鼠标模式的相机绕**视野中心球**转
      // (球在机体上方 fc.y), 所以把相机高度按"球高 − 目标俯角高度"拉回来 ——
      // 俯角与键盘一致, 而注视点仍是球(构图/机体在画面里的位置不变)。
      const maElevOffset = 0.57 * this.zoomMult * this.sizeScale - fc.y;   // Phase E1: 0.9 → 0.57
      // The camera POSITION always orbits the aircraft's view-centre ball.
      // R-look (lookTarget held): BOTH stay centred — the camera still stares
      // at the ball, AND the orbit ANGLE auto-aligns onto the ball→target
      // line, so the locked target's radar box ALSO sits at the view centre
      // (behind the ball on the same line of sight). Release → the orbit
      // returns to the mouse-driven angle.
      const vc = this.tmpFrameF.copy(playerPos).add(this.tmpFrameR.set(fc.x, fc.y, fc.z));
      let orbit = maDir;
      if (this.targetLook) {
        const toT = this.tmpFrameU.copy(this.targetLook).sub(vc);
        if (toT.lengthSq() > 1e-6) orbit = toT.normalize();
      }
      desiredPos.copy(vc).addScaledVector(orbit, -MA_DIST);
      desiredPos.y += maElevOffset;   // 俯角对齐键盘模式(见上)
      desiredLook.copy(vc);
      // === 自动补偿"视野中心相对机头指向的偏移" (per user request) ================
      // 症状(用户原话): "镜头根据机头上指向方向, 在镜头内的视野中心左右下少许偏移;
      //   鼠标模式里飞机在屏幕中的位置从正中间移到了正下方 ⇒ 指向有偏差"。
      // 原因: 相机为了构图被**整体抬高** maElevOffset, 但仍然"看着球"(desiredLook = vc)
      //   ⇒ 实际视线方向 = vc − camPos 相对瞄准方向 aimDir **倾斜**了
      //   atan(maElevOffset / MA_DIST) ≈ 4~5°(抬得越多偏得越多) ⇒ 屏幕中心(准心)指的方向
      //   不是机头/操控环的方向, 于是"打出去偏一点"。
      // 补偿: 注视点同样抬高 maElevOffset ⇒ 视线与 aimDir **严格平行**, 偏差归零;
      //   相机位置不动 ⇒ 机体的屏幕位置/构图完全不变(飞机仍在偏下处)。
      //   (键盘模式在后面的 frameCentre 段做了同类补偿, 见 "shift the final look target"。)
      desiredLook.y += maElevOffset;
      desiredUp.copy(new THREE.Vector3(0, 1, 0)); // world up — camera never banks
      desiredFov = 60;
    } else if (noTransientView) {
      const speedT = THREE.MathUtils.clamp(speed / maxSpeed, 0, 1);
      // === Smoothed attitude basis (per user request: 相机跟随不自然/抖动) ===
      // 用低通后的 forward/up 构建 offset 与拖尾:锚点仍是当帧 playerPos,
      // 所以机体不会"跟不上/滑走";高频姿态抖(攻角限制器贴边)不再进入
      // 拖尾放大项。rate→k 同样按 dt 指数换算,帧率无关。
      const sdtSafe = dt > 0 ? Math.min(dt, 0.33) : 1 / 60;
      const kB = 1 - Math.exp(-CameraRig.BASIS_RATE * sdtSafe);
      this.camFwd.lerp(playerForward, kB).normalize();
      this.camUp.lerp(playerUp, kB).normalize();
      const cr = this.camRight.crossVectors(this.camUp, this.camFwd);
      if (cr.lengthSq() > 1e-8) cr.normalize(); else cr.set(1, 0, 0);
      const cFwd = this.camFwd;
      const cUp = this.camUp;
      const cRight = this.camRight;
      // 拖尾用"低通姿态的帧间变化量"(rate 近似),不再放大原始抖动
      const turnAngleFwd = Math.acos(THREE.MathUtils.clamp(cFwd.dot(this.prevCamFwd), -1, 1));
      const turnAngleUp = Math.acos(THREE.MathUtils.clamp(cUp.dot(this.prevCamUp), -1, 1));
      const turnMag = turnAngleFwd + turnAngleUp * 0.5;
      // === 机动角速率(多轴) —— 供下面的"响应/回正"融合用 (per user request) ===
      // 换算成 rad/s(帧率无关), 滚转主要体现在 up 项、俯仰/偏航主要体现在 fwd 项。
      this._mvrRateFwd = turnAngleFwd / sdtSafe;
      this._mvrRateUp = turnAngleUp / sdtSafe;

      if (this.current === 'chase') {
        // Close chase — offset scaled by zoom. zoomMult can go down to 0.28 for
        // very tight near-shots (player fills the frame).
        // === Closer + lower camera (per user request) ===
        // Reduced base distance 14→11 and base height 4→3.2 so the aircraft
        // sits larger and slightly lower in frame, matching the reference
        // screenshot (wingspan ~62% of screen width, body in lower-center).
        // === 最小机位距离兜底 (per fix) =========================================
        // 相机距离 = 11 × zoomMult, 而 zoomMult 可以被设置/滚轮压得很小 ⇒ 相机会跑到**机身内部**
        // (实测 zoomMult 0.2474 时距机体中心仅 2.7 单位, 画面底部全是机尾)。机体长十几单位,
        // 所以这里加一个硬下限: 再近也不低于 6 单位。
        let baseDist = Math.max(3.8, 7.0 * this.zoomMult * this.sizeScale);   // Phase E1: 6/11 → 3.8/7.0
        // === 速度感: 加速稍微拉远, 减速拉近 (per user request: 恢复此要素) ==========
        // 之前只有 FOV 会随速度张开(60 + speedT*6), 距离是固定的 —— 用户要的是
        // "加速时镜头稍微退一点、收油时凑近一点" 的**距离**变化。
        // 幅度刻意小: 满速 +2.2 个世界单位(基准约 12.5, 即 +18%), "稍微拉远"的手感,
        // 不会让机体明显变小。两种操控模式用同一个系数(构图统一)。
        baseDist += speedT * CameraRig.SPEED_PULL;
        // === 俯角两次下调 (per user request) ======================================
        // 原 3.2/11 ⇒ 16.2°; 先减半到 1.6 ⇒ 8.3°; 再降四分之一 ⇒ 1.2 ⇒ atan(1.2/11) ≈ **6.2°**。
        // (baseDist = 11×zoomMult 始终不变 ⇒ 屏占比/机体大小只由距离决定, 调俯角不影响大小)
        let baseHeight = 0.57 * this.zoomMult * this.sizeScale;   // Phase E1: 0.9 → 0.57(俯角不变)
        // === Look-at-target framing (per user request: 玩家+敌机同时居中) ===
        // The camera frames BOTH the player's model centre AND the locked
        // enemy near the view centre: aim at their midpoint and pull back
        // further when the bandit is far so both aircraft fit in frame —
        // NOT the original look-ahead framing.
        let targetMid: THREE.Vector3 | null = null;
        if (this.targetLook) {
          targetMid = playerPos.clone().add(this.targetLook).multiplyScalar(0.5);
          const sep = playerPos.distanceTo(this.targetLook);
          // Phase E1: 11 → 7.0 且 140 → 220(机体缩小 1.571×, 同一个"双机取景"构图)
          baseDist = Math.max(baseDist, 7.0 * this.zoomMult * THREE.MathUtils.clamp(1 + sep / 220, 1, 3.2));
          baseHeight += 1.9;   // Phase E1: +3 → +1.9(与 baseHeight 同比例)
        }
        // === Drag/swing offset ===
        // When the player turns, the camera lags behind by an amount proportional
        // to the angular rate. We compute the lag in player-local space:
        // - Lateral lag: dot(turn-axis, playerRight)
        // - Vertical lag: dot(turn-axis, playerUp)
        // === 抖动修复 (per user request: 相机跟手机体抖/闪) ===
        // 帧间增量改由"低通姿态"(camFwd/camUp)给出 —— 攻角限制器贴边时
        // 的高频姿态抖不再乘进 ×42/×22 拖尾项。
        const fwdDelta = cFwd.clone().sub(this.prevCamFwd);
        const upDelta = cUp.clone().sub(this.prevCamUp);
        // === 拖尾项改为帧率无关 (per fix: 高负载下相机跟不上飞机) ===
        // 原实现用**每帧增量** × 42/22。帧率一掉, 每帧增量成倍变大(40ms 相比
        // 16ms 约 2.5×), 滞后量跟着成倍放大 → 相机被甩到飞机后方、机体跑出画面。
        // 这里把"每帧增量"换算成"每秒角速率"(× dt*60), 于是 60Hz 手感不变,
        // 而低帧率下滞后量不再放大。同时按帧时进一步衰减:帧时越长说明在卡顿,
        // 越不该再叠加人造滞后(卡顿时应优先"锁住"而不是"甩尾")。
        const lagDtScale = Math.min(1, Math.max(0.25, (dt > 0 ? dt : 1 / 60) * 60)) / 1;
        // 帧时 > ~66ms 时把拖尾整体收掉(卡顿保护):不做人造滞后, 直接刚性跟随。
        const lagStallFade = dt > 0.066 ? Math.max(0, 1 - (dt - 0.066) / 0.05) : 1;
        const lagGain = lagDtScale * lagStallFade;
        // Lag in local frame — fwdDelta in world; transform to local via dot with playerRight/Up
        // === Reduced drag (per user request) ===
        // Previous multipliers (80 / 40) produced so much lateral swing that
        // during high-G turns the player aircraft drifted out of frame. Now
        // trimmed to (35 / 18) — still gives a noticeable "weight" feel but
        // the camera stays glued to the player through hard maneuvers.
        // === 转向/机动的**起始响应**与回正同速: 滞后项 ÷3 (per user request) ===
        // 原 42/22/(3+turnMag×16) 相对于"回正 ÷3"显得太急, 现在同步 ÷3 ——
        // 于是"开始被甩开"和"慢慢回正"是同一节奏, 镜头整体更稳。
        // === 键盘模式: 响应/回正的视角变换最大幅度 ×0.6 (per user request) ==========
        // 拖尾量决定"机动时画面被甩开多少", 机动结束后相机再从那个偏移慢慢回正
        // ⇒ 把拖尾量与它的钳位一起乘 0.6, 就是"响应和回正的最大幅度都降到 6/10"。
        // (只动幅度, 不动"机动快跟随 / 平稳慢回正"那套速率与时间常数。)
        // === 机动更难拉动视角 (per user request: 让机动更难拉动视角移动) ==========
        // 0.6 → 0.42: 机动时画面被甩开的**幅度**再降 30%(响应/回正同源, 一起变小)。
        // 另外把下面的灵敏度分母一起加大(见 maneuverAmt), 于是"要多猛的机动才进入快跟随"
        // 也更高 —— 两处一起改才是"更难被拉动"。想恢复: 0.42 → 0.6 并把分母改回 2.5/0.9。
        const RESP_AMP_K = 0.42;
        const lateralLag = fwdDelta.dot(cRight) * 14 * RESP_AMP_K * this.lagScale * lagGain;
        const verticalLag = (fwdDelta.dot(cUp) + upDelta.dot(cUp)) * 7.3 * RESP_AMP_K * this.lagScale * lagGain;
        // Clamp lag to avoid extreme swings
        // === Tighter clamp (per user request) ===
        // Previous maxLag = 6 + turnMag * 40 let the camera swing up to ~30
        // units off-axis during a hard turn — enough to push the player off-
        // screen. New maxLag = 3 + turnMag * 14 keeps the camera locked to
        // the player through high-G pulls.
        const maxLag = (1 + turnMag * 5.3) * RESP_AMP_K * this.lagScale;   // 幅度 ×0.6
        const clampedLag = THREE.MathUtils.clamp(lateralLag, -maxLag, maxLag);
        const clampedVlag = THREE.MathUtils.clamp(verticalLag, -maxLag * 0.4, maxLag * 0.4);

        // === 键盘模式的拖尾也改成**纯平移**, 并减半 (per user request) ==================
        // 用户(键盘模式): "在原本的屏幕位置上进行左右轴滑移, 而不是直接摸到屏幕左右端; 滑移程度降为
        // 原来的一半; 机翼上指向方向在重力反方向时(倒飞)向上的滑移非常轻微"。
        // 实测先暴露了一个真问题: 原来 drag **只加在相机位置上**, 而注视点仍钉在机体上 ⇒ 等于把相机
        // "拽着转"(满杆滚转时朝向变了约 11°, 点积 0.981), 而且位移 ~0.23 NDC 反而比鼠标模式还大。
        // 现在: drag 同时加到**位置与注视点**(等量平移 ⇒ 视线方向不变), 幅度 ×0.5, 倒飞时压掉"向上"那份。
        // === 键盘模式的屏幕位移系数 = 现场旋钮 (per user request) ======================
        // 用户要的是"**机体**在原本的屏幕位置上小幅左右滑移, 而不是相机晃到屏幕左右端"。
        // 键盘模式里推屏幕位置的一共有两份: ① 追逐相机的拖尾(这份) ② 机动滑移(下面 updateManeuverShift)。
        // 与其反复改代码重编译, 这里把两份的系数都接到 localStorage 旋钮上(**每帧读** ⇒ 立刻生效):
        //   skybound.kbDrag  : 拖尾系数倍数(默认 1; 想更小就 0.5 / 0.25, 0 = 完全不要拖尾)
        //   skybound.kbShift : 机动滑移倍数(默认 1)
        // 在浏览器 devtools 里: localStorage.setItem('skybound.kbDrag','0.4') 即可, 无需重开任务。
        // === 键盘模式左右轴滑移: 再降为四分之一 (per user request) ====================
        // 沿革: 0.15/0.1 →(§260 减半)→ 0.075/0.05 →(本次 再乘 1/4)→ 0.01875/0.0125。
        // 与机动滑移(xScale=0.25)取同一个比例, 这样"拖尾 + 机动滑移"两份横向位移的配比不变、
        // 整体幅度一起缩到 1/4, 不会出现一份缩了另一份没缩导致方向变歪。
        const kbDragMul = readTuning('skybound.kbDrag', 1, 0, 2);
        this._kbDrag.set(0, 0, 0)
          .addScaledVector(cRight, -clampedLag * 0.01875 * kbDragMul)
          .addScaledVector(cUp, -clampedVlag * 0.0125 * kbDragMul);
        // === "机体几乎不会向上滑移" (per user request) ================================
        // 实测方向约定(见 updateManeuverShift 顶部): _kbDrag·世界up > 0 ⇒ 相机上移 ⇒
        // 机体在画面里**向下**走; < 0 ⇒ 相机下移 ⇒ 机体**向上**走。
        // 所以要把**负**的那一份压掉 98%(原来这里判的是 > 0, 方向反了 —— 压到的是"向下"那份,
        // 而用户要压的是"向上"那份)。鼠标模式不走这条分支, 不受影响。
        const kbUp = this._kbDrag.dot(this._shiftUp0);
        if (kbUp < 0) this._kbDrag.addScaledVector(this._shiftUp0, -kbUp * 0.98);
        const back = playerPos.clone()
          .addScaledVector(cFwd, -baseDist)
          .addScaledVector(cUp, baseHeight)
          .add(this._kbDrag);
        desiredPos.copy(back);
        // === Look-ahead point biased UPWARD (per user request) ===
        // Previously the camera looked straight ahead at the player position
        // (well, slightly ahead), which placed the player aircraft in the
        // vertical CENTER of the screen. The user wants the aircraft to sit
        // in the LOWER third of the screen — like a typical air-combat camera.
        // We achieve this by raising the look-at point ABOVE the player by a
        // few units, which pitches the camera up slightly and pushes the
        // player down in frame.
        // === Stronger downward bias (per user request) ===
        // Look-ahead raised from 3.0 → 5.5 so the aircraft sits clearly in
        // the lower 40% of the screen, not the center. Combined with the
        // closer baseDist this matches the reference screenshot framing.
        // === 抖动修复:look 点同样用低通姿态(锚点仍是当帧 playerPos) ===
        const lookAheadDist = (10.2 + speedT * 3.8) * this.sizeScale;   // Phase E1: (16+6) → (10.2+3.8)
        desiredLook.copy(playerPos)
          .addScaledVector(cFwd, lookAheadDist)
          // 注视点抬高同步: 5.5 → 2.75(减半) → 2.06(再降 1/4) —— 与机位高度保持同一比例
          // Phase E1: 1.545+speedT·0.28 → 0.98+speedT·0.18(同上 ×0.6364)
          .addScaledVector(cUp, 0.98 + speedT * 0.18)   // look above player → aircraft drops in frame
          .add(this._kbDrag);                            // ← 与相机位置等量平移 ⇒ 视线方向不变
        // === Reduced FOV kick (per user request: 高速镜头拉太远) ===
        // 60 + speedT*14 → 60 + speedT*6: at top speed the FOV opens to ~66
        // instead of 74, so the aircraft doesn't shrink into the distance.
        desiredFov = 60 + speedT * 6;
        // === Look-at-target override (per user request: R 注视敌人) ===
        // Look at the midpoint of the player and the locked enemy — BOTH
        // stay near the centre of the view (not the original camera
        // framing). World-space up in third person.
        if (this.targetLook && targetMid) {
          desiredLook.copy(targetMid);
          // === World-space up in third person (per user request) ===
          // The target cam stays level to the WORLD (up = world up) instead
          // of rolling with the aircraft's bank — the view is defined in
          // world coordinates, not the airframe's local frame.
          desiredUp.copy(new THREE.Vector3(0, 1, 0));
        }
      } else if (this.current === 'far') {
        // Phase E1: 35 → 22 / 6.17 → 3.93 / 前瞻 30 → 19.1(机体缩小 1.571×, 构图与俯角不变)
        const baseDist = 22 * this.zoomMult;
        const baseHeight = 3.93 * this.zoomMult;   // 仰角 30° → 10° (per user request: 键盘模式视角压低)
        const back = playerPos.clone()
          .addScaledVector(cFwd, -baseDist)
          .addScaledVector(cUp, baseHeight);
        desiredPos.copy(back);
        desiredLook.copy(playerPos).addScaledVector(cFwd, 19.1);
        desiredFov = 55 + speedT * 8;
      } else if (this.current === 'cockpit') {
        // Just in front of canopy looking forward — plane is ~14 units long at 1.4× scale
        // (Phase E1: 22 单位 @2.2× → 14 单位 @1.4×), so sit at canopy height (≈1.4 up) and
        // slightly forward of center (≈1.91 forward).
        desiredPos.copy(playerPos).addScaledVector(playerUp, 1.4).addScaledVector(playerForward, 1.91);
        desiredLook.copy(playerPos).addScaledVector(playerForward, 60);
        desiredFov = 70 + speedT * 10;
        // === Look-at-target in cockpit (per user request) ===
        // First-person target cam aims the view at the locked enemy but KEEPS
        // the body-relative orientation — no world-space coordinate change.
        if (this.targetLook) desiredLook.copy(this.targetLook);
      } else if (this.current === 'side') {
        // === AC-130 side-firing gunport view (per user request) ===
        // Camera sits at the port-side gunport (left side of the aircraft,
        // slightly forward and below the wing) looking OUTWARD — i.e. along
        // -playerRight (perpendicular to the aircraft's forward axis).
        // The player can drag the mouse within a limited cone (±99° yaw,
        // ±58° pitch) to aim the 105mm howitzer visually. Per the user spec:
        //   - The drag has a MAX range (clamped cone, not unlimited orbit).
        //   - The camera does NOT auto-snap back to the aircraft. Even if the
        //     aircraft leaves the FOV, the camera stays where the player left
        //     it — the player is the gunner, not the pilot.
        // Position: 3 units out the port side (-playerRight * 3), 0.5 fwd,
        // 0.4 below center. This puts the camera at the gunport opening.
        // === 遗留侧炮机位(第一人称炮口视角) ===
        // 相机位于机侧炮口: 机侧 3 单位、略靠前、略低于机身中心 —— 就是侧炮模式一直以来的那个机位。
        // === 参考图那种炮手机位 (per user request: 机翼/发动机出现在画面右下角) ===
        // 参考画面(AC-130 侧炮 FPS): 相机在**机翼上方略靠后**, 朝机体外侧**俯视**出去,
        // 于是机翼与发动机的剪影压在画面右下角, 视野主要给地面目标。
        //   · 横向 1.8(比原来 3.0 更靠内) —— 让机翼留在画面内而不是甩在视野外;
        //   · 前向 -0.6(略靠后) —— 机翼根部/发动机落在右下;
        //   · 上向 +0.9(**在机翼上方**) —— 关键: 原来 -0.4 在翼下, 抬头看到的是翼下表面,
        //     与参考图相反。
        const gunportOffset = playerPos.clone()
          .addScaledVector(playerRight, -1.8)
          .addScaledVector(playerForward, -0.6)
          .addScaledVector(playerUp, 0.9);
        desiredPos.copy(gunportOffset);
        // Base look direction: straight out the port side (-playerRight),
        // pitched slightly down so the player sees the ground where they're
        // shooting (gunship targets are typically below the orbit altitude).
        // Then apply the player's mouse-drag yaw/pitch offsets on top.
        // === Smooth the drag offsets ===
        // Lerp toward the target drag each frame so small mouse movements
        // feel smooth rather than snappy. Fast lerp (0.22) keeps aim feeling
        // responsive — gunship combat needs precise aim, not floaty lag.
        this.sideViewYawSmooth = THREE.MathUtils.lerp(this.sideViewYawSmooth, this.sideViewYaw, 0.22);
        this.sideViewPitchSmooth = THREE.MathUtils.lerp(this.sideViewPitchSmooth, this.sideViewPitch, 0.22);
        // Base look direction = -playerRight (port side), 30° down.
        const baseLookDir = playerRight.clone().multiplyScalar(-1)
          .addScaledVector(playerUp, -0.5)  // tilt down ~27°
          .addScaledVector(playerForward, 0.15);  // slight forward bias so orbit reads naturally
        // === Camera-relative aim basis (per user request: 炮基本坐标系换成相机) ===
        // Previously yaw/pitch rotated around the AIRCRAFT axes (playerUp /
        // playerRight), so any bank or pitch of the airframe fought the mouse
        // and the gunner's aim swung around unpredictably. Now the drag
        // rotates around HORIZONTAL axes (world-up + level right derived from
        // the heading's horizontal projection) — a stable gimbal that ignores
        // the aircraft's roll/pitch attitude, exactly like a camera mount.
        const worldUp = new THREE.Vector3(0, 1, 0);
        const fwdH = new THREE.Vector3(playerForward.x, 0, playerForward.z);
        if (fwdH.lengthSq() < 1e-6) fwdH.set(0, 0, 1);
        fwdH.normalize();
        const horizRight = new THREE.Vector3().crossVectors(fwdH, worldUp).normalize();
        const qYaw = new THREE.Quaternion().setFromAxisAngle(worldUp, this.sideViewYawSmooth);
        const qPitch = new THREE.Quaternion().setFromAxisAngle(horizRight, this.sideViewPitchSmooth);
        baseLookDir.applyQuaternion(qYaw).applyQuaternion(qPitch);
        desiredLook.copy(gunportOffset).add(baseLookDir.multiplyScalar(60));
        // === NO auto-snap-back mechanism ===
        // (Note: the chase/far "frame guarantee" boost has been removed
        // globally — see update() — so side view is no longer special in
        // this regard. The comment is kept for historical context.)
        // The whole point of side view is that the aircraft can leave the
        // FOV — the gunner is looking at the target, not at their own aircraft.
        desiredFov = 55;  // slightly tighter FOV for aiming precision
        // Suppress the standard chase-mode drag/swing calc for side view.
        desiredUp.copy(playerUp);
      }
      // === 侧炮视线由引擎喂来的方向驱动 (per user request: 固定机位也要随鼠标转向) ===
      // 相机位置仍是上面的 gunportOffset(遗留炮口固定点); 只把注视点换成
      // "炮口 + 操控方向 × 100", 于是鼠标(指针增量)一转, 视线立刻跟着转,
      // 且与开火方向/落点指示器完全同源。上下方向跟着机体(playerUp) ⇒ 第一人称观感。
      if (this.current === 'side' && this.sideAimOverride) {
        desiredLook.copy(desiredPos).addScaledVector(this.sideAimOverride, 100);
        desiredUp.copy(playerUp);
      }
      // Look-back flips the camera behind the player. Skip in side view
      // (looking back from the gunport makes no sense — you'd just see the
      // fuselage interior).
      // === 侧炮机位 = **遗留逻辑**(per user request) ===
      // 用户明确: CapsLock 进侧炮的"固定机位"就是**之前侧炮模式下的遗留视角** ——
      // 第一人称炮口视角(机侧 3 单位、略前略下), 视线由相机自己的拖拽锥角决定;
      // **不是**绕着机体转的第三人称。所以这里不再用引擎喂来的操控环覆盖视线,
      // 上面的 gunportOffset + 拖拽基向量就是最终结果。
      // (历史: §146 曾让"视线跟着操控环"、§147 曾把机位挪到机翼正下方 —— 均已按用户要求撤回。
      //  开火方向仍走 sideCannonAimDir(鼠标模式=操控环, 键盘模式=鼠标环), 与遗留瞄准一致。)
      if (this.lookBack && this.current !== 'side') {
        // Flip look direction
        desiredLook.copy(playerPos).addScaledVector(playerForward, -20);
        const tmp = desiredPos.clone();
        desiredPos.copy(playerPos).addScaledVector(playerForward, 14).addScaledVector(playerUp, 4);
        void tmp;
      }

      // === Free-look offset (per user request) ===
      // While the free-look key is held, the chase camera decouples from the
      // aircraft's orientation. We rotate the look-direction around the
      // player's position by (yaw around playerUp, pitch around playerRight)
      // so the camera position stays put but the look-at point swings.
      // This lets the player look around without turning the aircraft.
      //
      // The smoothed yaw/pitch lerps toward the target each frame so the
      // camera glides smoothly instead of snapping.
      this.freeLookYawSmooth = THREE.MathUtils.lerp(this.freeLookYawSmooth, this.freeLookYaw, 0.18);
      this.freeLookPitchSmooth = THREE.MathUtils.lerp(this.freeLookPitchSmooth, this.freeLookPitch, 0.18);
      if (Math.abs(this.freeLookYawSmooth) > 0.001 || Math.abs(this.freeLookPitchSmooth) > 0.001) {
        // Compute the current look direction (from desiredPos → desiredLook)
        // and rotate it around the player position.
        const lookDir = desiredLook.clone().sub(playerPos);
        // Apply yaw around playerUp, then pitch around playerRight.
        // We use THREE.Quaternion.setFromAxisAngle for clean rotation.
        const qYaw = new THREE.Quaternion().setFromAxisAngle(playerUp, this.freeLookYawSmooth);
        const qPitch = new THREE.Quaternion().setFromAxisAngle(playerRight, this.freeLookPitchSmooth);
        lookDir.applyQuaternion(qYaw).applyQuaternion(qPitch);
        desiredLook.copy(playerPos).add(lookDir);
        // Also nudge the camera position slightly so the aircraft stays
        // visible in frame when looking far off-axis. We move the camera
        // sideways opposite to the look direction so the aircraft ends up
        // on the opposite side of the screen from where the player is
        // looking (e.g. look right → camera shifts left, plane on right).
        // Magnitude is small (max 4 units) so it doesn't break the chase feel.
        const posOffset = playerRight.clone().multiplyScalar(-this.freeLookYawSmooth * 3.0);
        desiredPos.add(posOffset);
      }

      // Track for next frame's drag computation
      // === 抖动修复:存"上一帧低通姿态",供帧间增量(delta)使用 ===
      this.prevCamFwd.copy(this.camFwd);
      this.prevCamUp.copy(this.camUp);
    }

    // === 机动滑移 (per user request) ================================================
    // 位置放在这里(两条分支都算完之后)是刻意的: 此时 desiredLook/desiredPos/desiredFov 都是终值,
    // 不用在两个分支里各写一份, 也不会取到还没赋值的 desiredFov。
    if (noTransientView) {
      // 鼠标模式系数更大(用户要"较大偏移"); 键盘模式小一些 —— 它本来就有拖尾 lag, 叠太大会晕。
      // === 幅度减半 (per user request: "滑移程度降为原来的二分之一") ==================
    // 而且它是**从机体当前屏幕位置起算的相对滑移**(纯平移就是相对的), 不是把机体推到屏幕
    // 左右端 —— 原系数 0.42/0.26 配上 1.6 的施加系数最大能到半屏宽的 ~67%(看着像"顶到边"),
    // 现在减半 ⇒ 最大约 1/3 屏宽, 是"滑出去一点"而不是"贴边"。
    // 键盘模式的机动滑移也挂旋钮(见上面 kbDrag 的说明): skybound.kbShift(默认 1)。
    // 鼠标模式**不动**(用户明确说鼠标已经好了) —— 它恒用 0.21。
    const kbShiftMul = readTuning('skybound.kbShift', 1, 0, 2);
    // === 键盘模式左右轴最大值再减半 (per user request: "左右轴滑移最大值只能为原来的二分之一") ==
    // 0.13 → 0.065(与上面 kbDrag 的 0.15→0.075 一起, 把键盘左右轴的上限压到原来一半)。
    const shiftMag = this.mouseAimDir ? 0.21 : 0.065 * kbShiftMul;
    // === 竖直滑移的驱动量: 航迹在**世界竖直方向**上的弯曲 =============================
    // 引擎的 playerGForce = 1 + |ω×v|/g **恒 ≥ 1**(无符号), 所以方向得自己判。
    //   dF = playerForward − 上一帧(**航迹**的转向矢量);  turnMag = |dF|
    // ★ 参照系必须是**世界向上**(= 施加滑移用的屏幕 up 同源), **不能**用机体的上方。
    //   用户报的 bug: "为什么在倒飞的时候上下滑移的方向才是对的" —— 因为用 dF·playerUp 得到的是
    //   **载荷方向**(座舱里感觉到的 G), 它只在正飞时与世界竖直一致; 倒飞时两者恰好相反 ⇒ 方向反。
    //   用世界竖直就没这个问题: 正飞/倒飞/侧立/垂直爬升/滚转中, 方向都自动正确 ——
    //     正 = 航迹在**世界**里向上弯(拉起/爬升) 负 = 向下弯(俯冲) 平飞转弯(航迹水平)自然得 0。
    // 连续投影(不是 ±1 硬符号): 换杆/滚转时平滑穿过 0, 不会"啪"地翻转(用户: "滑移不自然")。
    this._gTmp.copy(playerForward).sub(this._prevPlayerFwd);
    const turnMag = this._gTmp.length();
    this._gSign = turnMag > 1e-5
      ? THREE.MathUtils.clamp(this._gTmp.dot(this._shiftUp0) / turnMag, -1, 1)
      : 0;
    this._prevPlayerFwd.copy(playerForward);
    const gSigned = (this.gForce - 1) * this._gSign;
    this.updateManeuverShift(dt, playerRight.y, playerForward.y, playerUp.y, shiftMag, gSigned);
      const sd = this._shiftF.copy(desiredLook).sub(desiredPos);
      const sdLen = sd.length();
      if (sdLen > 1e-3) {
        sd.multiplyScalar(1 / sdLen);
        this.applyManeuverShift(desiredPos, desiredLook, sd, sdLen, desiredFov);
      }
    }

    // === Camera frame-centre offset (per user request: 机库调视野中心) ===
    // Traditional cameras only (the mouse-aim branch computes its own 3D view
    // centre above): shift the final look target along the camera's right/up
    // so the aircraft sits at the hangar-tuned screen position, and back the
    // camera off by z (zoom). Transient views (wingman/missile/cinematic)
    // are untouched.
    if (noTransientView && !this.mouseAimDir) {
      const fc = this.frameCenterOld;
      if (fc.x !== 0 || fc.y !== 0 || fc.z !== 0) {
        const fwd = this.tmpFrameF.copy(desiredLook).sub(desiredPos);
        const dist = fwd.length();
        if (dist > 0.001) {
          fwd.normalize();
          const right = this.tmpFrameR.crossVectors(fwd, this.tmpFrameWU);
          if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
          else right.normalize();
          const up = this.tmpFrameU.crossVectors(right, fwd);
          // Half-screen extent at the plane's distance — converts the -1..1
          // screen fraction into a world-unit look-target shift.
          const S = dist * Math.tan(THREE.MathUtils.degToRad(desiredFov * 0.5));
          desiredLook.addScaledVector(right, -fc.x * S).addScaledVector(up, -fc.y * S);
          // z: pull the camera along its look direction (positive = closer).
          desiredPos.addScaledVector(fwd, -fc.z);
        }
      }
    }

    // Smooth toward desired — slower lerp = more weight/drag feel.
    // We use a critically-damped spring for position to give it punchy-but-heavy feel.
    // When zoom is very close, snap faster so the user sees the close-up quickly.
    // === Reverted to lighter, more responsive camera lerp (per user request: 太重了) ===
    // The previous "heavier weight" pass trimmed the base chase lerp to 0.10
    // which made the camera lag too far behind the aircraft — felt like the
    // camera was on a long boom arm. Reverted to 0.18 so the camera follows
    // crisply but still has a tiny bit of lag for character.
    //
    // === Frame guarantee REMOVED (per user request: 不准让机体在视角外的限制机制) ===
    // The previous frame-guarantee code computed the angle between the
    // camera's look direction and the direction to the player, then boosted
    // the lerp factor when that angle exceeded 18° to snap the player back
    // into frame. This is exactly the "keep the aircraft in view" mechanism
    // the user wants GONE — regardless of zoom level / FOV. With it removed,
    // the camera follows the smoothed chase offset and does NOT intervene
    // if the player aircraft drifts out of the FOV during hard maneuvers.
    // Side view (CapsLock) already had this bypass; now chase + far also
    // skip it. The only thing that still pulls the camera is the natural
    // spring lerp toward desiredPos — no boost, no auto-recenter.
    const closeBoost = this.zoomMult < 0.5 ? (0.5 - this.zoomMult) * 0.6 : 0;
    // === Side view uses a tighter lerp (per user request) ===
    // Side view is rigidly attached to the gunport (like cockpit mode), so
    // we use a fast lerp (0.55) so the camera tracks the airframe crisply.
    // The mouse-drag offset (sideViewYawSmooth/PitchSmooth) is what gives
    // the camera its aim direction — that's already smoothed above.
    // === 机动跟随(快) 与 回正(慢) 分离 (per user request) ===
    // 上一轮我把整个系数 ÷3, 结果"跟随机动"也一起变慢了(用户: 相机响应转向/机动和回正一样慢)。
    // 其实这是两种不同的事, 应该分开:
    //   · **机动中**(有载荷/姿态在变) → 用原值快速跟随, 镜头才跟得上转弯;
    //   · **平稳时**(回正/拖曳恢复) → 用 ÷3 的慢速, 才有"重"的回正手感。
    // 判据原来是现成的过载量 `gForce`: 1G = 平稳 → 慢; 3.5G+ = 机动 → 快。
    // === 多轴叠加融合 (per user request: 相机响应升级成多轴融合, 不再单轴) ===
    // 只用 |gForce−1| 判据是**单轴**的: 过载几乎只由拉杆(俯仰)产生, 纯滚转/纯偏航时
    // ≈ 0 ⇒ 相机一直用回正的慢速率 ⇒ 玩家感受就是"相机只响应一个轴"。
    // 现在再并入**姿态角速率项**(上面对低通姿态基算出的 _mvrRateFwd/_mvrRateUp, 三轴都会进),
    // 两者取 max 融合: 俯仰(过载大)/滚转(up 速率大)/偏航(fwd 速率大) 任一轴机动都进入快跟随,
    // 松杆后两项同时衰减 ⇒ 回正也是同一套融合后的速率(仍然慢)。
    // 灵敏度同步降 (per user request: 机动更难拉动视角): 满机动判据 0.9 → 1.3 rad/s,
    // 过载判据 2.5 → 3.5 G ⇒ 同样的机动只给出原先 ~70% 的机动量, 镜头更"粘"在机身上。
    const mvrRate = (this._mvrRateFwd + this._mvrRateUp * 0.5) / 1.3;
    const maneuverAmt = THREE.MathUtils.clamp(
      Math.max(Math.abs(this.gForce - 1) / 3.5, mvrRate), 0, 1);
    const posFast = THREE.MathUtils.clamp(0.3 * this.followSpeed + closeBoost + (1 - this.lagScale) * 0.2, 0.08, 0.92);
    const posSlow = THREE.MathUtils.clamp(posFast / 3, 0.03, 0.31);
    let lerpPos = this.current === 'cinematic' ? 0.06
      : this.current === 'cockpit' ? 0.6
      : this.current === 'side' ? 0.55
      : THREE.MathUtils.lerp(posSlow, posFast, maneuverAmt);
    // === Lag-scale look lerp (per user request: 拖尾可调让视角更稳) ===
    // Lower lagScale → faster look follow so the view feels locked in.
    // === 注视点: 同样"机动快 / 回正慢" (per user request) ===
    // 原式 clamp(0.28×followSpeed + (1−lagScale)×0.1, 0.08, 0.6) ⇒ 默认 0.28/帧;
    // 机动中用原值(镜头跟得住转弯), 平稳时用 ÷3(慢回正, τ≈0.179s)。
    const lookFast = THREE.MathUtils.clamp(0.28 * this.followSpeed + (1 - this.lagScale) * 0.1, 0.08, 0.6);
    const lookSlow = THREE.MathUtils.clamp(lookFast / 3, 0.03, 0.21);
    let lerpLook = this.current === 'cinematic'
      ? 0.08
      : THREE.MathUtils.lerp(lookSlow, lookFast, maneuverAmt);
    // === (已删除)速度前馈 ===
    // 上一轮试过"期望机位沿速度外推一个帧时"来消除滞后, 但那是**错的工具**:
    // 外推量 = 速度 × dt, 一旦掉帧/卡顿(dt 0.05~0.15s)就是 30~90 世界单位的一次性位移,
    // 相机被"推"一下 ⇒ **闪现更严重**。正确做法见下面: 相机位置不再按世界坐标平滑。
    // === Mouse-aim camera: LOCKED view-centre tracking (per user request) ===
    // The mouse-aim camera uses its OWN lerp from skybound.maFloat — 0 locks
    // the position/look to the view-centre ball (lerp 1.0, so the aircraft
    // never drifts away at speed), 1 restores the floaty chase feel (0.5).
    if (this.mouseAimDir) {
      const maK = THREE.MathUtils.clamp(1 - this.mouseAimFloat * 0.5, 0.05, 1);
      lerpPos = maK;
      lerpLook = maK;
    }

    // === 平滑的是**相对机体的偏移**, 不是世界坐标 (per fix: 相机突然跟不上又突然闪回) ===
    // 根因: 原来 `this.pos` 存的是**世界坐标**, 每帧向世界目标插值 —— 于是相机的实际滞后
    // 正比于帧时(速度 600 × dt 0.15s = 90 单位)。一旦卡顿/掉帧, 相机就被落下 90 单位,
    // 随后几帧再追回来 ⇒ 观感就是"闪一下"。这也解释了为什么它**经常**出现(帧时抖动是常态)。
    // 现在改成: 偏移(机体 → 相机/注视点)才做平滑, 世界位置每次都用**当帧**机体位置重建:
    //   相机世界位置 = playerPos + 平滑后的偏移
    // ⇒ 无论帧时多大, 相机都不会在世界上被落下, 卡顿不再闪; 平滑只负责"机位相对机体的
    //    角度/距离"这类慢变量, 手感(拖尾/回正)完全保留。
    this._tmpOffA.copy(desiredPos).sub(playerPos);
    this._tmpOffB.copy(desiredLook).sub(playerPos);
    if (this.pos.lengthSq() === 0) {
      this.pos.copy(this._tmpOffA);
      this.look.copy(this._tmpOffB);
    } else {
      // 帧率一致平滑: 每帧固定因子 → 按实际 dt 积分(60Hz 手感不变)。
      // dt 上限收紧到 0.1s: 卡顿帧不再让平滑一次跨一大步(偏移是慢变量, 收窄上限不损手感)。
      const sdtC = dt > 0 ? Math.min(dt, 0.1) : 1 / 60;
      this.pos.lerp(this._tmpOffA, CameraRig.frameToDt(lerpPos, sdtC));
      this.look.lerp(this._tmpOffB, CameraRig.frameToDt(lerpLook, sdtC));
    }
    // === 机顶(决定画面滚转)也走同一套融合速率 (per user request: 回正也是多轴融合) ===
    // 原来是固定 0.1/帧: 机动中滚转跟不住(画面歪着慢慢扭回来), 且和 pos·look 的
    // "机动快/回正慢"节奏不一致。现在 chase/far 与 lerpPos/lerpLook 用**同一个** maneuverAmt
    // ⇒ 俯仰+滚转+偏航同时机动时, 三个目标(位置/注视点/机顶)按同一融合量一起响应、一起回正。
    // 机舱/侧炮/电影这三种"刚性挂载"机位保持原值(它们本来就硬跟, 别动);
    // 鼠标操控模式机顶恒为世界上方(相机不跟着滚), 也不动。
    const rigidView = this.current === 'cinematic' || this.current === 'cockpit' || this.current === 'side';
    const upRate = (this.mouseAimDir || rigidView) ? 0.1
      : THREE.MathUtils.lerp(0.1, 0.3, maneuverAmt);
    this.up.lerp(desiredUp, CameraRig.frameToDt(upRate, dt > 0 ? Math.min(dt, 0.1) : 1 / 60));

    this.fov = THREE.MathUtils.lerp(this.fov, desiredFov, CameraRig.frameToDt(0.06, dt > 0 ? Math.min(dt, 0.33) : 1 / 60));
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();

    // Shake — base shake (events) plus ambient G-load rumble
    // === Reduced shake (per user request) ===
    // Event-shake duration trimmed (0.5 → 0.3) and decay rate increased
    // (0.9 → 0.82) so hit/explosion shakes recover quickly and don't bleed
    // into the next event. The previous values left a residual wobble for
    // ~0.8s after a hit, which the user found too much.
    let shakeOffset = new THREE.Vector3();
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const s = this.shakeAmt * (this.shakeT / 0.3);
      shakeOffset.add(new THREE.Vector3(
        (Math.random() - 0.5) * s * 1.0,
        (Math.random() - 0.5) * s * 1.0,
        (Math.random() - 0.5) * s * 1.0,
      ));
      this.shakeAmt *= 0.82;
    }
    // G-load ambient rumble — small high-frequency jitter when pulling Gs.
    // Tuned down: only kicks in past 6G (was 5G) and amplitude halved so the
    // view stays readable during high-G maneuvers — the player aircraft must
    // remain locked in frame, not jittering around.
    if (this.gForce > 6) {
      const gShake = (this.gForce - 6) * 0.012; // was 0.025 — halved
      shakeOffset.add(new THREE.Vector3(
        (Math.random() - 0.5) * gShake,
        (Math.random() - 0.5) * gShake,
        (Math.random() - 0.5) * gShake,
      ));
    }

    // === Ambient airflow turbulence =====================================
    // Continuous, organic low-amplitude camera wobble driven by airspeed.
    // This is the "you're flying through real air" feel — distinct from event
    // shake (explosions) and G-rumble (maneuvers). Uses three sine waves with
    // slowly drifting phase so the motion never repeats.
    // Skip in cockpit mode (camera is rigidly attached to the airframe there).
    // === Trimmed (per user request) ===
    // Amplitude was 0.04 + speedT * 0.12 — bumped the camera around enough
    // that the player aircraft never felt "locked in". New amplitude is half
    // as strong so the camera stays calm even at top speed.
    if (this.current !== 'cockpit' && this.current !== 'cinematic') {
      // Advance phase with per-axis drift rates (drift itself slowly varies)
      this.turbDriftX += (Math.random() - 0.5) * dt * 0.4;
      this.turbDriftY += (Math.random() - 0.5) * dt * 0.4;
      this.turbDriftZ += (Math.random() - 0.5) * dt * 0.4;
      // Clamp drift so it doesn't run away
      this.turbDriftX = THREE.MathUtils.clamp(this.turbDriftX, 0.3, 2.0);
      this.turbDriftY = THREE.MathUtils.clamp(this.turbDriftY, 0.3, 2.0);
      this.turbDriftZ = THREE.MathUtils.clamp(this.turbDriftZ, 0.3, 2.0);
      // === Slower phase advance (per user request) ===
      // Previous rates (4/5/3 + drift) made the wobble visibly fast. Trimmed
      // to (2.5/3.0/2.0 + drift) so the camera drifts slowly and gently.
      this.turbPhaseX += dt * (2.5 + this.turbDriftX) * (0.6 + this.speedT);
      this.turbPhaseY += dt * (3.0 + this.turbDriftY) * (0.6 + this.speedT);
      this.turbPhaseZ += dt * (2.0 + this.turbDriftZ) * (0.6 + this.speedT);
      // Amplitude scales with airspeed — barely perceptible at low speed,
      // noticeable buffeting at high speed. Storm weather amplifies further
      // (engine reads storm via gForce proxy: high-G maneuvers feel rougher).
      // === 幅度放大 (per user request: 机体自身的气流晃动幅度都太小了) ===
      // 历史: 0.04 + speedT×0.12 → 减半到 0.02 + speedT×0.06(为了"稳")。
      // 现在按用户要求**放大到原来的 3 倍**: 0.06 + speedT×0.18 ——
      // 低速时是轻微飘动, 高速时能看到明显的颠簸/抖动, 但仍然是"连续的气流"而不是事件抖屏。
      // 想再调: localStorage 'skybound.turbAmp'(倍数, 默认 1) —— 1.5 = 再放大一半, 0 = 关掉。
      let turbMul = 1;
      try {
        // === 键不存在必须回到默认值 (per fix) ===
        // 旧写法 Number(null) === 0 且守卫是 `>= 0` ⇒ turbAmp 被解析成 0 ⇒ 镜头气流抖动
        // 在默认配置下**完全不生效**(用户一直看不到它)。
        turbMul = readTuning('skybound.turbAmp', 1, 0, 5);
      } catch { /* ignore */ }
      // 退回"减半"值 (per user request: 要晃的是机体, 不是镜头)
      const amp = (0.02 + this.speedT * 0.06) * turbMul;
      // Triple-frequency sine for organic, non-pure-sinusoidal wobble
      const wx = Math.sin(this.turbPhaseX) * 0.6 + Math.sin(this.turbPhaseX * 2.3) * 0.3 + Math.sin(this.turbPhaseX * 4.7) * 0.1;
      const wy = Math.sin(this.turbPhaseY) * 0.6 + Math.sin(this.turbPhaseY * 2.7) * 0.3 + Math.sin(this.turbPhaseY * 5.1) * 0.1;
      const wz = Math.sin(this.turbPhaseZ) * 0.6 + Math.sin(this.turbPhaseZ * 2.1) * 0.3 + Math.sin(this.turbPhaseZ * 4.3) * 0.1;
      shakeOffset.add(new THREE.Vector3(wx * amp, wy * amp, wz * amp * 0.5));
    }

    // 世界位置 = 当帧机体位置 + 平滑后的偏移(见上面的说明)
    this.camera.position.copy(playerPos).add(this.pos).add(shakeOffset);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this._tmpLookWorld.copy(playerPos).add(this.look));
  }
}
