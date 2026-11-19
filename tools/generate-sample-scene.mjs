#!/usr/bin/env node
/**
 * 合成样例场景生成器（T-700005）
 *
 * 目的：让 tools/verify-scene-manifest-client.mjs 在干净克隆 + 无私有数据时可跑。
 * 产物全部为程序生成（synthetic=true），不是真实重建，禁止拿本夹具的结果当真实场景证据。
 *
 * 用法：node tools/generate-sample-scene.mjs
 * 输出：data/reconstructions/sample/{scene.json, room.glb, walls.glb, floor.glb, sofa.glb}
 *       （MINIVERSE_DATA_DIR 可覆盖数据目录，与 apps/web/src/lib/server/paths.ts 同一约定）
 *
 * 场景定义在 tools/sample-scene/scene-definition.json（盒子组合：两面墙 + 地板 + 沙发，
 * 开放盒子形态，nu 单位、+Y 向上）。glTF 组装手法复用 tools/generate-furniture-glb.mjs
 * （该文件属缩略图卡独占，本脚本不改它，只复用其手法）。
 *
 * 清单契约：schema 必须等于 apps/web/src/lib/server/recon-editable-scene.ts 的
 * SCENE_MANIFEST_SCHEMA（miniverse.scene-manifest.v1）；资产路径必须是扁平 basename 的 .glb。
 * 生成后自校验这些不变量，任一不满足即退出码 1。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCENE_MANIFEST_SCHEMA = "miniverse.scene-manifest.v1"; // 与 recon-editable-scene.ts 保持一致
const DEF_PATH = path.join(ROOT, "tools", "sample-scene", "scene-definition.json");

const def = JSON.parse(fs.readFileSync(DEF_PATH, "utf8"));
if (def.synthetic !== true) {
  console.error("场景定义必须显式 synthetic=true（诚实原则）");
  process.exit(1);
}

/* ---------- 颜色：sRGB hex → glTF 线性（同 generate-furniture-glb.mjs 手法） ---------- */
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

/* ---------- 盒子几何（中心点 + 尺寸，每面 4 顶点、法线朝外） ---------- */
function makeBox(cx, cy, cz, w, h, d) {
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const y0 = cy - h / 2, y1 = cy + h / 2;
  const z0 = cz - d / 2, z1 = cz + d / 2;
  const positions = new Float32Array([
    x1,y0,z1, x1,y0,z0, x1,y1,z0, x1,y1,z1,
    x0,y0,z0, x0,y0,z1, x0,y1,z1, x0,y1,z0,
    x0,y1,z1, x1,y1,z1, x1,y1,z0, x0,y1,z0,
    x0,y0,z0, x1,y0,z0, x1,y0,z1, x0,y0,z1,
    x0,y0,z1, x1,y0,z1, x1,y1,z1, x0,y1,z1,
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

/* ---------- glTF 组装：多节点 GLB（room.glb 用组节点 room 包 walls/floor/sofa） ---------- */
function buildGlb(nodeSpecs, rootName) {
  const buffers = [];
  const bufferViews = [];
  const accessors = [];
  let byteOffset = 0;

  function addView(typedArray) {
    const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    const viewIndex = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length });
    buffers.push(bytes, new Uint8Array(pad));
    byteOffset += bytes.length + pad;
    return viewIndex;
  }
  function addVec3Accessor(arr, hasMinMax) {
    const view = addView(arr);
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
    accessors.push(acc);
    return accessors.length - 1;
  }
  function addIndexAccessor(arr) {
    const view = addView(arr);
    accessors.push({ bufferView: view, componentType: 5123, count: arr.length, type: "SCALAR" });
    return accessors.length - 1;
  }

  const meshes = [];
  const materials = [];
  const materialIndex = new Map();
  const nodes = [];

  for (const spec of nodeSpecs) {
    const primitives = spec.parts.map(([cx, cy, cz, w, h, d, color]) => {
      const g = makeBox(cx, cy, cz, w, h, d);
      if (!materialIndex.has(color)) {
        materialIndex.set(color, materials.length);
        materials.push({
          pbrMetallicRoughness: { baseColorFactor: hexToLinearFactor(color), metallicFactor: 0.0, roughnessFactor: 0.8 },
          doubleSided: false,
        });
      }
      return {
        attributes: { POSITION: addVec3Accessor(g.positions, true), NORMAL: addVec3Accessor(g.normals, false) },
        indices: addIndexAccessor(g.indices),
        material: materialIndex.get(color),
      };
    });
    meshes.push({ primitives });
    nodes.push({ name: spec.name, mesh: meshes.length - 1 });
  }

  // 根节点：多节点时是组节点（room），单节点时直接就是该资产节点
  let sceneNodes;
  if (nodeSpecs.length > 1) {
    nodes.push({ name: rootName, children: nodes.map((_, i) => i) });
    sceneNodes = [nodes.length - 1];
  } else {
    sceneNodes = [0];
  }

  const gltf = {
    asset: { version: "2.0", generator: "MiniVerse synthetic sample-scene generator (procedural, NOT a real reconstruction)" },
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes,
    meshes,
    materials,
    bufferViews,
    accessors,
    buffers: [{ byteLength: byteOffset }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const totalLength = 12 + 8 + jsonBytes.length + jsonPad + 8 + byteOffset;
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
  glb.writeUInt32LE(byteOffset, o); o += 4;
  glb.writeUInt32LE(0x004e4942, o); o += 4; // BIN
  for (const chunk of buffers) {
    Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(glb, o);
    o += chunk.byteLength;
  }
  return glb;
}

/* ---------- 生成资产 ---------- */
const dataDir = process.env.MINIVERSE_DATA_DIR || path.join(ROOT, "data");
const outDir = path.join(dataDir, "reconstructions", def.sceneId);
fs.mkdirSync(outDir, { recursive: true });

const assetNames = ["walls", "floor", "sofa"];
const assets = {};
function writeAsset(name, glb) {
  fs.writeFileSync(path.join(outDir, `${name}.glb`), glb);
  assets[name] = {
    path: `${name}.glb`,
    bytes: glb.length,
    sha256: crypto.createHash("sha256").update(glb).digest("hex"),
  };
  console.log(`✓ ${name}.glb (${(glb.length / 1024).toFixed(1)} KB)`);
}

// 整场景 room.glb：组节点 room 包 walls/floor/sofa（客户端默认取 ?asset=room）
writeAsset("room", buildGlb(assetNames.map((n) => ({ name: n, parts: def.geometry[n] })), "room"));
// 单资产 GLB：节点名与清单 nodeName 一致
for (const n of assetNames) writeAsset(n, buildGlb([{ name: n, parts: def.geometry[n] }], n));

/* ---------- 清单 ---------- */
const identity = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], visible: true };
const manifest = {
  schema: SCENE_MANIFEST_SCHEMA,
  sceneId: def.sceneId,
  units: def.units,
  upAxis: def.upAxis,
  asset: { units: def.units, upAxis: def.upAxis },
  synthetic: true,
  note: def.note,
  generator: { tool: "tools/generate-sample-scene.mjs", definition: "tools/sample-scene/scene-definition.json" },
  assets,
  objects: def.objects.map((o) => ({
    ...o,
    startTransform: identity,
    provenance: { source: "procedural", synthetic: true, note: "程序生成，非真实重建" },
  })),
};

/* ---------- 自校验（不满足即失败，绝不产出非法清单） ---------- */
const errors = [];
if (manifest.schema !== SCENE_MANIFEST_SCHEMA) errors.push("schema 不等于 SCENE_MANIFEST_SCHEMA");
if (manifest.synthetic !== true) errors.push("synthetic 必须显式为 true");
if (!Array.isArray(manifest.objects) || manifest.objects.length === 0) errors.push("objects 为空");
const ids = new Set();
for (const o of manifest.objects) {
  if (typeof o.objectId !== "string" || typeof o.nodeName !== "string") errors.push(`对象缺 objectId/nodeName: ${JSON.stringify(o)}`);
  if (ids.has(o.objectId)) errors.push(`objectId 重复: ${o.objectId}`);
  ids.add(o.objectId);
}
for (const [name, a] of Object.entries(assets)) {
  if (path.basename(a.path) !== a.path || path.extname(a.path).toLowerCase() !== ".glb") {
    errors.push(`资产路径必须是扁平 basename 的 .glb: ${name} → ${a.path}`);
  }
  if (!fs.existsSync(path.join(outDir, a.path))) errors.push(`资产文件缺失: ${a.path}`);
}
// room.glb 必须包含全部 nodeName 对应的节点（客户端按名字匹配）
const roomGlb = fs.readFileSync(path.join(outDir, "room.glb"));
const jsonLen = roomGlb.readUInt32LE(12);
const roomGltf = JSON.parse(roomGlb.subarray(20, 20 + jsonLen).toString("utf8"));
const nodeNames = new Set(roomGltf.nodes.map((n) => n.name));
for (const o of manifest.objects) {
  if (!nodeNames.has(o.nodeName)) errors.push(`room.glb 缺少节点: ${o.nodeName}`);
}
if (errors.length) {
  console.error("自校验失败:\n- " + errors.join("\n- "));
  process.exit(1);
}

fs.writeFileSync(path.join(outDir, "scene.json"), JSON.stringify(manifest, null, 2));
console.log(`✓ scene.json（schema=${SCENE_MANIFEST_SCHEMA}，objects=${manifest.objects.length}）`);
console.log(`输出目录: ${outDir}`);
console.log("⚠ 本场景为程序生成（synthetic=true），非真实重建；只用于客户端契约验收，不得作为真实重建证据。");