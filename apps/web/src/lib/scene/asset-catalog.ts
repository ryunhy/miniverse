import type { SceneData } from "./schema";

export interface CatalogAsset {
  /** 白名单 ID：AI 输出与场景 JSON 中的 assetId 只允许取自这里 */
  assetId: string;
  label: string;
  category: "家具" | "收纳" | "装饰";
  /** 占位几何体尺寸 [宽, 高, 深]，米；替换 GLB 后仍作为碰撞/摆位参考 */
  size: [number, number, number];
  defaultColor: string;
  /** 未来接 GLB：/models/xxx.glb；占位阶段为 null 时渲染几何体 */
  glbPath: string | null;
}

export const ASSET_CATALOG: CatalogAsset[] = [
  { assetId: "bed_single", label: "单人床", category: "家具", size: [1.1, 0.55, 2.0], defaultColor: "#E8D9C5", glbPath: null },
  { assetId: "bed_double", label: "双人床", category: "家具", size: [1.6, 0.55, 2.05], defaultColor: "#E8D9C5", glbPath: null },
  { assetId: "desk", label: "书桌", category: "家具", size: [1.3, 0.75, 0.65], defaultColor: "#A87953", glbPath: null },
  { assetId: "chair", label: "椅子", category: "家具", size: [0.5, 0.85, 0.5], defaultColor: "#96704D", glbPath: null },
  { assetId: "sofa", label: "沙发", category: "家具", size: [1.8, 0.8, 0.85], defaultColor: "#7C90A0", glbPath: null },
  { assetId: "coffee_table", label: "茶几", category: "家具", size: [0.9, 0.4, 0.55], defaultColor: "#96704D", glbPath: null },
  { assetId: "bookshelf", label: "书架", category: "收纳", size: [0.9, 1.8, 0.3], defaultColor: "#96704D", glbPath: null },
  { assetId: "wardrobe", label: "衣柜", category: "收纳", size: [1.2, 2.0, 0.6], defaultColor: "#C89B71", glbPath: null },
  { assetId: "dresser", label: "斗柜", category: "收纳", size: [0.8, 0.9, 0.45], defaultColor: "#C89B71", glbPath: null },
  { assetId: "nightstand", label: "床头柜", category: "收纳", size: [0.45, 0.55, 0.4], defaultColor: "#C89B71", glbPath: null },
  { assetId: "tv_cabinet", label: "电视柜", category: "家具", size: [1.6, 0.45, 0.4], defaultColor: "#5C4A38", glbPath: null },
  { assetId: "rug", label: "地毯", category: "装饰", size: [1.8, 0.02, 1.2], defaultColor: "#C97B5A", glbPath: null },
  { assetId: "plant", label: "绿植", category: "装饰", size: [0.4, 1.0, 0.4], defaultColor: "#5E8C5A", glbPath: null },
  { assetId: "floor_lamp", label: "落地灯", category: "装饰", size: [0.35, 1.5, 0.35], defaultColor: "#D9C9A3", glbPath: null },
];

export const ASSET_MAP: ReadonlyMap<string, CatalogAsset> = new Map(
  ASSET_CATALOG.map((a) => [a.assetId, a])
);

export function getAsset(assetId: string): CatalogAsset | undefined {
  return ASSET_MAP.get(assetId);
}

/** 灯光预设 → 环境光/方向光参数 */
export const LIGHT_PRESETS: Record<
  SceneData["lighting"]["preset"],
  { ambient: string; sun: string; sunPosition: [number, number, number]; background: string }
> = {
  warm: { ambient: "#fff2e0", sun: "#ffe4bd", sunPosition: [5, 10, 5], background: "#EFE7DA" },
  cool: { ambient: "#e6f0ff", sun: "#d8e9ff", sunPosition: [-5, 10, 4], background: "#E4EBF4" },
  neutral: { ambient: "#ffffff", sun: "#ffffff", sunPosition: [4, 10, 6], background: "#EDF0F3" },
  night: { ambient: "#3a4468", sun: "#8fa0d9", sunPosition: [-4, 8, -3], background: "#232A40" },
};
