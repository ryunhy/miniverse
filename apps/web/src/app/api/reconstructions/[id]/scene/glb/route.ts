import fs from "node:fs";
import { NextResponse } from "next/server";
import {
  SceneValidationError,
  assetHash,
  sceneAssetPath,
} from "@/lib/server/recon-editable-scene";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 下发场景 GLB（默认 room，可用 ?asset=walls|floor|sofa|… 取单对象）。
 * ETag = 文件 sha256；浏览器带 If-None-Match 命中时返回 304。
 * 这样重新生成场景后 ETag 变化，缓存必然失效；未变化时又不必重传十几 MB。
 */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const asset = url.searchParams.get("asset") ?? "room";
  try {
    const file = sceneAssetPath(id, asset);
    const etag = `"${assetHash(file)}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "public, max-age=0, must-revalidate" },
      });
    }
    const body = fs.readFileSync(file);
    const headers: Record<string, string> = {
      "Content-Type": "model/gltf-binary",
      "Content-Length": String(body.byteLength),
      ETag: etag,
      "Cache-Control": "public, max-age=0, must-revalidate",
      "X-Scene-Asset": asset,
    };
    if (url.searchParams.get("download") === "1") {
      headers["Content-Disposition"] = `attachment; filename="miniverse-${id}-${asset}.glb"`;
    }
    return new NextResponse(new Uint8Array(body), { status: 200, headers });
  } catch (e) {
    if (e instanceof SceneValidationError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    throw e;
  }
}

export async function HEAD(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const asset = new URL(req.url).searchParams.get("asset") ?? "room";
  try {
    const file = sceneAssetPath(id, asset);
    const st = fs.statSync(file);
    return new NextResponse(null, {
      status: 200,
      headers: {
        "Content-Type": "model/gltf-binary",
        "Content-Length": String(st.size),
        ETag: `"${assetHash(file)}"`,
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    });
  } catch (e) {
    if (e instanceof SceneValidationError) {
      return NextResponse.json({ error: e.message }, { status: 404 });
    }
    throw e;
  }
}
