"use client";

import { useState } from "react";
import { Box, Eye, EyeOff, Sparkles, Trash2, GripVertical, Search } from "lucide-react";
import { ASSET_CATALOG } from "@shared/asset-catalog";
import { getAsset } from "@shared/asset-catalog";
import { useEditorStore } from "@/stores/editor-store";

const CATEGORIES = ["家具", "收纳", "装饰"] as const;

export default function LeftPanel() {
  const [tab, setTab] = useState<"assets" | "tree">("assets");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("家具");
  const [search, setSearch] = useState("");

  return (
    <div
      className="flex h-full flex-col"
      style={{
        background: "rgba(8,13,26,0.95)",
        backdropFilter: "blur(20px)",
      }}
    >
      {/* Tab 切换 */}
      <div
        className="flex shrink-0"
        style={{ borderBottom: "1px solid rgba(139,92,246,0.12)" }}
      >
        {(
          [
            ["assets", "素材库"],
            ["tree", "场景树"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="flex-1 py-2.5 text-xs font-medium transition-all duration-150"
            style={
              tab === key
                ? {
                    color: "#a855f7",
                    borderBottom: "2px solid #a855f7",
                    background: "rgba(168,85,247,0.06)",
                    textShadow: "0 0 8px rgba(168,85,247,0.5)",
                  }
                : {
                    color: "#475569",
                    borderBottom: "2px solid transparent",
                  }
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "assets" ? (
        <>
          {/* 搜索栏 */}
          <div className="shrink-0 px-2 py-2">
            <div
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5"
              style={{
                background: "rgba(15,23,42,0.6)",
                border: "1px solid rgba(51,65,85,0.4)",
              }}
            >
              <Search size={11} style={{ color: "#475569" }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索素材…"
                className="flex-1 bg-transparent text-[11px] text-slate-300 outline-none placeholder:text-slate-600"
              />
            </div>
          </div>

          {/* 分类标签 */}
          <div className="flex shrink-0 gap-1 px-2 pb-2">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className="flex-1 rounded-lg py-1 text-[11px] font-medium transition-all duration-150"
                style={
                  category === c
                    ? {
                        background: "linear-gradient(135deg, rgba(99,102,241,0.3), rgba(168,85,247,0.2))",
                        color: "#c4b5fd",
                        border: "1px solid rgba(139,92,246,0.3)",
                        boxShadow: "0 0 8px rgba(168,85,247,0.15)",
                      }
                    : {
                        background: "rgba(15,23,42,0.4)",
                        color: "#475569",
                        border: "1px solid rgba(51,65,85,0.3)",
                      }
                }
              >
                {c}
              </button>
            ))}
          </div>

          {/* 素材卡片网格 */}
          <div className="grid flex-1 grid-cols-2 gap-2 overflow-y-auto p-2 pt-0">
            {ASSET_CATALOG.filter(
              (a) =>
                a.category === category &&
                (search === "" || a.label.includes(search))
            ).map((a) => (
              <button
                key={a.assetId}
                onClick={() => useEditorStore.getState().addObject(a.assetId)}
                title={`添加${a.label}（占地 ${a.footprint[0]}×${a.footprint[1]}m）`}
                className="group flex flex-col items-start gap-1.5 rounded-xl p-2 text-left transition-all duration-200"
                style={{
                  background: "rgba(10,15,30,0.7)",
                  border: "1px solid rgba(51,65,85,0.3)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.border = "1px solid rgba(168,85,247,0.4)";
                  e.currentTarget.style.boxShadow = "0 0 16px rgba(168,85,247,0.12)";
                  e.currentTarget.style.background = "rgba(15,23,42,0.9)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.border = "1px solid rgba(51,65,85,0.3)";
                  e.currentTarget.style.boxShadow = "none";
                  e.currentTarget.style.background = "rgba(10,15,30,0.7)";
                }}
              >
                {/* 预览图：与 GLB 同一套程序化几何渲染（tools/generate-furniture-glb.mjs），
                    路径按 assetId 约定推导：/assets/furniture/previews/<assetId>.png。
                    图缺失时 onError 隐藏 img，露出底下的线性图标兜底（不标注占位字样）。 */}
                <span
                  className="h-16 w-full rounded-lg flex items-center justify-center relative overflow-hidden"
                  style={{
                    background: `linear-gradient(135deg, ${a.defaultColor}33, ${a.defaultColor}14)`,
                    border: `1px solid ${a.defaultColor}44`,
                  }}
                >
                  <Box
                    size={22}
                    strokeWidth={1.5}
                    style={{ color: a.defaultColor, opacity: 0.85, filter: `drop-shadow(0 0 6px ${a.defaultColor}55)` }}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element -- 静态小尺寸预览图，next/image 优化收益为负 */}
                  <img
                    src={`/assets/furniture/previews/${a.assetId}.png`}
                    alt={`${a.label}预览（程序化模型渲染）`}
                    className="absolute inset-0 h-full w-full object-contain"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                  {/* 扫描线动画 */}
                  <span
                    className="absolute inset-0 opacity-0 group-hover:opacity-100"
                    style={{
                      background: `linear-gradient(180deg, transparent 0%, ${a.defaultColor}18 50%, transparent 100%)`,
                      animation: "mv-scan-line 1.5s linear infinite",
                    }}
                  />
                </span>

                {/* 标签行 */}
                <span className="flex w-full items-center justify-between">
                  <span className="text-xs font-medium text-slate-200">{a.label}</span>
                  {a.glbPath ? (
                    <span
                      className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px]"
                      style={{
                        background: "rgba(34,211,238,0.1)",
                        color: "#67e8f9",
                        border: "1px solid rgba(34,211,238,0.15)",
                      }}
                    >
                      <Box size={8} /> GLB
                    </span>
                  ) : (
                    <span className="text-[9px] text-slate-600">无 GLB</span>
                  )}
                </span>

                {/* 尺寸 */}
                <span className="text-[10px] text-slate-600">
                  {a.footprint[0]}×{a.footprint[1]}m
                </span>
              </button>
            ))}
          </div>

          {/* 底部说明 */}
          <div
            className="shrink-0 px-3 py-2 text-[9px] leading-4 text-slate-600"
            style={{ borderTop: "1px solid rgba(139,92,246,0.08)" }}
          >
            GLB 模型程序化生成（真实 glTF 链路）；预览图由同一套几何渲染
          </div>
        </>
      ) : (
        <SceneTree />
      )}
    </div>
  );
}

function SceneTree() {
  const scene = useEditorStore((s) => s.scene);
  const selectedId = useEditorStore((s) => s.selectedId);
  const select = useEditorStore((s) => s.select);
  const updateObject = useEditorStore((s) => s.updateObject);
  const removeObject = useEditorStore((s) => s.removeObject);

  if (!scene || scene.objects.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <div
          className="rounded-2xl p-4"
          style={{
            background: "rgba(139,92,246,0.06)",
            border: "1px solid rgba(139,92,246,0.12)",
          }}
        >
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="mx-auto mb-2 opacity-30">
            <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" stroke="#a855f7" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M12 3v18M3 7l9 4 9-4" stroke="#a855f7" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <p className="text-[11px] leading-5 text-slate-500">
            场景为空。<br />
            从「素材库」添加家具，<br />
            或点顶部「重置」载入示例。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-2">
      {/* 高斯背景图层 */}
      {scene.reconstruction.format === "gaussian-splat" && (
        <div
          className="mb-2 flex items-center gap-2 rounded-xl px-2.5 py-2 text-[11px]"
          style={{
            background: "rgba(8,47,73,0.4)",
            border: "1px solid rgba(34,211,238,0.18)",
            color: "#67e8f9",
          }}
        >
          <Sparkles size={11} style={{ filter: "drop-shadow(0 0 4px rgba(34,211,238,0.7))" }} />
          <span>高斯背景{scene.reconstruction.synthetic ? "（演示·程序生成）" : ""}</span>
        </div>
      )}

      {/* 对象列表 */}
      {scene.objects.map((obj) => {
        const asset = getAsset(obj.assetId);
        const isSelected = obj.id === selectedId;
        return (
          <div
            key={obj.id}
            onClick={() => select(obj.id)}
            className="group mb-1 flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-2 text-xs transition-all duration-150"
            style={
              isSelected
                ? {
                    background: "linear-gradient(135deg, rgba(99,102,241,0.2), rgba(168,85,247,0.12))",
                    border: "1px solid rgba(168,85,247,0.3)",
                    color: "#c4b5fd",
                    boxShadow: "0 0 12px rgba(168,85,247,0.1)",
                  }
                : {
                    background: "transparent",
                    border: "1px solid transparent",
                    color: "#94a3b8",
                  }
            }
            onMouseEnter={(e) => {
              if (!isSelected) {
                e.currentTarget.style.background = "rgba(30,41,59,0.5)";
                e.currentTarget.style.border = "1px solid rgba(51,65,85,0.4)";
              }
            }}
            onMouseLeave={(e) => {
              if (!isSelected) {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.border = "1px solid transparent";
              }
            }}
          >
            {/* 拖拽把手 */}
            <GripVertical size={11} className="shrink-0 opacity-0 group-hover:opacity-30 text-slate-500" />

            {/* 颜色圆点 */}
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{
                background: obj.materialOverrides.color ?? asset?.defaultColor ?? "#6366f1",
                boxShadow: isSelected
                  ? `0 0 6px ${obj.materialOverrides.color ?? asset?.defaultColor ?? "#6366f1"}99`
                  : "none",
              }}
            />

            {/* 名称 */}
            <span className="flex-1 truncate">
              {obj.label ?? asset?.label ?? obj.assetId}
              {obj.origin !== "user" && (
                <span
                  className="ml-1 rounded px-1 text-[8px]"
                  style={{
                    background: obj.origin === "ai-detected" ? "rgba(52,211,153,0.15)" : "rgba(56,189,248,0.15)",
                    color: obj.origin === "ai-detected" ? "#6ee7b7" : "#7dd3fc",
                  }}
                >
                  {obj.origin === "ai-detected" ? "AI检" : "AI推"}
                </span>
              )}
            </span>

            {/* 操作按钮 */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                updateObject(obj.id, { visible: !obj.visible });
              }}
              className="shrink-0 text-slate-600 opacity-0 transition-all group-hover:opacity-100 hover:text-slate-200"
              title={obj.visible ? "隐藏" : "显示"}
            >
              {obj.visible ? <Eye size={12} /> : <EyeOff size={12} />}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                removeObject(obj.id);
              }}
              className="shrink-0 text-slate-600 opacity-0 transition-all group-hover:opacity-100 hover:text-red-400"
              title="删除"
            >
              <Trash2 size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
