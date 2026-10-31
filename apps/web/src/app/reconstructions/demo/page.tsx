"use client";

import Link from "next/link";
import { Info } from "lucide-react";
import SplatViewer from "@/components/splat/SplatViewer";

/**
 * 演示高斯场景：tools/generate-demo-splat.mjs 程序生成的 3DGS PLY。
 * 明确标注为演示数据（非真实重建），用于无 GPU 环境验证查看器链路。
 */
export default function DemoSplatPage() {
  return (
    <div className="min-h-screen" style={{ background: "#030712", color: "#f1f5f9" }}>
      <div className="stars-bg pointer-events-none" />

      {/* 顶栏 */}
      <header
        className="relative flex items-center gap-3 px-5 py-0"
        style={{
          height: 52,
          background: "rgba(8,13,26,0.95)",
          borderBottom: "1px solid rgba(139,92,246,0.15)",
          backdropFilter: "blur(20px)",
          boxShadow: "0 1px 0 rgba(139,92,246,0.08)",
          zIndex: 50,
        }}
      >
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ filter: "drop-shadow(0 0 6px rgba(168,85,247,0.7))" }}>
            <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" stroke="url(#dmGrad)" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M12 3v18M3 7l9 4 9-4" stroke="url(#dmGrad)" strokeWidth="1.5" strokeLinejoin="round" />
            <defs>
              <linearGradient id="dmGrad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
                <stop stopColor="#a855f7" /><stop offset="0.5" stopColor="#ec4899" /><stop offset="1" stopColor="#f59e0b" />
              </linearGradient>
            </defs>
          </svg>
          <span
            className="text-sm font-bold"
            style={{
              background: "linear-gradient(135deg, #a855f7 0%, #ec4899 50%, #f59e0b 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            MiniVerse
          </span>
        </Link>
        <span className="text-slate-700">/</span>
        <Link href="/reconstructions" className="text-xs text-slate-500 hover:text-slate-300 transition">
          重建任务
        </Link>
        <span className="text-slate-700">/</span>
        <span
          className="text-xs px-2.5 py-1 rounded-full"
          style={{
            background: "rgba(34,211,238,0.1)",
            color: "#67e8f9",
            border: "1px solid rgba(34,211,238,0.2)",
          }}
        >
          演示高斯场景
        </span>
        <Link href="/reconstructions" className="ml-auto btn-ghost">
          ← 任务列表
        </Link>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        {/* 标题区 */}
        <div className="mb-6 text-center mv-fade-in">
          <h1 className="text-2xl font-bold text-slate-100">演示高斯场景</h1>
          <p className="mt-2 text-sm text-slate-500">程序化生成的 3D Gaussian Splatting 场景，用于验证渲染链路</p>
        </div>

        {/* 查看器 */}
        <section
          className="overflow-hidden rounded-2xl mv-fade-in"
          style={{
            border: "1px solid rgba(34,211,238,0.18)",
            boxShadow: "0 0 40px rgba(34,211,238,0.06)",
          }}
        >
          <SplatViewer url="/demo/demo-room.ply" height={560} />

          {/* 说明条 */}
          <div
            className="flex items-start gap-3 px-4 py-3"
            style={{
              borderTop: "1px solid rgba(34,211,238,0.12)",
              background: "rgba(8,47,73,0.5)",
            }}
          >
            <Info size={14} className="mt-0.5 shrink-0" style={{ color: "#67e8f9" }} />
            <p className="text-[11px] leading-5" style={{ color: "rgba(103,232,249,0.8)" }}>
              这是<b>程序生成的演示高斯场景</b>（约 8k 高斯点构成 5×4×3m 房间外壳），用于在无 GPU 环境验证
              Gaussian Splatting 加载/渲染链路，<b>不是真实照片重建结果</b>。
              真实重建请{" "}
              <Link href="/reconstructions" className="underline hover:text-cyan-300 transition">
                上传照片创建任务
              </Link>
              。
            </p>
          </div>
        </section>

        {/* 技术说明 */}
        <div
          className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3 mv-fade-in"
        >
          {[
            { label: "高斯点数", value: "~8,000", color: "#a855f7" },
            { label: "场景尺寸", value: "5×4×3m", color: "#22d3ee" },
            { label: "格式", value: "3DGS PLY", color: "#34d399" },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-2xl px-4 py-4 text-center"
              style={{
                background: "rgba(10,15,30,0.6)",
                border: `1px solid ${item.color}22`,
                backdropFilter: "blur(12px)",
              }}
            >
              <div
                className="text-2xl font-bold"
                style={{
                  color: item.color,
                  filter: `drop-shadow(0 0 8px ${item.color}66)`,
                }}
              >
                {item.value}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">{item.label}</div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
