/**
 * 可编辑场景清单（scene-manifest v1）的共享类型。
 *
 * 服务端与客户端共用本文件，禁止引入 node:fs 等运行时依赖。
 * 坐标系：清单里的 position/quaternion/scale 都在清单声明的世界系
 * （当前 v1 = nerfstudio 归一化系，单位 nu、+Y 向上），客户端不得再自行改轴。
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface SceneTransform {
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
  visible: boolean;
}

/** 对象角色：background = 墙体/地板等背景结构，furniture = 可移除家具 */
export type SceneObjectRole = "background" | "furniture";

export interface SceneObjectInfo {
  objectId: string;
  nodeName: string;
  label: string;
  /** manifest 未声明时由客户端按 label/nodeName 推断，见 inferObjectRole */
  role?: SceneObjectRole;
  faces?: number;
  vertices?: number;
  pivot?: number[];
  worldBounds?: { min: number[]; max: number[] };
  startTransform?: SceneTransform;
  material?: { name?: string; textureSize?: number[]; doubleSided?: boolean };
  provenance?: Record<string, unknown>;
}

export interface SceneManifest {
  schema: string;
  sceneId: string;
  units?: string;
  upAxis?: string;
  asset?: { units?: string; upAxis?: string };
  assets?: Record<string, { path?: string; bytes?: number; sha256?: string }>;
  objects: SceneObjectInfo[];
  checks?: Record<string, { pass?: boolean } & Record<string, unknown>>;
  [key: string]: unknown;
}

export interface SceneEdits {
  version: 1;
  sceneId: string;
  baseSceneVersion: string;
  updatedAt: string;
  objects: Record<string, SceneTransform>;
}

export interface ScenePayload {
  manifest: SceneManifest;
  sceneVersion: string;
  /** 资产名 → sha256；客户端据此给 GLB 请求加版本参数 */
  assets: Record<string, string>;
  edits: SceneEdits | null;
  editsStale: boolean;
}

/** 移除家具后的背景完整性检查结果（相机视线采样）。 */
export interface BackgroundCheckReport {
  /** 采样视线数（画布内 N×N 网格） */
  rays: number;
  /** 移除前命中任意可见几何的视线数 */
  baselineHits: number;
  /** 移除后命中任意可见几何的视线数 */
  afterHits: number;
  /** 移除后直接命中背景对象（role=background）的视线数 */
  backgroundHits: number;
  /** 移除前有几何、移除后什么都没有、且四周被背景包围的视线数 = 真正的新洞 */
  newHoles: number;
  /**
   * 移除前有几何、移除后没有、但邻居也大多没有的视线数。
   * 这些是房间开放边界/天空（扫描本身没覆盖的区域），不是「家具背后的洞」。
   */
  silhouetteMisses: number;
  /** afterHits / rays */
  coverage: number;
  /** backgroundHits / afterHits */
  backgroundCoverage: number;
  pass: boolean;
  checkedAt: string;
}

/** 三维向量的有限数值校验（客户端用于拒绝 manifest 里的 NaN/Infinity）。 */
export function isFiniteVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

export function isFiniteQuat(v: unknown): v is Quat {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

const BACKGROUND_HINTS = ["wall", "floor", "ceiling", "room", "background", "墙", "地板", "天花"];

/** v1 清单主键为 role；老清单/手写 fixture 缺失时按 label/nodeName 兜底。 */
export function inferObjectRole(o: Pick<SceneObjectInfo, "role" | "label" | "nodeName" | "objectId">): SceneObjectRole {
  if (o.role === "background" || o.role === "furniture") return o.role;
  const text = `${o.objectId} ${o.nodeName} ${o.label}`.toLowerCase();
  return BACKGROUND_HINTS.some((h) => text.includes(h)) ? "background" : "furniture";
}
