import * as THREE from "three";
import type { Vec3 } from "../../../shared/document";
export interface VoxelHit {
  cell: Vec3;
  /** 入口参数（从射线起点到该体素表面的距离） */
  enter: number;
  /** 出口参数 */
  exit: number;
}
/**
 * Amanatides–Woo 体素 DDA：沿方向 dir 遍历 [0, maxDist] 内经过的所有体素。
 * dir 必须是单位向量；仅在 isSolid 返回 true 时记录命中。
 */
export function traceVoxels(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxDist: number,
  isSolid: (cell: Vec3) => boolean,
): VoxelHit[] {
  const hits: VoxelHit[] = [];
  const o = origin;
  let x = Math.floor(o.x),
    y = Math.floor(o.y),
    z = Math.floor(o.z);
  const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
  const stepY = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0;
  const stepZ = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;
  // 到下一条体素边界的参数距离
  const boundary = (start: number, d: number, cell: number, step: number) => {
    if (d === 0) return Infinity;
    const b = step > 0 ? cell + 1 : cell;
    return (b - start) / d;
  };
  let tMaxX = boundary(o.x, dir.x, x, stepX);
  let tMaxY = boundary(o.y, dir.y, y, stepY);
  let tMaxZ = boundary(o.z, dir.z, z, stepZ);
  const tDeltaX = dir.x === 0 ? Infinity : Math.abs(1 / dir.x);
  const tDeltaY = dir.y === 0 ? Infinity : Math.abs(1 / dir.y);
  const tDeltaZ = dir.z === 0 ? Infinity : Math.abs(1 / dir.z);
  let t = 0;
  // 起点本身在实心体素内（例如相机被挤进墙）：先记录该体素
  if (isSolid({ x, y, z }))
    hits.push({ cell: { x, y, z }, enter: 0, exit: Math.min(tMaxX, tMaxY, tMaxZ) });
  // 上限取世界尺寸，避免退化方向下的死循环
  for (let guard = 0; guard < 256 && t < maxDist; guard++) {
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
    }
    if (t > maxDist) break;
    if (x < -16 || x > 15 || z < -16 || z > 15 || y < 0 || y > 19) break;
    if (isSolid({ x, y, z })) {
      const exit = Math.min(tMaxX, tMaxY, tMaxZ, maxDist);
      // 相邻同体素不会重复进入；去重保险
      const last = hits[hits.length - 1];
      if (!last || last.cell.x !== x || last.cell.y !== y || last.cell.z !== z)
        hits.push({ cell: { x, y, z }, enter: t, exit });
    }
  }
  return hits;
}
