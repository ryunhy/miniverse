"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import MiniatureUploader from "@/components/miniature/MiniatureUploader";
import { api } from "@/lib/api";
import { deriveMiniatureView, type MiniatureView } from "@/lib/miniature/stages";

/**
 * 与其他页面同一模式：client 组件 + /api 拉取。
 * 不在 server 端读任务库 —— next.config.ts 开了 cacheComponents，
 * 服务端未缓存的数据必须进 Suspense，徒增复杂度且给了过期结论的机会。
 */
export default function MiniatureHome() {
  const [rows, setRows] = useState<MiniatureView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const { tasks } = await api.listTasks();
        if (!alive) return;
        setRows(tasks.slice(0, 20).map((t) => deriveMiniatureView(t)));
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "任务列表读取失败");
      }
    };
    load();
    const iv = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-6 py-10">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-100">照片 → 微缩模型</h1>
        <p className="text-sm text-slate-400">
          上传一组房间照片，自动完成结构识别、家具分离、几何补全与照片纹理烘焙，产出可下载的 GLB。
        </p>
      </header>

      <MiniatureUploader />

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-slate-300">最近的生成</h2>
        {error && (
          <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300" data-testid="list-error">
            任务列表读取失败：{error}
          </p>
        )}
        {!error && rows.length === 0 && <p className="text-xs text-slate-500">还没有任务。</p>}
        <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
          {rows.map((v) => (
            <li key={v.taskId}>
              <Link
                href={`/miniature/${v.taskId}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-slate-900/60"
                data-testid="task-row"
              >
                <span className="font-mono text-xs text-slate-400">{v.taskId.slice(0, 8)}</span>
                <span className="text-xs text-slate-300">{v.status}</span>
                <span className={`text-xs ${v.ready ? "text-emerald-300" : "text-slate-500"}`}>
                  {v.ready ? "可预览 / 下载" : "无产物"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
