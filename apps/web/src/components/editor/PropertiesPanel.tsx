"use client";

import { Copy, Eye, EyeOff, Trash2, ChevronRight } from "lucide-react";
import { useEditorStore } from "@/stores/editor-store";
import { getAsset } from "@shared/asset-catalog";

function NumberField({
  label,
  value,
  step = 0.1,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        className="w-20 rounded-lg px-2 py-1 text-right text-[11px] text-slate-200 outline-none transition-all"
        style={{
          background: "rgba(15,23,42,0.7)",
          border: "1px solid rgba(51,65,85,0.4)",
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "rgba(168,85,247,0.5)";
          e.currentTarget.style.boxShadow = "0 0 8px rgba(168,85,247,0.2)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "rgba(51,65,85,0.4)";
          e.currentTarget.style.boxShadow = "none";
        }}
      />
    </label>
  );
}

const ORIGIN_LABEL: Record<string, string> = {
  user: "用户添加",
  "ai-detected": "AI 检测",
  "ai-inferred": "AI 推测",
};

const ORIGIN_STYLE: Record<string, { background: string; color: string; border: string }> = {
  user: { background: "rgba(51,65,85,0.4)", color: "#94a3b8", border: "1px solid rgba(71,85,105,0.3)" },
  "ai-detected": { background: "rgba(6,78,59,0.3)", color: "#6ee7b7", border: "1px solid rgba(52,211,153,0.2)" },
  "ai-inferred": { background: "rgba(12,74,110,0.3)", color: "#7dd3fc", border: "1px solid rgba(56,189,248,0.2)" },
};

interface PropertiesPanelProps {
  onCollapse?: () => void;
  collapsed?: boolean;
}

export default function PropertiesPanel({ onCollapse, collapsed }: PropertiesPanelProps) {
  const scene = useEditorStore((s) => s.scene);
  const selectedId = useEditorStore((s) => s.selectedId);
  const updateObject = useEditorStore((s) => s.updateObject);
  const removeObject = useEditorStore((s) => s.removeObject);
  const duplicateSelected = useEditorStore((s) => s.duplicateSelected);
  const updateRoom = useEditorStore((s) => s.updateRoom);
  const updateLighting = useEditorStore((s) => s.updateLighting);

  if (!scene) return null;
  const obj = scene.objects.find((o) => o.id === selectedId) ?? null;
  const asset = obj ? getAsset(obj.assetId) : undefined;

  return (
    <div
      className="flex h-full flex-col overflow-y-auto"
      style={{ background: "rgba(8,13,26,0.95)", backdropFilter: "blur(20px)" }}
    >
      {/* 面板标题 */}
      <div
        className="flex items-center justify-between shrink-0 px-3 py-2.5"
        style={{ borderBottom: "1px solid rgba(139,92,246,0.12)" }}
      >
        <span className="text-xs font-semibold text-slate-300">属性</span>
        {onCollapse && (
          <button
            onClick={onCollapse}
            className="text-slate-600 transition hover:text-slate-300"
            title="折叠属性面板"
          >
            <ChevronRight size={14} style={{ transform: collapsed ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
          </button>
        )}
      </div>

      {obj && asset ? (
        <div className="flex flex-col gap-3 p-3 mv-fade-in">
          {/* 对象信息卡 */}
          <div
            className="rounded-xl p-3"
            style={{
              background: "rgba(99,102,241,0.08)",
              border: "1px solid rgba(99,102,241,0.2)",
            }}
          >
            <div className="text-sm font-semibold text-slate-100">{obj.label ?? asset.label}</div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-[10px] text-slate-600 font-mono">{obj.assetId}</span>
              <span
                className="rounded-full px-2 py-0.5 text-[9px] font-semibold"
                style={ORIGIN_STYLE[obj.origin] ?? ORIGIN_STYLE.user}
              >
                {ORIGIN_LABEL[obj.origin]}
              </span>
            </div>
            {!asset.glbPath && (
              <div
                className="mt-1.5 rounded-lg px-2 py-1 text-[10px]"
                style={{
                  background: "rgba(180,83,9,0.2)",
                  color: "#fbbf24",
                  border: "1px solid rgba(245,158,11,0.2)",
                }}
              >
                ⚠ 占位几何体（无 GLB 素材）
              </div>
            )}
          </div>

          {/* 位置 */}
          <Section title="位置（米）">
            <NumberField label="X" value={obj.position[0]} onChange={(v) => updateObject(obj.id, { position: [v, obj.position[1], obj.position[2]] })} />
            <NumberField label="Y（离地）" value={obj.position[1]} min={0} onChange={(v) => updateObject(obj.id, { position: [obj.position[0], v, obj.position[2]] })} />
            <NumberField label="Z" value={obj.position[2]} onChange={(v) => updateObject(obj.id, { position: [obj.position[0], obj.position[1], v] })} />
          </Section>

          {/* 旋转 */}
          <Section title="旋转（度）">
            <NumberField
              label="Y 轴"
              step={15}
              value={(obj.rotation[1] * 180) / Math.PI}
              onChange={(v) => updateObject(obj.id, { rotation: [0, (v * Math.PI) / 180, 0] })}
            />
          </Section>

          {/* 缩放 */}
          <Section title="缩放">
            <NumberField label="整体倍数" value={obj.scale[0]} min={0.2} max={4} step={0.1} onChange={(v) => updateObject(obj.id, { scale: [v, v, v] })} />
          </Section>

          {/* 颜色 */}
          <Section title="颜色覆盖">
            <label className="flex items-center justify-between text-[11px] text-slate-500">
              <span>材质颜色</span>
              <div className="flex items-center gap-2">
                <span
                  className="h-5 w-5 rounded-md"
                  style={{
                    background: obj.materialOverrides.color ?? asset.defaultColor,
                    border: "1px solid rgba(255,255,255,0.15)",
                    boxShadow: `0 0 6px ${obj.materialOverrides.color ?? asset.defaultColor}88`,
                  }}
                />
                <input
                  type="color"
                  value={obj.materialOverrides.color ?? asset.defaultColor}
                  onChange={(e) =>
                    updateObject(obj.id, { materialOverrides: { color: e.target.value } })
                  }
                  className="h-7 w-16 cursor-pointer rounded-lg"
                  style={{
                    background: "rgba(15,23,42,0.7)",
                    border: "1px solid rgba(139,92,246,0.25)",
                    padding: "1px",
                  }}
                />
              </div>
            </label>
          </Section>

          {/* 操作按钮 */}
          <div className="grid grid-cols-3 gap-1.5">
            <button
              onClick={() => updateObject(obj.id, { visible: !obj.visible })}
              className="btn-ghost flex flex-col items-center gap-1 py-2"
              style={{ fontSize: 10 }}
            >
              {obj.visible ? <Eye size={14} /> : <EyeOff size={14} />}
              {obj.visible ? "隐藏" : "显示"}
            </button>
            <button
              onClick={() => duplicateSelected()}
              className="btn-ghost flex flex-col items-center gap-1 py-2"
              style={{ fontSize: 10 }}
            >
              <Copy size={14} />
              复制
            </button>
            <button
              onClick={() => removeObject(obj.id)}
              className="btn-danger flex flex-col items-center gap-1 py-2"
              style={{ fontSize: 10 }}
            >
              <Trash2 size={14} />
              删除
            </button>
          </div>
        </div>
      ) : (
        <div
          className="m-3 rounded-xl p-4 text-[11px] leading-5 text-slate-600 mv-fade-in"
          style={{
            background: "rgba(139,92,246,0.04)",
            border: "1px solid rgba(139,92,246,0.1)",
          }}
        >
          点击场景中的家具编辑属性
          <br />
          <span className="text-slate-700 text-[10px]">
            Gizmo：移动 / 旋转 / 缩放
            <br />
            Ctrl+D 复制 · Delete 删除
          </span>
        </div>
      )}

      {/* 房间与灯光（底部） */}
      <div
        className="mt-auto flex flex-col gap-2 p-3"
        style={{ borderTop: "1px solid rgba(139,92,246,0.1)" }}
      >
        <div className="text-[11px] font-semibold text-slate-500 mb-1">房间与灯光</div>

        <Section title="尺寸（米）">
          <NumberField label="宽" value={scene.room.width} min={2} max={20} step={0.5} onChange={(v) => updateRoom({ width: v })} />
          <NumberField label="深" value={scene.room.depth} min={2} max={20} step={0.5} onChange={(v) => updateRoom({ depth: v })} />
          <NumberField label="高" value={scene.room.height} min={2} max={6} step={0.5} onChange={(v) => updateRoom({ height: v })} />
        </Section>

        {/* 灯光预设 */}
        <label className="flex items-center justify-between text-[11px] text-slate-500">
          <span>灯光预设</span>
          <select
            value={scene.lighting.preset}
            onChange={(e) => updateLighting({ preset: e.target.value as typeof scene.lighting.preset })}
            className="rounded-lg px-2 py-1 text-[11px] text-slate-200 outline-none"
            style={{
              background: "rgba(15,23,42,0.7)",
              border: "1px solid rgba(51,65,85,0.4)",
              cursor: "pointer",
            }}
          >
            <option value="warm">☀ 暖光</option>
            <option value="cool">❄ 冷光</option>
            <option value="neutral">⬜ 自然光</option>
            <option value="night">🌙 夜晚</option>
          </select>
        </label>

        {/* 颜色 */}
        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <span>地板 / 墙面</span>
          <span className="flex items-center gap-2">
            <ColorDot value={scene.room.floorColor} label="地板" onChange={(v) => updateRoom({ floorColor: v })} />
            <ColorDot value={scene.room.wallColor} label="墙面" onChange={(v) => updateRoom({ wallColor: v })} />
          </span>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="text-[10px] font-semibold uppercase tracking-widest"
        style={{ color: "rgba(168,85,247,0.6)" }}
      >
        {title}
      </div>
      <div
        className="flex flex-col gap-1.5 rounded-xl p-2.5"
        style={{ background: "rgba(15,23,42,0.4)", border: "1px solid rgba(51,65,85,0.2)" }}
      >
        {children}
      </div>
    </div>
  );
}

function ColorDot({ value, label, onChange }: { value: string; label: string; onChange: (v: string) => void }) {
  return (
    <label
      className="relative cursor-pointer"
      title={label}
    >
      <span
        className="block h-6 w-8 rounded-lg"
        style={{
          background: value,
          border: "1px solid rgba(255,255,255,0.1)",
          boxShadow: `0 0 6px ${value}66`,
        }}
      />
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
    </label>
  );
}
