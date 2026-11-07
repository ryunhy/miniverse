"use client";

import { Suspense, useMemo } from "react";
import * as THREE from "three";
import { useGLTF, TransformControls } from "@react-three/drei";
import type { SceneObject } from "@shared/scene-schema";
import { getAsset } from "@shared/asset-catalog";
import type { GizmoMode } from "@/stores/editor-store";

interface FurnitureProps {
  obj: SceneObject;
  selected: boolean;
  pickable: boolean;
  gizmoMode: GizmoMode;
  onSelect: (id: string) => void;
  onTransformStart: () => void;
  /** gizmo 拖动回调；object 为被控 three 组实例 */
  onTransform: (id: string, object: THREE.Object3D) => void;
}

/**
 * 家具渲染：
 * - 白名单 GLB（程序化生成，真实 glTF 加载链路）；无 GLB 回退占位几何体（UI 标注）
 * - 选中时由本组件包裹 drei TransformControls（移动/旋转/缩放），避免跨组件 ref 传递
 */
function GlbModel({ url, colorOverride }: { url: string; colorOverride?: string }) {
  const { scene } = useGLTF(url);
  const cloned = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        node.material = (node.material as THREE.Material).clone();
        if (colorOverride) {
          const m = node.material as THREE.MeshStandardMaterial;
          if (m.color) m.color.set(colorOverride);
        }
      }
    });
    return c;
  }, [scene, colorOverride]);
  return <primitive object={cloned} />;
}

function PlaceholderBox({ size, color }: { size: [number, number, number]; color: string }) {
  return (
    <mesh position={[0, size[1] / 2, 0]} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.7} />
    </mesh>
  );
}

/** 未知资产只警告一次，避免每帧渲染刷屏 */
const warnedUnknownAssets = new Set<string>();

export default function Furniture({
  obj,
  selected,
  pickable,
  gizmoMode,
  onSelect,
  onTransformStart,
  onTransform,
}: FurnitureProps) {
  const asset = getAsset(obj.assetId);
  if (!asset && !warnedUnknownAssets.has(obj.assetId)) {
    warnedUnknownAssets.add(obj.assetId);
    console.warn(
      `[editor] 未知素材 assetId="${obj.assetId}"（不在 asset-catalog 白名单内），已用占位方块显示。`
    );
  }

  const colorOverride = obj.materialOverrides.color;
  const baseColor = colorOverride ?? asset?.defaultColor ?? "#9ca3af";
  const footprint: [number, number] = asset?.footprint ?? [0.4, 0.4];
  const placeholderSize: [number, number, number] = [footprint[0], asset ? 0.6 : 0.4, footprint[1]];

  const content = (
    <group
      visible={obj.visible}
      position={obj.position}
      rotation={obj.rotation}
      scale={obj.scale}
      onClick={
        pickable
          ? (e) => {
              e.stopPropagation();
              onSelect(obj.id);
            }
          : undefined
      }
    >
      <Suspense fallback={<PlaceholderBox size={placeholderSize} color={baseColor} />}>
        {asset?.glbPath ? (
          <GlbModel url={asset.glbPath} colorOverride={colorOverride} />
        ) : (
          <PlaceholderBox size={placeholderSize} color={baseColor} />
        )}
      </Suspense>
      {selected && <SelectionRing footprint={footprint} />}
    </group>
  );

  if (!selected) return content;

  return (
    <TransformControls
      mode={gizmoMode}
      size={0.8}
      showX={gizmoMode !== "rotate"}
      showY={gizmoMode === "translate" || gizmoMode === "scale"}
      showZ={gizmoMode !== "rotate"}
      onMouseDown={() => onTransformStart()}
      onObjectChange={(e) => {
        const target = e?.target as unknown as { object: THREE.Object3D } | undefined;
        if (target) onTransform(obj.id, target.object);
      }}
    >
      {content}
    </TransformControls>
  );
}

/** 选中指示：地面高亮环 */
function SelectionRing({ footprint }: { footprint: [number, number] }) {
  const r = Math.max(footprint[0], footprint[1]) * 0.62;
  return (
    <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[r * 0.88, r, 48]} />
      <meshBasicMaterial color="#f59e0b" transparent opacity={0.9} side={THREE.DoubleSide} />
    </mesh>
  );
}
