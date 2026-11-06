"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, TransformControls, useGLTF } from "@react-three/drei";
import {
  inferObjectRole,
  type BackgroundCheckReport,
  type SceneManifest,
  type SceneObjectInfo,
  type ScenePayload,
  type SceneTransform,
} from "@/lib/scene-types";

type Mode = "translate" | "rotate" | "scale";

type Draft = Record<string, SceneTransform>;

const LABELS: Record<string, string> = {
  "obj-walls": "墙体",
  walls: "墙体",
  wall: "墙体",
  "obj-floor": "地板",
  floor: "地板",
  "obj-sofa": "沙发",
  sofa: "沙发",
};

const MODES: { key: Mode; label: string }[] = [
  { key: "translate", label: "移动" },
  { key: "rotate", label: "旋转" },
  { key: "scale", label: "缩放" },
];

/** 背景检查的视线网格边长：24×24 = 576 条视线，覆盖画布中心区域。 */
const CHECK_GRID = 24;
const HISTORY_LIMIT = 50;

interface MVHook {
  ready: boolean;
  sceneId: string | null;
  sceneVersion: string | null;
  selectedId: string | null;
  mode: Mode;
  dirty: boolean;
  canUndo: boolean;
  undoDepth: number;
  furnitureRemoved: boolean;
  check: BackgroundCheckReport | null;
  objects: Record<string, { position: number[]; quaternion: number[]; scale: number[]; visible: boolean }>;
  screen?: Record<string, { x: number; y: number }>;
  gizmo?: { x: number; y: number } | null;
  /** 选中对象三根世界轴在屏幕上的单位方向（自动化拖动坐标轴手柄用） */
  axes?: Record<"x" | "y" | "z", { x: number; y: number }> | null;
  canvas?: { left: number; top: number; width: number; height: number };
}

declare global {
  interface Window {
    __mv?: Partial<MVHook>;
  }
}

function identityTransform(): SceneTransform {
  return { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], visible: true };
}

function normalizeTransform(t: SceneTransform): SceneTransform {
  return {
    position: [...t.position] as [number, number, number],
    quaternion: [...t.quaternion] as [number, number, number, number],
    scale: [...t.scale] as [number, number, number],
    visible: t.visible,
  };
}

function cloneDraft(draft: Draft): Draft {
  return Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, normalizeTransform(v)]));
}

function objectLabel(o: SceneObjectInfo): string {
  return LABELS[o.objectId] ?? LABELS[o.nodeName] ?? o.label ?? o.nodeName;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** 世界坐标 → canvas 内屏幕坐标（CSS 像素）。 */
function worldToScreen(
  v: THREE.Vector3,
  state: { camera: THREE.Camera; size: { width: number; height: number } },
) {
  const p = v.clone().project(state.camera);
  return {
    x: (p.x * 0.5 + 0.5) * state.size.width,
    y: (-p.y * 0.5 + 0.5) * state.size.height,
  };
}

/** 从已加载的 glTF 场景里按 nodeName 找到清单声明的对象。 */
function nodeMapFor(scene: THREE.Object3D, objects: SceneObjectInfo[]) {
  const map = new Map<string, THREE.Object3D>();
  scene.traverse((node) => {
    const hit = objects.find((o) => o.nodeName === node.name);
    if (hit) {
      node.userData.objectId = hit.objectId;
      map.set(hit.objectId, node);
    }
  });
  return map;
}

function objectIdAt(object: THREE.Object3D | null): string | null {
  let cur = object;
  while (cur) {
    const id = cur.userData?.objectId as string | undefined;
    if (id) return id;
    cur = cur.parent;
  }
  return null;
}

function SceneCanvas({
  url,
  objects,
  draft,
  checkBaseline,
  selectedId,
  mode,
  dragging,
  checkToken,
  onSelect,
  onDragging,
  onDragStart,
  onCommit,
  onReady,
  onCheckResult,
}: {
  url: string;
  objects: SceneObjectInfo[];
  draft: Draft;
  checkBaseline: Record<string, boolean> | null;
  selectedId: string | null;
  mode: Mode;
  dragging: boolean;
  checkToken: number;
  onSelect: (objectId: string | null) => void;
  onDragging: (v: boolean) => void;
  onDragStart: () => void;
  onCommit: (objectId: string) => void;
  onReady: (map: Map<string, THREE.Object3D>) => void;
  onCheckResult: (report: BackgroundCheckReport) => void;
}) {
  const { scene } = useGLTF(url);
  const { camera, controls, gl } = useThree() as {
    camera: THREE.PerspectiveCamera;
    controls?: { target: THREE.Vector3; update: () => void };
    gl: THREE.WebGLRenderer;
  };

  const clone = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        // 上游 GLB 缺 NORMAL 时补算法线：MeshStandardMaterial 没有法线会全黑/无立体感。
        if (!node.geometry.attributes.normal) node.geometry.computeVertexNormals();
        const mat = node.material as THREE.MeshStandardMaterial | undefined;
        if (mat && !Array.isArray(mat)) {
          mat.side = THREE.DoubleSide;
          mat.needsUpdate = true;
        }
      }
    });
    return c;
  }, [scene]);

  const nodes = useMemo(() => nodeMapFor(clone, objects), [clone, objects]);
  const roles = useMemo(() => {
    const m = new Map<string, "background" | "furniture">();
    for (const o of objects) m.set(o.objectId, inferObjectRole(o));
    return m;
  }, [objects]);

  const framed = useRef(false);

  useEffect(() => {
    // 每个对象的包围盒中心只算一次（真实网格几十万面，逐帧 setFromObject 太贵），
    // 供测试钩子投影屏幕坐标 / 指针命中用。
    for (const node of nodes.values()) {
      const box = new THREE.Box3().setFromObject(node);
      node.userData.__center = box.isEmpty()
        ? new THREE.Vector3()
        : node.worldToLocal(box.getCenter(new THREE.Vector3()));
    }
    onReady(nodes);
  }, [nodes, onReady]);

  // 布局同步：面板/撤销改 draft，节点跟着变；gizmo 拖动期间不改 draft，避免互相抢写。
  useEffect(() => {
    for (const [objectId, t] of Object.entries(draft)) {
      const node = nodes.get(objectId);
      if (!node) continue;
      node.position.fromArray(t.position);
      node.quaternion.fromArray(t.quaternion);
      node.scale.fromArray(t.scale);
      node.visible = t.visible;
    }
  }, [draft, nodes]);

  // 打开即按真实包围盒取景（nu 尺度未知，不能写死距离）。
  // R3F 相机是命令式外部对象：取景必须改 position/near/far，走 React 状态反而会丢帧。
  /* eslint-disable react-hooks/immutability */
  useEffect(() => {
    if (framed.current || nodes.size === 0) return;
    const box = new THREE.Box3();
    for (const node of nodes.values()) box.expandByObject(node);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-3);
    const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.25;
    const dir = new THREE.Vector3(0.9, 0.55, 1.0).normalize();
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.near = Math.max(radius / 500, 1e-4);
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    camera.lookAt(center);
    if (controls) {
      controls.target.copy(center);
      controls.update();
    }
    framed.current = true;
  }, [camera, controls, nodes]);
  /* eslint-enable react-hooks/immutability */

  const helper = useMemo(() => {
    const h = new THREE.BoxHelper(new THREE.Object3D(), 0x22d3ee);
    h.visible = false;
    return h;
  }, []);
  useEffect(() => () => helper.geometry.dispose(), [helper]);

  // 自动化测试钩子：对象屏幕坐标 + 画布矩形，供真实指针/CDP 使用。
  // 用按需函数（而非逐帧写 window）——headless 浏览器会节流 rAF，逐帧钩子可能拿不到值。
  useEffect(() => {
    const hook = () => {
      const rect = gl.domElement.getBoundingClientRect();
      const canvas = {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      const screen: Record<string, { x: number; y: number }> = {};
      for (const [objectId, node] of nodes) {
        if (!node.visible) continue;
        const local = node.userData.__center as THREE.Vector3 | undefined;
        if (!local) continue;
        const p = worldToScreen(node.localToWorld(local.clone()), {
          camera,
          size: { width: rect.width, height: rect.height },
        });
        screen[objectId] = { x: Math.round(p.x), y: Math.round(p.y) };
      }
      const sel = selectedId ? nodes.get(selectedId) : null;
      const origin = sel && sel.visible ? sel.getWorldPosition(new THREE.Vector3()) : null;
      const gizmo = origin
        ? (() => {
            const p = worldToScreen(origin, { camera, size: { width: rect.width, height: rect.height } });
            return { x: Math.round(p.x), y: Math.round(p.y) };
          })()
        : null;
      // 屏幕单位方向：世界轴取一段随相机距离缩放的步长，投影后归一化。
      let axes: Record<"x" | "y" | "z", { x: number; y: number }> | null = null;
      if (origin && gizmo) {
        const size = { width: rect.width, height: rect.height };
        const step = Math.max(camera.position.distanceTo(origin) * 0.08, 1e-6);
        const base = worldToScreen(origin, { camera, size });
        axes = { x: { x: 0, y: 0 }, y: { x: 0, y: 0 }, z: { x: 0, y: 0 } };
        for (const [name, vec] of [
          ["x", new THREE.Vector3(1, 0, 0)],
          ["y", new THREE.Vector3(0, 1, 0)],
          ["z", new THREE.Vector3(0, 0, 1)],
        ] as const) {
          const tip = worldToScreen(origin.clone().addScaledVector(vec, step), { camera, size });
          const dx = tip.x - base.x;
          const dy = tip.y - base.y;
          const len = Math.hypot(dx, dy) || 1;
          axes[name] = { x: dx / len, y: dy / len };
        }
      }
      return { screen, gizmo, axes, canvas };
    };
    (window as unknown as { __mvProject?: typeof hook }).__mvProject = hook;
    const projected = hook();
    (window.__mv ??= {}).screen = projected.screen;
    (window.__mv ??= {}).gizmo = projected.gizmo;
    (window.__mv ??= {}).axes = projected.axes;
    (window.__mv ??= {}).canvas = projected.canvas;
  }, [camera, gl, nodes, selectedId]);

  useFrame(() => {
    const node = selectedId ? nodes.get(selectedId) : null;
    if (node && node.visible) {
      helper.setFromObject(node);
      // eslint-disable-next-line react-hooks/immutability -- BoxHelper 是每帧更新的外部对象
      helper.visible = true;
    } else {
      helper.visible = false;
    }
  });

  const lastCheck = useRef(0);

  /**
   * 移除家具后的背景检查：
   *  1) 把可见性恢复成「移除前」基线，向画布网格发射 576 条视线，记录命中掩码；
   *  2) 按当前（家具已移除）可见性再采样一次；
   *  3) 基线有几何、移除后什么都没有的视线 = 新露出的洞（newHoles）。
   * 只有 newHoles=0 且仍有背景几何命中才算通过。
   */
  useEffect(() => {
    if (!checkToken || checkToken === lastCheck.current) return;
    lastCheck.current = checkToken;

    const raycaster = new THREE.Raycaster();
    const setVisibility = (visibility: Record<string, boolean>) => {
      for (const [objectId, node] of nodes) {
        node.visible = visibility[objectId] ?? true;
        node.updateMatrixWorld(true);
      }
    };

    const meshesFor = () => {
      const list: THREE.Mesh[] = [];
      for (const node of nodes.values()) {
        if (!node.visible) continue;
        node.traverse((child) => {
          if (child instanceof THREE.Mesh && child.visible) list.push(child);
        });
      }
      return list;
    };

    const sample = (visibility: Record<string, boolean>) => {
      setVisibility(visibility);
      const meshes = meshesFor();
      const mask = new Uint8Array(CHECK_GRID * CHECK_GRID);
      let hits = 0;
      let backgroundHits = 0;
      for (let iy = 0; iy < CHECK_GRID; iy++) {
        for (let ix = 0; ix < CHECK_GRID; ix++) {
          const ndc = new THREE.Vector2(
            ((ix + 0.5) / CHECK_GRID) * 2 - 1,
            ((iy + 0.5) / CHECK_GRID) * 2 - 1,
          );
          raycaster.setFromCamera(ndc, camera);
          const hit = raycaster.intersectObjects(meshes, true)[0];
          if (!hit) continue;
          const index = iy * CHECK_GRID + ix;
          mask[index] = 1;
          hits += 1;
          const objectId = objectIdAt(hit.object);
          if (objectId && roles.get(objectId) === "background") backgroundHits += 1;
        }
      }
      return { mask, hits, backgroundHits };
    };

    const baselineVisibility =
      checkBaseline ??
      Object.fromEntries(Object.entries(draft).map(([k, t]) => [k, t.visible]));
    const baseline = sample(baselineVisibility);
    const after = sample(
      Object.fromEntries(Object.entries(draft).map(([k, t]) => [k, t.visible])),
    );

    // 「洞」判定：移除前有几何、移除后没有，且 8 邻域里至少一半仍是背景命中
    // （孤立空缺像洞）。邻居大多也空的，是房间开放边界/天空，不算家具背后的洞。
    let newHoles = 0;
    let silhouetteMisses = 0;
    const at = (ix: number, iy: number) => (ix < 0 || iy < 0 || ix >= CHECK_GRID || iy >= CHECK_GRID ? -1 : iy * CHECK_GRID + ix);
    for (let iy = 0; iy < CHECK_GRID; iy++) {
      for (let ix = 0; ix < CHECK_GRID; ix++) {
        const i = iy * CHECK_GRID + ix;
        if (!baseline.mask[i] || after.mask[i]) continue;
        let neighbours = 0;
        let covered = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const j = at(ix + dx, iy + dy);
            if (j < 0) continue;
            neighbours += 1;
            if (after.mask[j]) covered += 1;
          }
        }
        if (neighbours > 0 && covered / neighbours >= 0.5) newHoles += 1;
        else silhouetteMisses += 1;
      }
    }

    const rays = CHECK_GRID * CHECK_GRID;
    onCheckResult({
      rays,
      baselineHits: baseline.hits,
      afterHits: after.hits,
      backgroundHits: after.backgroundHits,
      newHoles,
      silhouetteMisses,
      coverage: rays ? after.hits / rays : 0,
      backgroundCoverage: after.hits ? after.backgroundHits / after.hits : 0,
      pass: newHoles === 0 && after.hits > 0,
      checkedAt: new Date().toISOString(),
    });
  }, [camera, checkBaseline, checkToken, draft, nodes, onCheckResult, roles]);

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    // 拖动 gizmo 结束时 dragging 已被 onMouseUp 置回 false，若此时指针下面恰好是
    // 地板/墙体，R3F 的 click 会把选择抢走（撤销后高亮仍停在地板上）。按指针位移过滤。
    if (dragging || e.delta > 4) return;
    const objectId = objectIdAt(e.object);
    if (objectId) {
      e.stopPropagation();
      onSelect(objectId);
      return;
    }
    onSelect(null);
  };

  const selected = selectedId ? nodes.get(selectedId) ?? null : null;

  return (
    <>
      <color attach="background" args={["#080d1a"]} />
      <ambientLight intensity={1.4} />
      <hemisphereLight args={["#ffffff", "#334155", 1.1]} />
      <directionalLight position={[4, 7, 5]} intensity={2.1} />
      <directionalLight position={[-5, 3, -4]} intensity={0.7} />
      <primitive object={clone} onClick={onClick} />
      <primitive object={helper} />
      {selected && selected.visible ? (
        <TransformControls
          object={selected}
          mode={mode}
          size={0.9}
          onMouseDown={() => {
            onDragStart();
            onDragging(true);
          }}
          onMouseUp={() => {
            onDragging(false);
            if (selectedId) onCommit(selectedId);
          }}
        />
      ) : null}
      <OrbitControls makeDefault enabled={!dragging} minDistance={0.02} maxDistance={500} />
    </>
  );
}

export default function EditableSceneViewerCore({
  id,
  height = 620,
}: {
  id: string;
  height?: number;
}) {
  const [payload, setPayload] = useState<ScenePayload | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [defaults, setDefaults] = useState<Draft>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("translate");
  const [dragging, setDragging] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checkBaseline, setCheckBaseline] = useState<Record<string, boolean> | null>(null);
  const [checkToken, setCheckToken] = useState(0);
  const [checkReport, setCheckReport] = useState<BackgroundCheckReport | null>(null);
  const [furnitureRemoved, setFurnitureRemoved] = useState(false);
  const [undoDepth, setUndoDepth] = useState(0);

  const nodesRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const historyRef = useRef<Draft[]>([]);
  const dragStartRef = useRef<Draft | null>(null);

  const manifest: SceneManifest | null = payload?.manifest ?? null;

  const furnitureIds = useMemo(() => {
    if (!manifest) return [] as string[];
    return manifest.objects
      .filter((o) => inferObjectRole(o) === "furniture")
      .map((o) => o.objectId);
  }, [manifest]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/reconstructions/${id}/scene`, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as ScenePayload;
      const base: Draft = {};
      for (const o of data.manifest.objects) {
        base[o.objectId] = o.startTransform
          ? normalizeTransform(o.startTransform)
          : identityTransform();
      }
      const stored = data.edits?.objects ?? {};
      const merged: Draft = { ...base };
      for (const [objectId, t] of Object.entries(stored)) {
        if (merged[objectId]) merged[objectId] = normalizeTransform(t);
      }
      setDefaults(cloneDraft(base));
      setDraft(merged);
      setPayload(data);
      setSelectedId(null);
      setCheckReport(null);
      setCheckBaseline(null);
      setFurnitureRemoved(false);
      setDirty(false);
      historyRef.current = [];
      setUndoDepth(0);
      if (data.editsStale) {
        setMessage("场景已重新生成，旧布局已失效，已回退到清单默认布局。");
      } else if (data.edits) {
        setMessage("已恢复上次保存的布局。");
      } else {
        setMessage("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "场景加载失败");
    }
  }, [id]);

  useEffect(() => {
    // 首屏拉取清单/布局：数据来自外部 API，必须在挂载后写回状态。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const pushHistory = useCallback((snapshot?: Draft) => {
    historyRef.current.push(cloneDraft(snapshot ?? draft));
    if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
    setUndoDepth(historyRef.current.length);
  }, [draft]);

  const undo = useCallback(() => {
    const prev = historyRef.current.pop();
    if (!prev) return;
    setUndoDepth(historyRef.current.length);
    setDraft(prev);
    setDirty(true);
    setCheckReport(null);
    // 撤销「移除家具」后要同步背景检查面板状态，否则「恢复家具」按钮仍停用
    setFurnitureRemoved(furnitureIds.some((objectId) => prev[objectId]?.visible === false));
    setMessage("已撤销上一步操作。");
  }, [furnitureIds]);

  const onReady = useCallback((map: Map<string, THREE.Object3D>) => {
    nodesRef.current = map;
  }, []);

  const onCommit = useCallback(
    (objectId: string) => {
      const node = nodesRef.current.get(objectId);
      if (!node) return;
      const next: SceneTransform = {
        position: [round(node.position.x), round(node.position.y), round(node.position.z)],
        quaternion: [
          node.quaternion.x,
          node.quaternion.y,
          node.quaternion.z,
          node.quaternion.w,
        ].map(round) as [number, number, number, number],
        scale: [round(node.scale.x), round(node.scale.y), round(node.scale.z)],
        visible: draft[objectId]?.visible ?? true,
      };
      const prev = dragStartRef.current ?? draft;
      dragStartRef.current = null;
      // 没有实际变化就不污染撤销栈（点一下 gizmo 轴不算一次操作）
      const old = draft[objectId];
      const changed =
        !old ||
        old.position.some((v, i) => Math.abs(v - next.position[i]) > 1e-6) ||
        old.quaternion.some((v, i) => Math.abs(v - next.quaternion[i]) > 1e-6) ||
        old.scale.some((v, i) => Math.abs(v - next.scale[i]) > 1e-6);
      if (changed) pushHistory(prev);
      setDraft((cur) => ({ ...cur, [objectId]: next }));
      if (changed) setDirty(true);
    },
    [draft, pushHistory],
  );

  const toggleVisible = useCallback(
    (objectId: string) => {
      pushHistory();
      setDraft((cur) => {
        const t = cur[objectId] ?? identityTransform();
        return { ...cur, [objectId]: { ...t, visible: !t.visible } };
      });
      setDirty(true);
      setCheckReport(null);
    },
    [pushHistory],
  );

  /** 移除家具（visible=false，可撤销），然后触发背景完整性检查。 */
  const removeFurniture = useCallback(() => {
    if (furnitureIds.length === 0) {
      setMessage("清单里没有 role=furniture 的对象，无需移除。");
      return;
    }
    pushHistory();
    setCheckBaseline(
      Object.fromEntries(Object.entries(draft).map(([k, t]) => [k, t.visible])),
    );
    setDraft((cur) => {
      const next = { ...cur };
      for (const objectId of furnitureIds) {
        const t = next[objectId];
        if (t) next[objectId] = { ...t, visible: false };
      }
      return next;
    });
    setFurnitureRemoved(true);
    setDirty(true);
    setCheckToken((n) => n + 1);
    setMessage("已移除家具，正在检查背景完整性…");
  }, [draft, furnitureIds, pushHistory]);

  const restoreFurniture = useCallback(() => {
    pushHistory();
    setDraft((cur) => {
      const next = { ...cur };
      for (const objectId of furnitureIds) {
        const t = next[objectId];
        if (t) next[objectId] = { ...t, visible: true };
      }
      return next;
    });
    setFurnitureRemoved(false);
    setCheckReport(null);
    setDirty(true);
    setMessage("已恢复家具。");
  }, [furnitureIds, pushHistory]);

  const onCheckResult = useCallback((report: BackgroundCheckReport) => {
    setCheckReport(report);
    setMessage(
      report.pass
        ? `背景检查通过：${report.rays} 条视线，新增露洞 0，背景命中率 ${(report.backgroundCoverage * 100).toFixed(1)}%。`
        : `背景检查未通过：新增露洞 ${report.newHoles} 条，背景命中率 ${(report.backgroundCoverage * 100).toFixed(1)}%。`,
    );
  }, []);

  const resetLayout = useCallback(() => {
    pushHistory();
    setDraft(cloneDraft(defaults));
    setDirty(true);
    setCheckReport(null);
    setFurnitureRemoved(false);
    setMessage("已恢复清单默认布局（未保存）。");
  }, [defaults, pushHistory]);

  const save = useCallback(async () => {
    if (!payload) return;
    setSaving(true);
    setMessage("");
    try {
      const body = {
        version: 1 as const,
        sceneId: payload.manifest.sceneId,
        baseSceneVersion: payload.sceneVersion,
        updatedAt: new Date().toISOString(),
        objects: draft,
      };
      const res = await fetch(`/api/reconstructions/${id}/scene/edits`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        currentVersion?: string;
        edits?: { baseSceneVersion: string };
      };
      if (res.status === 409) {
        setMessage("保存失败：场景已重新生成，请刷新页面后重试。");
        if (data.currentVersion) {
          setPayload((cur) => (cur ? { ...cur, sceneVersion: data.currentVersion as string } : cur));
        }
        return;
      }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDirty(false);
      setPayload((cur) =>
        cur
          ? {
              ...cur,
              edits: body as unknown as ScenePayload["edits"],
            }
          : cur,
      );
      setMessage("布局已保存，刷新后自动恢复。");
    } catch (e) {
      setMessage(`保存失败：${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setSaving(false);
    }
  }, [draft, id, payload]);

  const clearSaved = useCallback(async () => {
    try {
      const res = await fetch(`/api/reconstructions/${id}/scene/edits`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      pushHistory();
      setDraft(cloneDraft(defaults));
      setDirty(false);
      setCheckReport(null);
      setFurnitureRemoved(false);
      setPayload((cur) => (cur ? { ...cur, edits: null } : cur));
      setMessage("已清除保存的布局，回到清单默认位置。");
    } catch (e) {
      setMessage(`清除失败：${e instanceof Error ? e.message : "未知错误"}`);
    }
  }, [defaults, id, pushHistory]);

  // Ctrl/Cmd+Z 撤销；Esc 取消选择。输入框内不拦截。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (e.key === "Escape") {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  // 测试/验收钩子：状态快照（不含像素），供 CDP 断言撤销栈与布局。
  useEffect(() => {
    (window.__mv ??= {}).ready = Boolean(payload);
    (window.__mv ??= {}).sceneId = manifest?.sceneId ?? null;
    (window.__mv ??= {}).sceneVersion = payload?.sceneVersion ?? null;
    (window.__mv ??= {}).selectedId = selectedId;
    (window.__mv ??= {}).mode = mode;
    (window.__mv ??= {}).dirty = dirty;
    (window.__mv ??= {}).canUndo = undoDepth > 0;
    (window.__mv ??= {}).undoDepth = undoDepth;
    (window.__mv ??= {}).furnitureRemoved = furnitureRemoved;
    (window.__mv ??= {}).check = checkReport;
    (window.__mv ??= {}).objects = Object.fromEntries(
      Object.entries(draft).map(([k, t]) => [
        k,
        {
          position: t.position.map((v) => round(v)),
          quaternion: t.quaternion.map((v) => round(v)),
          scale: t.scale.map((v) => round(v)),
          visible: t.visible,
        },
      ]),
    );
  }, [checkReport, dirty, draft, furnitureRemoved, manifest, mode, payload, selectedId, undoDepth]);

  if (error) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-3 rounded-2xl text-sm text-red-300"
        style={{ height, background: "rgba(10,15,30,0.7)", border: "1px solid rgba(248,113,113,0.3)" }}
        data-testid="scene-error"
      >
        <span>场景加载失败：{error}</span>
        <button className="btn-ghost" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div
      className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_330px]"
      style={{ minHeight: height }}
      data-testid="editable-scene"
    >
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {MODES.map((m) => (
            <button
              key={m.key}
              className="btn-ghost"
              aria-pressed={mode === m.key}
              data-testid={`mode-${m.key}`}
              onClick={() => setMode(m.key)}
              style={
                mode === m.key
                  ? { borderColor: "rgba(34,211,238,0.6)", color: "#67e8f9" }
                  : undefined
              }
            >
              {m.label}
            </button>
          ))}
          <button
            className="btn-ghost"
            onClick={undo}
            disabled={undoDepth === 0}
            data-testid="undo"
            title="撤销上一步（Ctrl+Z）"
          >
            撤销
          </button>
          <span className="ml-auto text-[10px] text-slate-500">
            {selectedId ? `已选中：${objectLabel(manifest!.objects.find((o) => o.objectId === selectedId) ?? { objectId: selectedId, nodeName: "", label: "" })}` : "点击画布中的对象选中"}
          </span>
        </div>

        <div
          className="relative overflow-hidden rounded-2xl"
          style={{ height, border: "1px solid rgba(139,92,246,0.2)" }}
          data-testid="scene-canvas"
        >
          {payload ? (
            <Canvas
              shadows
              dpr={[1, 2]}
              camera={{ fov: 50, position: [1.6, 1.2, 1.8], near: 0.001, far: 200 }}
              gl={{ antialias: true, preserveDrawingBuffer: true }}
            >
              <Suspense fallback={null}>
                <SceneCanvas
                  key={payload.sceneVersion}
                  url={`/api/reconstructions/${id}/scene/glb?v=${payload.sceneVersion}`}
                  objects={payload.manifest.objects}
                  draft={draft}
                  checkBaseline={checkBaseline}
                  selectedId={selectedId}
                  mode={mode}
                  dragging={dragging}
                  checkToken={checkToken}
                  onSelect={setSelectedId}
                  onDragging={setDragging}
                  onDragStart={() => {
                    dragStartRef.current = cloneDraft(draft);
                  }}
                  onCommit={onCommit}
                  onReady={onReady}
                  onCheckResult={onCheckResult}
                />
              </Suspense>
            </Canvas>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-slate-500">
              正在加载可编辑场景…
            </div>
          )}
          <div className="pointer-events-none absolute left-3 top-3 rounded-lg bg-black/60 px-2.5 py-1 text-[10px] text-slate-300">
            点击对象选中 · 拖动坐标轴变换 · 滚轮缩放 · 右键平移 · Ctrl+Z 撤销
          </div>
        </div>
      </div>

      <aside
        className="flex flex-col gap-3 rounded-2xl p-3"
        style={{ background: "rgba(10,15,30,0.75)", border: "1px solid rgba(139,92,246,0.2)" }}
      >
        <div>
          <div className="mb-2 text-[11px] font-semibold text-slate-300">对象</div>
          <div className="flex flex-col gap-1">
            {manifest?.objects.map((o) => {
              const t = draft[o.objectId];
              const active = o.objectId === selectedId;
              const role = inferObjectRole(o);
              return (
                <div
                  key={o.objectId}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5"
                  style={{
                    background: active ? "rgba(34,211,238,0.12)" : "rgba(255,255,255,0.03)",
                    border: `1px solid ${active ? "rgba(34,211,238,0.45)" : "rgba(255,255,255,0.06)"}`,
                  }}
                >
                  <button
                    className="flex-1 text-left text-xs"
                    onClick={() => setSelectedId(o.objectId)}
                    data-testid={`select-${o.objectId}`}
                  >
                    <span className="text-slate-200">{objectLabel(o)}</span>
                    <span className="ml-2 text-[10px] text-slate-500">
                      {role === "background" ? "背景" : "家具"}
                    </span>
                  </button>
                  <button
                    className="text-[10px] text-slate-400 transition hover:text-slate-200"
                    onClick={() => toggleVisible(o.objectId)}
                    data-testid={`toggle-${o.objectId}`}
                  >
                    {t?.visible === false ? "显示" : "隐藏"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {selectedId && draft[selectedId] && (
          <div className="rounded-lg px-2 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
            <div className="mb-1 text-[10px] font-semibold text-slate-400">位置（nu）</div>
            <div className="grid grid-cols-3 gap-1">
              {(["x", "y", "z"] as const).map((axis, i) => (
                <label key={axis} className="flex flex-col gap-0.5 text-[10px] text-slate-500">
                  {axis.toUpperCase()}
                  <input
                    type="number"
                    step="0.01"
                    value={round(draft[selectedId].position[i])}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v)) return;
                      pushHistory();
                      setDraft((cur) => {
                        const t = cur[selectedId];
                        if (!t) return cur;
                        const position = [...t.position] as [number, number, number];
                        position[i] = v;
                        return { ...cur, [selectedId]: { ...t, position } };
                      });
                      setDirty(true);
                      setCheckReport(null);
                    }}
                    data-testid={`pos-${axis}`}
                  />
                </label>
              ))}
            </div>
            <div className="mt-1 text-[10px] text-slate-500">
              缩放 {draft[selectedId].scale.map(round).join(" / ")}
            </div>
          </div>
        )}

        <div>
          <div className="mb-2 text-[11px] font-semibold text-slate-300">背景检查</div>
          <div className="flex flex-col gap-1.5">
            <button
              className="btn-ghost"
              onClick={removeFurniture}
              disabled={furnitureIds.length === 0}
              data-testid="remove-furniture"
            >
              移除家具并检查背景
            </button>
            <button
              className="btn-ghost"
              onClick={restoreFurniture}
              disabled={!furnitureRemoved}
              data-testid="restore-furniture"
            >
              恢复家具
            </button>
          </div>
          {checkReport && (
            <div
              className="mt-2 rounded-lg px-2 py-2 text-[10px] leading-relaxed"
              data-testid="background-check"
              data-pass={checkReport.pass}
              style={{
                background: checkReport.pass ? "rgba(52,211,153,0.08)" : "rgba(248,113,113,0.08)",
                border: `1px solid ${checkReport.pass ? "rgba(52,211,153,0.35)" : "rgba(248,113,113,0.35)"}`,
                color: checkReport.pass ? "#6ee7b7" : "#fca5a5",
              }}
            >
              {checkReport.pass ? "通过" : "未通过"} · 视线 {checkReport.rays} ·
              新增露洞 {checkReport.newHoles} · 开放边界 {checkReport.silhouetteMisses} ·
              覆盖 {(checkReport.coverage * 100).toFixed(1)}% ·
              背景命中 {(checkReport.backgroundCoverage * 100).toFixed(1)}%
            </div>
          )}
        </div>

        <div className="mt-auto flex flex-col gap-1.5">
          <button
            className="btn-ghost"
            onClick={() => void save()}
            disabled={saving || !dirty}
            data-testid="save-layout"
          >
            {saving ? "保存中…" : dirty ? "保存布局" : "布局已保存"}
          </button>
          <div className="flex gap-1.5">
            <button className="btn-ghost flex-1" onClick={resetLayout} data-testid="reset-layout">
              重置布局
            </button>
            <button className="btn-ghost flex-1" onClick={() => void clearSaved()} data-testid="clear-saved">
              清除已保存
            </button>
          </div>
          <p className="min-h-[2.5em] text-[10px] leading-relaxed text-slate-500" data-testid="scene-message">
            {message}
          </p>
        </div>
      </aside>
    </div>
  );
}
