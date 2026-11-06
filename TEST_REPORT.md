# TEST_REPORT — MiniVerse 2.0

测试时间：2026-10-24 01:50 ~ 03:00。所有结论均来自实际执行，无"应该能跑"表述。

> **本报告为 2026-10-24 历史快照**：其中的 28/28、33/33、11 路由、12 路由与「eslint 0 错误」均为当时记录，不追改；当前实测（2026-11-02）为 vitest 45/45、build 17 条路由（含 `/_not-found`）、eslint 2 errors + 1 warning。以实测为准。

## 一、自动化测试（vitest，28/28 通过）

```
npm test
Test Files  4 passed (4)
     Tests  28 passed (28)
```

| 套件 | 覆盖 | 关键断言 |
|---|---|---|
| `packages/shared/src/scene-schema.test.ts`（8） | Schema v2 | 合法场景默认值填充；拒绝非法颜色/负缩放/非法 origin/越界房间/schemaVersion 不符/非法 uuid；**v1→v2 迁移**（color→materialOverrides）；演示场景 7 件家具且全部命中白名单；clampToRoom 越界拉回 |
| `apps/web/src/lib/server/task-store.test.ts`（7） | 任务状态机 | pending→processing→completed 合法流转；**拒绝** completed→processing、pending→completed（跳步）；failed→canceled→retry 累加 attempts；重试上限 3 次抛错；processing 中不可重试；**跨实例持久化**（关闭重开 db 后状态/参数/事件完整） |
| `apps/web/src/lib/server/uploads.test.ts`（7） | 上传安全 | **路径穿越根除**（`../../etc/passwd.png` 落盘为 `001.png`）；数量下限/上限；扩展名白名单；**魔数校验拒绝伪装图片**（PHP shell 改名 .png 被拒）；空文件/超 15MB 拒绝；非法 taskId 拒绝 |
| `apps/web/src/lib/server/scene-store.test.ts`（5） | 场景存取 | 保存→读取完整往返；拒绝写入非法场景；列表按更新时间倒序含摘要；删除后 404 语义；**脏文件隔离**（损坏 JSON 不影响其他场景列表） |

## 二、静态检查与构建

| 项 | 命令 | 结果 |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | 0 错误 |
| ESLint | `npx eslint .` | 0 错误 0 警告 |
| 生产构建 | `npm run build` | **EXIT=0**，编译 3.4s，11 路由（4 静态 + 7 动态 API） |

## 三、API 实测（curl，dev 服务器 :3100）

| 用例 | 结果 |
|---|---|
| `POST /api/scenes {"template":"demo"}` | 201，返回合法 v2 场景（7 objects） |
| `GET /api/scenes/<id>` | 200，书架 position=[1.5,0,1.2]（浏览器修改后**持久化验证**） |
| `GET /api/health` | 200，`{"python":"python","workerBusy":false,"taskCount":0,"sceneCount":N}` |
| `GET /demo/demo-room.ply` | 200，473219 字节，PLY 头合法（binary_little_endian，17 float 属性/顶点） |

## 四、浏览器端到端（内置 Chromium，WebGL2 + RTX 4070 硬件加速）

| # | 场景 | 步骤 | 结果 |
|---|---|---|---|
| 1 | 首页自动建场 | 打开 `/` | 自动创建演示场景并跳转 `/editor/<uuid>`，工具栏/素材库/属性面板/状态栏齐全 ✅ |
| 2 | 3D 渲染（GLB） | 截图 | 双人床（床头板/床垫/枕头/蓝毯）、书桌、椅、书架、绿植、地毯全部正确渲染 ✅（截图存档 session artifacts） |
| 3 | 点击选中 | 点击床 | 属性面板显示"双人床 assetId=bed_double"，位置/旋转与场景 JSON 一致 ✅ |
| 4 | 编辑持久化 | 面板改书架 X=1.5 → 等 2s → **刷新** → 场景树 | 7 件家具全部恢复；`GET /api/scenes/<id>` 证实 X=1.5 已落盘；状态栏"服务端已同步" ✅ |
| 5 | Gizmo | 选中床截图 | TransformControls 三轴 + 选中高亮环显示；拖拽触发 OrbitControls 旋转（事件链路通）；合成拖拽未精确命中 gizmo 轴，**数值移动经面板输入验证** ⚠️ |
| 6 | 高斯查看器 | 打开 `/reconstructions/demo` 截图 | **真实 3DGS PLY 渲染成功**：6952 高斯点，三面墙/地板/地毯/床/绿植/书桌正确呈现，"程序生成演示数据"标注可见 ✅ |
| 7 | WebGL 能力 | getContext webgl2 + 扩展探测 | EXT_color_buffer_float / OES_texture_float_linear / EXT_float_blend 全支持 ✅ |

## 五、重建流水线可用性检查

| 项 | 结果 |
|---|---|
| `python -m app.main check-env` | 退出码 2（预期），JSON 报告诚实输出：colmap=false / nerfstudio=false / torch_cuda=false（import 冲突原因：`colorama has no attribute init`）/ vram=7.99GB / 推荐 max_resolution=1200、steps=7000 |
| 流水线代码路径 | preprocess/colmap/train_splat/export 五模块 import 通过（Pillow 标准链路）；COLMAP/ns-train 路径含失败日志尾部提取与 OOM 降级重试 |
| 未执行真实训练 | **本机环境不满足，按任务书"不伪造"原则保留完整实现**；环境就绪步骤见 `docs/INSTALL-Windows-WSL2.md`，Docker 路线见 `services/reconstruction/Dockerfile` |

## 六、发现的缺陷与修复记录

| 缺陷 | 根因 | 修复 | 回归验证 |
|---|---|---|---|
| R3F Canvas 停 300×150（全局） | `next.config.ts` ESM 下 `__dirname` undefined → turbopack.root 失效 → three 模块错乱 | `import.meta.dirname` | root 警告消失，/lab 最小页可渲染 |
| spark 黑屏（首次） | StrictMode 双挂载 dispose 掉 useMemo 实例 | 实例改在 effect 内创建 | demo 页 dbg.state=ready |
| 画面停首帧（深挖后） | IAB 窗口遮挡 → Chromium 冻结 rAF（visibilityState 仍 visible），R3F 所有 frameloop 依赖 rAF | `lib/render-fallback.ts`：探测冻结后 setInterval 直驱 gl.render | 高斯/编辑器渲染截图实证 |
| TaskStore.close 二次调用崩溃 | 幂等缺失 | `if (this.db.isOpen)` 守卫 | 28/28 通过 |
| `force-dynamic`/`runtime` 导出与 cacheComponents 不兼容 | Next 16 约束 | 移除 8 个 route 的该导出（Handler 默认动态） | build EXIT=0 |
| editor/[id] 直开 404 语义 | dynamic ssr:false 在 Server Component 禁用 + useParams 需 Suspense | 页面改客户端组件 + Suspense 包裹 | build 11/11 页面生成 |

## 七、遗留风险

1. Gizmo 拖拽的自动化验证依赖真实鼠标命中精度，建议人工验收（功能代码路径与面板输入共用 `updateObject`，面板路径已实证）。
2. 高斯查看器在真实重建数据（百万级高斯）下的性能未测（spark 支持 LOD，必要时开启）。
3. 上传 API 无并发限流（单 worker 锁已防 GPU 并发，但 HTTP 层可被刷）；生产部署前需加鉴权与配额。

---

## 八、真实照片重建端到端验证（2026-10-24 下午会话追加）

**这是核心产品能力的首次完整实证**：用户路径全链路（照片上传 → COLMAP → Splatfacto → PLY → 编辑器查看）在真实数据上跑通。

| 环节 | 实测结果 |
|---|---|
| 重建环境 | WSL2 Ubuntu 22.04.1 + torch 2.1.2+cu121（CUDA 可用）+ nerfstudio（ns-train/ns-export）+ apt colmap；`check-env` 全项 ✅ |
| 数据 | Mip-NeRF 360 "room"（311 张真实室内照片，**CC BY-NC 4.0，仅限管线验证**），抽帧 104 张 |
| COLMAP 位姿恢复 | ✅ sequential matcher（CPU），sparse/0 三件套落盘，约 20 分钟 |
| Splatfacto 训练 | ✅ 7000 步 / 1200px / MAX_JOBS=2 编译 gsplat；**总耗时 16 分 13 秒**（含编译 ~10 分钟） |
| 显存峰值 | **2987 MiB / 8188 MiB（37%）**（nvidia-smi 5 秒采样，/root/gpu-mon.log） |
| 产物 | scene.ply **106MB**；status.json result 含完整环境/参数记录；attempts=1 |
| 自动导入 | ✅ `POST /api/scenes/from-reconstruction` → 编辑器加载渲染（截图存档 session artifacts） |
| 失败留痕 | 前四轮失败（vis 参数 / CLI 结构 / colmap 归位 / pkg_resources+OOM）全部保留 status.json 与日志，无删改 |

回归确认：vitest 33/33、tsc 0 错误、eslint 0 错误、build EXIT=0（12 路由）。

**限制声明**：CC BY-NC 数据集不可商用；COLMAP 坐标系无重力对齐（查看视角为稳健居中）；PSNR 指标在 tensorboard 事件文件中未做自动提取。
