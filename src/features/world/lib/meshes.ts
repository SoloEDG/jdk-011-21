import * as THREE from "three";
import type { WorldDocument } from "../../../shared/document";
import { key, type Block } from "../../../shared/document";
import { materials } from "../../../shared/materials";
export interface BlockMeshes {
  group: THREE.Group;
  /** 所有可拾取的网格（含淡出层），每个实例带 userData.cells */
  pickables: THREE.InstancedMesh[];
}
/**
 * @param fadeSet 需要局部淡出的方块键集合。淡出只改变渲染层，
 * 原始方块仍保留在不透明网格中，因此射线拾取与玩家碰撞完全不受影响。
 */
export function blockMeshes(
  doc: WorldDocument,
  fadeSet: Set<string> = new Set(),
): BlockMeshes {
  const group = new THREE.Group();
  const pickables: THREE.InstancedMesh[] = [];
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const matrix = new THREE.Matrix4();
  const all = Object.values(doc.blocks);
  for (const spec of materials) {
    const blocks = all.filter((b) => b.material === spec.id);
    if (!blocks.length) continue;
    const solid = blocks.filter((b) => !fadeSet.has(key(b)));
    const faded = blocks.filter((b) => fadeSet.has(key(b)));
    const make = (list: Block[], transparent: boolean, opacity: number) => {
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: spec.color,
          roughness: 0.9,
          transparent,
          opacity,
          depthWrite: !transparent,
        }),
        list.length,
      );
      list.forEach((b, i) => {
        matrix.makeTranslation(b.x + 0.5, b.y + 0.5, b.z + 0.5);
        mesh.setMatrixAt(i, matrix);
        const shade = 0.92 + ((b.x * 13 + b.z * 7 + b.y * 3) % 7) * 0.012;
        mesh.setColorAt(i, new THREE.Color().setScalar(shade));
      });
      mesh.userData.cells = list;
      mesh.castShadow = !transparent;
      mesh.receiveShadow = true;
      if (transparent) mesh.renderOrder = 2;
      group.add(mesh);
      pickables.push(mesh);
    };
    make(solid, spec.opacity < 1, spec.opacity);
    // 淡出层：无论原材质是否透明，统一压到低透明度
    make(faded, true, Math.min(spec.opacity, 0.14));
  }
  return {
    group,
    pickables,
  };
}
export function disposeGroup(group: THREE.Group) {
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach((m) => m.dispose());
    }
  });
}
