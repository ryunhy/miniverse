import type { SceneData } from "./scene-schema";

/**
 * 素材白名单：场景 objects[].assetId 与（未来）AI 识别映射只允许取自这里。
 * 禁止 AI 或前端自行拼模型路径。
 */
export interface CatalogAsset {
  assetId: string;
  label: string;
  category: "家具" | "收纳" | "装饰";
  /** 参考占地 [宽, 深]（米），用于碰撞/摆位约束；GLB 已按真实尺寸生成 */
  footprint: [number, number];
  defaultColor: string;
  /**
   * GLB 相对 apps/web 的 public 路径；null = 无 GLB，渲染程序化几何体（UI 必须标注“占位”）
   * 程序化生成的 GLB（tools/generate-furniture-glb.mjs 产物）同样在 UI 标注“程序化模型”。
   */
  glbPath: string | null;
}

export const ASSET_CATALOG: CatalogAsset[] = [
  { assetId: "bed_single", label: "单人床", category: "家具", footprint: [1.1, 2.0], defaultColor: "#E8D9C5", glbPath: "/assets/furniture/bed_single.glb" },
  { assetId: "bed_double", label: "双人床", category: "家具", footprint: [1.6, 2.05], defaultColor: "#E8D9C5", glbPath: "/assets/furniture/bed_double.glb" },
  { assetId: "desk", label: "书桌", category: "家具", footprint: [1.3, 0.65], defaultColor: "#A87953", glbPath: "/assets/furniture/desk.glb" },
  { assetId: "chair", label: "椅子", category: "家具", footprint: [0.5, 0.5], defaultColor: "#96704D", glbPath: "/assets/furniture/chair.glb" },
  { assetId: "sofa", label: "沙发", category: "家具", footprint: [1.8, 0.85], defaultColor: "#7C90A0", glbPath: "/assets/furniture/sofa.glb" },
  { assetId: "coffee_table", label: "茶几", category: "家具", footprint: [0.9, 0.55], defaultColor: "#96704D", glbPath: "/assets/furniture/coffee_table.glb" },
  { assetId: "tv_cabinet", label: "电视柜", category: "家具", footprint: [1.6, 0.4], defaultColor: "#5C4A38", glbPath: "/assets/furniture/tv_cabinet.glb" },
  { assetId: "bookshelf", label: "书架", category: "收纳", footprint: [0.9, 0.3], defaultColor: "#96704D", glbPath: "/assets/furniture/bookshelf.glb" },
  { assetId: "wardrobe", label: "衣柜", category: "收纳", footprint: [1.2, 0.6], defaultColor: "#C89B71", glbPath: "/assets/furniture/wardrobe.glb" },
  { assetId: "dresser", label: "斗柜", category: "收纳", footprint: [0.8, 0.45], defaultColor: "#C89B71", glbPath: "/assets/furniture/dresser.glb" },
  { assetId: "nightstand", label: "床头柜", category: "收纳", footprint: [0.45, 0.4], defaultColor: "#C89B71", glbPath: "/assets/furniture/nightstand.glb" },
  { assetId: "rug", label: "地毯", category: "装饰", footprint: [1.8, 1.2], defaultColor: "#C97B5A", glbPath: "/assets/furniture/rug.glb" },
  { assetId: "plant", label: "绿植", category: "装饰", footprint: [0.4, 0.4], defaultColor: "#5E8C5A", glbPath: "/assets/furniture/plant.glb" },
  { assetId: "floor_lamp", label: "落地灯", category: "装饰", footprint: [0.35, 0.35], defaultColor: "#D9C9A3", glbPath: "/assets/furniture/floor_lamp.glb" },
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
