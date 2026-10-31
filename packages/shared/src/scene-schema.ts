import { z } from "zod";

/**
 * MiniVerse 场景数据结构 v2（P4）
 *
 * 坐标系约定：
 * - 单位：米
 * - Y 轴向上，地板平面为 XZ，y=0 为地面
 * - 家具 position 为其底部中心点（与素材 GLB 的原点约定一致）
 * - 重建背景（Gaussian Splatting）与编辑器共享同一世界坐标系
 */

export const SCHEMA_VERSION = 2;

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "必须是 #RRGGBB 格式颜色");

export const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

/** 物体来源：区分真实检测 / 模型推测 / 用户手动添加（禁止混淆） */
export const objectOriginSchema = z.enum(["user", "ai-detected", "ai-inferred"]);

export const materialOverridesSchema = z.object({
  color: hexColorSchema.optional(),
});

export const sceneObjectSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  label: z.string().max(50).optional(),
  /** 底部中心点，米 */
  position: vec3Schema,
  /** 欧拉角（弧度）；编辑器仅允许绕 Y 轴旋转 */
  rotation: vec3Schema,
  scale: vec3Schema.refine(
    (s) => s.every((v) => v > 0),
    "缩放必须为正数"
  ),
  visible: z.boolean().default(true),
  origin: objectOriginSchema.default("user"),
  materialOverrides: materialOverridesSchema.default({}),
});

export const roomSchema = z.object({
  width: z.number().min(2).max(20),
  depth: z.number().min(2).max(20),
  height: z.number().min(2).max(6),
  floorColor: hexColorSchema,
  wallColor: hexColorSchema,
  /** 重建背景激活时可隐藏程序化房间外壳 */
  visible: z.boolean().default(true),
});

export const reconstructionStatusSchema = z.enum([
  "none",
  "pending",
  "processing",
  "completed",
  "failed",
]);

export const reconstructionSchema = z.object({
  /** 关联的重建任务 ID；null 表示未使用重建背景 */
  taskId: z.string().nullable().default(null),
  status: reconstructionStatusSchema.default("none"),
  format: z.enum(["none", "gaussian-splat"]).default("none"),
  /** 高斯数据访问地址（同源 API 路径或 /demo 静态路径） */
  url: z.string().nullable().default(null),
  /** true = 演示/程序生成数据，必须在 UI 上明确标注，禁止冒充真实重建 */
  synthetic: z.boolean().default(false),
  /**
   * 重建环境平均色（#RRGGBB），用于填补「未观测区域」时的背景兜底色。
   * null = 未采样，前端回退到房间墙/地色的混合色。不参与几何，仅影响观感。
   */
  ambientColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
});

export const cameraSchema = z.object({
  position: vec3Schema,
  target: vec3Schema,
  fov: z.number().min(20).max(100),
  /** true = 视角尚未确认，加载重建背景时允许自动取景一次；取景或用户交互保存后置 false（旧场景缺省视为未确认） */
  autoFrame: z.boolean().default(true),
});

export const lightingSchema = z.object({
  preset: z.enum(["warm", "cool", "neutral", "night"]),
  intensity: z.number().min(0.2).max(3),
});

export const metadataSchema = z.object({
  name: z.string().min(1).max(60).default("未命名场景"),
  createdAt: z.string().datetime().default(() => new Date().toISOString()),
  updatedAt: z.string().datetime().default(() => new Date().toISOString()),
  /** true = 内置演示场景 */
  demo: z.boolean().default(false),
  note: z.string().max(300).optional(),
});

export const sceneDataSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  sceneId: z.string().uuid(),
  room: roomSchema,
  reconstruction: reconstructionSchema.prefault({}),
  camera: cameraSchema,
  objects: z.array(sceneObjectSchema).max(300),
  lighting: lightingSchema,
  metadata: metadataSchema.prefault({}),
});

export type Vec3 = z.infer<typeof vec3Schema>;
export type SceneObject = z.infer<typeof sceneObjectSchema>;
export type SceneData = z.infer<typeof sceneDataSchema>;
export type RoomSpec = z.infer<typeof roomSchema>;
export type ReconstructionSpec = z.infer<typeof reconstructionSchema>;
export type CameraSpec = z.infer<typeof cameraSchema>;
export type LightingSpec = z.infer<typeof lightingSchema>;
export type SceneMetadata = z.infer<typeof metadataSchema>;
export type ObjectOrigin = z.infer<typeof objectOriginSchema>;

export const DEFAULT_CAMERA: CameraSpec = {
  position: [7.5, 6.6, 7.6],
  target: [0, 1, 0],
  fov: 45,
  autoFrame: true,
};

export function safeParseScene(raw: unknown) {
  return sceneDataSchema.safeParse(raw);
}

export function parseScene(raw: unknown): SceneData {
  return sceneDataSchema.parse(raw);
}

/** v1（首夜原型）→ v2 迁移：color 移入 materialOverrides，补齐新字段 */
export function migrateV1Scene(raw: unknown): SceneData | null {
  const v1 = z
    .object({
      version: z.literal(1),
      room: z.object({
        width: z.number(),
        depth: z.number(),
        height: z.number(),
        floorColor: hexColorSchema,
        wallColor: hexColorSchema,
      }),
      objects: z.array(
        z.object({
          id: z.string(),
          assetId: z.string(),
          position: vec3Schema,
          rotation: vec3Schema,
          scale: vec3Schema,
          color: hexColorSchema.optional(),
        })
      ),
      lighting: lightingSchema,
    })
    .safeParse(raw);
  if (!v1.success) return null;
  const d = v1.data;
  return parseScene({
    schemaVersion: 2,
    sceneId: crypto.randomUUID(),
    room: { ...d.room, visible: true },
    reconstruction: {},
    camera: DEFAULT_CAMERA,
    objects: d.objects.map((o) => ({
      id: o.id,
      assetId: o.assetId,
      position: o.position,
      rotation: o.rotation,
      scale: o.scale,
      visible: true,
      origin: "user" as const,
      materialOverrides: o.color ? { color: o.color } : {},
    })),
    lighting: d.lighting,
    metadata: { name: "迁移场景（v1）", note: "由 v1 场景自动迁移" },
  });
}

export function createEmptyScene(name = "未命名场景"): SceneData {
  return parseScene({
    schemaVersion: SCHEMA_VERSION,
    sceneId: crypto.randomUUID(),
    room: {
      width: 5,
      depth: 4,
      height: 3,
      floorColor: "#B98B65",
      wallColor: "#F1DFC9",
      visible: true,
    },
    reconstruction: {},
    camera: DEFAULT_CAMERA,
    objects: [],
    lighting: { preset: "warm", intensity: 1.2 },
    metadata: { name },
  });
}

export function createDemoScene(): SceneData {
  const scene = createEmptyScene("演示卧室（程序化）");
  const objects: Array<[string, Vec3, number]> = [
    // [assetId, position, rotY]
    ["bed_double", [-1.2, 0, -0.9], 0],
    ["nightstand", [-2.05, 0, -1.6], 0],
    ["desk", [1.4, 0, -1.45], 0],
    ["chair", [1.4, 0, -0.6], Math.PI],
    ["bookshelf", [2.2, 0, 1.2], -Math.PI / 2],
    ["rug", [-0.2, 0, 0.9], 0],
    ["plant", [-2.0, 0, 1.5], 0],
  ];
  return parseScene({
    ...scene,
    metadata: { name: "演示卧室（程序化）", demo: true, note: "内置演示场景，非真实重建" },
    objects: objects.map(([assetId, position, rotY]) => ({
      id: `${assetId}-demo-${Math.random().toString(36).slice(2, 8)}`,
      assetId,
      position: [...position],
      rotation: [0, rotY, 0],
      scale: [1, 1, 1],
      visible: true,
      origin: "user" as const,
      materialOverrides: {},
    })),
  });
}

/**
 * 位置约束：家具包围盒不越出房间、y 不低于地面。
 * 旋转取 Y 轴，交换 XZ 半径，近似处理斜角。
 */
export function clampToRoom(room: RoomSpec, obj: SceneObject, footprint: [number, number]): SceneObject {
  const halfW = footprint[0] / 2;
  const halfD = footprint[1] / 2;
  const rotY = Math.abs(Math.sin(obj.rotation[1])) > 0.7;
  const extX = rotY ? halfD : halfW;
  const extZ = rotY ? halfW : halfD;
  const clamp = (v: number, ext: number, bound: number) =>
    Math.min(bound - ext, Math.max(-bound + ext, v));
  return {
    ...obj,
    rotation: [0, obj.rotation[1], 0],
    position: [
      clamp(obj.position[0], extX, room.width / 2),
      Math.max(0, obj.position[1]),
      clamp(obj.position[2], extZ, room.depth / 2),
    ],
  };
}

export function touchScene(scene: SceneData): SceneData {
  return { ...scene, metadata: { ...scene.metadata, updatedAt: new Date().toISOString() } };
}
