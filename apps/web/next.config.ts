import path from "node:path";
import type { NextConfig } from "next";

// ESM 上下文无 __dirname，必须用 import.meta.dirname（Node 20.11+）；
// 否则 turbopack.root 静默失效 → 模块解析错乱 → R3F Canvas 不启动
const repoRoot = path.join(import.meta.dirname, "../..");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    root: repoRoot,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // packages/shared 以 TS 源码形式被 web 直接引用
  transpilePackages: ["@miniverse/shared"],
};

export default nextConfig;
