"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, ContactShadows } from "@react-three/drei";
import { useEditorStore, type ViewPreset } from "@/stores/editor-store";
import { LIGHT_PRESETS } from "@shared/asset-catalog";
import { installRenderFallback } from "@/lib/render-fallback";
import type { CameraSpec } from "@shared/scene-schema";
import Room from "./Room";
import Furniture from "./Furniture";
import SplatObject from "./SplatObject";

let disposeFallback: (() => void) | null = null;

export default function SceneCanvas() {
  // R3F canvas 偶发初始 measure 不触发（canvas 停留 300×150）；挂载后 poke 一次 resize
  useEffect(() => {
    const poke = () => window.dispatchEvent(new Event("resize"));
    poke();
    const t = setTimeout(poke, 200);
    return () => clearTimeout(t);
  }, []);

  const scene = useEditorStore((s) => s.scene);
  const selectedId = useEditorStore((s) => s.selectedId);
  const gizmoMode = useEditorStore((s) => s.gizmoMode);
  const previewMode = useEditorStore((s) => s.previewMode);
  const select = useEditorStore((s) => s.select);
  const pushHistory = useEditorStore((s) => s.pushHistory);
  const setCamera = useEditorStore((s) => s.setCamera);
  const splatFrame = useEditorStore((s) => s.splatFrame);
  /** 高斯加载失败后的重试：换 key 重挂载 SplatObject，重新走一遍下载/解析 */
  const [splatRetryKey, setSplatRetryKey] = useState(0);

  const light = scene ? LIGHT_PRESETS[scene.lighting.preset] : LIGHT_PRESETS.warm;
  const { width, depth } = scene?.room ?? { width: 5, depth: 4 };
  const splatActive = scene?.reconstruction.format === "gaussian-splat" && !!scene.reconstruction.url;
  // 重建场景的兜底背景色：优先用服务端采样到的环境色；没有则取墙/地色混合，
  // 避免「未观测区域」被近黑背景色画成刺眼的洞（见 evidence/Q3/INTEGRATION-B-backdrop.md）
  const backdropColor = scene
    ? scene.reconstruction.ambientColor ?? mixHex(scene.room.floorColor, scene.room.wallColor, 0.35)
    : "#2b2a28";

  // Gizmo 拖拽：开始时记历史快照
  const onTransformStart = useCallback(() => {
    pushHistory();
  }, [pushHistory]);

  const onTransform = useCallback((id: string, object: THREE.Object3D) => {
    const st = useEditorStore.getState();
    if (st.gizmoMode === "translate") {
      st.updateObject(id, { position: [object.position.x, object.position.y, object.position.z] }, { history: false });
    } else if (st.gizmoMode === "rotate") {
      st.updateObject(id, { rotation: [0, object.rotation.y, 0] }, { history: false });
    } else {
      const uniform = THREE.MathUtils.clamp(object.scale.x, 0.2, 4);
      st.updateObject(id, { scale: [uniform, uniform, uniform] }, { history: false });
    }
  }, []);

  if (!scene) return null;

  return (
    <>
      <Canvas
        shadows
        camera={{
          position: scene.camera.position as unknown as [number, number, number],
          fov: scene.camera.fov,
        }}
        onPointerMissed={() => !previewMode && select(null)}
        onCreated={({ gl, scene, camera }) => {
            disposeFallback?.(); // 换 renderer 时清理旧兜底
            disposeFallback = installRenderFallback(gl, scene, camera);
  }}
      >
        <color attach="background" args={[splatActive ? backdropColor : light.background]} />
        <ambientLight color={light.ambient} intensity={0.9 * scene.lighting.intensity} />
        <directionalLight
          color={light.sun}
          intensity={1.6 * scene.lighting.intensity}
          position={light.sunPosition}
          castShadow={!splatActive}
          shadow-mapSize={[1024, 1024]}
        />
        <directionalLight position={[-6, 4, -6]} intensity={0.3} />

        {!splatActive && <Room room={scene.room} />}
        {/* 重建场景：外壳作为兜底背景板（画在重建之后、不吃光照），
            让「未观测区域」后面是墙和地，而不是近黑虚空 */}
        {splatActive && splatFrame && (
          <Room room={scene.room} backdrop frame={splatFrame} />
        )}
        {splatActive && scene.reconstruction.url && (
          <SplatObject
            key={`${scene.reconstruction.url}#${splatRetryKey}`}
            url={scene.reconstruction.url}
            synthetic={scene.reconstruction.synthetic}
          />
        )}

        {scene.objects.map((obj) => (
          <Furniture
            key={obj.id}
            obj={obj}
            selected={obj.id === selectedId && !previewMode}
            pickable={!previewMode}
            gizmoMode={gizmoMode}
            onSelect={select}
            onTransformStart={onTransformStart}
            onTransform={onTransform}
          />
        ))}

        {!splatActive && (
          <ContactShadows
            position={[0, 0.002, 0]}
            scale={Math.max(width, depth) * 2}
            opacity={0.3}
            blur={1.2}
            far={3}
          />
        )}

        <CameraRig cameraSpec={scene.camera} splatActive={splatActive} onChange={setCamera} />
        <ViewPresetRig />
      </Canvas>
      <SplatLoadOverlay
        key={splatRetryKey}
        onRetry={() => setSplatRetryKey((k) => k + 1)}
      />
    </>
  );
}

/**
 * 大点云加载蒙版：加载期间给出阶段、进度与预计等待，失败时可见并可重新加载。
 * 半透明遮罩（仍能看到场景轮廓）：高斯背景未就绪前，视角预设依赖的包围帧还没算出来，
 * 此时明确告诉用户在等什么，而不是让空视口看起来像坏了。
 */
function SplatLoadOverlay({ onRetry }: { onRetry: () => void }) {
  const scene = useEditorStore((s) => s.scene);
  const splatLoad = useEditorStore((s) => s.splatLoad);
  const progress = useEditorStore((s) => s.splatProgress);
  /** 已等待秒数与预计剩余：由 interval 回调写入（渲染期不读时钟） */
  const [elapsedSec, setElapsedSec] = useState(0);
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  const startRef = useRef(0);
  const progressRef = useRef(progress);

  const active = scene?.reconstruction.format === "gaussian-splat" && !!scene.reconstruction.url;

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    if (splatLoad !== "loading") return;
    startRef.current = Date.now();
    const iv = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.max(0, now - startRef.current);
      setElapsedSec((prev) => {
        const next = Math.floor(elapsed / 1000);
        return prev === next ? prev : next;
      });
      const p = progressRef.current;
      const done = p?.phase === "download" ? p.percent : null;
      // 前 5% 样本太少（TCP 慢启动），不做外推，改为只显示已等待时长
      const nextRemain =
        done !== null && done >= 5 && done < 100 && elapsed > 0
          ? Math.max(1, Math.round((elapsed / done) * (100 - done) / 1000))
          : null;
      setRemainingSec((prev) => (prev === nextRemain ? prev : nextRemain));
    }, 500);
    return () => clearInterval(iv);
  }, [splatLoad]);

  if (!active || splatLoad === "idle" || splatLoad === "ready") return null;

  const pct = progress?.phase === "download" ? progress.percent : null;

  if (splatLoad === "error") {
    return (
      <div
        className="absolute inset-0 z-20 flex items-center justify-center px-4"
        style={{ background: "rgba(3,7,18,0.72)", backdropFilter: "blur(1px)" }}
      >
        <div className="w-[min(22rem,calc(100%-1rem))] rounded-xl border border-red-500/30 bg-slate-950/90 p-4 text-center">
          <div className="text-xs font-semibold text-red-300">高斯点云加载失败</div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
            点云没能下载或解析成功，可能是网络中断、文件不完整或浏览器显存不足。
            家具编辑不受影响，可以重新加载一次。
          </p>
          <div className="mt-3 flex justify-center gap-2">
            <button
              className="rounded border border-cyan-500/40 px-3 py-1.5 text-[11px] text-cyan-300 transition hover:bg-cyan-500/10"
              onClick={onRetry}
            >
              重新加载
            </button>
            <button
              className="rounded border border-slate-600 px-3 py-1.5 text-[11px] text-slate-400 transition hover:bg-slate-700/30"
              onClick={() => window.location.reload()}
            >
              刷新页面
            </button>
          </div>
        </div>
      </div>
    );
  }

  const phaseText =
    progress?.phase === "parse"
      ? `已下载完成，正在解析点云 · 已等待 ${elapsedSec} 秒`
      : pct !== null
        ? `已下载 ${pct}%${remainingSec !== null ? ` · 预计还需 ${remainingSec} 秒` : ""}`
        : `正在下载点云 · 已等待 ${elapsedSec} 秒`;

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center px-4"
      style={{ background: "rgba(3,7,18,0.55)", backdropFilter: "blur(1px)" }}
    >
      <div className="w-[min(22rem,calc(100%-1rem))] rounded-xl border border-cyan-500/25 bg-slate-950/90 p-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-cyan-200">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-300" />
          正在加载高斯点云
        </div>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(34,211,238,0.12)" }}>
          {pct !== null ? (
            <span
              className="block h-full rounded-full transition-all duration-300"
              style={{
                width: `${pct}%`,
                background: "linear-gradient(90deg, #06b6d4, #22d3ee)",
                boxShadow: "0 0 8px rgba(34,211,238,0.6)",
              }}
            />
          ) : (
            <span
              className="block h-full w-1/3 rounded-full"
              style={{
                background: "linear-gradient(90deg, transparent, #22d3ee, transparent)",
                animation: "mv-loading-slide 1.2s ease-in-out infinite",
              }}
            />
          )}
        </div>
        <div className="mt-2 text-[11px] text-slate-300">{phaseText}</div>
        <div className="mt-1 text-[10px] text-slate-500">
          加载完成后才能使用 360° 与三视图视角；家具编辑现在就可以继续。
        </div>
      </div>
    </div>
  );
}

/**
 * 360° 环绕 / 三视图预设：监听 store 的 viewRequest，按高斯稳健包围帧放置相机。
 * - model360：外部环绕全向轨道（polar 全开，可转整圈）
 * - front/side/top：轴对齐三视图（同样处于环绕轨道）
 * - inside：回到房间内部漫游（限制俯角到地平线上方）
 */
function ViewPresetRig() {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target?: THREE.Vector3; update?: () => void } | null;
  const viewRequest = useEditorStore((s) => s.viewRequest);
  const setViewMode = useEditorStore((s) => s.setViewMode);

  useEffect(() => {
    if (!viewRequest) return;
    const { preset } = viewRequest;
    const cam = camera as THREE.PerspectiveCamera;
    const st = useEditorStore.getState();
    const frame = st.splatFrame;

    if (preset === "inside") {
      setViewMode("inside");
      return;
    }
    if (!frame || !controls?.target) {
      // 高斯帧未就绪（非重建场景）——忽略请求
      return;
    }
    const center = new THREE.Vector3(...frame.center);
    // 环绕距离用训练相机轨道半径（数据视角带）：室内重建数据只在拍摄位置带可靠，
    // 推到包围盒外是空腔+离群碎片。三视图轴向不变、距离同轨道
    const dist = Math.max(frame.orbitRadius, 0.6);
    const dirs: Record<Exclude<ViewPreset, "inside">, THREE.Vector3> = {
      model360: new THREE.Vector3(0.75, 0.5, 1).normalize(),
      front: new THREE.Vector3(0, 0, 1),
      side: new THREE.Vector3(1, 0, 0),
      top: new THREE.Vector3(0, 1, 0.02).normalize(),
    };
    cam.up.set(0, 1, 0);
    cam.position.copy(center.clone().add(dirs[preset].multiplyScalar(dist)));
    controls.target.copy(center);
    controls.update?.();
    setViewMode("model");
    // 视图预设不写入场景相机（临时查看态，用户手动调整后才由 CameraRig 落盘）
  }, [viewRequest, camera, controls, setViewMode]);

  return null;
}

/** 两个 #RRGGBB 按比例混合（t=0 → a，t=1 → b）；解析失败回退深灰 */
function mixHex(a: string, b: string, t: number): string {
  const parse = (hex: string) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    return m ? parseInt(m[1], 16) : 0x2b2a28;
  };
  const pa = parse(a);
  const pb = parse(b);
  const mix = (shift: number) =>
    Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `#${[mix(16), mix(8), mix(0)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

function CameraRig({
  cameraSpec,
  splatActive,
  onChange,
}: {
  cameraSpec: CameraSpec;
  splatActive: boolean;
  onChange: (c: CameraSpec) => void;
}) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { target?: THREE.Vector3 } | null;
  const viewMode = useEditorStore((s) => s.viewMode);

  // 只在一次手势结束（onEnd）时提交一次相机姿态。
  // 原来用 onChange + 500ms 节流：阻尼期间每 0.5 秒都会写一次，实测拖一次视角产生 20 次 PUT。
  const commitCamera = useCallback(() => {
    const cam = camera as THREE.PerspectiveCamera;
    if (!controls?.target) return;
    // 用户主动调整视角 = 视角已确认，落 autoFrame=false 防止重建背景加载时被自动取景覆盖
    onChange({
      position: [cam.position.x, cam.position.y, cam.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
      fov: cam.fov,
      autoFrame: false,
    });
  }, [camera, controls, onChange]);

  // 轨道约束随查看模式切换：inside=房间内部（不钻地）；model=360° 全向环绕（可顶视/仰视整圈）
  const inside = viewMode === "inside";

  return (
    <OrbitControls
      makeDefault
      target={cameraSpec.target as unknown as [number, number, number]}
      onEnd={commitCamera}
      // 重建场景尺度由 COLMAP 归一化决定（相机距主体常 <1.5m），放宽房间尺度限制
      minDistance={splatActive ? (inside ? 0.2 : 0.5) : 1.5}
      maxDistance={splatActive ? 80 : 20}
      maxPolarAngle={splatActive && !inside ? Math.PI - 0.03 : Math.PI / 2.05}
      enablePan
    />
  );
}
