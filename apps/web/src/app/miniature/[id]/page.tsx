import Link from "next/link";
import MiniatureLive from "@/components/miniature/MiniatureLive";

/**
 * 只解析 params，状态由 MiniatureLive 在客户端拉取。
 * 不在 server 端读任务库：next.config.ts 开了 cacheComponents，
 * 服务端未缓存数据需要额外包 Suspense，且容易给出过期结论。
 *
 * `instant = false`：本页必须拿到任务 id 才能渲染，属于请求期数据。
 * 按 Next 文档（docs/01-app/02-guides/building.md 的 `[block]` 选项）
 * 显式声明为阻塞式路由，避免预渲染阶段报
 * "encountered runtime data during prerendering"。
 */
export const instant = false;
export default async function MiniatureDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main className="mx-auto max-w-5xl space-y-5 px-6 py-10">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/miniature" className="text-xs text-slate-500 hover:text-slate-300">
            ← 返回列表
          </Link>
          <h1 className="mt-1 text-lg font-semibold text-slate-100">微缩生成 · {id.slice(0, 8)}</h1>
        </div>
      </div>

      <MiniatureLive taskId={id} />

      <details className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-400">
        <summary className="cursor-pointer select-none">界面状态契约示例（fixture 示例，非真实产物）</summary>
        <div className="mt-3">
          <MiniatureLive taskId="fixture" fixture />
        </div>
      </details>
    </main>
  );
}
