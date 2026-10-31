import { z } from "zod";

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "必须是 #RRGGBB 格式颜色");

export const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const roomSchema = z.object({
  width: z.number().min(2).max(20),
  depth: z.number().min(2).max(20),
  height: z.number().min(2).max(6),
  floorColor: hexColorSchema,
  wallColor: hexColorSchema,
});

export const lightingSchema = z.object({
  preset: z.enum(["warm", "cool", "neutral", "night"]),
  intensity: z.number().min(0.2).max(3),
});

export const sceneObjectSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  /** 物体底部中心点，米；y=0 表示贴地 */
  position: vec3Schema,
  /** 欧拉角（弧度），只允许绕 Y 轴旋转 */
  rotation: vec3Schema,
  scale: vec3Schema,
  color: hexColorSchema.optional(),
});

export const sceneDataSchema = z.object({
  version: z.literal(1),
  room: roomSchema,
  objects: z.array(sceneObjectSchema).max(200),
  lighting: lightingSchema,
});

export type SceneObject = z.infer<typeof sceneObjectSchema>;
export type SceneData = z.infer<typeof sceneDataSchema>;
export type RoomSpec = z.infer<typeof roomSchema>;
export type LightingSpec = z.infer<typeof lightingSchema>;

export function emptyScene(): SceneData {
  return {
    version: 1,
    room: {
      width: 5,
      depth: 4,
      height: 3,
      floorColor: "#B98B65",
      wallColor: "#F1DFC9",
    },
    objects: [],
    lighting: { preset: "warm", intensity: 1.2 },
  };
}

export function demoScene(): SceneData {
  return {
    ...emptyScene(),
    objects: [
      {
        id: "bed-001",
        assetId: "bed_double",
        position: [-1.2, 0, -0.9],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        color: "#E8D9C5",
      },
      {
        id: "nightstand-001",
        assetId: "nightstand",
        position: [-2.05, 0, -1.6],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      {
        id: "desk-001",
        assetId: "desk",
        position: [1.4, 0, -1.45],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        color: "#A87953",
      },
      {
        id: "chair-001",
        assetId: "chair",
        position: [1.4, 0, -0.6],
        rotation: [0, Math.PI, 0],
        scale: [1, 1, 1],
      },
      {
        id: "bookshelf-001",
        assetId: "bookshelf",
        position: [2.2, 0, 1.2],
        rotation: [0, -Math.PI / 2, 0],
        scale: [1, 1, 1],
      },
      {
        id: "rug-001",
        assetId: "rug",
        position: [-0.2, 0, 0.9],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      {
        id: "plant-001",
        assetId: "plant",
        position: [-2.0, 0, 1.5],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    ],
  };
}

export function parseScene(raw: unknown): SceneData {
  return sceneDataSchema.parse(raw);
}

export function safeParseScene(raw: unknown) {
  return sceneDataSchema.safeParse(raw);
}
