"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as Spark from "@sparkjsdev/spark";
import { installRenderFallback } from "@/lib/render-fallback";
import { fetchSplatBytes, createSplatMesh, ORIENT_COLMAP_NERFSTUDIO_Q, trainingViewpoint } from "@/lib/splat-load";
import { CAMERA_EVENT, publishCamera, reportCameraState, fallbackViewpoint, type ViewerCameraDetail, type ViewerControls } from "@/lib/viewer-sync";

interface SplatViewerCoreProps {
  url: string;
  height?: number;
  /** 数据朝向：colmap-nerfstudio = 真实重建 PLY（nerfstudio 归一化系，Z-up），需 Rx(-90°) 立起 */
  orient?: "identity" | "colmap-nerfstudio";
  /** 关联重建任务 ID：提供时加载完成后按训练相机取景（真实拍摄视角） */
  taskId?: string | null;
  /** 视角同步开关（与网格查看器共用，默认开） */
  syncEnabled?: boolean;
}

/** 加载进度：download 百分比（Content-Length 未知时 null）/ parse 阶段 */
export interface ViewerProgress {
  phase: "download" | "parse";
  percent: number | null;
}

/**
 * 独立 Gaussian Splatting 查看器核心（P3）——由 SplatViewer.tsx 以 dynamic(ssr:false) 挂载。
 * - 加载 .ply（3DGS 格式，COLMAP+Splatfacto 导出）/ .spz
 * - 手动流式 fetch 上报下载进度（spark url 直载无进度回调）
 * - 提供 taskId 时按训练相机取景，否则用与网格查看器共用的默认机位
 * - 与编辑器同一 three/R3F 坐标系约定（米、Y 向上）
 */
export default function SplatViewerCore({ url, height = 520, orient = "identity", taskId, syncEnabled = true }: SplatViewerCoreProps) {
  const [progress, setProgress] = useState<ViewerProgress | null>({ phase: "download", percent: null });
  // react-use-measure 的 ResizeObserver 在部分水合/导航时序下不派发初始回调，
  // R3F canvas 会停留 300×150 且渲染循环不启动；挂载后手动 poke 一次 resize（已实证有效）
  useEffect(() => {
    const poke = () => window.dispatchEvent(new Event("resize"));
    poke();
    const t = setTimeout(poke, 200);
    return () => clearTimeout(t);
  }, []);
  return (
    <div style={{ height }} className="relative w-full">
      <Canvas
        camera={{ position: [4, 3, 5], fov: 50 }}
        onCreated={({ gl, scene, camera }) => {
            disposeFallback?.(); // 换 renderer 时清理旧兜底
            disposeFallback = installRenderFallback(gl, scene, camera);
}}
      >
        <color attach="background" args={["#111418"]} />
        <ambientLight intensity={0.9} />
        <directionalLight position={[5, 10, 5]} intensity={1.5} />
        <SplatScene url={url} orient={orient} taskId={taskId} syncEnabled={syncEnabled} onProgress={setProgress} />
        <OrbitControlsRef target={[0, 1, 0]} />
      </Canvas>
      <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-slate-950/70 px-2.5 py-1 text-[10px] text-slate-400">
        人眼视角 · 地面网格 1 m/格
      </div>
      {progress && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-slate-950/70 text-xs text-slate-300">
          {progress.phase === "download" && progress.percent !== null ? (
            <>
              <span>高斯数据下载中 {progress.percent}%</span>
              <span className="h-1.5 w-48 overflow-hidden rounded-full bg-slate-700">
                <span
                  className="block h-full rounded-full bg-cyan-400 transition-all duration-200"
                  style={{ width: `${progress.percent}%` }}
                />
              </span>
            </>
          ) : (
            <span className="flex items-center gap-2">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
              {progress.phase === "parse" ? "解析高斯数据…" : "准备下载…"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

let disposeFallback: (() => void) | null = null;

/** makeDefault OrbitControls：target 交由取景逻辑动态设置（初始 [0,1,0]） */
function OrbitControlsRef({ target }: { target: [number, number, number] }) {
  return <OrbitControls makeDefault target={target} minDistance={0.4} maxDistance={50} />;
}

function SplatScene({
  url,
  orient,
  taskId,
  syncEnabled,
  onProgress,
}: {
  url: string;
  orient: "identity" | "colmap-nerfstudio";
  taskId?: string | null;
  syncEnabled: boolean;
  onProgress: (p: ViewerProgress | null) => void;
}) {
  const [failed, setFailed] = useState(false);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as ViewerControls | null;
  const [instances, setInstances] = useState<{ splat: Spark.SplatMesh; spark: Spark.SparkRenderer } | null>(null);
  /** 地面网格位置：取景时按点云的中心与地面分位放，避免网格飘在半空 */
  const [grid, setGrid] = useState({ x: 0, y: 0, z: 0 });
  const [framed, setFramed] = useState(false);
  const lastRemote = useRef<ViewerCameraDetail | null>(null);

  // 实例在 effect 内创建：StrictMode 双挂载下 useMemo 实例会被首次 cleanup dispose（黑屏根因）
  useEffect(() => {
    // 渲染循环内异常不经过 React——挂全局钩子捕获（spark onBeforeRender 抛错会杀死 rAF 循环）
    const errs: string[] = [];
    (window as unknown as { __mvErrs?: string[] }).__mvErrs = errs;
    const onErr = (e: ErrorEvent) => errs.push(`E:${e.message?.slice(0, 200)}`);
    const onRej = (e: PromiseRejectionEvent) =>
      errs.push(`R:${String(e.reason?.message ?? e.reason).slice(0, 200)}`);
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    // rAF 探针：判断 R3F 渲染循环是否在跑
    const w = window as unknown as { __rafCount?: number; __rafPatched?: boolean };
    if (!w.__rafPatched) {
      w.__rafCount = 0;
      const orig = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        orig((t) => {
          w.__rafCount = (w.__rafCount ?? 0) + 1;
          return cb(t);
        })) as typeof window.requestAnimationFrame;
      w.__rafPatched = true;
    }
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, []);

  // R3F 相机是命令式外部对象：取景与同步必须直接改 position/target，走 React 状态会丢帧。
  /* eslint-disable react-hooks/immutability */
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    const dbg = window as unknown as { __splatDebug?: unknown };
    // 与编辑器同一套抑制参数：限制单高斯屏幕半径（默认 512 → 128），
    // 收紧高斯边缘，丢弃近透明噪点，避免拖动/贴近时高斯被拉成满屏条纹
    const spark = new Spark.SparkRenderer({
      renderer: gl as THREE.WebGLRenderer,
      maxPixelRadius: 128,
      maxStdDev: 2.0,
      minAlpha: 0.02,
      sortRadial: true,
    });
    let splat: Spark.SplatMesh | null = null;
    dbg.__splatDebug = { url, state: "loading" };

    (async () => {
      try {
        const bytes = await fetchSplatBytes(url, {
          signal: abort.signal,
          onDownload: (percent) => {
            if (disposed) return;
            onProgress({ phase: "download", percent });
          },
        });
        if (disposed) return;
        onProgress({ phase: "parse", percent: null });
        splat = createSplatMesh(bytes, { signal: abort.signal, onParsed: () => {} });
        // 真实重建 PLY（nerfstudio 归一化系）竖直轴为 Z（协方差实证），Rx(-90°) 立起为 Y-up；
        // 演示 PLY（generate-demo-splat，地板 y=0）本身 Y-up，保持恒等
        if (orient === "colmap-nerfstudio") {
          splat.quaternion.copy(ORIENT_COLMAP_NERFSTUDIO_Q);
        }
        await splat.initialized;
        if (disposed) return;
        dbg.__splatDebug = {
          state: "ready",
          splat,
          splats: splat.packedSplats?.numSplats ?? null,
        };

        // 取景：训练相机优先（真实拍摄视角），失败时用与网格查看器同一套默认机位
        const cam = camera as THREE.PerspectiveCamera;
        const orientQ = splat.quaternion;
        const vp = taskId ? await trainingViewpoint(taskId, orientQ, abort.signal) : null;
        if (disposed) return;

        // 点云先按朝向旋转到世界坐标，再统计中心与地面高度
        const N = splat.packedSplats?.numSplats ?? 0;
        const center = new THREE.Vector3();
        let floorY = 0;
        if (N > 0) {
          const step = Math.max(1, Math.floor(N / 6000));
          const xs: number[] = [];
          const ys: number[] = [];
          const zs: number[] = [];
          const v = new THREE.Vector3();
          splat.forEachSplat((index, splatCenter) => {
            if (index % step !== 0) return;
            v.copy(splatCenter).applyQuaternion(orientQ);
            xs.push(v.x);
            ys.push(v.y);
            zs.push(v.z);
          });
          const sorted = (arr: number[]) => [...arr].sort((p, q) => p - q);
          const at = (arr: number[], ratio: number) => arr[Math.floor(arr.length * ratio)] ?? 0;
          const sx = sorted(xs);
          const sy = sorted(ys);
          const sz = sorted(zs);
          floorY = at(sy, 0.02);
          center.set(at(sx, 0.5), at(sy, 0.5), at(sz, 0.5));
        }

        cam.up.set(0, 1, 0);
        let targetPoint: THREE.Vector3;
        if (vp) {
          targetPoint = vp.target;
          cam.position.copy(vp.position);
        } else {
          const fb = fallbackViewpoint(center, floorY);
          targetPoint = fb.target;
          cam.position.copy(fb.position);
        }
        if (controls?.target) controls.target.copy(targetPoint);
        cam.near = 0.05;
        cam.far = Math.max(200, cam.position.distanceTo(center) * 50);
        cam.updateProjectionMatrix();
        controls?.update?.();
        setGrid({ x: center.x, y: floorY + 0.002, z: center.z });
        setFramed(true);
        reportCameraState("splat", cam, targetPoint);
        publishCamera({
          source: "splat",
          position: cam.position.toArray(),
          target: targetPoint.toArray(),
          distance: cam.position.distanceTo(targetPoint),
        });

        onProgress(null);
        setInstances({ splat, spark });
      } catch (err: unknown) {
        if (disposed || abort.signal.aborted) return;
        dbg.__splatDebug = { state: "error", error: String(err) };
        onProgress(null);
        setFailed(true);
      }
    })();

    return () => {
      disposed = true;
      abort.abort();
      splat?.dispose();
      spark.dispose();
      setInstances(null);
    };
  }, [gl, url, orient, taskId, onProgress, camera, controls]);

  // 记录本查看器实际生效的机位（与同步开关无关：关掉同步只是停止联动，不影响本地拖动）
  useEffect(() => {
    if (!framed || !controls?.addEventListener) return;
    let raf = 0;
    const report = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        reportCameraState("splat", camera, controls.target);
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
          source: "splat",
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
      if (!detail || detail.source === "splat") return;
      lastRemote.current = detail;
      camera.position.set(...detail.position);
      if (controls?.target) {
        controls.target.set(...detail.target);
        controls.update?.();
      }
      reportCameraState("splat", camera, controls?.target ?? new THREE.Vector3(...detail.target));
    };
    window.addEventListener(CAMERA_EVENT, onRemote);
    return () => window.removeEventListener(CAMERA_EVENT, onRemote);
  }, [syncEnabled, camera, controls]);
  /* eslint-enable react-hooks/immutability */

  if (failed) {
    return (
      <>
        {/* 1 米网格：给用户空间尺度参照，避免把正常几何当成碎数据 */}
        <gridHelper args={[12, 12, "#2b3d57", "#1b2534"]} position={[grid.x, grid.y, grid.z]} />
        <mesh position={[0, 1.5, 0]}>
          <boxGeometry args={[0.5, 0.5, 0.5]} />
          <meshStandardMaterial color="#ef4444" wireframe />
        </mesh>
      </>
    );
  }
  if (!instances) {
    return (
      <>
        <gridHelper args={[12, 12, "#2b3d57", "#1b2534"]} position={[grid.x, grid.y, grid.z]} />
        <mesh position={[0, 1.5, 0]}>
          <sphereGeometry args={[0.3, 16, 16]} />
          <meshStandardMaterial color="#22d3ee" />
        </mesh>
      </>
    );
  }

  return (
    <>
      <gridHelper args={[12, 12, "#2b3d57", "#1b2534"]} position={[grid.x, grid.y, grid.z]} />
      <primitive object={instances.spark} />
      <primitive object={instances.splat} />
    </>
  );
}
