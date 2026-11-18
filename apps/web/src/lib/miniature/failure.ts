/**
 * 微缩失败归因（卡 #700122，1-3）：把 worker 上报的诊断码翻译成人话 + 解除条件 + 能否原样重试。
 *
 * 复用既有归因链路：诊断码由 worker 侧 `app/miniature/contracts.py` 产生、
 * 随 result.miniature.error / task.error 上报，码表与严重度定义在
 * `docs/miniature/CONTRACT.md` 第 4 节。本模块只做展示层映射，不改任何阈值与判定。
 */

export interface DiagnosisRow {
  /** 码表与 docs/miniature/CONTRACT.md §4 对齐；INSUFFICIENT_IMAGES 见 docs/miniature/DELIVERY.md 负例证据 */
  code: string;
  /** 一句话人话（页面直接展示） */
  human: string;
  /** 解除条件（怎么才能成功），来自契约 §4「解除条件」列 */
  recover: string;
  /** 原样重试（不改照片/输入）能否成功 */
  retryableAsIs: boolean;
}

const TABLE: DiagnosisRow[] = [
  { code: "NO_IMAGES", human: "照片目录里没有可用照片", recover: "放入 jpg/png/webp 照片后重新上传", retryableAsIs: false },
  { code: "INSUFFICIENT_IMAGES", human: "照片数量不足，凑不够可靠重建的最低门槛", recover: "补拍更多照片（建议 ≥20 张、多角度环绕）后重新上传", retryableAsIs: false },
  { code: "NO_SFM_BASELINE", human: "缺少相机位姿基准（COLMAP 稀疏模型）", recover: "需要先跑完整重建得到 COLMAP 结果，不能只重试微缩", retryableAsIs: false },
  {
    code: "LOW_REGISTRATION",
    human: "照片之间重叠太少，大部分照片没能定位到统一坐标系",
    recover: "补拍重叠视角（相邻照片画面重叠约 2/3）或重跑匹配",
    retryableAsIs: false,
  },
  { code: "LOW_AZIMUTH_COVERAGE", human: "站位环绕不足 180°，只是视差提示", recover: "环绕补拍（不阻塞生成，可忽略）", retryableAsIs: true },
  { code: "LOW_LOOKDIR_COVERAGE", human: "拍摄朝向覆盖不足 180°，看不全所需的两面墙", recover: "原地转身补拍另一侧后再上传", retryableAsIs: false },
  { code: "CORRUPT_IMAGE", human: "有照片文件损坏、无法解码", recover: "删除或替换损坏的照片文件", retryableAsIs: false },
  { code: "DUPLICATE_SCENE", human: "这批照片和已有场景重复（同一场景传过）", recover: "换一个独立的新场景再上传", retryableAsIs: false },
  { code: "UNMETRIC_SCALE", human: "照片里没有米制基准物", recover: "提供标定物可解锁真实尺寸（不阻塞生成）", retryableAsIs: true },
  { code: "DISTORTION_NOT_UNDISTORTED", human: "照片带镜头畸变但未声明已去畸变", recover: "去畸变或声明 undistorted=True", retryableAsIs: false },
  { code: "SCALE_INCONSISTENT", human: "坐标轴/尺度口径自相矛盾（产物问题）", recover: "属于管线产物缺陷，需要修代码后重跑", retryableAsIs: false },
  { code: "UNSUPPORTED_ROOM", human: "地板以上的内容太少或找不到家具实例", recover: "换场景或补足房间内容覆盖", retryableAsIs: false },
  { code: "NO_DEPTH_FOR_BAKE", human: "稀疏点云为空，无法聚类与烘焙", recover: "补拍让 COLMAP 能生成足够稀疏点", retryableAsIs: false },
];

export interface Diagnosis {
  code: string;
  human: string;
  recover: string;
  /** 该码对应的输入是否原样重试就能成功 */
  retryableAsIs: boolean;
}

export interface FailureExplanation {
  /** 一句话总结（已完成但无产物 / 任务失败） */
  summary: string;
  /** 识别到的诊断码（按出现顺序，最多去重） */
  codes: Diagnosis[];
  /** 所有识别到的码都允许原样重试时为 true；识别不到码时也为 true（未知原因，先试一次重试） */
  retryableAsIs: boolean;
  /** 识别不到任何已知诊断码时给出兜底说明 */
  unknownReason?: string;
}

const CODE_RE = new RegExp(TABLE.map((r) => r.code).join("|"), "g");

/** 从文本里扫描已知诊断码（按出现顺序去重），最多 5 个。 */
export function scanDiagnosticCodes(...texts: (string | null | undefined)[]): Diagnosis[] {
  const found: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(CODE_RE)) {
      if (!found.includes(m[0])) found.push(m[0]);
    }
  }
  return found.slice(0, 5).map((code) => {
    const row = TABLE.find((r) => r.code === code)!;
    return { code: row.code, human: row.human, recover: row.recover, retryableAsIs: row.retryableAsIs };
  });
}

/**
 * 归因入口：
 * - task.status=failed → 原因在 task.error / 阶段 detail；
 * - task 完成（或部分完成）但没有可用 GLB → 原因在 result.miniature 的 error / failed_stage / stages。
 * 返回 null 表示无需归因（没有失败语义）。
 */
export function explainMiniatureFailure(input: {
  status: string;
  error?: string | null;
  miniatureStatus?: string | null;
  miniatureError?: string | null;
  failedStage?: string | null;
  stageDetails?: (string | null | undefined)[];
}): FailureExplanation | null {
  const failed = input.status === "failed";
  const endedWithoutGlb =
    (input.status === "completed" || input.status === "partial") && input.miniatureStatus && input.miniatureStatus !== "ok" && input.miniatureStatus !== "degraded";
  if (!failed && !endedWithoutGlb) return null;

  const codes = scanDiagnosticCodes(
    input.error,
    input.miniatureError,
    input.failedStage ? `微缩阶段 ${input.failedStage} 失败` : null,
    ...(input.stageDetails ?? []),
  );
  const prefix = failed ? "生成失败" : "照片处理未能生成可用的微缩模型";
  if (codes.length === 0) {
    const raw = (input.error || input.miniatureError || "").trim();
    return {
      summary: `${prefix}，worker 未给出可识别的原因${raw ? "，原始信息见下" : ""}`,
      codes: [],
      retryableAsIs: true,
      unknownReason: raw || undefined,
    };
  }
  return {
    summary: `${prefix}：${codes.map((c) => c.human).join("；")}`,
    codes,
    retryableAsIs: codes.every((c) => c.retryableAsIs),
  };
}
