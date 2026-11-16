import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type {
  CameraViews,
  FollowView,
  OrbitView,
  Region,
  Vec3,
  WorldDocument,
} from "../../../shared/document";
import { key } from "../../../shared/document";
import { materialSpec } from "../../../shared/materials";
import { traceVoxels } from "./voxel";

export type RigMode = "orbit" | "follow";
const TRANSITION_MS = 450;
const FOLLOW_MIN_DIST = 2.2;
const FOLLOW_MAX_DIST = 10;
const MIN_PITCH = 0.12;
const MAX_PITCH = Math.PI / 2 - 0.08;
const SMOOTH = 1 - Math.exp(-8 * 0.016);

export const defaultViews = (): CameraViews => ({
  orbit: {
    target: { x: 0, y: 2, z: 0 },
    yaw: Math.atan2(34, 30),
    pitch: 1.03,
    distance: Math.hypot(30, 25, 34),
  },
  follow: { yaw: Math.PI, pitch: 0.42, distance: 5.5 },
});

export interface RigDeps {
  camera: THREE.PerspectiveCamera;
  dom: HTMLElement;
  getDoc: () => WorldDocument;
  getPlayer: () => Vec3;
  getMode: () => RigMode;
  /** 每帧检测到的需要局部淡出的不透明方块 */
  onFadeChange: (cells: Set<string>) => void;
}

const easeInOut = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

export class CameraRig {
  private deps: RigDeps;
  private controls: OrbitControls;
  private orbit: OrbitView;
  private follow: FollowView;
  private mode: RigMode = "orbit";
  private transition: {
    from: THREE.Vector3;
    fromTarget: THREE.Vector3;
    start: number;
    toMode: RigMode;
  } | null = null;
  private locked = false;
  private followTarget = new THREE.Vector3();
  private actualPos = new THREE.Vector3(30, 27, 34);
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };
  private aspect = 1;
  private lastSaved = "";

  constructor(deps: RigDeps) {
    this.deps = deps;
    const views = deps.getDoc().views ?? defaultViews();
    this.orbit = structuredClone(views.orbit);
    this.follow = structuredClone(views.follow);
    this.controls = new OrbitControls(deps.camera, deps.dom);
    this.controls.maxPolarAngle = Math.PI / 2.1;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 70;
    this.controls.enableDamping = true;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.target.set(
      this.orbit.target.x,
      this.orbit.target.y,
      this.orbit.target.z,
    );
    deps.camera.position.copy(this.orbitPose().pos);
    this.controls.update();
    this.actualPos.copy(deps.camera.position);
    deps.dom.addEventListener("pointerdown", this.onPointerDown);
    deps.dom.addEventListener("pointermove", this.onPointerMove);
    deps.dom.addEventListener("pointerup", this.onPointerUp);
    deps.dom.addEventListener("wheel", this.onWheel, { passive: false });
  }

  get inputLocked() {
    return this.locked;
  }

  /** 只读相机姿态探针，供端到端验证使用 */
  probe() {
    return {
      mode: this.mode,
      locked: this.locked,
      target: this.controls.target.toArray(),
    };
  }

  private orbitPose(): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const target = new THREE.Vector3(
      this.orbit.target.x,
      this.orbit.target.y,
      this.orbit.target.z,
    );
    const pos = target
      .clone()
      .add(
        new THREE.Vector3(
          Math.sin(this.orbit.yaw) * Math.sin(this.orbit.pitch),
          Math.cos(this.orbit.pitch),
          Math.cos(this.orbit.yaw) * Math.sin(this.orbit.pitch),
        ).multiplyScalar(this.orbit.distance),
      );
    return { pos, target };
  }

  private followPose(): {
    pos: THREE.Vector3;
    target: THREE.Vector3;
  } {
    const p = this.deps.getPlayer();
    const desiredTarget = new THREE.Vector3(p.x, p.y + 1.25, p.z);
    if (!this.followTarget.lengthSq() || this.mode === "orbit")
      this.followTarget.copy(desiredTarget);
    this.followTarget.lerp(desiredTarget, SMOOTH);
    const target = this.followTarget.clone();
    const pos = target
      .clone()
      .add(
        new THREE.Vector3(
          Math.sin(this.follow.yaw) * Math.cos(this.follow.pitch),
          Math.sin(this.follow.pitch),
          Math.cos(this.follow.yaw) * Math.cos(this.follow.pitch),
        ).multiplyScalar(this.follow.distance),
      );
    return { pos, target };
  }

  setMode(mode: RigMode, force = false) {
    if (mode === this.mode && !this.transition && !force) return;
    const camera = this.deps.camera;
    this.transition = {
      from: camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      start: performance.now(),
      toMode: mode,
    };
    this.locked = true;
    this.controls.enabled = false;
    this.dragging = false;
    if (mode === "follow") {
      const p = this.deps.getPlayer();
      this.followTarget.set(p.x, p.y + 1.25, p.z);
    }
  }

  /** 选区变化时让轨道中心平滑检查选区 */
  focusRegion(region: Region) {
    if (this.mode !== "orbit" || this.transition) return;
    const { a, b } = region;
    const center = new THREE.Vector3(
      (a.x + b.x + 1) / 2,
      (a.y + b.y + 1) / 2,
      (a.z + b.z + 1) / 2,
    );
    const size = Math.max(
      Math.abs(a.x - b.x) + 1,
      Math.abs(a.y - b.y) + 1,
      Math.abs(a.z - b.z) + 1,
    );
    const halfFov = THREE.MathUtils.degToRad(this.deps.camera.fov * 0.5);
    const fit = (size * 0.85) / Math.tan(halfFov);
    this.orbit.target = { x: center.x, y: center.y, z: center.z };
    this.orbit.distance = clamp(
      Math.max(this.orbit.distance, fit),
      6,
      this.controls.maxDistance,
    );
    // 立即让 OrbitControls 与新球坐标对齐，避免下一帧跳变
    const pose = this.orbitPose();
    this.controls.target.copy(pose.target);
    this.deps.camera.position.copy(pose.pos);
    this.controls.update();
  }

  clearRegionFocus(): void {
    this.orbit.target = { x: 0, y: 2, z: 0 };
    const pose = this.orbitPose();
    this.controls.target.copy(pose.target);
    this.deps.camera.position.copy(pose.pos);
    this.controls.update();
  }

  reset() {
    const home = defaultViews();
    this.orbit = structuredClone(home.orbit);
    this.follow = structuredClone(home.follow);
    this.persist(true);
    this.setMode("orbit", true);
  }

  /** 载入存档后按当前窗口比例恢复各自视角 */
  applyLoaded(views: CameraViews | undefined) {
    const v = views ?? defaultViews();
    this.orbit = structuredClone(v.orbit);
    this.follow = structuredClone(v.follow);
    this.aspect = this.deps.camera.aspect;
    // 竖屏/窄窗口下球坐标不变，仅把距离放宽以保持构图，位置完全由球坐标重算
    if (this.aspect < 1.15)
      this.orbit.distance = clamp(
        this.orbit.distance * Math.sqrt(1.15 / Math.max(0.4, this.aspect)),
        6,
        this.controls.maxDistance,
      );
    const { pos, target } = this.orbitPose();
    this.deps.camera.position.copy(pos);
    this.controls.target.copy(target);
    this.actualPos.copy(pos);
    this.mode = "orbit";
    this.transition = null;
    this.locked = false;
    this.controls.enabled = true;
    this.controls.enableZoom = true;
    this.controls.enableRotate = true;
    this.controls.enablePan = true;
    this.controls.update();
  }

  private persist(force = false) {
    const snapshot = JSON.stringify({
      orbit: this.orbit,
      follow: this.follow,
    });
    if (!force && snapshot === this.lastSaved) return;
    this.lastSaved = snapshot;
    const doc = this.deps.getDoc();
    doc.views = {
      orbit: structuredClone(this.orbit),
      follow: structuredClone(this.follow),
    };
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.mode !== "follow" || this.locked) return;
    this.dragging = true;
    this.lastPointer = { x: e.clientX, y: e.clientY };
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging || this.locked) return;
    const dx = e.clientX - this.lastPointer.x;
    const dy = e.clientY - this.lastPointer.y;
    this.lastPointer = { x: e.clientX, y: e.clientY };
    this.follow.yaw -= dx * 0.005;
    this.follow.pitch = clamp(
      this.follow.pitch - dy * 0.005,
      MIN_PITCH,
      MAX_PITCH,
    );
  };

  private onPointerUp = () => {
    this.dragging = false;
  };

  private onWheel = (e: WheelEvent) => {
    if (this.mode !== "follow" || this.locked) return;
    e.preventDefault();
    this.follow.distance = clamp(
      this.follow.distance + e.deltaY * 0.006,
      FOLLOW_MIN_DIST,
      FOLLOW_MAX_DIST,
    );
  };

  private isOpaqueSolid = (cell: Vec3) => {
    const b = this.deps.getDoc().blocks[key(cell)];
    return !!b && materialSpec(b.material).opacity >= 1;
  };

  /**
   * 跟随相机避障：方向保持不变（准星不转向背后的方块），
   * 仅沿视线把相机拉近；距离仍不足时由淡出层处理遮挡。
   */
  private resolveFollow(
    pos: THREE.Vector3,
    target: THREE.Vector3,
  ): { pos: THREE.Vector3; fade: Set<string> } {
    const dir = pos.clone().sub(target);
    const desired = dir.length();
    dir.normalize();
    const hits = traceVoxels(target, dir, desired, this.isOpaqueSolid);
    const fade = new Set<string>();
    if (!hits.length) {
      // 近裁剪面跟随距离收窄，避免贴近时角色被近平面切掉
      this.deps.camera.near = clamp(desired * 0.08, 0.05, 0.3);
      return { pos, fade };
    }
    const first = hits[0];
    const pull = Math.max(first.enter - 0.35, FOLLOW_MIN_DIST * 0.55);
    const resolved = target.clone().add(dir.multiplyScalar(pull));
    this.deps.camera.near = clamp(pull * 0.18, 0.05, 0.3);
    // 拉到最近仍被墙夹住时，把剩余不透明遮挡方块局部淡出
    if (pull < FOLLOW_MIN_DIST + 0.25)
      for (const h of hits)
        if (h.enter <= pull + 0.15) fade.add(key(h.cell));
    return { pos: resolved, fade };
  }

  update(now: number) {
    const camera = this.deps.camera;
    let fade = new Set<string>();

    if (this.transition) {
      const t = clamp(
        (now - this.transition.start) / TRANSITION_MS,
        0,
        1,
      );
      const k = easeInOut(t);
      const end =
        this.transition.toMode === "follow"
          ? this.followPose()
          : this.orbitPose();
      camera.position.lerpVectors(this.transition.from, end.pos, k);
      this.controls.target.lerpVectors(
        this.transition.fromTarget,
        end.target,
        k,
      );
      camera.lookAt(this.controls.target);
      camera.near = THREE.MathUtils.lerp(camera.near, 0.1, k);
      if (t >= 1) {
        this.mode = this.transition.toMode;
        this.transition = null;
        this.locked = false;
        this.controls.enabled = this.mode === "orbit";
        // 跟随模式下滚轮由自定义控制器处理，避免 OrbitControls 抢事件
        this.controls.enableZoom = this.mode === "orbit";
        this.controls.enableRotate = this.mode === "orbit";
        this.controls.enablePan = this.mode === "orbit";
        if (this.mode === "follow") {
          this.actualPos.copy(camera.position);
        } else {
          this.controls.update();
        }
        this.persist(true);
      }
      camera.updateProjectionMatrix();
      this.deps.onFadeChange(fade);
      return;
    }

    if (this.mode === "orbit") {
      this.controls.update();
      // 从 OrbitControls 的实际姿态反算球坐标并保存
      const offset = camera.position.clone().sub(this.controls.target);
      const dist = offset.length();
      this.orbit = {
        target: {
          x: this.controls.target.x,
          y: this.controls.target.y,
          z: this.controls.target.z,
        },
        yaw: Math.atan2(offset.x, offset.z),
        pitch: Math.acos(clamp(offset.y / dist, -1, 1)),
        distance: dist,
      };
      this.persist();
      camera.near = 0.1;
      camera.updateProjectionMatrix();
      this.deps.onFadeChange(new Set());
      return;
    }

    // follow
    const { pos, target } = this.followPose();
    const resolved = this.resolveFollow(pos, target);
    fade = resolved.fade;
    this.actualPos.lerp(resolved.pos, SMOOTH);
    camera.position.copy(this.actualPos);
    this.controls.target.copy(target);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    this.persist();
    this.deps.onFadeChange(fade);
  }

  dispose() {
    this.deps.dom.removeEventListener("pointerdown", this.onPointerDown);
    this.deps.dom.removeEventListener("pointermove", this.onPointerMove);
    this.deps.dom.removeEventListener("pointerup", this.onPointerUp);
    this.deps.dom.removeEventListener("wheel", this.onWheel);
    this.controls.dispose();
  }
}
