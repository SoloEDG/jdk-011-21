import * as THREE from "three";
import { blockMeshes, disposeGroup, type BlockMeshes } from "./meshes";
import { CameraRig, defaultViews, type RigMode } from "./cameraRig";
import type { Workspace, Vec3 } from "../../../shared/document";
import { key } from "../../../shared/document";
import type { SceneHit } from "../../../shared/commands";
export function mountScene(
  host: HTMLElement,
  state: Workspace,
  onHit: (hit: SceneHit) => void,
) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#dce5df");
  scene.fog = new THREE.Fog("#dce5df", 55, 110);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  camera.position.set(30, 27, 34);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  let blocks: BlockMeshes = blockMeshes(state.doc);
  scene.add(blocks.group);
  let fadeSet = new Set<string>();
  let activeFadeSig = "";
  let revision = state.doc.revision;

  const rig = new CameraRig({
    camera,
    dom: renderer.domElement,
    getDoc: () => state.doc,
    getPlayer: () => state.doc.player,
    getMode: () => (state.mode === "walk" ? "follow" : "orbit"),
    onFadeChange: (cells) => {
      fadeSet = cells;
    },
  });

  scene.add(new THREE.HemisphereLight("#fffae8", "#779082", 2.5));
  const sun = new THREE.DirectionalLight("#fff1d5", 3);
  sun.position.set(-15, 32, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    left: -25,
    right: 25,
    top: 25,
    bottom: -25,
  });
  sun.shadow.bias = -0.001;
  scene.add(sun);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: "#cdd8d0", roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.08;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(32, 32, "#abb9ad", "#c3cec3");
  grid.position.y = 0.005;
  scene.add(grid);

  const cursor = new THREE.Mesh(
    new THREE.BoxGeometry(1.02, 1.02, 1.02),
    new THREE.MeshBasicMaterial({ color: "#e9b261", wireframe: true }),
  );
  cursor.visible = false;
  scene.add(cursor);
  const region = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({
      color: "#eab569",
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    }),
  );
  region.visible = false;
  scene.add(region);
  const avatar = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.95, 0.38),
    new THREE.MeshStandardMaterial({ color: "#df8d4d" }),
  );
  body.position.y = 0.7;
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.46, 0.46, 0.46),
    new THREE.MeshStandardMaterial({ color: "#f1ceac" }),
  );
  head.position.y = 1.4;
  avatar.add(body, head);
  scene.add(avatar);

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let pointerKnown = false;
  let hit: SceneHit | null = null;
  let down = { x: 0, y: 0 };

  /** 用当前（本帧）相机矩阵做拾取，保证相机运动与指针拾取同源 */
  function pick(): SceneHit | null {
    if (!pointerKnown) return null;
    ray.setFromCamera(ndc, camera);
    const h = ray.intersectObjects(blocks.pickables, false)[0];
    if (h && h.instanceId !== undefined && h.face) {
      const cell = h.object.userData.cells[h.instanceId] as Vec3;
      const n = h.face.normal;
      const result: SceneHit = {
        cell: { ...cell },
        adjacent: { x: cell.x + n.x, y: cell.y + n.y, z: cell.z + n.z },
      };
      const p = state.tool === "place" ? result.adjacent : result.cell;
      cursor.position.set(p.x + 0.5, p.y + 0.5, p.z + 0.5);
      return result;
    }
    return null;
  }

  const onPointerMove = (e: PointerEvent) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      (-(e.clientY - r.top) / r.height) * 2 + 1,
    );
    pointerKnown = true;
  };
  const onPointerDown = (e: PointerEvent) => {
    down = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent) => {
    // 模式切换过渡期间或仍在过渡中按下的点击一律忽略，避免一次点击被解释成两个位置
    if (
      e.button !== 0 ||
      rig.inputLocked ||
      state.mode !== "build" ||
      Math.hypot(e.clientX - down.x, e.clientY - down.y) >= 5
    )
      return;
    // 点击瞬间以同一帧相机矩阵重新检测，而不是复用旧帧缓存
    const fresh = pick();
    if (fresh) onHit(fresh);
  };
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);

  const resize = new ResizeObserver(() => {
    const w = host.clientWidth,
      h = host.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resize.observe(host);

  let frame = 0,
    currentDoc = state.doc,
    regionKey: string | null = null,
    rigMode: RigMode = "orbit";

  function rebuildBlocks() {
    scene.remove(blocks.group);
    disposeGroup(blocks.group);
    blocks = blockMeshes(state.doc, fadeSet);
    scene.add(blocks.group);
    revision = state.doc.revision;
    activeFadeSig = fadeSig(fadeSet);
  }

  function animate(now: number) {
    frame = requestAnimationFrame(animate);
    // 存档载入：文档被整体替换，按新窗口比例恢复各自视角
    if (state.doc !== currentDoc) {
      currentDoc = state.doc;
      rig.applyLoaded(state.doc.views ?? defaultViews());
      regionKey = null;
      rebuildBlocks();
    }
    const nextMode: RigMode = state.mode === "walk" ? "follow" : "orbit";
    if (nextMode !== rigMode && !rig.inputLocked) {
      rigMode = nextMode;
      rig.setMode(nextMode);
    }
    rig.update(now);

    // 方块变更或淡出集合变化才重建；淡出方块的碰撞与拾取仍在同一数据上
    if (
      state.doc.revision !== revision ||
      fadeSig(fadeSet) !== activeFadeSig
    )
      rebuildBlocks();

    avatar.position.set(
      state.doc.player.x,
      state.doc.player.y,
      state.doc.player.z,
    );
    if (state.region) {
      const { a, b } = state.region;
      const rk = `${key(a)}>${key(b)}`;
      if (rk !== regionKey) {
        regionKey = rk;
        rig.focusRegion(state.region);
      }
      region.visible = true;
      region.position.set(
        (a.x + b.x + 1) / 2,
        (a.y + b.y + 1) / 2,
        (a.z + b.z + 1) / 2,
      );
      region.scale.set(
        Math.abs(a.x - b.x) + 1,
        Math.abs(a.y - b.y) + 1,
        Math.abs(a.z - b.z) + 1,
      );
    } else if (regionKey !== null) {
      regionKey = null;
      rig.clearRegionFocus();
      region.visible = false;
    }

    // 相机更新之后再拾取：悬停准星与点击使用的是同一帧视图
    hit = pick();
    cursor.visible = !!hit;
    renderer.render(scene, camera);
  }
  animate(0);
  // 只读探针：供端到端验证相机姿态/淡出集合，不参与业务逻辑
  (renderer.domElement as any).__cameraProbe = () => ({
    ...rig.probe(),
    position: camera.position.toArray(),
    near: camera.near,
    aspect: camera.aspect,
    fade: [...fadeSet],
  });
  return {
    reset() {
      rigMode = "orbit";
      rig.reset();
    },
    dispose() {
      cancelAnimationFrame(frame);
      resize.disconnect();
      rig.dispose();
      disposeGroup(blocks.group);
      renderer.dispose();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.remove();
    },
  };
}
function fadeSig(set: Set<string>) {
  return [...set].sort().join(",");
}
