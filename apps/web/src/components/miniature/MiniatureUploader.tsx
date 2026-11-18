"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** 通用「照片 → 微缩」入口：不预设场景、不需要手选区域。 */
export default function MiniatureUploader() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const submit = async () => {
    setErr(null);
    if (files.length < 3) {
      setErr("至少需要 3 张照片");
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      for (const f of files) form.append("photos", f);
      // worker 只认 params.miniature（services/reconstruction/app/worker.py:193）；
      // 传 exportMesh 会额外跑 2DGS 网格导出，与本入口无关且慢很多。
      form.append("params", JSON.stringify({ miniature: true }));
      const res = await fetch("/api/reconstructions", { method: "POST", body: form });
      const body = (await res.json()) as { task?: { id: string }; error?: string };
      if (!res.ok || !body.task) {
        setErr(body.error ?? `创建失败（HTTP ${res.status}）`);
        return;
      }
      router.push(`/miniature/${body.task.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <input
        ref={input}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        data-testid="photo-input"
        onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        className="w-full rounded-lg border border-dashed border-slate-700 px-4 py-8 text-sm text-slate-300 hover:border-slate-500 hover:bg-slate-800/40"
      >
        选择照片（3~120 张，JPG / PNG / WebP）
      </button>
      {files.length > 0 && (
        <p className="mt-2 text-xs text-slate-400" data-testid="selected-count">
          已选 {files.length} 张
        </p>
      )}
      {err && <p className="mt-2 text-xs text-rose-300">{err}</p>}
      <button
        type="button"
        disabled={busy || files.length < 3}
        onClick={submit}
        className="mt-3 w-full rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white disabled:opacity-40"
      >
        {busy ? "正在创建任务…" : "开始生成微缩模型"}
      </button>
      <p className="mt-2 text-[11px] text-slate-500">
        换一组照片即可重跑同一套流程：不需要改代码、不需要框选区域、不需要手工修模。
      </p>
    </div>
  );
}
