#!/usr/bin/env node
/**
 * 演示 Gaussian Splatting 场景生成器（真实 3DGS PLY 二进制格式）
 *
 * 生成一个 5×4×3 米房间外壳的高斯点云（地板/墙面/地毯/床/桌/绿植色块），
 * 与演示编辑场景共享坐标系。⚠ 这是程序生成的演示数据，用于验证 Web 端
 * 高斯加载/渲染链路，不是真实照片重建结果（页面有明确标注）。
 *
 * PLY 属性遵循 3DGS 约定：x y z nx ny nz f_dc_0..2 opacity scale_0..2 rot_0..3
 * - f_dc = (color01 - 0.5) / 0.28209479177387814（SH DC 项）
 * - opacity = logit(o)；scale = log(s)（均为激活前值）
 * - rot = (0,0,0,1) 单位四元数（DC 色对旋转不变，两种分量顺序均安全）
 *
 * 用法：node tools/generate-demo-splat.mjs
 * 输出：apps/web/public/demo/demo-room.ply + data/demo/demo-room.ply
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = [
  path.join(ROOT, "apps", "web", "public", "demo", "demo-room.ply"),
  path.join(ROOT, "data", "demo", "demo-room.ply"),
];

const SH_C0 = 0.28209479177387814;
const logit = (o) => Math.log(o / (1 - o));

class SplatWriter {
  constructor() {
    this.points = [];
  }
  /** c: [r,g,b] 0~255；s: [sx,sy,sz] 米；o: 不透明度 0~1 */
  push(x, y, z, c, s = [0.07, 0.07, 0.07], o = 0.92) {
    this.points.push({ x, y, z, c, s, o });
  }
  count() {
    return this.points.length;
  }
  toPlyBuffer() {
    const n = this.points.length;
    const props = [
      "x", "y", "z", "nx", "ny", "nz",
      "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
      "scale_0", "scale_1", "scale_2",
      "rot_0", "rot_1", "rot_2", "rot_3",
    ];
    const header =
      `ply\nformat binary_little_endian 1.0\ncomment MiniVerse demo splat (procedural, NOT a real reconstruction)\n` +
      `element vertex ${n}\n` +
      props.map((p) => `property float ${p}\n`).join("") +
      `end_header\n`;
    const headerBytes = Buffer.from(header, "ascii");
    const body = Buffer.alloc(n * 17 * 4);
    let o = 0;
    const rnd = mulberry32(42);
    for (const p of this.points) {
      const jitter = (rng, amt) => (rng() - 0.5) * amt;
      const noise = 1 + (rnd() - 0.5) * 0.12; // 颜色微噪声，避免色带
      const writeF = (v) => {
        body.writeFloatLE(v, o);
        o += 4;
      };
      writeF(p.x + jitter(rnd, 0.015));
      writeF(p.y + jitter(rnd, 0.015));
      writeF(p.z + jitter(rnd, 0.015));
      writeF(0); writeF(0); writeF(0); // 法线占位
      for (let k = 0; k < 3; k++) writeF(((p.c[k] / 255) * noise - 0.5) / SH_C0);
      writeF(logit(p.o));
      for (let k = 0; k < 3; k++) writeF(Math.log(p.s[k]));
      writeF(0); writeF(0); writeF(0); writeF(1); // rot
    }
    return Buffer.concat([headerBytes, body]);
  }
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- 场景构建：与演示编辑场景同尺寸 5×4×3m ---------- */
const W = 5, D = 4, H = 3; // x ∈ [-2.5,2.5], z ∈ [-2,2], y ∈ [0,3]
const w = new SplatWriter();
const rnd = mulberry32(7);

const FLOOR = [185, 139, 101];
const WALL = [241, 223, 201];
const WALL_L = [226, 199, 166];
const RUG = [201, 123, 90];
const BED = [232, 217, 197];
const BEDD = [124, 144, 160];
const WOOD = [150, 112, 77];
const PLANT = [94, 140, 90];

const inRug = (x, z) => x >= -1.15 && x <= 0.75 && z >= 0.25 && z <= 1.55;

// 地板（y=0，扁平高斯）
const step = 0.09;
for (let x = -W / 2 + 0.05; x < W / 2; x += step) {
  for (let z = -D / 2 + 0.05; z < D / 2; z += step) {
    const c = inRug(x, z) ? RUG : FLOOR;
    w.push(x, 0, z, c, [0.075, 0.012, 0.075], 0.95);
  }
}

// 后墙（z=-2）
for (let x = -W / 2 + 0.05; x < W / 2; x += step) {
  for (let y = 0.05; y < H; y += step) {
    w.push(x, y, -D / 2, WALL, [0.075, 0.075, 0.012], 0.9);
  }
}
// 左墙（x=-2.5）
for (let z = -D / 2 + 0.05; z < D / 2; z += step) {
  for (let y = 0.05; y < H; y += step) {
    w.push(-W / 2, y, z, WALL_L, [0.012, 0.075, 0.075], 0.9);
  }
}
// 右墙（x=2.5，稀疏、低不透明度——模拟半透明侧）
for (let z = -D / 2 + 0.1; z < D / 2; z += step * 1.5) {
  for (let y = 0.1; y < H; y += step * 1.5) {
    w.push(W / 2, y, z, WALL_L, [0.01, 0.1, 0.1], 0.55);
  }
}

// 床（-1.2, 0, -0.9）1.6×2.05，被面+床头板
for (let i = 0; i < 260; i++) {
  const x = -1.2 + (rnd() - 0.5) * 1.5;
  const z = -0.9 + (rnd() - 0.5) * 1.9;
  const blanket = z > -0.35;
  w.push(x, 0.55, z, blanket ? BEDD : BED, [0.09, 0.09, 0.09], 0.75);
}
for (let i = 0; i < 60; i++) {
  const x = -1.2 + (rnd() - 0.5) * 1.5;
  w.push(x, 0.6 + rnd() * 0.45, -1.88, WOOD, [0.07, 0.12, 0.05], 0.85);
}

// 书桌（1.4, 0, -1.45）
for (let i = 0; i < 140; i++) {
  const x = 1.4 + (rnd() - 0.5) * 1.2;
  const z = -1.45 + (rnd() - 0.5) * 0.55;
  w.push(x, 0.74, z, WOOD, [0.09, 0.03, 0.07], 0.85);
}

// 绿植（-2.0, 0, 1.5）
for (let i = 0; i < 90; i++) {
  const a = rnd() * Math.PI * 2;
  const r = rnd() * 0.22;
  w.push(-2.0 + Math.cos(a) * r, 0.35 + rnd() * 0.65, 1.5 + Math.sin(a) * r, PLANT, [0.08, 0.08, 0.08], 0.8);
}

const buf = w.toPlyBuffer();
for (const out of OUT) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
}
console.log(`✓ 演示高斯场景：${w.count()} 个高斯点，${(buf.length / 1024).toFixed(0)} KB`);
console.log(`  输出：${OUT.map((p) => path.relative(ROOT, p)).join(" , ")}`);
console.log("  ⚠ 程序生成演示数据（非真实重建），页面已明确标注");
