"use client";

import { useEffect, useState } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import * as Spark from "@sparkjsdev/spark";
import { useEditorStore } from "@/stores/editor-store";
import { fetchSplatBytes, createSplatMesh, robustFrameFromSplat, trainingViewpoint, type TrainingViewpoint } from "@/lib/splat-load";

/** 恒等姿态（演示 PLY 本身 Y-up） */
const IDENTITY_Q = new THREE.Quaternion(0, 0, 0, 1);
/** 真实重建 PLY（nerfstudio 归一化系）→ 编辑器 Y-up：绕 X 轴 -90°，(x,y,z)→(x,z,-y) */
const RX_N90_Q = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);

/**
 * Gaussian Splatting 背景对象（@sparkjsdev/spark，编辑器内叠加）。
 * - 实例在 effect 内创建：StrictMode 双挂载下 useMemo 创建的实例会被首次 cleanup
 *   dispose 而无法复用（表现为黑屏），因此必须每次挂载重建
 * - 加载进度：手动流式 fetch 上报（spark url 直载无进度回调）
 * - 取景闭环：camera.autoFrame=false（用户已确认视角）则不重置；否则依次尝试
 *   ① 训练相机 API（真实拍摄视角）② 高斯中位数稳健取景；取景成功后 autoFrame 落 false
 */
export default function SplatObject({ url, synthetic = false }: { url: string; synthetic?: boolean }) {
  const [failed, setFailed] = useState(false);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target?: THREE.Vector3; update?: () => void } | null;
  const [instances, setInstances] = useState<{ splat: Spark.SplatMesh; spark: Spark.SparkRenderer } | null>(null);

  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    // 渲染参数抑制「近距离大高斯撑成满屏条纹」：
    //  - maxPixelRadius 默认 512，相机贴近墙面时单个高斯能盖住半屏 → 压到 128
    //  - maxStdDev 默认 √8≈2.83，边缘过软会拖影 → 收到 2.0（≈2σ，视觉仍连续）
    //  - minAlpha 默认 ~0.002，几乎透明的噪点也参与排序 → 提到 0.02
    //  - sortRadial 保持 true：径向排序在视角旋转时更稳定（官方注释）
    const spark = new Spark.SparkRenderer({
      renderer: gl as THREE.WebGLRenderer,
      maxPixelRadius: 128,
      maxStdDev: 2.0,
      minAlpha: 0.02,
      sortRadial: true,
    });
    let splat: Spark.SplatMesh | null = null;

    const st0 = useEditorStore.getState();
    st0.setSplatLoad("loading");
    st0.setSplatProgress({ phase: "download", percent: null });

    (async () => {
      try {
        const bytes = await fetchSplatBytes(url, {
          signal: abort.signal,
          onDownload: (percent) => {
            if (disposed) return;
            useEditorStore.getState().setSplatProgress({ phase: "download", percent });
          },
        });
        if (disposed) return;
        useEditorStore.getState().setSplatProgress({ phase: "parse", percent: null });
        splat = createSplatMesh(bytes, { signal: abort.signal, onParsed: () => {} });
        // 真实重建 PLY（nerfstudio 归一化系）竖直轴为 Z（对样例任务 PLY 协方差实证：Z 方差
        // 5.87 ≪ X/Y 的 14.9），Rx(-90°) 把 N 的 +Z（天花板）映到编辑器 +Y，与 Y-up 家具体系
        // 一致、OrbitControls 默认 up 直接可用。演示 PLY（generate-demo-splat）本身 Y-up，不翻
        splat.quaternion.copy(synthetic ? IDENTITY_Q : RX_N90_Q);
        await splat.initialized;
        if (disposed) return;

        const vp = await autoFrame(splat, camera, controls, abort.signal);

        // 写入世界系稳健包围帧（360° 环绕 / 三视图预设的取景依据）。
        // orbitRadius = 训练相机轨道半径（数据视角带）；训练相机不可用时以稳健半径的 0.7 近似
        if (!disposed) {
          const frame = robustFrameFromSplat(splat);
          if (frame) {
            const c = vp?.sceneCenter ?? frame.center.clone().applyQuaternion(splat.quaternion);
            useEditorStore.getState().setSplatFrame({
              center: [c.x, c.y, c.z],
              radius: frame.radius,
              orbitRadius: vp?.orbitRadius ?? Math.max(frame.radius * 0.7, 1),
            });
          }
        }

        useEditorStore.getState().setSplatProgress(null);
        useEditorStore.getState().setSplatLoad("ready");
        setInstances({ splat, spark });
      } catch (e) {
        if (disposed || abort.signal.aborted) return;
        useEditorStore.getState().setSplatProgress(null);
        useEditorStore.getState().setSplatLoad("error");
        setFailed(true);
        console.error("SplatObject 加载失败:", e);
      }
    })();

    return () => {
      disposed = true;
      abort.abort();
      splat?.dispose();
      spark.dispose();
      setInstances(null);
      useEditorStore.getState().setSplatProgress(null);
      useEditorStore.getState().setSplatFrame(null);
      useEditorStore.getState().setViewMode("inside");
    };
  }, [gl, url, camera, controls, synthetic]);

  if (failed) {
    return (
      <mesh position={[0, 1.5, 0]}>
        <boxGeometry args={[0.5, 0.5, 0.5]} />
        <meshStandardMaterial color="#ef4444" wireframe />
      </mesh>
    );
  }
  if (!instances) return null;

  return (
    <>
      <primitive object={instances.spark} />
      <primitive object={instances.splat} />
    </>
  );
}

/** 取景：autoFrame=false 时跳过；训练相机 API 失败回退稳健取景。成功后 autoFrame 落 false 持久化。返回训练视角（含轨道半径）供 splatFrame 用 */
async function autoFrame(
  splat: Spark.SplatMesh,
  camera: THREE.Camera,
  controls: { target?: THREE.Vector3; update?: () => void } | null,
  signal: AbortSignal
): Promise<TrainingViewpoint | null> {
  try {
    const st = useEditorStore.getState();
    if (!st.scene) return null;
    const cam = camera as THREE.PerspectiveCamera;
    const orient = splat.quaternion; // mesh 的姿态变换（Rx(-90°) 或恒等），与高斯同一坐标系映射

    const placeAt = (pos: THREE.Vector3, target: THREE.Vector3) => {
      cam.position.copy(pos);
      if (controls?.target) {
        controls.target.copy(target);
        controls.update?.();
      }
      if (useEditorStore.getState().scene) {
        st.setCamera({
          position: [cam.position.x, cam.position.y, cam.position.z],
          target: [target.x, target.y, target.z],
          fov: cam.fov,
          autoFrame: false,
        });
      }
    };

    // 用户已确认过视角：不重置相机，但仍返回训练视角数据（供 360° 模式）
    const confirmed = st.scene.camera.autoFrame === false;
    const taskId = st.scene.reconstruction.taskId;
    if (taskId) {
      const vp = await trainingViewpoint(taskId, orient, signal);
      if (signal.aborted) return null;
      if (vp) {
        if (!confirmed) {
          cam.up.set(0, 1, 0);
          placeAt(vp.position, vp.target);
        }
        return vp;
      }
    }

    // ② 稳健取景：分量中位数中心 + 距离中位数×4 半径（离群高斯污染 bbox 的兜底）
    if (!confirmed) {
      const frame = robustFrameFromSplat(splat);
      if (frame) {
        const center = frame.center.clone().applyQuaternion(orient);
        const dir = new THREE.Vector3(0.75, 0.5, 1).normalize();
        placeAt(center.clone().add(dir.multiplyScalar(frame.radius * 2.2)), center);
      }
    }
    return null;
  } catch {
    // 取景失败不阻塞加载
    return null;
  }
}
