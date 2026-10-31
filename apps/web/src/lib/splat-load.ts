import * as THREE from "three";
import * as Spark from "@sparkjsdev/spark";

/**
 * 带进度的高斯资产加载（编辑器 SplatObject 与任务详情 SplatViewerCore 共用）。
 *
 * spark 的 url 直载模式不暴露下载进度，改为手动流式 fetch：
 * - Content-Length 可知时上报 0~100 百分比；未知时 percent=null（不确定进度）
 * - 下载完成后以 fileBytes 构建 SplatMesh（spark 本就全量解析，无额外内存峰值）
 * - onParsed 在 initialized resolve 前回调，用于切「解析中」阶段
 */

export interface SplatLoadHandlers {
  onDownload?: (percent: number | null) => void;
  onParsed?: () => void;
  signal?: AbortSignal;
}

export async function fetchSplatBytes(url: string, handlers: SplatLoadHandlers): Promise<Uint8Array> {
  const res = await fetch(url, { signal: handlers.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const totalHeader = res.headers.get("Content-Length");
  const total = totalHeader ? Number(totalHeader) : null;

  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    handlers.onDownload?.(100);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      handlers.onDownload?.(total ? Math.min(99, Math.round((received / total) * 100)) : null);
    }
  }
  handlers.onDownload?.(100);

  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function createSplatMesh(bytes: Uint8Array, handlers: SplatLoadHandlers = {}): Spark.SplatMesh {
  handlers.onParsed?.();
  const splat = new Spark.SplatMesh({
    fileBytes: bytes,
    fileName: "scene.ply",
  });
  return splat;
}

/** 真实重建 PLY（nerfstudio 归一化系）→ 编辑器 Y-up：绕 X 轴 -90°，(x,y,z)→(x,z,-y) */
export const ORIENT_COLMAP_NERFSTUDIO_Q = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);

export interface TrainingViewpoint {
  position: THREE.Vector3;
  target: THREE.Vector3;
  /** 训练相机轨道半径（数据视角带），供 360° 环绕查看 */
  orbitRadius: number;
  /** nerfstudio 点云中心（orient 后） */
  sceneCenter: THREE.Vector3;
}

export interface TrainingOrbit {
  /** 相机到场景中心距离的中位数 = 训练拍摄轨道半径；360° 环绕查看应沿此半径转（Luma/Polycam 式 orbit 视角带） */
  orbitRadius: number;
  sceneCenter: THREE.Vector3;
}

/**
 * 计算训练相机的环绕轨道（360° 查看的正确距离）。
 * 室内重建数据只在「拍摄相机所在的位置带」有可靠表现——从更远处看是空腔+离群碎片。
 */
export function trainingOrbit(
  cameras: { position: number[] }[],
  sceneCenterN: number[],
  orient: THREE.Quaternion
): TrainingOrbit | null {
  if (cameras.length === 0) return null;
  const center = new THREE.Vector3(...sceneCenterN).applyQuaternion(orient);
  const dists = cameras
    .map((c) => new THREE.Vector3(...c.position).applyQuaternion(orient).distanceTo(center))
    .sort((a, b) => a - b);
  const orbitRadius = dists[Math.floor(dists.length / 2)];
  if (!Number.isFinite(orbitRadius) || orbitRadius <= 0) return null;
  return { orbitRadius, sceneCenter: center };
}

/**
 * 训练相机取景（编辑器与任务详情查看器共用）：
 * - 选「位置典型 + 姿态水平」的相机（位置偏离全体中位数 + 俯/仰惩罚 |fwd·up|）
 * - target 落在拍摄视线前方（相机到场景中心距离处），视线沿拍摄方向、不会与 up 近平行
 *   导致 OrbitControls lookAt 退化
 * - position/fwd 均应用 orient 四元数（与高斯 mesh 同一坐标系映射）
 * 返回 null = API 不可用/无相机（调用方回退稳健取景）
 */
export async function trainingViewpoint(
  taskId: string,
  orient: THREE.Quaternion,
  signal?: AbortSignal
): Promise<TrainingViewpoint | null> {
  try {
    const res = await fetch(`/api/reconstructions/${taskId}/cameras`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      cameras: { position: number[]; forward: number[]; up: number[] }[];
      sceneCenter: number[];
    };
    if (data.cameras.length === 0) return null;

    const mids = [0, 1, 2].map((i) => {
      const arr = data.cameras.map((c) => c.position[i]).sort((a, b) => a - b);
      return arr[Math.floor(arr.length / 2)];
    });
    let best = data.cameras[0];
    let bestScore = Infinity;
    for (const c of data.cameras) {
      const dist = Math.hypot(c.position[0] - mids[0], c.position[1] - mids[1], c.position[2] - mids[2]);
      const upLen = Math.hypot(c.up[0], c.up[1], c.up[2]) || 1;
      const fwdLen = Math.hypot(c.forward[0], c.forward[1], c.forward[2]) || 1;
      const tilt = Math.abs((c.forward[0] * c.up[0] + c.forward[1] * c.up[1] + c.forward[2] * c.up[2]) / (upLen * fwdLen));
      const score = dist + 2 * tilt;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    const pos = new THREE.Vector3(...best.position).applyQuaternion(orient);
    const fwd = new THREE.Vector3(...best.forward).applyQuaternion(orient).normalize();
    const center = new THREE.Vector3(...data.sceneCenter).applyQuaternion(orient);
    const toCenter = center.clone().sub(pos);
    const d = THREE.MathUtils.clamp(toCenter.length(), 0.4, 3);
    const dists = data.cameras
      .map((c) => new THREE.Vector3(...c.position).applyQuaternion(orient).distanceTo(center))
      .sort((a, b) => a - b);
    const orbitRadius = dists[Math.floor(dists.length / 2)];
    return {
      position: pos,
      target: pos.clone().add(fwd.multiplyScalar(d)),
      orbitRadius: Number.isFinite(orbitRadius) && orbitRadius > 0 ? orbitRadius : Math.max(d, 0.5),
      sceneCenter: center,
    };
  } catch {
    return null;
  }
}

/**
 * 由 SplatMesh 建相机取景参数（不直接操作相机）。
 * 返回 null 表示无法采样（无 packedSplats / 空场景）。
 * 稳健策略：分量中位数中心 + 距离中位数 ×4 半径（离群高斯污染 bbox 的兜底，见 PROGRESS 坑 13）。
 */
export function robustFrameFromSplat(splat: Spark.SplatMesh): {
  center: THREE.Vector3;
  radius: number;
} | null {
  const N = splat.packedSplats?.numSplats ?? 0;
  if (N === 0) return null;
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
  if (xs.length === 0) return null;
  const median = (arr: number[]) => {
    const a = [...arr].sort((p, q) => p - q);
    return a[Math.floor(a.length / 2)] ?? 0;
  };
  const center = new THREE.Vector3(median(xs), median(ys), median(zs));
  const dists: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    dists.push(Math.hypot(xs[i] - center.x, ys[i] - center.y, zs[i] - center.z));
  }
  const radius = Math.max(median(dists) * 4, 1.5);
  return { center, radius };
}
