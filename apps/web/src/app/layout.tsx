import type { Metadata } from "next";
import type { ReactNode } from "react";
// Geist/Geist Mono 改为自托管（public/fonts + fonts.css）：next/font/google 在构建期
// 必须联网拉字体，离线/代理不可用时整个 build 会失败。字形与 unicode-range 保持一致。
import "./fonts.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "MiniVerse · AI 3D 重建与微缩世界编辑器",
  description: "上传房间照片，COLMAP + Gaussian Splatting 重建真实空间，浏览器中查看与编辑",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
