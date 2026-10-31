"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

/** 入口：无场景则创建演示场景，然后跳转编辑器 */
export default function Home() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { scenes } = await api.listScenes();
        if (!alive) return;
        if (scenes.length > 0) {
          router.replace(`/editor/${scenes[0].sceneId}`);
          return;
        }
        setCreating(true);
        const { scene } = await api.createScene("demo");
        if (alive) router.replace(`/editor/${scene.sceneId}`);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "初始化失败");
      }
    })();
    return () => {
      alive = false;
    };
  }, [router]);

  return (
    <div className="relative flex h-screen flex-col items-center justify-center overflow-hidden bg-[#030712]">
      {/* 星空背景 */}
      <div className="stars-bg" />

      {/* 星云光晕 */}
      <div
        className="nebula-glow"
        style={{
          width: 600,
          height: 600,
          background: "radial-gradient(ellipse, rgba(139,92,246,0.12) 0%, transparent 70%)",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
        }}
      />
      <div
        className="nebula-glow"
        style={{
          width: 400,
          height: 300,
          background: "radial-gradient(ellipse, rgba(34,211,238,0.07) 0%, transparent 70%)",
          top: "30%",
          right: "10%",
        }}
      />
      <div
        className="nebula-glow"
        style={{
          width: 350,
          height: 250,
          background: "radial-gradient(ellipse, rgba(245,158,11,0.06) 0%, transparent 70%)",
          bottom: "20%",
          left: "5%",
        }}
      />

      {/* 主内容 */}
      <div className="relative z-10 flex flex-col items-center gap-6" style={{ animation: "mv-fade-in 0.6s ease" }}>
        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          <div
            className="flex h-20 w-20 items-center justify-center rounded-2xl"
            style={{
              background: "linear-gradient(135deg, rgba(124,58,237,0.3), rgba(168,85,247,0.15))",
              border: "1px solid rgba(168,85,247,0.35)",
              boxShadow: "0 0 40px rgba(168,85,247,0.2), inset 0 1px 0 rgba(255,255,255,0.05)",
            }}
          >
            <svg
              width="44"
              height="44"
              viewBox="0 0 24 24"
              fill="none"
              style={{ filter: "drop-shadow(0 0 12px rgba(168,85,247,0.8))" }}
            >
              <path
                d="M3 7l9-4 9 4v10l-9 4-9-4V7z"
                stroke="url(#logoGrad)"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <path d="M12 3v18M3 7l9 4 9-4" stroke="url(#logoGrad)" strokeWidth="1.5" strokeLinejoin="round" />
              <defs>
                <linearGradient id="logoGrad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#a855f7" />
                  <stop offset="0.5" stopColor="#ec4899" />
                  <stop offset="1" stopColor="#f59e0b" />
                </linearGradient>
              </defs>
            </svg>
          </div>

          <div className="text-center">
            <h1
              className="text-5xl font-bold tracking-tight"
              style={{
                background: "linear-gradient(135deg, #a855f7 0%, #ec4899 45%, #f59e0b 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
                filter: "drop-shadow(0 0 20px rgba(168,85,247,0.5))",
              }}
            >
              MiniVerse
            </h1>
            <p className="mt-2 text-sm text-slate-400">AI 驱动 · 3D 高斯重建 · 微缩世界编辑器</p>
          </div>
        </div>

        {/* 状态区 */}
        <div
          className="flex flex-col items-center gap-3 rounded-2xl px-8 py-5"
          style={{
            background: "rgba(10,15,30,0.7)",
            border: "1px solid rgba(139,92,246,0.18)",
            backdropFilter: "blur(20px)",
            boxShadow: "0 0 30px rgba(139,92,246,0.08)",
            minWidth: 280,
          }}
        >
          {error ? (
            <>
              <div className="flex items-center gap-2 text-sm text-red-400">
                <span style={{ textShadow: "0 0 10px rgba(248,113,113,0.5)" }}>⚠ {error}</span>
              </div>
              <button
                onClick={() => location.reload()}
                className="btn-accent"
              >
                重试
              </button>
            </>
          ) : (
            <>
              {/* 骨架屏加载动画 */}
              <div className="flex flex-col items-center gap-2 w-full">
                <div className="flex items-center gap-2">
                  {/* 旋转环 */}
                  <svg width="18" height="18" viewBox="0 0 18 18" style={{ animation: "mv-spin 1s linear infinite" }}>
                    <circle cx="9" cy="9" r="7" fill="none" stroke="rgba(139,92,246,0.2)" strokeWidth="2" />
                    <path
                      d="M9 2 A7 7 0 0 1 16 9"
                      fill="none"
                      stroke="url(#spinGrad)"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <defs>
                      <linearGradient id="spinGrad" x1="0" y1="0" x2="1" y2="1">
                        <stop stopColor="#a855f7" />
                        <stop offset="1" stopColor="#f59e0b" />
                      </linearGradient>
                    </defs>
                  </svg>
                  <span className="text-xs text-slate-400">
                    {creating ? "正在创建演示场景…" : "正在进入编辑器…"}
                  </span>
                </div>

                {/* 骨架进度条 */}
                <div className="w-full rounded-full overflow-hidden" style={{ height: 3, background: "rgba(139,92,246,0.1)" }}>
                  <div
                    className="h-full rounded-full progress-glow"
                    style={{ width: creating ? "65%" : "85%", transition: "width 0.5s ease" }}
                  />
                </div>

                {/* 骨架行 */}
                <div className="w-full space-y-2 mt-1">
                  <div className="skeleton h-2 w-3/4 mx-auto" />
                  <div className="skeleton h-2 w-1/2 mx-auto" />
                </div>
              </div>
            </>
          )}
        </div>

        {/* 底部说明 */}
        <p className="text-[11px] text-slate-600">
          上传房间照片 → COLMAP → Gaussian Splatting → 浏览器编辑
        </p>
      </div>
    </div>
  );
}
