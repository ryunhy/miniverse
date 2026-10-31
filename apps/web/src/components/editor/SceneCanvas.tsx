"use client";

import { useCallback, useEffect, useRef } from "react";
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
        <SplatObject url={scene.reconstruction.url} synthetic={scene.reconstruction.synthetic} />
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const cam = camera as THREE.PerspectiveCamera;
      if (!controls?.target) return;
      // 用户主动调整视角 = 视角已确认，落 autoFrame=false 防止重建背景加载时被自动取景覆盖
      onChange({
        position: [cam.position.x, cam.position.y, cam.position.z],
        target: [controls.target.x, controls.target.y, controls.target.z],
        fov: cam.fov,
        autoFrame: false,
      });
    }, 500);
  }, [camera, controls, onChange]);

  // 轨道约束随查看模式切换：inside=房间内部（不钻地）；model=360° 全向环绕（可顶视/仰视整圈）
  const inside = viewMode === "inside";

  return (
    <OrbitControls
      makeDefault
      target={cameraSpec.target as unknown as [number, number, number]}
      onChange={handleChange}
      // 重建场景尺度由 COLMAP 归一化决定（相机距主体常 <1.5m），放宽房间尺度限制
      minDistance={splatActive ? (inside ? 0.2 : 0.5) : 1.5}
      maxDistance={splatActive ? 80 : 20}
      maxPolarAngle={splatActive && !inside ? Math.PI - 0.03 : Math.PI / 2.05}
      enablePan
    />
  );
}
