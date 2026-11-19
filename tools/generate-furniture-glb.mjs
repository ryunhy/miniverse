#!/usr/bin/env node
/**
 * 程序化家具 GLB 生成器
 * 生成真实的 glTF 2.0 二进制文件（盒子组合建模，底部中心原点、Y 向上、米制尺寸），
 * 由 apps/web 通过 GLTFLoader 加载。产物为程序化模型（非美术素材），UI 端有明确标注。
 *
 * 同时为每件家具渲染预览图（软件光栅化同一套盒子几何，正交相机 + 平面着色），
 * 输出 PNG 到 previews/ 子目录，供素材库缩略图按 assetId 约定引用：
 *   /assets/furniture/previews/<assetId>.png
 * 预览图与 GLB 来自同一份几何定义，不是外部素材、不是占位图标。
 *
 * 用法：node tools/generate-furniture-glb.mjs
 * 输出：apps/web/public/assets/furniture/*.glb + previews/*.png
 *       assets/furniture/（源备份，含 previews/）
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIRS = [
  path.join(ROOT, "apps", "web", "public", "assets", "furniture"),
  path.join(ROOT, "assets", "furniture"),
];

/* ---------- 颜色：sRGB hex → glTF 线性 ---------- */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function hexToLinearFactor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [
    srgbToLinear(((n >> 16) & 255) / 255),
    srgbToLinear(((n >> 8) & 255) / 255),
    srgbToLinear((n & 255) / 255),
    1.0,
  ];
}

/* ---------- 盒子几何（中心点 + 尺寸） ---------- */
function makeBox(cx, cy, cz, w, h, d) {
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const y0 = cy - h / 2, y1 = cy + h / 2;
  const z0 = cz - d / 2, z1 = cz + d / 2;
  const positions = new Float32Array([
    // 每面 4 顶点，法线朝外
    // +X
    x1,y0,z1, x1,y0,z0, x1,y1,z0, x1,y1,z1,
    // -X
    x0,y0,z0, x0,y0,z1, x0,y1,z1, x0,y1,z0,
    // +Y
    x0,y1,z1, x1,y1,z1, x1,y1,z0, x0,y1,z0,
    // -Y
    x0,y0,z0, x1,y0,z0, x1,y0,z1, x0,y0,z1,
    // +Z
    x0,y0,z1, x1,y0,z1, x1,y1,z1, x0,y1,z1,
    // -Z
    x1,y0,z0, x0,y0,z0, x0,y1,z0, x1,y1,z0,
  ]);
  const normals = new Float32Array([
    1,0,0, 1,0,0, 1,0,0, 1,0,0,
    -1,0,0, -1,0,0, -1,0,0, -1,0,0,
    0,1,0, 0,1,0, 0,1,0, 0,1,0,
    0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0,
    0,0,1, 0,0,1, 0,0,1, 0,0,1,
    0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1,
  ]);
  const indices = new Uint16Array([
    0,1,2, 0,2,3, 4,5,6, 4,6,7, 8,9,10, 8,10,11,
    12,13,14, 12,14,15, 16,17,18, 16,18,19, 20,21,22, 20,22,23,
  ]);
  return { positions, normals, indices };
}

/* ---------- 家具定义：[cx, cy, cz, w, h, d, color] ---------- */
const T = 0.05; // 板厚参考

function legs(positions, lx, ly, lz, w, h, d, color, out) {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    out.push([positions[0] + sx * lx, ly, positions[2] + sz * lz, w, h, d, color]);
  }
}

const FURNITURE = {
  bed_single: () => [
    [0, 0.175, 0.025, 1.1, 0.35, 2.0, "#8a6a4f"],
    [0, 0.4, 0.05, 1.0, 0.2, 1.9, "#e8e2d4"],
    [0, 0.55, -0.72, 0.55, 0.12, 0.35, "#f5f1e8"],
    [0, 0.52, 0.35, 1.02, 0.1, 1.1, "#7c90a0"],
    [0, 0.55, -1.0, 1.1, 1.1, 0.08, "#8a6a4f"],
  ],
  bed_double: () => [
    [0, 0.175, 0.025, 1.6, 0.35, 2.0, "#8a6a4f"],
    [0, 0.4, 0.05, 1.5, 0.2, 1.9, "#e8e2d4"],
    [-0.35, 0.55, -0.72, 0.6, 0.12, 0.35, "#f5f1e8"],
    [0.35, 0.55, -0.72, 0.6, 0.12, 0.35, "#f5f1e8"],
    [0, 0.52, 0.35, 1.52, 0.1, 1.1, "#7c90a0"],
    [0, 0.55, -1.0, 1.6, 1.1, 0.08, "#8a6a4f"],
  ],
  desk: () => {
    const parts = [[0, 0.72, 0, 1.3, 0.06, 0.65, "#a87953"]];
    legs([0, 0, 0], 0.6, 0.34, 0.27, 0.06, 0.68, 0.06, "#7a5a40", parts);
    return parts;
  },
  chair: () => {
    const parts = [
      [0, 0.45, 0, 0.45, 0.06, 0.45, "#96704d"],
      [0, 0.72, -0.2, 0.45, 0.5, 0.06, "#96704d"],
    ];
    legs([0, 0, 0], 0.18, 0.21, 0.18, 0.05, 0.42, 0.05, "#7a5a40", parts);
    return parts;
  },
  sofa: () => [
    [0, 0.25, 0.02, 1.8, 0.35, 0.8, "#7c90a0"],
    [0, 0.62, -0.36, 1.8, 0.5, 0.18, "#6b8294"],
    [-0.82, 0.52, 0.02, 0.16, 0.32, 0.8, "#6b8294"],
    [0.82, 0.52, 0.02, 0.16, 0.32, 0.8, "#6b8294"],
    [0, 0.46, 0.1, 1.48, 0.14, 0.55, "#8ba3b4"],
  ],
  coffee_table: () => {
    const parts = [[0, 0.38, 0, 0.9, 0.05, 0.55, "#96704d"]];
    legs([0, 0, 0], 0.38, 0.18, 0.22, 0.05, 0.36, 0.05, "#7a5a40", parts);
    return parts;
  },
  tv_cabinet: () => [
    [0, 0.22, 0, 1.6, 0.4, 0.4, "#5c4a38"],
    [0, 0.44, 0, 1.62, 0.03, 0.42, "#4a3a2c"],
    [-0.4, 0.22, 0.21, 0.7, 0.3, 0.02, "#3d2f24"],
    [0.4, 0.22, 0.21, 0.7, 0.3, 0.02, "#3d2f24"],
  ],
  bookshelf: () => {
    const parts = [
      [-0.42, 0.9, 0, 0.06, 1.8, 0.3, "#96704d"],
      [0.42, 0.9, 0, 0.06, 1.8, 0.3, "#96704d"],
      [0, 0.9, -0.14, 0.9, 1.8, 0.04, "#7a5a40"],
    ];
    for (let i = 0; i <= 4; i++) parts.push([0, 0.04 + i * 0.43, 0, 0.78, 0.04, 0.28, "#96704d"]);
    return parts;
  },
  wardrobe: () => [
    [0, 1.0, 0, 1.2, 2.0, 0.6, "#c89b71"],
    [0, 0.03, 0, 1.14, 0.06, 0.54, "#8a6a4f"],
    [-0.08, 1.0, 0.31, 0.03, 0.16, 0.03, "#555555"],
    [0.08, 1.0, 0.31, 0.03, 0.16, 0.03, "#555555"],
    [0, 1.0, 0.305, 0.012, 1.8, 0.01, "#8a6a4f"],
  ],
  dresser: () => {
    const parts = [[0, 0.45, 0, 0.8, 0.9, 0.45, "#c89b71"]];
    for (const y of [0.22, 0.45, 0.68]) {
      parts.push([0, y, 0.228, 0.7, 0.015, 0.012, "#8a6a4f"]);
      parts.push([0, y + 0.09, 0.235, 0.16, 0.025, 0.02, "#555555"]);
    }
    return parts;
  },
  nightstand: () => {
    const parts = [
      [0, 0.27, 0, 0.45, 0.54, 0.4, "#c89b71"],
      [0, 0.555, 0, 0.47, 0.03, 0.42, "#8a6a4f"],
    ];
    for (const y of [0.18, 0.38]) {
      parts.push([0, y, 0.203, 0.37, 0.012, 0.01, "#8a6a4f"]);
      parts.push([0, y + 0.06, 0.21, 0.12, 0.02, 0.02, "#555555"]);
    }
    return parts;
  },
  rug: () => [
    [0, 0.012, 0, 1.8, 0.024, 1.2, "#c97b5a"],
    [0, 0.026, 0, 1.45, 0.006, 0.88, "#d9a184"],
  ],
  plant: () => [
    [0, 0.16, 0, 0.3, 0.32, 0.3, "#a9603f"],
    [0, 0.33, 0, 0.26, 0.02, 0.26, "#4a3428"],
    [0, 0.66, 0, 0.4, 0.62, 0.4, "#5e8c5a"],
    [0, 0.97, 0, 0.24, 0.26, 0.24, "#6da26a"],
  ],
  floor_lamp: () => [
    [0, 0.025, 0, 0.3, 0.05, 0.3, "#4a4a4a"],
    [0, 0.78, 0, 0.045, 1.5, 0.045, "#9a9a9a"],
    [0, 1.4, 0, 0.3, 0.26, 0.3, "#d9c9a3"],
  ],
};

/* ---------- glTF 组装 ---------- */
function buildGlb(parts) {
  const geometries = parts.map(([cx, cy, cz, w, h, d]) => makeBox(cx, cy, cz, w, h, d));
  const materials = parts.map((p) => p[6]);
  const uniqueColors = [...new Set(materials)];
  const materialIndex = materials.map((c) => uniqueColors.indexOf(c));

  // buffer 拼装（每个 accessor 独立 bufferView，4 字节对齐）
  const buffers = [];
  const bufferViews = [];
  const accessors = [];
  let byteOffset = 0;

  function addView(typedArray, target) {
    const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    const viewIndex = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, target });
    buffers.push(bytes, new Uint8Array(pad));
    byteOffset += bytes.length + pad;
    return viewIndex;
  }

  function addVec3Accessor(arr, hasMinMax) {
    const view = addView(arr, undefined);
    const acc = { bufferView: view, componentType: 5126, count: arr.length / 3, type: "VEC3" };
    if (hasMinMax) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < arr.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (arr[i + k] < min[k]) min[k] = arr[i + k];
          if (arr[i + k] > max[k]) max[k] = arr[i + k];
        }
      }
      acc.min = min;
      acc.max = max;
    }
    const idx = accessors.length;
    accessors.push(acc);
    return idx;
  }

  function addIndexAccessor(arr) {
    const view = addView(arr, undefined);
    const idx = accessors.length;
    accessors.push({ bufferView: view, componentType: 5123, count: arr.length, type: "SCALAR" });
    return idx;
  }

  const primitives = geometries.map((g, i) => ({
    attributes: { POSITION: addVec3Accessor(g.positions, true), NORMAL: addVec3Accessor(g.normals, false) },
    indices: addIndexAccessor(g.indices),
    material: materialIndex[i],
  }));

  const binLength = byteOffset;
  const gltf = {
    asset: { version: "2.0", generator: "MiniVerse procedural furniture generator" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "furniture" }],
    meshes: [{ primitives }],
    materials: uniqueColors.map((c) => ({
      pbrMetallicRoughness: { baseColorFactor: hexToLinearFactor(c), metallicFactor: 0.0, roughnessFactor: 0.8 },
      doubleSided: false,
    })),
    bufferViews,
    accessors,
    buffers: [{ byteLength: binLength }],
  };

  const jsonText = JSON.stringify(gltf);
  const jsonBytes = new TextEncoder().encode(jsonText);
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const totalLength = 12 + 8 + jsonBytes.length + jsonPad + 8 + binLength;

  const glb = Buffer.alloc(totalLength);
  let o = 0;
  glb.writeUInt32LE(0x46546c67, o); o += 4; // glTF
  glb.writeUInt32LE(2, o); o += 4;
  glb.writeUInt32LE(totalLength, o); o += 4;
  glb.writeUInt32LE(jsonBytes.length + jsonPad, o); o += 4;
  glb.writeUInt32LE(0x4e4f534a, o); o += 4; // JSON
  Buffer.from(jsonBytes).copy(glb, o);
  for (let i = 0; i < jsonPad; i++) glb[o + jsonBytes.length + i] = 0x20;
  o += jsonBytes.length + jsonPad;
  glb.writeUInt32LE(binLength, o); o += 4;
  glb.writeUInt32LE(0x004e4942, o); o += 4; // BIN
  for (const chunk of buffers) {
    Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(glb, o);
    o += chunk.byteLength;
  }
  return glb;
}

/* ---------- 预览图：软件光栅化（与 GLB 同一套盒子几何） ----------
 * 正交相机 + 画家算法 + 平面着色，2x 超采样后降采样抗锯齿。
 * 不引入任何新依赖：PNG 用 node:zlib 手工编码（RGBA8）。
 */
const PREVIEW_SIZE = 128; // 输出边长（px）
const SS = 2; // 超采样倍率

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function boxFaces([cx, cy, cz, w, h, d, color]) {
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const y0 = cy - h / 2, y1 = cy + h / 2;
  const z0 = cz - d / 2, z1 = cz + d / 2;
  // 每个面：4 顶点（逆时针）+ 外法线
  return [
    { n: [1, 0, 0], v: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]] },
    { n: [-1, 0, 0], v: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
    { n: [0, 1, 0], v: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]] },
    { n: [0, -1, 0], v: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
    { n: [0, 0, 1], v: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
    { n: [0, 0, -1], v: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]] },
  ].map((f) => ({ ...f, color }));
}

function renderPreview(parts, size = PREVIEW_SIZE) {
  const S = size * SS;
  const buf = new Float64Array(S * S * 4); // 预乘 RGBA 累积

  // 相机：从右前上方看（Y 向上），正交投影
  const zaxis = norm([1.3, 0.95, 1.7]); // 指向相机
  const xaxis = norm(cross([0, 1, 0], zaxis));
  const yaxis = cross(zaxis, xaxis);
  const light = norm([0.45, 0.85, 0.5]);

  const faces = parts.flatMap(boxFaces);
  // 投影所有顶点，求 2D 包围盒以自适应居中缩放
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  const proj = faces.map((f) => {
    const p = f.v.map((p3) => [dot(p3, xaxis), dot(p3, yaxis), dot(p3, zaxis)]);
    for (const [u, v] of p) {
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    return { ...f, p };
  });
  const scale = (0.78 * S) / Math.max(maxU - minU, maxV - minV);
  const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
  const toPx = ([u, v]) => [S / 2 + (u - cu) * scale, S / 2 - (v - cv) * scale];

  // 画家算法：远面先画（深度 = 沿 zaxis 投影，越大越靠近相机）
  const visible = proj
    .filter((f) => dot(f.n, zaxis) > 1e-6)
    .map((f) => ({ ...f, depth: f.p.reduce((s, p) => s + p[2], 0) / 4 }))
    .sort((a, b) => a.depth - b.depth);

  function fillTri(t0, t1, t2, rgb) {
    const xs = [t0[0], t1[0], t2[0]], ys = [t0[1], t1[1], t2[1]];
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const x1 = Math.min(S - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(S - 1, Math.ceil(Math.max(...ys)));
    const [ax, ay] = t0, [bx, by] = t1, [cx2, cy2] = t2;
    const denom = (by - cy2) * (ax - cx2) + (cx2 - bx) * (ay - cy2);
    if (Math.abs(denom) < 1e-9) return;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((by - cy2) * (px - cx2) + (cx2 - bx) * (py - cy2)) / denom;
        const w1 = ((cy2 - ay) * (px - cx2) + (ax - cx2) * (py - cy2)) / denom;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const i = (y * S + x) * 4;
        buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = 1;
      }
    }
  }

  for (const f of visible) {
    const n = f.n;
    const shade = 0.38 + 0.62 * Math.max(0, dot(n, light));
    const hex = parseInt(f.color.slice(1), 16);
    const rgb = [((hex >> 16) & 255) * shade, ((hex >> 8) & 255) * shade, (hex & 255) * shade];
    const q = f.p.map(toPx);
    fillTri(q[0], q[1], q[2], rgb);
    fillTri(q[0], q[2], q[3], rgb);
  }

  // 降采样（预乘平均 → 直通 RGBA）
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * S + x * SS + dx) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      const alpha = a / n;
      out[o] = alpha > 0 ? Math.round(r / a) : 0;
      out[o + 1] = alpha > 0 ? Math.round(g / a) : 0;
      out[o + 2] = alpha > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(out, size, size);
}

/* ---------- PNG 编码（RGBA8，无滤镜，zlib deflate） ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- 主流程 ---------- */
let count = 0;
let previewBytes = 0;
for (const [name, def] of Object.entries(FURNITURE)) {
  const parts = def();
  const glb = buildGlb(parts);
  const png = renderPreview(parts);
  previewBytes += png.length;
  for (const dir of OUT_DIRS) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.glb`), glb);
    const pdir = path.join(dir, "previews");
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, `${name}.png`), png);
  }
  count++;
  console.log(`✓ ${name}.glb (${(glb.length / 1024).toFixed(1)} KB) + previews/${name}.png (${(png.length / 1024).toFixed(1)} KB)`);
}
console.log(`完成：${count} 个程序化 GLB 家具 + ${count} 张预览图已写入 public/assets/furniture 与 assets/furniture`);
console.log(`预览图单份总体积：${(previewBytes / 1024).toFixed(1)} KB（${count} 张，验收上限 1 MB）`);
if (previewBytes >= 1024 * 1024) {
  console.error("预览图总体积超过 1 MB 验收上限，请降低 PREVIEW_SIZE 或简化着色");
  process.exit(1);
}
