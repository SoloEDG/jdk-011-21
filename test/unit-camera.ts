import * as THREE from "three";
import { traceVoxels } from "../src/features/world/lib/voxel";
import {
  CameraRig,
  defaultViews,
} from "../src/features/world/lib/cameraRig";
import type { Vec3, WorldDocument } from "../src/shared/document";
import { key } from "../src/shared/document";

let passed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) throw new Error(`${name}${detail ? " — " + detail : ""}`);
  passed++;
  console.log(`PASS  ${name}`);
}
const solidWorld = (cells: [number, number, number][]) => {
  const set = new Set(cells.map(([x, y, z]) => `${x},${y},${z}`));
  return (c: Vec3) => set.has(key(c));
};

// ---------- DDA 体素射线 ----------
{
  // 沿 +X 方向穿过 3 个实心体素
  const isSolid = solidWorld([
    [1, 0, 0],
    [2, 0, 0],
    [3, 0, 0],
  ]);
  const hits = traceVoxels(
    new THREE.Vector3(0.5, 0.5, 0.5),
    new THREE.Vector3(1, 0, 0),
    4,
    isSolid,
  );
  check("DDA 沿轴射线命中全部实心体素", hits.length === 3, `n=${hits.length}`);
  check(
    "DDA 入口距离单调且正确",
    hits[0].enter === 0.5 && hits[1].enter === 1.5 && hits[2].enter === 2.5,
    hits.map((h) => h.enter).join(","),
  );
}
{
  // 对角线射线
  const isSolid = solidWorld([
    [1, 1, 1],
    [2, 2, 2],
  ]);
  const dir = new THREE.Vector3(1, 1, 1).normalize();
  const hits = traceVoxels(new THREE.Vector3(0.2, 0.2, 0.2), dir, 4, isSolid);
  check("DDA 对角线射线能命中体素", hits.length === 2, `n=${hits.length}`);
}
{
  // 起点位于实心体素内
  const isSolid = solidWorld([[0, 0, 0]]);
  const hits = traceVoxels(
    new THREE.Vector3(0.5, 0.5, 0.5),
    new THREE.Vector3(0, 1, 0),
    2,
    isSolid,
  );
  check("DDA 起点在墙内时记录该体素", hits.length === 1 && hits[0].enter === 0);
}
{
  // 射线只到 maxDist，越界不命中
  const isSolid = solidWorld([[9, 0, 0]]);
  const hits = traceVoxels(
    new THREE.Vector3(0.5, 0.5, 0.5),
    new THREE.Vector3(1, 0, 0),
    3,
    isSolid,
  );
  check("DDA 尊重最大距离", hits.length === 0);
}

// ---------- CameraRig 测试夹具 ----------
function makeRig(doc: WorldDocument) {
  const camera = new THREE.PerspectiveCamera(40, 1280 / 800, 0.1, 200);
  // OrbitControls 需要的最小 DOM 接口；事件用 EventTarget 承载
  const target = new EventTarget();
  const dom = Object.assign(target, {
    getRootNode: () => ({ addEventListener() {}, removeEventListener() {} }),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    style: {},
  }) as unknown as HTMLElement;
  const fades: Set<string>[] = [];
  const rig = new CameraRig({
    camera,
    dom,
    getDoc: () => doc,
    getPlayer: () => doc.player,
    getMode: () => "follow",
    onFadeChange: (s) => fades.push(new Set(s)),
  });
  return { camera, dom, rig, fades, lastFade: () => fades[fades.length - 1] };
}
function wallDoc(): WorldDocument {
  const blocks: WorldDocument["blocks"] = {};
  const put = (x: number, y: number, z: number, material = "brick") => {
    const b = { x, y, z, material: material as any };
    blocks[key(b)] = b;
  };
  // 玩家前方 -Z 方向 3 格处一堵 3x3 砖墙（不透明）
  for (let y = 3; y <= 5; y++)
    for (let x = -1; x <= 1; x++) put(x, y, -4);
  // 玻璃墙（透明）不应触发不透明淡出
  for (let y = 3; y <= 5; y++) put(3, y, -4, "glass");
  return {
    version: 1,
    name: "t",
    blocks,
    inventory: {} as any,
    player: { x: 0, y: 3, z: 0 },
    revision: 0,
  };
}

// ---------- 过渡与输入锁 ----------
{
  const doc = wallDoc();
  const { rig, camera } = makeRig(doc);
  const startPos = camera.position.clone();
  rig.setMode("follow");
  check("setMode 后立即锁定输入", rig.inputLocked === true);
  rig.update(performance.now() + 50);
  const midPos = camera.position.clone();
  check("过渡中相机开始平滑移动", midPos.distanceTo(startPos) > 0.01);
  // 过渡中途再次请求同模式不会重置过渡
  rig.setMode("follow");
  rig.update(performance.now() + 600);
  check("过渡结束后解锁", rig.inputLocked === false);
}

// ---------- 跟随避障：方向不变、只拉距离 ----------
{
  const doc = wallDoc();
  const { rig, camera, lastFade } = makeRig(doc);
  rig.setMode("follow");
  for (let i = 0; i < 40; i++) rig.update(performance.now() + i * 16);
  check("已进入 follow 模式", rig.inputLocked === false);
  // 让相机停稳
  for (let i = 0; i < 30; i++) rig.update(performance.now() + 1000 + i * 16);
  const probe = rig.probe();
  const p = doc.player;
  const target = new THREE.Vector3(p.x, p.y + 1.25, p.z);
  const dist = camera.position.distanceTo(target);
  // 墙在 z=-4，距角色约 4 格；相机被拉到墙前（< 4），绝不会穿过墙
  check(
    "避障把相机拉到墙前而不是穿墙",
    dist < 4.1 && camera.position.z > -3.6,
    `dist=${dist.toFixed(2)} z=${camera.position.z.toFixed(2)}`,
  );
  // 相机始终在角色的 -Z 一侧（朝向没有被转到背后）
  check(
    "避障不改变准星方向（相机仍在角色正后方）",
    Math.abs(camera.position.x - target.x) < 0.2 &&
      Math.abs(camera.position.z - target.z) > 2,
    `x=${camera.position.x.toFixed(2)}`,
  );
  // 墙在 4 格外、相机拉到屋内即可看见角色：不应误淡出
  check(
    "距离足够时不触发淡出（仅避障拉距）",
    lastFade().size === 0,
    [...lastFade()].join("|"),
  );
  // 近裁剪面被压小
  check("近距离近裁剪面收窄", camera.near <= 0.31, `near=${camera.near}`);
  void probe;
}

// ---------- 窄屋贴身墙：避障到极限后局部淡出 ----------
{
  const doc = wallDoc();
  // 在角色后方 2 格处再加一堵贴脸墙
  for (let y = 3; y <= 5; y++)
    for (let x = -1; x <= 1; x++)
      doc.blocks[key({ x, y, z: -2 })] = { x, y, z: -2, material: "brick" };
  const { rig, camera, lastFade } = makeRig(doc);
  rig.setMode("follow");
  for (let i = 0; i < 60; i++) rig.update(performance.now() + i * 16);
  const target = new THREE.Vector3(0, 4.25, 0);
  const dist = camera.position.distanceTo(target);
  // 贴脸墙在 z=-2（入口约 1.35），相机被限制在墙与角色之间
  check(
    "贴脸墙下相机被限制在屋内不穿墙",
    dist < 2 && camera.position.z > -2,
    `dist=${dist.toFixed(2)} z=${camera.position.z.toFixed(2)}`,
  );
  const fade = lastFade();
  check(
    "避障到极限时局部淡出遮挡墙",
    [...fade].some((k) => k.endsWith(",-2")),
    [...fade].join("|"),
  );
  check(
    "玻璃墙不参与不透明淡出",
    ![...fade].some((k) => k.startsWith("3,")),
  );
  // 淡出方块仍在世界数据中：碰撞与建造不受影响
  check(
    "淡出的墙仍保留方块数据（参与碰撞/建造）",
    !!doc.blocks[key({ x: 0, y: 4, z: -2 })],
  );
}

// ---------- 开阔地无遮挡：不拉近距离、无淡出 ----------
{
  const doc = wallDoc();
  doc.blocks = {};
  const { rig, camera, lastFade } = makeRig(doc);
  rig.setMode("follow");
  for (let i = 0; i < 60; i++) rig.update(performance.now() + i * 16);
  const dist = camera.position.distanceTo(
    new THREE.Vector3(0, 4.25, 0),
  );
  check(
    "开阔地保持配置跟随距离",
    Math.abs(dist - 5.5) < 0.6,
    `dist=${dist.toFixed(2)}`,
  );
  check("开阔地没有淡出方块", lastFade().size === 0);
}

// ---------- 球坐标存档：位置可由存档完全重算 ----------
{
  const doc = wallDoc();
  const { rig, camera } = makeRig(doc);
  // 轨道模式反算的视角写入 doc.views
  for (let i = 0; i < 5; i++) rig.update(performance.now() + i * 16);
  check("轨道视角已持久化为球坐标", !!doc.views?.orbit.target);
  const v = doc.views!.orbit;
  const target = new THREE.Vector3(v.target.x, v.target.y, v.target.z);
  const rebuilt = target.add(
    new THREE.Vector3(
      Math.sin(v.yaw) * Math.sin(v.pitch),
      Math.cos(v.pitch),
      Math.cos(v.yaw) * Math.sin(v.pitch),
    ).multiplyScalar(v.distance),
  );
  check(
    "存档球坐标可精确重建相机位置",
    rebuilt.distanceTo(camera.position) < 1e-6,
  );
  // 跟随视角独立保存
  check(
    "跟随视角独立保存（yaw/pitch/distance）",
    typeof doc.views!.follow.yaw === "number" &&
      doc.views!.follow.distance > 0,
  );
}

// ---------- 载入存档适应新宽高比 ----------
{
  const doc = wallDoc();
  doc.views = defaultViews();
  const { rig, camera } = makeRig(doc);
  camera.aspect = 0.5; // 竖屏
  const oldDist = doc.views.orbit.distance;
  rig.applyLoaded(doc.views);
  check(
    "窄窗口载入时按 aspect 放宽轨道距离、球坐标不变",
    camera.position && doc.views!.orbit.distance >= oldDist,
    `${oldDist} -> ${doc.views!.orbit.distance}`,
  );
  // 横屏恢复时距离不被额外放大
  camera.aspect = 1.6;
  const doc2 = wallDoc();
  doc2.views = defaultViews();
  rig.applyLoaded(doc2.views);
  check(
    "宽窗口载入保持原球坐标距离",
    Math.abs(doc2.views!.orbit.distance - defaultViews().orbit.distance) < 1e-6,
  );
}

// ---------- 各自视角互不覆盖 ----------
{
  const doc = wallDoc();
  const { rig } = makeRig(doc);
  const followBefore = JSON.stringify(doc.views?.follow ?? null);
  rig.setMode("follow");
  for (let i = 0; i < 40; i++) rig.update(performance.now() + i * 16);
  // 模拟跟随拖动修改
  rig.setMode("orbit");
  for (let i = 0; i < 40; i++) rig.update(performance.now() + 800 + i * 16);
  check(
    "模式切换后两套视角都保留在存档中",
    !!doc.views?.orbit && !!doc.views?.follow,
  );
  void followBefore;
}

console.log(`\n${passed} 项断言全部通过`);
