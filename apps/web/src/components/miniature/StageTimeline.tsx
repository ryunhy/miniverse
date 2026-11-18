import type { StageView } from "@/lib/miniature/stages";

const STYLE: Record<string, { dot: string; text: string; label: string }> = {
  done: { dot: "bg-emerald-400", text: "text-emerald-300", label: "完成" },
  running: { dot: "bg-sky-400 animate-pulse", text: "text-sky-300", label: "进行中" },
  failed: { dot: "bg-rose-500", text: "text-rose-300", label: "失败" },
  skipped: { dot: "bg-slate-600", text: "text-slate-400", label: "跳过" },
  not_started: { dot: "bg-slate-700", text: "text-slate-500", label: "未开始" },
  unknown: { dot: "bg-slate-700", text: "text-slate-500", label: "未上报" },
};

/** 六阶段时间线。不显示百分比——后端没有逐阶段进度时不能编。 */
export default function StageTimeline({ stages }: { stages: StageView[] }) {
  return (
    <ol className="space-y-2" data-testid="stage-timeline">
      {stages.map((s, i) => {
        const st = STYLE[s.state] ?? STYLE.unknown;
        return (
          <li key={s.key} className="flex items-start gap-3 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
            <span className="mt-1 text-[10px] tabular-nums text-slate-600">{String(i + 1).padStart(2, "0")}</span>
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${st.dot}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-sm text-slate-200">{s.label}</span>
                <span className={`text-[11px] ${st.text}`}>{st.label}</span>
              </div>
              <p className="truncate text-[11px] text-slate-500">{s.detail ?? s.hint}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
