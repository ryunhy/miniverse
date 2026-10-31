import { describe, expect, it, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseColmapImagesBin,
  parseColmapPointsBin,
  loadTrainingCameras,
  CamerasUnavailableError,
  type TrainingCameras,
} from "./recon-cameras";

/** 构造合成 images.bin：n 条记录，恒等旋转（q=wxyz 1,0,0,0）、任意平移 t、k 个 points2D */
function buildImagesBin(records: { name: string; t: [number, number, number]; n2d?: number }[]): Buffer {
  const parts: Buffer[] = [];
  const count = Buffer.alloc(8);
  count.writeBigUInt64LE(BigInt(records.length));
  parts.push(count);
  for (const [i, r] of records.entries()) {
    const head = Buffer.alloc(4 + 7 * 8 + 4); // imageId + qvec(wxyz)+tvec(xyz) + cameraId
    head.writeUInt32LE(i + 1, 0);
    head.writeDoubleLE(1, 4); // q.w
    head.writeDoubleLE(0, 12); // q.x
    head.writeDoubleLE(0, 20); // q.y
    head.writeDoubleLE(0, 28); // q.z
    head.writeDoubleLE(r.t[0], 36);
    head.writeDoubleLE(r.t[1], 44);
    head.writeDoubleLE(r.t[2], 52);
    head.writeUInt32LE(1, 60); // cameraId
    parts.push(head);
    parts.push(Buffer.concat([Buffer.from(r.name, "utf8"), Buffer.from([0])]));
    const n2d = Buffer.alloc(8);
    n2d.writeBigUInt64LE(BigInt(r.n2d ?? 0));
    parts.push(n2d);
    for (let k = 0; k < (r.n2d ?? 0); k++) {
      const p2d = Buffer.alloc(24);
      p2d.writeDoubleLE(0.5, 0);
      p2d.writeDoubleLE(0.5, 8);
      p2d.writeBigInt64LE(BigInt(-1), 16);
      parts.push(p2d);
    }
  }
  return Buffer.concat(parts);
}

/** 构造合成 points3D.bin：trackLen=0 的最简记录 */
function buildPointsBin(points: [number, number, number][]): Buffer {
  const parts: Buffer[] = [];
  const count = Buffer.alloc(8);
  count.writeBigUInt64LE(BigInt(points.length));
  parts.push(count);
  for (const [i, p] of points.entries()) {
    const rec = Buffer.alloc(8 + 24 + 3 + 8 + 8);
    rec.writeBigUInt64LE(BigInt(i + 1), 0);
    rec.writeDoubleLE(p[0], 8);
    rec.writeDoubleLE(p[1], 16);
    rec.writeDoubleLE(p[2], 24);
    rec.writeBigUInt64LE(BigInt(0), 8 + 24 + 3 + 8); // trackLen
    parts.push(rec);
  }
  return Buffer.concat(parts);
}

const TRANSFORM_IDENTITY = {
  transform: [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ],
  scale: 1,
};

let tmp: string;
let origEnv: string | undefined;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mv-cams-"));
  origEnv = process.env.MINIVERSE_DATA_DIR;
  process.env.MINIVERSE_DATA_DIR = tmp;
});

afterAll(() => {
  if (origEnv === undefined) delete process.env.MINIVERSE_DATA_DIR;
  else process.env.MINIVERSE_DATA_DIR = origEnv;
  for (const fn of cleanups.splice(0)) fn();
});

function writeTaskFixtures(taskId: string, opts: { images: Buffer; points?: Buffer; transform?: object }) {
  const sparse = path.join(tmp, "processed", taskId, "colmap", "sparse", "0");
  const run = path.join(tmp, "processed", taskId, "nerfstudio", "unnamed", "splatfacto", "run");
  fs.mkdirSync(sparse, { recursive: true });
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(sparse, "images.bin"), opts.images);
  if (opts.points) fs.writeFileSync(path.join(sparse, "points3D.bin"), opts.points);
  fs.writeFileSync(
    path.join(run, "dataparser_transforms.json"),
    JSON.stringify(opts.transform ?? TRANSFORM_IDENTITY)
  );
  cleanups.push(() => fs.rmSync(path.join(tmp, "processed", taskId), { recursive: true, force: true }));
}

describe("parseColmapImagesBin", () => {
  it("解析记录数、文件名与平移向量，跳过 points2D 块", () => {
    const buf = buildImagesBin([
      { name: "0001.jpg", t: [1, -2, 3], n2d: 2 },
      { name: "0002.jpg", t: [0, 0, 0] },
    ]);
    const imgs = parseColmapImagesBin(buf);
    expect(imgs).toHaveLength(2);
    expect(imgs[0].name).toBe("0001.jpg");
    expect(imgs[0].t).toEqual([1, -2, 3]);
    expect(imgs[1].name).toBe("0002.jpg");
  });

  it("记录数头与实际不符时抛 CamerasUnavailableError", () => {
    const buf = buildImagesBin([{ name: "a.jpg", t: [0, 0, 0] }]);
    // 头部改成 2 但只有 1 条记录
    buf.writeBigUInt64LE(BigInt(2), 0);
    expect(() => parseColmapImagesBin(buf)).toThrow(CamerasUnavailableError);
  });
});

describe("parseColmapPointsBin", () => {
  it("解析点位并正确跳过 track 块", () => {
    const buf = buildPointsBin([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    const pts = parseColmapPointsBin(buf);
    expect(pts).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });
});

describe("loadTrainingCameras", () => {
  const TASK = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  it("恒等变换下 pos=-t、forward 来自恒等旋转的 -Z", () => {
    writeTaskFixtures(TASK, {
      images: buildImagesBin([{ name: "cam.jpg", t: [0.5, 0, -1] }]),
      points: buildPointsBin([
        [1, 1, 1],
        [-1, -1, -1],
        [0.5, 0.5, 0.5],
      ]),
    });
    const d: TrainingCameras = loadTrainingCameras(TASK);
    expect(d.count).toBe(1);
    expect(d.cameras[0].position).toEqual([-0.5, 0, 1]);
    // 恒定旋转 → OpenGL forward = -第三列(R_gl) = -(0,0,-1) = +Z
    expect(d.cameras[0].forward.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 1]);
    // 三点中位数中心 = (0.5,0.5,0.5)
    expect(d.sceneCenter).toEqual([0.5, 0.5, 0.5]);
  });

  it("scale 与 transform 平移按先 scale 后 transform 顺序应用", () => {
    writeTaskFixtures(TASK, {
      images: buildImagesBin([{ name: "c.jpg", t: [1, 0, 0] }]),
      transform: {
        transform: [
          [1, 0, 0, 10],
          [0, 1, 0, 0],
          [0, 0, 1, 0],
        ],
        scale: 2,
      },
    });
    const d = loadTrainingCameras(TASK);
    // c = -t = (-1,0,0)，scale → (-2,0,0)，transform 平移 → (8,0,0)
    expect(d.cameras[0].position).toEqual([8, 0, 0]);
  });

  it("缺 dataparser_transforms.json 抛 CamerasUnavailableError", () => {
    const sparse = path.join(tmp, "processed", TASK, "colmap", "sparse", "0");
    fs.mkdirSync(sparse, { recursive: true });
    fs.writeFileSync(path.join(sparse, "images.bin"), buildImagesBin([]));
    cleanups.push(() => fs.rmSync(path.join(tmp, "processed", TASK), { recursive: true, force: true }));
    expect(() => loadTrainingCameras(TASK)).toThrow(CamerasUnavailableError);
  });

  it("points3D 缺失时 sceneCenter 退化为原点但不阻塞相机解析", () => {
    writeTaskFixtures(TASK, {
      images: buildImagesBin([{ name: "c.jpg", t: [0, 0, 0] }]),
    });
    const d = loadTrainingCameras(TASK);
    expect(d.count).toBe(1);
    expect(d.sceneCenter).toEqual([0, 0, 0]);
  });
});
