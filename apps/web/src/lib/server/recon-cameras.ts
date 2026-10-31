import fs from "node:fs";
import path from "node:path";
import { processedDir } from "./paths";

/**
 * 训练相机位姿导出（P1 取景闭环的数据侧）。
 *
 * Splatfacto 训练后的高斯位于 nerfstudio 归一化坐标系：
 *   pos_ns = T(3x4) @ (scale * pos_opengl)，旋转同理（标量 scale 不改变朝向）
 * 其中 pos_opengl 为 COLMAP OpenCV c2w 经「翻转 y/z 列」后的 OpenGL 惯例位姿。
 *
 * 公式已用样例任务 f1014582（104 张照片）实证：60 台配准相机解析后
 * 相机→点云中心距离 0.47~1.12（环绕分布），52/60 台 forward 指向场景中心（cos>0.5）。
 */

export interface TrainingCamera {
  /** COLMAP 记录的图像文件名 */
  name: string;
  /** nerfstudio 世界系下的相机位置 */
  position: [number, number, number];
  /** nerfstudio 世界系下的视线方向（单位化，OpenGL -Z） */
  forward: [number, number, number];
  /** nerfstudio 世界系下的相机 up 方向（单位化，OpenGL +Y），供前端还原拍摄滚转角 */
  up: [number, number, number];
}

export interface TrainingCameras {
  count: number;
  /** 高斯主体中心（COLMAP 点云经同一变换后的分量中位数），供取景 target 用 */
  sceneCenter: [number, number, number];
  cameras: TrainingCamera[];
}

export class CamerasUnavailableError extends Error {}

/** COLMAP qvec(w,x,y,z, world-to-camera) → 3x3 旋转矩阵 */
function qvec2rotmat(q: [number, number, number, number]): number[][] {
  const [w, x, y, z] = q;
  return [
    [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
    [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w],
    [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y],
  ];
}

function median(arr: number[]): number {
  const a = [...arr].sort((p, q) => p - q);
  return a[Math.floor(a.length / 2)] ?? 0;
}

interface RawImage {
  name: string;
  q: [number, number, number, number];
  t: [number, number, number];
}

/**
 * 解析 COLMAP images.bin。
 * 布局：u64 记录数 + 逐条 [u32 imageId, 7×f64 qvec(wxyz)+tvec, u32 cameraId,
 * 以 \0 结尾的文件名, u64 points2D 数, points2D×(f64 x, f64 y, i64 point3D_id)]
 */
export function parseColmapImagesBin(buf: Buffer): RawImage[] {
  if (buf.byteLength < 8) throw new CamerasUnavailableError("images.bin 过小，结构不合法");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const total = Number(dv.getBigUint64(o, true));
  o += 8;
  if (total > 100000) throw new CamerasUnavailableError(`images.bin 记录数异常: ${total}`);
  const imgs: RawImage[] = [];
  while (o < buf.byteLength && imgs.length < total) {
    o += 4; // imageId（无需使用）
    const q = [dv.getFloat64(o, true), dv.getFloat64(o + 8, true), dv.getFloat64(o + 16, true), dv.getFloat64(o + 24, true)] as [number, number, number, number];
    o += 32;
    const t = [dv.getFloat64(o, true), dv.getFloat64(o + 8, true), dv.getFloat64(o + 16, true)] as [number, number, number];
    o += 24;
    o += 4; // cameraId
    let end = o;
    while (end < buf.byteLength && buf[end] !== 0) end++;
    if (end >= buf.byteLength) throw new CamerasUnavailableError("images.bin 文件名截断");
    const name = buf.toString("utf8", o, end);
    o = end + 1;
    const n2d = Number(dv.getBigUint64(o, true));
    o += 8 + n2d * 24;
    imgs.push({ name, q, t });
  }
  if (imgs.length !== total) throw new CamerasUnavailableError(`images.bin 记录不完整 (${imgs.length}/${total})`);
  return imgs;
}

/** 解析 COLMAP points3D.bin，采样返回位置数组（上限 maxPoints，均匀跳采样） */
export function parseColmapPointsBin(buf: Buffer, maxPoints = 60000): number[][] {
  if (buf.byteLength < 8) return [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const total = Number(dv.getBigUint64(o, true));
  o += 8;
  if (total > 50000000) return [];
  const step = Math.max(1, Math.ceil(total / maxPoints));
  const pts: number[][] = [];
  let i = 0;
  while (o < buf.byteLength && i < total) {
    o += 8; // point3D_id
    const x = dv.getFloat64(o, true);
    const y = dv.getFloat64(o + 8, true);
    const z = dv.getFloat64(o + 16, true);
    o += 24 + 3 + 8; // xyz + rgb + error
    const trackLen = Number(dv.getBigUint64(o, true));
    o += 8 + trackLen * 8;
    if (i % step === 0) pts.push([x, y, z]);
    i++;
  }
  return pts;
}

/**
 * 从任务产物目录读取训练相机位姿（nerfstudio 世界系）。
 * 缺 dataparser_transforms.json / images.bin / 解析失败一律抛 CamerasUnavailableError，
 * 调用方（API 层）转 404，前端回退到高斯中位数稳健取景。
 */
export function loadTrainingCameras(taskId: string): TrainingCameras {
  const base = processedDir(taskId);
  const transformPath = path.join(base, "nerfstudio", "unnamed", "splatfacto", "run", "dataparser_transforms.json");
  const imagesPath = path.join(base, "colmap", "sparse", "0", "images.bin");
  const pointsPath = path.join(base, "colmap", "sparse", "0", "points3D.bin");
  for (const p of [transformPath, imagesPath]) {
    if (!fs.existsSync(p)) throw new CamerasUnavailableError(`产物缺失: ${path.basename(p)}`);
  }

  let transform: number[][];
  let scale: number;
  try {
    const meta = JSON.parse(fs.readFileSync(transformPath, "utf8")) as { transform: number[][]; scale: number };
    transform = meta.transform;
    scale = meta.scale;
  } catch {
    throw new CamerasUnavailableError("dataparser_transforms.json 解析失败");
  }
  if (!Array.isArray(transform) || transform.length !== 3 || transform.some((r) => !Array.isArray(r) || r.length !== 4)) {
    throw new CamerasUnavailableError("dataparser_transforms.json 结构不合法");
  }

  const apply = (p: [number, number, number]): [number, number, number] => [
    transform[0][0] * p[0] + transform[0][1] * p[1] + transform[0][2] * p[2] + transform[0][3],
    transform[1][0] * p[0] + transform[1][1] * p[1] + transform[1][2] * p[2] + transform[1][3],
    transform[2][0] * p[0] + transform[2][1] * p[1] + transform[2][2] * p[2] + transform[2][3],
  ];

  let images: RawImage[];
  try {
    images = parseColmapImagesBin(fs.readFileSync(imagesPath));
  } catch (e) {
    if (e instanceof CamerasUnavailableError) throw e;
    throw new CamerasUnavailableError("images.bin 解析失败");
  }

  const cameras: TrainingCamera[] = images.map((im) => {
    const R = qvec2rotmat(im.q); // world-to-camera (OpenCV)
    // c2w 旋转 = R^T；OpenGL 惯例翻转 y、z 列；再左乘 nerfstudio transform（旋转部分）
    const r00 = R[0][0], r01 = R[1][0], r02 = R[2][0];
    const r10 = R[0][1], r11 = R[1][1], r12 = R[2][1];
    const r20 = R[0][2], r21 = R[1][2], r22 = R[2][2];
    // R_gl = R^T · diag(1,-1,-1)
    const g = [
      [r00, -r01, -r02],
      [r10, -r11, -r12],
      [r20, -r21, -r22],
    ];
    // 位置：center = -R^T·t（与惯例无关），scale 后变换（r 矩阵即 R^T，按行点积 t）
    const c: [number, number, number] = [
      -(r00 * im.t[0] + r01 * im.t[1] + r02 * im.t[2]),
      -(r10 * im.t[0] + r11 * im.t[1] + r12 * im.t[2]),
      -(r20 * im.t[0] + r21 * im.t[1] + r22 * im.t[2]),
    ];
    const pos = apply([c[0] * scale, c[1] * scale, c[2] * scale]);
    // OpenGL 相机基（经 R^T·diag(1,-1,-1)）：forward=-第三列、up=第二列；再左乘 nerfstudio 旋转
    const rotate = (v: [number, number, number]): [number, number, number] => [
      transform[0][0] * v[0] + transform[0][1] * v[1] + transform[0][2] * v[2],
      transform[1][0] * v[0] + transform[1][1] * v[1] + transform[1][2] * v[2],
      transform[2][0] * v[0] + transform[2][1] * v[1] + transform[2][2] * v[2],
    ];
    const normalize = (v: [number, number, number]): [number, number, number] => {
      const n = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / n, v[1] / n, v[2] / n];
    };
    const fwd = normalize(rotate([-g[0][2], -g[1][2], -g[2][2]]));
    const upv = normalize(rotate([g[0][1], g[1][1], g[2][1]]));
    return { name: im.name, position: pos, forward: fwd, up: upv };
  });

  // 场景中心：COLMAP 点云经同一变换后的分量中位数（与前端高斯中位数取景同一思路）
  let sceneCenter: [number, number, number] = [0, 0, 0];
  try {
    const pts = parseColmapPointsBin(fs.readFileSync(pointsPath)).map((p) => apply([p[0] * scale, p[1] * scale, p[2] * scale] as [number, number, number]));
    if (pts.length > 0) {
      sceneCenter = [median(pts.map((p) => p[0])), median(pts.map((p) => p[1])), median(pts.map((p) => p[2]))];
    }
  } catch {
    // points3D 缺失不阻塞：取景 target 退化为相机位置中位数
  }

  return { count: cameras.length, sceneCenter, cameras };
}
