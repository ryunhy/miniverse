# PROGRESS — MiniVerse 2.0 通宵开发日志

> 会话时间：2026-10-24 01:31 ~ 03:00（北京时间）。上一会话（阶段一/二单应用原型）基础上的全面升级，交接信息见文末。
> 2026-10-24 傍晚追加：P1 体验闭环（加载进度条 + 训练相机取景 + 拍摄指引），见下方「P1 体验闭环」节；此后接原开发日志。

## P1 体验闭环（2026-10-24 傍晚会话，任务 #5872）

### 新增
- **高斯加载进度条**：`lib/splat-load.ts` 手动流式 fetch（spark url 直载无进度回调），下载百分比（Content-Length 未知时不确定态）→ 解析阶段 → ready；编辑器状态条 + 任务详情页覆盖层双 UI。
- **训练相机取景 API**：`GET /api/reconstructions/:id/cameras`（`lib/server/recon-cameras.ts`）——解析 COLMAP `images.bin`（u64 记录数头 + 逐条记录，points2D 跳过）+ `dataparser_transforms.json`，输出 nerfstudio 世界系相机位姿（position/forward/up）+ 点云中位数场景中心。合成 images.bin/points3D.bin 单测 7 例；样例任务 60 相机实测与独立验证脚本一致。
- **取景闭环**（schema `camera.autoFrame` 新字段）：加载重建背景时 autoFrame=true 才取景（训练相机优先→高斯中位数稳健取景兜底），取景/用户拖动后落 false 持久化，刷新不再重置视角。
- **坐标系修正**：对样例 PLY 44.5 万顶点协方差实证——nerfstudio 归一化系**竖直轴为 Z**（方差 5.87 ≪ X/Y 14.9），旧 X180 翻转把房间竖直映到编辑器 Z 轴（与 Y-up 家具错位，画面 roll/倒置的根因）。改为 **Rx(-90°)**（N 的 +Z→W 的 +Y），房间正立、OrbitControls 默认 up 直接可用；演示 PLY 本身 Y-up 保持恒等（synthetic 区分）。
- **训练相机选择算法**：位置偏离全体中位数 + 俯/仰惩罚 |fwd·up|（竖拍照片做初始视角会让 lookAt 退化产生 roll）；target 落在拍摄视线前方（到场景中心距离处）。
- **拍摄指引卡片**：上传页新增可折叠指引（30~80 张环绕 2~3 圈、60% 重叠、避免模糊/镜面/纯白墙、锁曝光）。
- 重建场景下 OrbitControls 距离放宽（min 0.2 / max 50，真实场景尺度由 COLMAP 归一化决定）。

### 实证
- vitest **40/40**（新增 recon-cameras 7 例）、tsc 0、eslint 0、build EXIT=0（12 路由）。
- cameras API：completed 任务 60 相机 JSON ✓；pending 任务 409 ✓。
- 浏览器 E2E（截图存档）：编辑器加载真实高斯后**正立真实拍摄视角**（沙发/躺椅/茶几/拖鞋/地毯/电视柜完整构图，无 roll）；camera.position=(-0.06,-0.189,0.667)/target=(-0.057,-0.358,-0.232)/autoFrame=false 持久化 ✓；**刷新后视角保持** ✓；任务详情页同视角正立 ✓；demo 页（演示 PLY 恒等姿态）不受影响 ✓。

### 踩坑记录（本轮新增 4 条）
14. images.bin 开头是 **u64 配准相机数**（104 张仅 60 张配准成功），逐条记录 u32 id + 7×f64 + u32 camera_id + name\0 + u64 n2d + n2d×24
15. nerfstudio 导出（exporter.py）直接用 `model.means`，无反变换——PLY 顶点系 = 训练归一化系；其竖直轴是 Z 不是 Y（orientation_method 未做 Y-up 对齐时）
16. OrbitControls 以 `camera.up` 为极轴做 polar/distance clamp：设置非默认 up 会把相机重排到异常位置（实测 Y≈20）；正确做法是把场景本身变换到 Y-up，而非挪 up
17. 视线与 up 近平行（俯/仰拍相机做初始视角）→ lookAt 退化 → 画面任意 roll；解法：选水平相机 + target 沿拍摄视线

### 下一步
P2：Grounding DINO + SAM 2 家具识别（origin=ai-detected/ai-inferred）；P1 剩余项：等用户自有照片走全流程（页面指引已就位）。

### P1 收官：「用户自有照片」级素材全流程实测（同日晚间，任务 #5872 后续）

用户不便拍摄，改为网上找真实素材替代实测（产品视角等价：真实手持设备拍摄的普通室内）：
- 素材：Pexels 免费视频 37674124/27975847 中选 **4K 公寓实拍视频**（8.7s，25fps，Pexels License 免费使用），ffmpeg 5fps 抽帧 **44 张**（≈60% 重叠）
- 全流程实测：API 上传 44 张 → 任务 `70597d42` → WSL `train-now` 模式直跑 → **COLMAP 2.5min + Splatfacto 10.5min + 导出 27s ≈ 14 分钟全程** → scene.ply 17.2MB → 一键导入 → 编辑器正立渲染、训练相机取景命中真实拍摄视角（截图留档）、视角保存刷新不重置
- 质量观察：4K 原片特征密度高，COLMAP 全部配准；视频原地小幅移动+俯仰的拍摄方式即可配准（对用户比「环绕 2~3 圈」门槛更低）；重建结构清晰（橱柜/冰箱/微波炉/行李箱/拖鞋可辨）
- 运维提醒：训练期 .wslconfig 临时 12GB（本轮备份 `.wslconfig.miniverse-p1-backup`，**已恢复 4GB**）；WSL 后台任务必须挂在常驻会话下（前台 sleep infinity 挂住 + 训练 nohup 后台），wsl.exe 单次调用退出会带走后台子进程
- Windows 侧 worker（spawn python -m app.worker）在 monorepo cwd 下报 ModuleNotFoundError: app——与本轮无关（WSL 直跑模式为主要路径），列入待修小问题

结论：**P1 全部完成**（含用户自有照片等价实测）。下一阶段 P2：Grounding DINO + SAM 2 家具识别。

### 查看模式：360° 环绕 + 三视图（同日晚间追加，响应用户反馈）

用户反馈「像照片查看，不是 3D 建模的 360°/三视图」。落地：
- **视图按钮组**（重建背景激活时顶栏显示）：环视（内部漫游）/ 360° / 正视 / 侧视 / 顶视。
- **orbit 视角带**（关键产品决策）：环绕距离取**训练相机到场景中心距离的中位数**（数据存在的位置带，Luma/Polycam 式），而非包围盒外——室内重建数据从外部看是「空腔+离群碎片」，推出去必糊。实现：`trainingViewpoint` 返回 `orbitRadius`，store `splatFrame` 承载，ViewPresetRig 应用预设。
- **全向轨道**：model 模式下 OrbitConstraints 放开（maxPolarAngle=π-0.03，可顶视/仰视整圈）；inside 模式维持不钻地约束。
- 实证：f1014582（环绕数据）360° 拖拽旋转全程有内容（截图）；正视预设下房间结构完整清晰（截图）。
- **诚实边界（已向用户说明）**：360° 画质上限=拍摄数据覆盖。70597d42（Pexels 单面视频）只有正面数据；要完整 360° 三视图需环绕拍摄素材（绕物体/房间整圈）。遗留演示 GLB 家具已从 69e00d43 清除（objects=[]）。
- 新发现缺陷（待修）：服务端短暂 5xx 时 EditorShell 回退 localStorage 旧镜像并自动保存回写，会冲掉服务端场景数据（本轮 69e00d43 的 reconstruction 字段曾被清为 none，已手工恢复）。

### 质量治理：30000 步重训消除 floater（同日夜间，响应用户「为什么看起来这么乱」）

诊断：用户看到满屏灰色絮状物 = **漂浮高斯（floater）**，根因是早期验证用 7000 步训练（recommend_steps 对 8GB 显存的保守值；splatfacto 官方默认 30000），欠训练下低质量高斯未被多视角一致性约束修剪。

处置：在 f1014582 已有 COLMAP 数据上直接重训（绕过 preprocess/COLMAP，WSL 脚本调 train_splatfacto(steps=30000) + export），36 分钟完成（19:37→20:14），新 PLY 119MB/47.99 万高斯（旧 110.5MB/44.58 万）。**重训后环视与 360° 视角絮状物大幅消失**（前后对比截图留档）。旧产物备份 `scene-7000steps-backup.ply`、旧训练目录 `run-7000-backup/`；status.json 已更新 steps=30000。

顺带修复（已 py_compile）：`export_gaussian_splat` 在 export_dir 已有 scene.ply 时会被旧文件掩盖（nerfstudio 1.x 实际输出 `splat.ply`，代码误读旧 scene.ply 的 stat 当成功）——改为先删旧 scene.ply、按 mtime 取最新 *.ply 换名。

经验沉淀：**「画面乱」第一反应查训练步数**——floater 是欠训练的典型症状，30000 步后基本消失；步数选择上 8GB 显存完全吃得消 30000 步（全程显存 ~5GB），recommend_steps 的 7000 保守值今后只用于快速冒烟。


## 已完成

### 第一阶段：环境诊断 ✅
- 实测输出：RTX 4070 Laptop 8GB / Win32 / WSL2（仅 docker-desktop）/ Python 3.10.6 / Node 24 / 32GB 内存 / 307GB 磁盘。
- 缺失：COLMAP、Nerfstudio、CUDA nvcc；torch import 链损坏（colorama 冲突）。→ 记录于 `docs/ENVIRONMENT.md`，重建走"完整实现 + 诚实降级"。

### 第二阶段：Monorepo 重构 ✅
- 单应用迁移为 `apps/web`，新增 `packages/shared`（workspace 依赖）、`services/reconstruction`、`tools`、`data`、`docs`。
- 新增依赖：`@sparkjsdev/spark@2.4.0`（three ≥0.180 兼容）、vitest 3。
- 坑：`next.config.ts` 里 `__dirname` 在 ESM 上下文为 undefined → `turbopack.root` 静默失效 → three/R3F 模块解析错乱（R3F Canvas 停 300×150）。**修复：`import.meta.dirname`**。此坑极隐蔽（构建可过、dev 可跑、仅渲染死）。

### P4：场景 Schema v2 ✅
- `packages/shared/src/scene-schema.ts`：schemaVersion=2、sceneId(uuid)、room(visible)、reconstruction(taskId/status/format/url/synthetic)、camera、objects[](visible/origin/materialOverrides)、lighting、metadata。
- `origin` 区分 `user / ai-detected / ai-inferred`（为阶段三 AI 识别预留，禁止混淆来源）。
- v1 → v2 迁移（color → materialOverrides）；`clampToRoom` 统一越界约束。
- 素材白名单 14 项带 `glbPath` 与 `footprint`。

### P0：编辑器 ✅（全部实测）
- 深色专业 UI：顶部（撤销/重做/移动·旋转·缩放/预览/保存/导入导出/重置）、左侧（素材库+场景树）、右侧属性面板、底部状态栏（存储模式/场景 ID/家具数/Python 环境状态）。
- GLB 加载：14 个程序化 glTF 2.0 二进制（`tools/generate-furniture-glb.mjs`，手动组 buffer/view/accessor，结构已校验），底部中心原点、米制、Y-up。
- 交互：点击选中（高亮环 + TransformControls 内嵌于 Furniture 组件）、三模式 Gizmo、Ctrl+Z / Ctrl+Shift+Z / Delete / Ctrl+D、隐藏/复制/删除、颜色覆盖、房间尺寸与灯光。
- 持久化：服务端 PUT（Zod 校验 + 原子写）+ localStorage 镜像双通道；**实测**：改书架 X 2.2→1.5 → 刷新 → 服务端返回 1.5 ✓。

### P1：上传与任务系统 ✅（全部实测）
- 上传校验：扩展名 + 魔数双重校验、3~120 张、单张 15MB；**丢弃客户端文件名**按序号落盘（根除路径穿越）；taskId UUID 白名单。
- SQLite（node:sqlite）任务库：`pending → processing → completed|failed|canceled` 状态机（非法流转抛错）、事件审计、`worker.log` 尾部读取、重试上限 3、单飞锁（PID 存活检测 + 僵尸锁清理）、cancel.flag 取消协议。
- API：`GET/POST /api/reconstructions`、`GET /:id`、`/:id/retry`、`/:id/cancel`、`/:id/result`（PLY 流式下发）、`GET /api/scenes`、`POST /api/scenes`、`GET/PUT/DELETE /api/scenes/:id`、`GET /api/health`。
- 前端：拖拽上传 + 缩略图预览 + XHR 进度 + 任务列表（状态徽章/重试/取消）+ 任务详情（事件/日志/内嵌高斯查看器）。

### P2：Python 重建流水线 ✅（代码完整，环境缺失时诚实降级）
- `preprocess.py`：EXIF 校正 + 按显存自动降采样（8GB→1200px）+ 质量报告。
- `colmap.py`：官方 CLI 三段（feature_extractor → exhaustive_matcher → mapper）+ 失败日志尾部提取 + 配准失败诊断提示。
- `train_splat.py`：`ns-train splatfacto`（按显存选步数）+ OOM 正则检测 + `ns-export gaussian-splat` → scene.ply + metadata.json。
- `worker.py`/`main.py`：文件协议（input/status/cancel）、阶段上报、OOM 自动降级（×0.75→×0.5，最多 2 次）、`check-env` 环境自检（**实测运行**：诚实输出缺 COLMAP/Nerfstudio/CUDA + torch 损坏原因 + 推荐参数）。
- Dockerfile（nvidia/cuda 12.1 + COLMAP + nerfstudio）与 requirements.txt（注明版本组合以官方文档为准）。

### P3：Gaussian Splatting 查看器 ✅（全部实测）
- `tools/generate-demo-splat.mjs`：生成**真实 3DGS 二进制 PLY**（6952 高斯点、f_dc SH 系数/logit opacity/log scale 编码），5×4×3m 演示房间，页面明确标注"程序生成演示数据，非真实重建"。
- `SplatViewerCore`（任务详情页内嵌）与 `SplatObject`（编辑器内叠加）双组件，spark SplatMesh URL 加载 + SparkRenderer。
- **实测渲染成功**（截图）：三面墙/地板/地毯/床/绿植/书桌全部正确呈现，包围盒 -2.5..2.5/-0..2.94/-2..1.93 与建模一致。

### 调试战役（本次最耗时的三个连环坑）
1. **turbopack.root 失效**（`__dirname` in ESM）→ 全局模块错乱。修复后 root 警告消失。
2. **StrictMode 双挂载 dispose**：useMemo 创建的 SplatMesh/SparkRenderer 被首次 cleanup 销毁后复用 → 黑屏。修复：实例在 effect 内创建（挂载即建，卸载即毁）。
3. **rAF 冻结**：内置浏览器窗口被遮挡时 Chromium 冻结 rAF（visibilityState 仍 visible），R3F always/demand 全部停摆（frame 停在 8/-1，draw calls=0）。逐层排除（Suspense、StrictMode、spark）后用 WebGL draw-call 探针 + rAF 存活测试定位。**修复：`lib/render-fallback.ts`** —— 探测冻结后 setInterval 直驱 `gl.render`，真实前台环境零开销。

## 测试结果（最终四件套）

| 项 | 结果 |
|---|---|
| vitest | **28/28 通过**（schema 校验/v1 迁移/白名单、任务状态机/持久化/重试上限、上传魔数·穿越·限额、场景往返/脏文件隔离） |
| tsc --noEmit | 0 错误 |
| eslint | 0 错误 0 警告 |
| next build | EXIT=0，11 路由 |
| 浏览器 E2E | 首页自动建场跳转、GLB 渲染、点击选中、属性联动、修改→刷新→服务端持久化、演示高斯渲染 —— 全部截图实证 |

## 已知限制 / 未完成（诚实清单）

1. **真实 GPU 训练未执行**——本机缺 COLMAP/Nerfstudio/CUDA，按"不伪造"原则保留完整流水线与诊断，环境就绪后一键可跑（`docs/INSTALL-Windows-WSL2.md`）。
2. Gizmo 拖拽在自动化测试中未验证移动（cua 合成拖拽未精确命中 gizmo 轴；事件链路经 OrbitControls 旋转实证通畅，数值移动经属性面板输入实证通过）。
3. AI 物体识别（Grounding DINO/SAM 2）与 3DGS 物体删除/背景补全：**未开始**（按任务书属后续研究阶段；schema 的 origin 字段已预留）。
4. 编辑器 `CameraRig` 的相机持久化在高斯背景模式下 target 为 (0,1,0) 固定值，重建场景的初始相机适配待真实数据调优。
5. 移动端触控未专门适配（OrbitControls 自带触控，但 UI 布局未做小屏优化）。

## 交接指引（新会话续作）

- 启动：根目录 `npm install && npm run dev`（端口 3000；调试期间用 `apps/web` 下 `npx next dev -p 3100`）。
- 任务库：`data/tasks/tasks.db`（SQLite，WAL）。重置演示数据：`npm run tools:glb && npm run tools:splat`。
- 重建环境装好后：`python -m app.main check-env` 看到 ✅ 即可在网页上传照片实测全链路。
- 修改共享 Schema 后同步跑 `npm test`；`packages/shared` 以 TS 源码被 web 直接引用（transpilePackages）。
- 渲染不显示时先查三件事：canvas 是否 300×150（root 配置）、控制台 StrictMode dispose、rAF 存活性（`render-fallback.ts` 已兜底，勿删）。

---

## 阶段更新：第二步「自动导入」完成（2026-10-24 上午会话）

按外部评审建议聚焦「真实照片重建 + 自动接入编辑器」，本轮落地接入半程（纯代码，不受 GPU 阻塞）：

### 新增
- `POST /api/scenes/from-reconstruction`（+ `lib/server/recon-scene.ts`）：完成任务 → 一键创建编辑器场景。校验链：任务存在 → completed → scene.ply 实际存在；`synthetic=false`、程序化房间外壳自动隐藏。
- 任务详情页：「导入到编辑器」按钮（成功后 router.push 进编辑器）。
- 编辑器：左上角重建背景状态条（加载中/失败态、任务详情链接、退出重建背景按钮恢复程序化外壳）。
- **相机自适应**：SplatObject 加载完成后按高斯包围盒自动取景（真实重建坐标系尺度/原点未知，不再假设对齐房间）。
- `tools/e2e-simulate-reconstruction.mjs`：E2E 链路模拟器（任务创建→产物就位→导入；脚本与页面均明确标注产物为演示 PLY）。

### 实证
- vitest **33/33**（新增 5 个自动导入用例：成功/未完成/产物缺失/不存在/穿越拒绝）；tsc、eslint 0 错误；build EXIT=0。
- 浏览器 E2E 截图：自动导入场景在编辑器中正确渲染高斯背景 + 状态条 + 相机自适应。

### 下一步（待决策/执行）
1. **第一步·真实重建**（需要用户决策）：WSL2 Ubuntu 安装（管理员+重启）或启动 Docker Desktop 走镜像，或云 GPU（¥4~12/h 需付费确认）——三路线对比见 docs/INSTALL-Windows-WSL2.md。
2. 第三步·家具识别（Grounding DINO + SAM 2）与第四步·3DGS 物体分离：未开始。

---

## 里程碑：第一次真实照片 3D 重建全链路打通（2026-10-24 下午会话）

按外部评审决策执行路线 1（WSL2 Ubuntu），单一目标：真实照片 → COLMAP → Splatfacto → PLY → 编辑器。

### 验收结果（对照评审标准）

| 标准 | 结果 |
|---|---|
| 真实照片 COLMAP 位姿恢复 | ✅ 104 张（Mip-NeRF360 room 抽帧），sequential matcher CPU，~20 分钟 |
| Splatfacto 训练 + PLY 导出 | ✅ 7000 步 / 1200px，scene.ply 106MB，exit=0 |
| MiniVerse 中自由查看 | ✅ 编辑器加载真实高斯并渲染（截图存档），可旋转缩放 |
| 记录显存峰值 / 耗时 / 质量 | 峰值 2987 MiB（8GB 的 37%）；训练总耗时 16 分 13 秒（含 gsplat 编译 ~10 分钟，纯训练 ~6 分钟）；PSNR 在 tensorboard 事件日志（data/processed/<task>/nerfstudio） |
| 失败保留日志、不用演示数据冒充 | ✅ 四次失败全程留痕（status.json/worker.log），成功产物为真实训练数据，页面无 synthetic 标记 |

### 数据来源声明
Mip-NeRF 360 "room" 场景（Google research storage，**CC BY-NC 4.0**——仅用于管线验证，禁止商用分发；用户提供自有照片后替换即可，流程完全一致）。

### 执行环境（最终形态）
WSL2 Ubuntu 22.04.1（Add-AppxPackage 安装）+ miniconda env `miniverse`（python 3.10.22 + torch 2.1.2+cu121 + cuda-toolkit 12.1 + nerfstudio）+ apt colmap（CPU）。Worker 以 `bash /root/train-now.sh`（MAX_JOBS=2）直跑任务。

### 本阶段踩坑全记录（每一条都已修复并沉淀到代码/文档）
1. `wsl --install` 依赖 raw.githubusercontent.com → 网络重置；绕道 aka.ms 直链 + Add-AppxPackage
2. AppxBundle 不支持 `wsl --install --from-file`（WSL_E_NOT_A_LINUX_DISTRO）
3. 新版 Miniconda 需 `conda tos accept`（defaults 渠道；商用分发应迁 conda-forge）
4. nerfstudio 1.x 无 `--vis none` → tensorboard；`--output` 应为顶层 `--output-dir`；COLMAP 原生数据用 `colmap` dataparser 且要求 `<data>/colmap/sparse/0` 结构（worker 已自动归位）
5. torch 2.1.2 需 `pkg_resources` → setuptools 降级 69.5.1
6. **WSL 内存被用户 .wslconfig 限 4GB** → OOM 杀 COLMAP/编译；训练期临时 12GB（原文件备份 .wslconfig.miniverse-backup，已恢复）
7. ninja 默认并行编译 → OOM；`MAX_JOBS=2` 限制
8. wsl.exe 把 `--` 后参数拼串交 /bin/sh → 复合命令分号拆裂；复杂操作必须走脚本文件
9. Git Bash MSYS 路径转换改写 `/root/...` → `MSYS_NO_PATHCONV=1`
10. WSL vmIdleTimeout 自动关机带走后台任务 → 保活会话 / 独立进程
11. input.json 的 Windows 路径 → worker 加 `wsl_path()` 转换
12. 快速任务无中间态 → 状态机允许 `pending → completed`
13. 相机自适应被离群高斯污染 → 改采样中位数稳健取景 + Y-down→Y-up 翻转（quaternion X180°）

### 交接
- 重建环境常驻：Ubuntu 内 `bash /root/train-now.sh` 模式直跑任务；或 `services/reconstruction/scripts/run-worker-wsl.sh` 常驻轮询。
- 用户拍摄自有房间照片后：上传 → 训练 → 自动导入，流程与本轮完全一致。
- 下一步（评审建议的第三/四步）：Grounding DINO + SAM 2 家具识别、3DGS 物体分离编辑——未开始。
