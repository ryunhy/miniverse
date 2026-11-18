# 数据取数口径：`data/processed` 与 `data/uploads` 不一致

> 本文解决一个会反复咬人的坑：**拿 `uploads` 当分母算注册率，会算出大于 100% 的值。**
> 结论只涉及"怎么读数"，不改任何计算逻辑。

## 1. 现象（2026-11-12 实测）

| 任务 | 当前 `data/uploads` 照片数 | `processed/images` 文件数 | `preprocess_report.input_count` | `database.db` images 行数 | `sparse/0` 注册图像 |
|---|---|---|---|---|---|
| c858acee-c175-4813-a266-a0ab4978cd82 | **45** | **78** | 78 | 78 | 76 |
| 34d9d0f6-c406-4dd4-b9b0-e0caeeacfaea | **23** | **39** | 39 | 39 | 23（`sparse/1` 另有 16） |

如果拿 uploads 做分母：

- c858acee `76 / 45 = 168.9%`
- 34d9d0f6 合并子模型后 `37 / 23 = 160.9%`

这两个数都没有意义。

## 2. 为什么会错位

`processed/<id>/` 是**任务第一次运行时留下的快照**，`uploads/<id>/` 是**可变的输入目录**。
任务跑过之后，上传目录可能被替换、清空、或删掉一部分照片，而 processed 不会跟着变。

时间戳证据（c858acee）：

| 路径 | 时间 |
|---|---|
| `uploads/c858acee/` 最新文件 | 2026-10-30 18:02:14 |
| `processed/c858acee/images/` | 2026-10-30 18:02:23 – 18:02:34 |
| `processed/c858acee/preprocess_report.json` | 2026-10-30 18:02:34（`input_count=78`） |
| `processed/c858acee/database.db` | 2026-10-30 18:05:53（images=78） |
| `processed/c858acee/sparse/0/images.bin` | 2026-10-30 18:06:16（注册 76） |

当时上传的是 78 张，processed 也是按 78 张生成的。当前 uploads 只剩 45 张，
说明上传目录在之后被改过，processed 仍是旧快照。

34d9d0f6 同理：processed 39 张、`input_count=39`、`database.db` 39 行，
当前 uploads 只剩 23 张。

## 3. 正确取数方式

**注册率的分母永远是 `processed/<id>/images` 的文件数，不是 `uploads`。**

推荐用三处交叉核验，三者相等才说明这批数据是自洽的：

```
preprocess_report.json::input_count
  == processed/<id>/images/ 下的图片文件数
  == database.db 的 `select count(*) from images`
```

分子是 `sparse/<n>/images.bin` 里的图像条数（不是 `cameras.bin`）。
有多个子模型时，先按图像名取并集去重，再除以分母：

```
合并后注册率 = |∪ sparse/*/images.bin 的图像名| / processed/images 文件数
```

现有 6 个任务的正确结果（2026-11-12 实测）：

| 任务 | 注册图像（合并后） | 分母 | 注册率 |
|---|---|---|---|
| 34d9d0f6 | 37 | 39 | 94.9% |
| 520b63da | 5 | 5 | 100% |
| 5955bff8 | 3 | 3 | 100% |
| 70597d42 | 44 | 44 | 100% |
| c858acee | 76 | 78 | 97.4% |
| f1014582 | 102 | 104 | 98.1%（只看 `sparse/0` 是 60/104 = 57.7%） |

## 4. 一行自检

在仓库根目录执行（只读）：

```bash
python -c "import json,sqlite3,pathlib;
d=pathlib.Path('data/processed');
[print(t.name[:8],
  'report=', json.load(open(t/'preprocess_report.json'))['input_count'] if (t/'preprocess_report.json').exists() else None,
  'files=', len([p for p in (t/'images').glob('*') if p.suffix.lower() in {'.jpg','.jpeg','.png','.webp'}]) if (t/'images').exists() else None,
  'db=', sqlite3.connect(f'file:{t}/database.db?mode=ro', uri=True).execute('select count(*) from images').fetchone()[0] if (t/'database.db').exists() else None)
 for t in sorted(d.iterdir()) if t.is_dir() and (t/'database.db').exists()]"
```

三列不相等的那一行，就是数据已经错位的任务。

## 5. 两个隐患的处理状态（2026-11-12 已修）

1. **`preprocess()` 不清理输出目录** —— 已修。`preprocess.py` 现在会按源图计算
   `(文件名, 大小, sha256)` 指纹，落盘 `processed/<id>/input_fingerprint.json`；
   指纹与上次不一致（或缺失）时，先清空 `images/`、`sparse/`、`database.db*`、
   `colmap/sparse/`，再重新预处理，并在日志里写明"输入变更，已作废旧位姿重建"。
2. **COLMAP 有产物缓存** —— 已加防护。`colmap.py` 的缓存分支现在要求输入指纹存在，
   缺指纹（历史任务）会打 warning；真正的作废动作由 `preprocess()` 完成，确保
   "有 `images.bin` 就跳过"不会发生在换图之后。

正确重跑流程：

- **正常重跑**：直接重跑任务即可。指纹一致 → 保留 COLMAP 位姿；换过照片 → 自动作废重建。
- **历史任务第一次重跑**：没有指纹文件，会按"输入变更"处理，清空一次旧位姿后重建。
  这是有意为之：无法证明输入一致时，复用风险大于重建成本。
- **绝对不要**手工删一半产物再跑；要么让指纹机制处理，要么清空整个 `processed/<id>/`。
