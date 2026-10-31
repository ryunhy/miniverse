#!/usr/bin/env node
/**
 * 程序化家具 GLB 生成器
 * 生成真实的 glTF 2.0 二进制文件（盒子组合建模，底部中心原点、Y 向上、米制尺寸），
 * 由 apps/web 通过 GLTFLoader 加载。产物为程序化模型（非美术素材），UI 端有明确标注。
 *
 * 用法：node tools/generate-furniture-glb.mjs
 * 输出：apps/web/public/assets/furniture/*.glb + assets/furniture/（源备份）
 */
import fs from "node:fs";
import path from "node:path";
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

/* ---------- 主流程 ---------- */
let count = 0;
for (const [name, def] of Object.entries(FURNITURE)) {
  const glb = buildGlb(def());
  for (const dir of OUT_DIRS) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.glb`), glb);
  }
  count++;
  console.log(`✓ ${name}.glb (${(glb.length / 1024).toFixed(1)} KB)`);
}
console.log(`完成：${count} 个程序化 GLB 家具已写入 public/assets/furniture 与 assets/furniture`);
