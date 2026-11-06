"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";

interface MeshViewerCoreProps {
  /** GLB 地址（/api/reconstructions/<id>/mesh） */
  url: string;
  height?: number;
  /**
   * 数据朝向：网格与 scene.ply 同在 nerfstudio 归一化系（Z-up），
   * 需要 Rx(-90°) 立起才能与编辑器 Y-up 世界对齐。
   */
  orient?: "identity" | "colmap-nerfstudio";
}

/** 与 SplatViewer 相同的朝向约定（见 lib/splat-load.ts 的 ORIENT_COLMAP_NERFSTUDIO_Q） */
const ORIENT_COLMAP_NERFSTUDIO_Q = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -Math.PI / 2,
);

function Model({ url, orient }: { url: string; orient: MeshViewerCoreProps["orient"] }) {
  const { scene } = useGLTF(url);
  const { camera, controls } = useThree() as { camera: THREE.PerspectiveCamera; controls?: { target: THREE.Vector3; update: () => void } };

  const object = useMemo(() => {
    const cloned = scene.clone(true);
    cloned.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        // 网格为烘焙贴图（baseColorTexture），保持 doubleSided 以免背面缺失
        const mat = node.material as THREE.MeshStandardMaterial;
        if (mat) {
          mat.side = THREE.DoubleSide;
          mat.needsUpdate = true;
        }
      }
    });
    return cloned;
  }, [scene]);

  // 加载后按包围盒取景（真实数据尺度未知，必须自适应，不能写死相机距离）。
  // R3F 相机是命令式外部对象：取景必须改 position/near/far，走 React 状态反而会丢帧。
  const framed = useRef(false);
  /* eslint-disable react-hooks/immutability */
  useEffect(() => {
    if (framed.current) return;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const dist = radius / Math.sin((camera.fov * Math.PI / 180) / 2) * 1.6;
    const dir = new THREE.Vector3(0.6, 0.5, 0.7).normalize();
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.near = Math.max(dist * 0.001, 0.001);
    camera.far = dist * 100;
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.copy(center);
      controls.update();
    }
    framed.current = true;
  }, [object, camera, controls]);
  /* eslint-enable react-hooks/immutability */

  return (
    <group quaternion={orient === "colmap-nerfstudio" ? ORIENT_COLMAP_NERFSTUDIO_Q : undefined}>
      <primitive object={object} />
    </group>
  );
}

export default function MeshViewerCore({ url, height = 520, orient = "identity" }: MeshViewerCoreProps) {
  const [error, setError] = useState<string | null>(null);

  // useGLTF 的加载错误会抛到渲染层，这里提前探测一次，给出可读提示
  useEffect(() => {
    let alive = true;
    fetch(url, { method: "HEAD" })
      .then((r) => {
        if (!alive) return;
        if (!r.ok) setError(r.status === 404 ? "该任务未生成网格产物" : `网格加载失败（HTTP ${r.status}）`);
      })
      .catch(() => alive && setError("网格加载失败（网络错误）"));
    return () => {
      alive = false;
    };
  }, [url]);

  if (error) {
    return (
      <div className="flex items-center justify-center bg-slate-900 text-xs text-slate-500" style={{ height }}>
        {error}
      </div>
    );
  }

  return (
    <div style={{ height, background: "#0a0f1e" }}>
      <Canvas camera={{ position: [0, 1.2, 2.5], fov: 50, near: 0.001, far: 1000 }} shadows>
        <ambientLight intensity={0.9} />
        <directionalLight position={[4, 6, 3]} intensity={1.4} castShadow />
        <directionalLight position={[-4, 3, -3]} intensity={0.5} />
        <Model url={url} orient={orient} />
        <OrbitControls makeDefault enableDamping />
      </Canvas>
    </div>
  );
}
