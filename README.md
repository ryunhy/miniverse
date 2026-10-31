# MiniVerse

AI 驱动的高保真真实空间 3D 重建与交互式微缩世界编辑器。

上传真实房间的多张照片 → COLMAP 恢复相机位姿 → Nerfstudio Splatfacto 训练 Gaussian Splatting → 在浏览器中自由查看，并叠加可独立编辑的家具（移动 / 旋转 / 缩放 / 删除 / 保存）。

> **诚实声明**：本仓库的内置演示场景（编辑器「演示卧室」与 `/reconstructions/demo` 高斯场景）均为**程序生成数据**，页面有明确标注，不冒充真实重建。真实重建需要按 `docs/INSTALL-Windows-WSL2.md` 配置 COLMAP + Nerfstudio + CUDA 环境。

## 功能总览

| 优先级 | 能力 | 状态 |
|---|---|---|
| P0 | 3D 编辑器（WebGL 画布 / 轨道相机 / 点击选中 / 移动·旋转·缩放 Gizmo / 增删 / 属性面板 / 撤销重做 / 刷新恢复） | ✅ 已实现并实测 |
| P1 | 照片上传（类型·魔数·数量·大小校验）+ SQLite 持久化任务系统（状态机 / 重试 / 取消 / 日志） | ✅ 已实现并实测 |
| P2 | Python 重建流水线（预处理 → COLMAP → Splatfacto → 导出 PLY；OOM 降级重试） | ✅ **已实现并实测**：104 张真实照片完成位姿恢复+训练+导出（106MB PLY），详见 TEST_REPORT 第八节 |
| P3 | 浏览器 Gaussian Splatting 查看器（@sparkjsdev/spark）+ 重建结果自动导入编辑器 | ✅ 已实现并实测（真实重建数据渲染通过） |
| P4 | 场景 Schema v2（Zod 校验 / v1 迁移 / 素材白名单） | ✅ 已实现并实测 |

## 快速开始（仅前端 + 编辑器，无需 GPU）

```bash
npm install          # monorepo 根目录
npm run tools:glb    # 生成 14 个程序化家具 GLB
npm run tools:splat  # 生成演示高斯场景（真实 3DGS PLY 格式）
npm run dev          # http://localhost:3000
```

打开首页即自动创建演示场景并进入编辑器。`npm test` 跑 28 个单元测试。

## 启用真实重建

前置：NVIDIA GPU（8GB+ 显存可跑低配）、COLMAP、Nerfstudio（含 gsplat 编译）。完整步骤见 [docs/INSTALL-Windows-WSL2.md](docs/INSTALL-Windows-WSL2.md)。

```bash
# 1) 环境自检（输出 JSON 报告 + 结论）
cd services/reconstruction && python -m app.main check-env

# 2) 在 Web 界面「照片重建」上传 30~80 张环绕拍摄的房间照片
# 3) 任务自动排队 → GPU Worker 执行 → 完成后任务详情页内嵌高斯查看器
```

流水线细节：照片预处理（EXIF 校正 + 低显存降采样）→ COLMAP 特征/匹配/位姿图 → `ns-train splatfacto` → `ns-export gaussian-splat` → 产物 `scene.ply` 由 `/api/reconstructions/:id/result` 下发。OOM 自动降分辨率重试（最多 2 次），取消用 `cancel.flag` 文件协议。

## 架构

```
miniverse/
├── apps/web/               # Next.js 16 + React 19 + R3F 9 + spark
│   ├── src/app/            # 页面与 API（scenes / reconstructions / health）
│   ├── src/components/     # 编辑器（SceneCanvas/Furniture/面板）+ SplatViewer
│   ├── src/lib/server/     # SQLite 任务库 / 场景存储 / 上传校验 / Worker 派发
│   └── src/stores/         # Zustand 编辑器状态（undo/redo/双存储）
├── packages/shared/        # Zod 场景 Schema v2 + 素材白名单（前后端共享）
├── services/reconstruction/  # Python GPU 服务（文件协议与 Web 解耦）
├── tools/                  # GLB 家具生成器 / 演示高斯场景生成器
├── data/                   # uploads / processed / reconstructions / tasks(db) / scenes
└── docs/                   # 安装 / 环境报告 / 进度 / 测试报告
```

关键设计决策：

- **AI/重建结果与编辑数据分层**：高斯背景只读叠加，家具变换独立保存在场景 JSON 的 `objects[]`，互不污染。
- **素材白名单**：`assetId` 只能取自 `packages/shared/src/asset-catalog.ts`，禁止任意模型路径。
- **坐标系约定**：米、Y 轴向上、家具原点在底部中心；重建与编辑共享同一世界坐标。
- **文件协议解耦**：Web ↔ Python worker 通过 `data/tasks/<id>/{input,status,worker.log,cancel.flag}` 通信，Web 端读取时懒同步 SQLite。
- **渲染兜底**：`lib/render-fallback.ts` 探测 rAF 冻结（窗口遮挡等场景），自动切换 setInterval 直驱 `gl.render`；前台环境零开销。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` / `build` / `lint` / `typecheck` | Web 开发与验证 |
| `npm test` | vitest（schema / 状态机 / 上传校验 / 场景存取） |
| `npm run tools:glb` / `tools:splat` | 重新生成素材与演示数据 |
| `python -m app.main check-env`（services/reconstruction） | 重建环境自检 |
| `python -m app.main worker-loop --data-dir <data>` | 手动模式 GPU Worker |

## 许可证说明

代码为本仓库自有。第三方组件（COLMAP、Nerfstudio、gsplat、spark、GLB 生成器产物均为程序化生成）各自遵循其上游许可证，**商用前需逐项核对**，特别是模型权重与数据集授权。
