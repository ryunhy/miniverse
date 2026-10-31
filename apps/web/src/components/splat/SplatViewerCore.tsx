"use client";

import { useEffect, useState } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as Spark from "@sparkjsdev/spark";
import { installRenderFallback } from "@/lib/render-fallback";
import { fetchSplatBytes, createSplatMesh, ORIENT_COLMAP_NERFSTUDIO_Q, trainingViewpoint } from "@/lib/splat-load";

interface SplatViewerCoreProps {
  url: string;
  height?: number;
  /** 数据朝向：colmap-nerfstudio = 真实重建 PLY（nerfstudio 归一化系，Z-up），需 Rx(-90°) 立起 */
  orient?: "identity" | "colmap-nerfstudio";
  /** 关联重建任务 ID：提供时加载完成后按训练相机取景（真实拍摄视角） */
  taskId?: string | null;
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
 * - 提供 taskId 时按训练相机取景，否则用高斯稳健取景
 * - 与编辑器同一 three/R3F 坐标系约定（米、Y 向上）
 */
export default function SplatViewerCore({ url, height = 520, orient = "identity", taskId }: SplatViewerCoreProps) {
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
        <SplatScene url={url} orient={orient} taskId={taskId} onProgress={setProgress} />
        <OrbitControlsRef target={[0, 1, 0]} />
      </Canvas>
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
  return <OrbitControls makeDefault target={target} minDistance={0.2} maxDistance={50} />;
}

function SplatScene({
  url,
  orient,
  taskId,
  onProgress,
}: {
  url: string;
  orient: "identity" | "colmap-nerfstudio";
  taskId?: string | null;
  onProgress: (p: ViewerProgress | null) => void;
}) {
  const [failed, setFailed] = useState(false);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target?: THREE.Vector3; update?: () => void } | null;
  const [instances, setInstances] = useState<{ splat: Spark.SplatMesh; spark: Spark.SparkRenderer } | null>(null);

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

        // 取景：训练相机优先（真实拍摄视角），失败回退高斯稳健取景
        const cam = camera as THREE.PerspectiveCamera;
        const orientQ = splat.quaternion;
        const vp = taskId ? await trainingViewpoint(taskId, orientQ, abort.signal) : null;
        if (disposed) return;
        if (vp) {
          cam.up.set(0, 1, 0);
          cam.position.copy(vp.position);
          if (controls?.target) {
            controls.target.copy(vp.target);
            controls.update?.();
          }
        } else {
          const N = splat.packedSplats?.numSplats ?? 0;
          if (N > 0) {
            const xs: number[] = [];
            const ys: number[] = [];
            const zs: number[] = [];
            const step = Math.max(1, Math.floor(N / 6000));
            const v = new THREE.Vector3();
            splat.forEachSplat((index, center) => {
              if (index % step === 0) {
                v.copy(center);
                xs.push(v.x);
                ys.push(v.y);
                zs.push(v.z);
              }
            });
            const median = (arr: number[]) => {
              const a = [...arr].sort((p, q) => p - q);
              return a[Math.floor(a.length / 2)] ?? 0;
            };
            const center = new THREE.Vector3(median(xs), median(ys), median(zs)).applyQuaternion(orientQ);
            const dists = xs.map((x, i) => Math.hypot(x - center.x, ys[i] - center.y, zs[i] - center.z));
            const radius = Math.max(median(dists) * 4, 1.5);
            const dir = new THREE.Vector3(0.75, 0.5, 1).normalize();
            cam.up.set(0, 1, 0);
            cam.position.copy(center.clone().add(dir.multiplyScalar(radius * 2.2)));
            if (controls?.target) {
              controls.target.copy(center);
              controls.update?.();
            }
          }
        }

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

  if (failed) {
    return (
      <mesh position={[0, 1.5, 0]}>
        <boxGeometry args={[0.5, 0.5, 0.5]} />
        <meshStandardMaterial color="#ef4444" wireframe />
      </mesh>
    );
  }
  if (!instances) {
    return (
      <mesh position={[0, 1.5, 0]}>
        <sphereGeometry args={[0.3, 16, 16]} />
        <meshStandardMaterial color="#22d3ee" />
      </mesh>
    );
  }

  return (
    <>
      <primitive object={instances.spark} />
      <primitive object={instances.splat} />
    </>
  );
}
