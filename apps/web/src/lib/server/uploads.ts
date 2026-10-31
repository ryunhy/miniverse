import fs from "node:fs";
import path from "node:path";
import { uploadDir } from "./paths";

/**
 * 照片上传校验与落盘。
 * 安全设计：
 * - 完全丢弃客户端文件名，落盘为 <taskId>/<序号>.<白名单扩展名>（根除路径穿越）
 * - 扩展名 + 魔数双重校验，防止伪装成图片的任意文件
 * - 数量 3~120 张、单张 ≤ 15MB
 */

export const MAX_PHOTOS = 120;
export const MIN_PHOTOS = 3;
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp"]);

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

function sniffImageMagic(head: Uint8Array, ext: string): boolean {
  if (ext === "jpg" || ext === "jpeg") {
    return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  }
  if (ext === "png") {
    return (
      head.length >= 4 &&
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    );
  }
  if (ext === "webp") {
    // RIFF....WEBP
    return (
      head.length >= 12 &&
      head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
    );
  }
  return false;
}

/** 校验并保存；返回相对路径列表（data/uploads/<taskId>/NNN.ext） */
export async function validateAndSavePhotos(
  files: File[],
  taskId: string
): Promise<string[]> {
  if (!Array.isArray(files) || files.length < MIN_PHOTOS) {
    throw new UploadError(`照片数量不足：至少 ${MIN_PHOTOS} 张，推荐 30~80 张`);
  }
  if (files.length > MAX_PHOTOS) {
    throw new UploadError(`照片数量超限：最多 ${MAX_PHOTOS} 张`);
  }

  const dir = uploadDir(taskId);
  fs.mkdirSync(dir, { recursive: true });

  const saved: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    // 只取扩展名做类型判断；文件名本身不参与任何落盘路径
    const rawName = file.name || "";
    const ext = rawName.split(".").pop()?.toLowerCase() ?? "";
    if (!ALLOWED_EXT.has(ext)) {
      throw new UploadError(`第 ${i + 1} 个文件类型不支持（${rawName || "未命名"}）：仅支持 JPG/PNG/WebP`);
    }
    if (file.size === 0) throw new UploadError(`第 ${i + 1} 个文件为空`);
    if (file.size > MAX_FILE_BYTES) {
      throw new UploadError(`第 ${i + 1} 个文件超过 15MB 限制`);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    if (!sniffImageMagic(buf.subarray(0, 16), ext)) {
      throw new UploadError(`第 ${i + 1} 个文件内容与图片格式不符（魔数校验失败）`);
    }
    const dest = path.join(dir, `${String(i + 1).padStart(3, "0")}.${ext}`);
    fs.writeFileSync(dest, buf);
    saved.push(path.relative(path.resolve(uploadDir(taskId), "..", ".."), dest).split(path.sep).join("/"));
  }
  return saved;
}
