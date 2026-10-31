"use client";

import * as THREE from "three";
import type { RoomSpec } from "@shared/scene-schema";

/**
 * 程序化房间外壳：地板 + 两面墙（缺角面向默认相机，微缩模型观感）。
 *
 * 两种用途：
 *  - 默认（编辑用外壳）：尺寸取 scene.room 的米制尺寸。
 *  - backdrop（重建场景的兜底背景板）：真实重建里「家具背后从未被拍到」的区域是空的，
 *    查看器会把空画成接近纯黑的背景色，看起来像洞。backdrop 用房间同色的墙/地包住重建，
 *    让缺口后面有「墙」，而不是虚空。它不参与光照、永远画在重建之后，不遮挡真实几何。
 */
export default function Room({
  room,
  backdrop = false,
  frame = null,
}: {
  room: RoomSpec;
  backdrop?: boolean;
  /** 重建稳健包围（世界系，已 orient）；backdrop 用它推导尺寸，避免米制与 scene-unit 混用 */
  frame?: { center: [number, number, number]; radius: number } | null;
}) {
  const { width, depth, height, floorColor, wallColor } = room;

  if (backdrop) {
    if (!frame) return null;
    const r = Math.max(frame.radius, 0.3);
    const w = r * 2.4;
    const h = r * 1.6;
    const [cx, cy, cz] = frame.center;
    // 地板对齐重建底部（center.y - r），整体包住重建主体
    const bottom = cy - r;
    return (
      <group renderOrder={-1}>
        <mesh position={[cx, bottom - 0.05, cz]} renderOrder={-1}>
          <boxGeometry args={[w, 0.1, w]} />
          <meshBasicMaterial color={floorColor} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
        {/* 四面墙：无论缺口朝向哪一边，后面都有墙 */}
        {[
          [cx, bottom + h / 2, cz - w / 2],
          [cx, bottom + h / 2, cz + w / 2],
          [cx - w / 2, bottom + h / 2, cz],
          [cx + w / 2, bottom + h / 2, cz],
        ].map((p, i) => (
          <mesh key={i} position={p as [number, number, number]} renderOrder={-1}>
            <boxGeometry args={i < 2 ? [w, h, 0.1] : [0.1, h, w]} />
            <meshBasicMaterial color={wallColor} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        ))}
      </group>
    );
  }

  return (
    <group visible={room.visible}>
      <mesh position={[0, -0.1, 0]} receiveShadow>
        <boxGeometry args={[width, 0.2, depth]} />
        <meshStandardMaterial color={floorColor} roughness={0.85} />
      </mesh>
      <mesh position={[0, height / 2, -depth / 2]} receiveShadow>
        <boxGeometry args={[width, height, 0.1]} />
        <meshStandardMaterial color={wallColor} roughness={0.9} />
      </mesh>
      <mesh position={[-width / 2, height / 2, 0]} receiveShadow>
        <boxGeometry args={[0.1, height, depth]} />
        <meshStandardMaterial color={wallColor} roughness={0.9} />
      </mesh>
    </group>
  );
}
