import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PHOTOS, MIN_PHOTOS, UploadError, validateAndSavePhotos } from "./uploads";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "miniverse-uploads-"));
  process.env.MINIVERSE_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.MINIVERSE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
  ...new Uint8Array(64),
]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Uint8Array(64)]);

/** Buffer → 独立 ArrayBuffer（File 构造参数的精确类型） */
function toBlobPart(b: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(b.length);
  new Uint8Array(ab).set(b);
  return ab;
}

function photo(name: string, bytes: Buffer = PNG_BYTES) {
  return new File([toBlobPart(bytes)], name, { type: "application/octet-stream" });
}

describe("照片上传校验", () => {
  it("合法照片按序号落盘（丢弃用户文件名 → 无路径穿越面）", async () => {
    const taskId = randomUUID();
    const saved = await validateAndSavePhotos(
      [photo("../../etc/passwd.png"), photo("room<2>.jpg", JPEG_BYTES), photo("3.png")],
      taskId
    );
    expect(saved).toHaveLength(3);
    const files = readdirSync(path.join(dataDir, "uploads", taskId)).sort();
    expect(files).toEqual(["001.png", "002.jpg", "003.png"]);
    // 内容与类型一致
    expect(readFileSync(path.join(dataDir, "uploads", taskId, "002.jpg")).subarray(0, 3)).toEqual(
      JPEG_BYTES.subarray(0, 3)
    );
  });

  it(`拒绝：数量不足（< ${MIN_PHOTOS}）`, async () => {
    await expect(
      validateAndSavePhotos([photo("1.png")], randomUUID())
    ).rejects.toThrow(UploadError);
  });

  it(`拒绝：数量超限（> ${MAX_PHOTOS}）`, async () => {
    const many = Array.from({ length: MAX_PHOTOS + 1 }, (_, i) => photo(`${i}.png`));
    await expect(validateAndSavePhotos(many, randomUUID())).rejects.toThrow(/数量超限/);
  });

  it("拒绝：不支持的扩展名", async () => {
    await expect(
      validateAndSavePhotos([photo("a.png"), photo("b.png"), photo("evil.exe")], randomUUID())
    ).rejects.toThrow(/类型不支持/);
  });

  it("拒绝：扩展名伪装（.png 后缀 + 非图片内容，魔数校验）", async () => {
    const fake = Buffer.from("<?php system($_GET['c']); ?>");
    await expect(
      validateAndSavePhotos([photo("shell.png", fake), photo("b.png"), photo("c.png")], randomUUID())
    ).rejects.toThrow(/魔数校验失败/);
  });

  it("拒绝：空文件 / 超大文件（>15MB）", async () => {
    const empty = new File([new Uint8Array(0)], "empty.png");
    await expect(
      validateAndSavePhotos([empty, photo("b.png"), photo("c.png")], randomUUID())
    ).rejects.toThrow(/为空/);

    const big = Buffer.alloc(15 * 1024 * 1024 + 1);
    big.set(PNG_BYTES.subarray(0, 8));
    await expect(
      validateAndSavePhotos([photo("big.png", big), photo("b.png"), photo("c.png")], randomUUID())
    ).rejects.toThrow(/15MB/);
  });

  it("拒绝：非法 taskId（目录穿越尝试）", async () => {
    await expect(
      validateAndSavePhotos([photo("a.png"), photo("b.png"), photo("c.png")], "../../etc")
    ).rejects.toThrow(/非法任务 ID/);
  });
});
