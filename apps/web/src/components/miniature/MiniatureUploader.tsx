"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 门槛与后端硬门对齐：阈值单一出处是
 * services/reconstruction/app/miniature/contracts.py::THRESHOLDS 与
 * docs/miniature/THRESHOLDS.md（min_images=20，error；min_lookdir_bins=6/12=180°，error）。
 * 前端只对齐提示与拦截，不定义、不修改阈值；后端也不会为迁就前端调低。
 *
 * 两种覆盖度必须分开说清（上一轮误判的来源就是混为一个指标）：
 * - 朝向覆盖 lookdir：原地转身拍摄，决定"能不能看到两面墙"，是准入硬门；
 * - 站位环绕 azimuth：人绕房间走动的范围，只影响视差与遮挡补全质量，仅提示、不阻塞。
 */
const MIN_PHOTOS = 20;

/** 通用「照片 → 微缩」入口：不预设场景、不需要手选区域。 */
export default function MiniatureUploader() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const submit = async () => {
    setErr(null);
    if (files.length < MIN_PHOTOS) {
      setErr(`至少需要 ${MIN_PHOTOS} 张照片（后端准入硬门，少于 ${MIN_PHOTOS} 张必被拒绝）`);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      const form = new FormData();
      for (const f of files) form.append("photos", f);
      // worker 只认 params.miniature（services/reconstruction/app/worker.py:193）；
      // 传 exportMesh 会额外跑 2DGS 网格导出，与本入口无关且慢很多。
      form.append("params", JSON.stringify({ miniature: true }));
      const res = await fetch("/api/reconstructions", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const body = (await res.json()) as { task?: { id: string }; error?: string };
      if (!res.ok || !body.task) {
        setErr(body.error ?? `创建失败（HTTP ${res.status}）`);
        return;
      }
      router.push(`/miniature/${body.task.id}`);
    } catch (e) {
      if (controller.signal.aborted) {
        // 用户主动取消：不是错误。回到可选态，已选照片保留，可再次提交。
        setErr(null);
      } else {
        setErr(e instanceof Error ? e.message : "创建失败");
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  const tooFew = files.length > 0 && files.length < MIN_PHOTOS;

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
        disabled={busy}
        onClick={() => input.current?.click()}
        className="w-full rounded-lg border border-dashed border-slate-700 px-4 py-8 text-sm text-slate-300 hover:border-slate-500 hover:bg-slate-800/40 disabled:opacity-40"
      >
        选择照片（{MIN_PHOTOS}~120 张，JPG / PNG / WebP）
      </button>
      {files.length > 0 && (
        <p className="mt-2 text-xs text-slate-400" data-testid="selected-count">
          已选 {files.length} 张
        </p>
      )}
      {tooFew && (
        <p className="mt-1 text-xs text-amber-300" data-testid="threshold-hint">
          还差 {MIN_PHOTOS - files.length} 张：至少 {MIN_PHOTOS} 张才能提交（后端硬门，少于 {MIN_PHOTOS} 张会被直接拒绝）。
        </p>
      )}
      {err && <p className="mt-2 text-xs text-rose-300">{err}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          data-testid="submit-upload"
          disabled={busy || files.length < MIN_PHOTOS}
          onClick={submit}
          className="w-full rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white disabled:opacity-40"
        >
          {busy ? "正在创建任务…" : "开始生成微缩模型"}
        </button>
        {busy && (
          <button
            type="button"
            data-testid="cancel-upload"
            onClick={cancel}
            className="shrink-0 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
          >
            取消上传
          </button>
        )}
      </div>
      <div className="mt-2 space-y-1 text-[11px] leading-4 text-slate-500">
        <p>
          拍摄要求（硬门）：至少 {MIN_PHOTOS} 张；请原地转身拍摄，让相机朝向覆盖至少半圈（180°），
          保证两面墙都被看到。朝向覆盖不足会被后端拒绝。
        </p>
        <p>
          站位环绕（绕房间走动）只影响细节质量，不是硬门：朝向覆盖够时，站位不必绕满一圈。
        </p>
        <p>换一组照片即可重跑同一套流程：不需要改代码、不需要框选区域、不需要手工修模。</p>
      </div>
    </div>
  );
}