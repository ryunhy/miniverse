import { defineConfig } from "eslint/config";
// 与 apps/web 同源的 TS 规则集（eslint-config-next 经 workspaces 提升到根 node_modules）。
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextTs,
]);
