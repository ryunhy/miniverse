"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import { trainingViewpoint } from "@/lib/splat-load";
import {
  CAMERA_EVENT,
  publishCamera,
  reportCameraState,
  fallbackViewpoint,
  type ViewerCameraDetail,
  type ViewerControls,
} from "@/lib/viewer-sync";

interface MeshViewerCoreProps {
  /** GLB 地址（/api/reconstructions/<id>/mesh） */
  url: string;
  height?: number;
  /**
   * 数据朝向：网格与 scene.ply 同在 nerfstudio 归一化系（Z-up），
   * 需要 Rx(-90°) 立起才能与编辑器 Y-up 世界对齐。
   */
  orient?: "identity" | "colmap-nerfstudio";
  /** 关联重建任务：提供时优先用训练相机机位，与高斯查看器保持一致 */
  taskId?: string | null;
  /** 视角同步开关（由任务详情页统一控制，默认开） */
  syncEnabled?: boolean;
}

/** 与 SplatViewer 相同的朝向约定（见 lib/splat-load.ts 的 ORIENT_COLMAP_NERFSTUDIO_Q） */
const ORIENT_COLMAP_NERFSTUDIO_Q = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -Math.PI / 2,
);

/** 与高斯查看器共用的默认机位（见 lib/viewer-sync.ts） */

function Model({
  url,
  orient,
  taskId,
  syncEnabled = true,
}: {
  url: string;
  orient: MeshViewerCoreProps["orient"];
  taskId?: string | null;
  syncEnabled?: boolean;
}) {
  const { scene } = useGLTF(url);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const controls = useThree((s) => s.controls) as unknown as ViewerControls | null;
  const q = orient === "colmap-nerfstudio" ? ORIENT_COLMAP_NERFSTUDIO_Q : null;
  const [gridY, setGridY] = useState(0);
  const [framed, setFramed] = useState(false);
  const lastRemote = useRef<ViewerCameraDetail | null>(null);

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

  /**
   * 取景：优先训练相机（与高斯侧同一 API、同一坐标系），否则用共享规则
   * 「场景中心 + 斜前方 1.2 个场景单位 + 抬到人眼高度」。包围盒必须先按朝向旋转再取景——
   * 否则 Z-up 数据会按未旋转的坐标摆相机，镜头跑到房间外上方。
   */
  // R3F 相机是命令式外部对象：取景与同步必须直接改 position/target，走 React 状态会丢帧。
  /* eslint-disable react-hooks/immutability */
  useEffect(() => {
    let alive = true;
    const abort = new AbortController();
    (async () => {
      const box = new THREE.Box3().setFromObject(object);
      if (box.isEmpty()) return;
      if (q) box.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
      const center = box.getCenter(new THREE.Vector3());
      const vp = taskId ? await trainingViewpoint(taskId, q ?? new THREE.Quaternion(), abort.signal) : null;
      if (!alive) return;

      camera.up.set(0, 1, 0);
      let targetPoint: THREE.Vector3;
      if (vp) {
        targetPoint = vp.target;
        camera.position.copy(vp.position);
      } else {
        // 抬高到人眼高度但保留朝向中心，不靠缩距离取巧（单位是场景单位 nu，不是米）
        const fb = fallbackViewpoint(center, box.min.y);
        targetPoint = fb.target;
        camera.position.copy(fb.position);
      }
      if (controls?.target) controls.target.copy(targetPoint);
      camera.near = 0.05;
      camera.far = Math.max(200, camera.position.distanceTo(center) * 50);
      camera.updateProjectionMatrix();
      controls?.update?.();
      setGridY(box.min.y + 0.002);
      setFramed(true);
      reportCameraState("mesh", camera, targetPoint);
      publishCamera({
        source: "mesh",
        position: camera.position.toArray(),
        target: targetPoint.toArray(),
        distance: camera.position.distanceTo(targetPoint),
      });
    })();
    return () => {
      alive = false;
      abort.abort();
    };
  }, [object, camera, controls, taskId, q]);

  // 记录本查看器实际生效的机位（与同步开关无关：关掉同步只是停止联动，不影响本地拖动）
  useEffect(() => {
    if (!framed || !controls?.addEventListener) return;
    let raf = 0;
    const report = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        reportCameraState("mesh", camera, controls.target);
      });
    };
    controls.addEventListener("change", report);
    report();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      controls.removeEventListener?.("change", report);
    };
  }, [framed, camera, controls]);

  // 拖动本查看器 → 广播机位（跳过刚被远端套用的那一帧，避免来回打架）
  useEffect(() => {
    if (!syncEnabled || !framed || !controls?.addEventListener) return;
    let raf = 0;
    const publish = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const target = controls.target;
        const lr = lastRemote.current;
        if (
          lr &&
          camera.position.distanceTo(new THREE.Vector3(...lr.position)) < 1e-3 &&
          target.distanceTo(new THREE.Vector3(...lr.target)) < 1e-3
        ) {
          return;
        }
        publishCamera({
          source: "mesh",
          position: camera.position.toArray(),
          target: target.toArray(),
          distance: camera.position.distanceTo(target),
        });
      });
    };
    controls.addEventListener("change", publish);
    publish();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      controls.removeEventListener?.("change", publish);
    };
  }, [framed, syncEnabled, camera, controls]);

  // 接收另一侧机位
  useEffect(() => {
    if (!syncEnabled) return;
    const onRemote = (e: Event) => {
      const detail = (e as CustomEvent<ViewerCameraDetail>).detail;
      if (!detail || detail.source === "mesh") return;
      lastRemote.current = detail;
      camera.position.set(...detail.position);
      if (controls?.target) {
        controls.target.set(...detail.target);
        controls.update?.();
      }
      reportCameraState("mesh", camera, controls?.target ?? new THREE.Vector3(...detail.target));
    };
    window.addEventListener(CAMERA_EVENT, onRemote);
    return () => window.removeEventListener(CAMERA_EVENT, onRemote);
  }, [syncEnabled, camera, controls]);
  /* eslint-enable react-hooks/immutability */

  return (
    <>
      {/* 1 米网格：给用户空间尺度参照，避免把正常几何当成碎数据 */}
      <gridHelper args={[12, 12, "#2b3d57", "#1b2534"]} position={[0, gridY, 0]} />
      <group quaternion={q ?? undefined}>
        <primitive object={object} />
      </group>
    </>
  );
}

export default function MeshViewerCore({
  url,
  height = 520,
  orient = "identity",
  taskId,
  syncEnabled = true,
}: MeshViewerCoreProps) {
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
    <div className="relative" style={{ height, background: "#0a0f1e" }}>
      <Canvas camera={{ position: [0, 1.5, 2.5], fov: 50, near: 0.05, far: 200 }} shadows>
        <color attach="background" args={["#0a0f1e"]} />
        <ambientLight intensity={0.9} />
        <directionalLight position={[4, 6, 3]} intensity={1.4} castShadow />
        <directionalLight position={[-4, 3, -3]} intensity={0.5} />
        <Model url={url} orient={orient} taskId={taskId} syncEnabled={syncEnabled} />
        <OrbitControls makeDefault enableDamping minDistance={0.4} maxDistance={50} />
      </Canvas>
      <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-slate-950/70 px-2.5 py-1 text-[10px] text-slate-400">
        人眼视角 · 地面网格 1 m/格
      </div>
    </div>
  );
}
