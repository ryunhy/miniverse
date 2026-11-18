"use client";

import * as THREE from "three";

/**
 * 两个独立查看器（网格 / 高斯）的相机同步通道与共用取景规则。
 * 每个查看器在 OrbitControls 变化时广播自己的机位；另一侧收到后直接套用。
 * 用 window 事件而不是模块单例：两者由 dynamic(ssr:false) 分块加载，
 * 事件总线不依赖模块实例是否被重复打包，也便于自动化验证监听。
 */
export const CAMERA_EVENT = "mv:viewer-camera";

export interface ViewerCameraDetail {
  source: "mesh" | "splat";
  position: [number, number, number];
  target: [number, number, number];
  /** 相机到目标点的距离（米），用于验证「同一机位」而不是靠观感 */
  distance: number;
}

export function publishCamera(detail: ViewerCameraDetail): void {
  window.dispatchEvent(new CustomEvent<ViewerCameraDetail>(CAMERA_EVENT, { detail }));
}

/**
 * 记录每个查看器「实际生效」的机位（含被远端套用后的结果），
 * 供自动化验证读取——事件流本身无法区分一次变化是本地拖动还是远端同步。
 */
export function reportCameraState(
  source: "mesh" | "splat",
  camera: THREE.Camera,
  target: THREE.Vector3,
): void {
  const w = window as unknown as { __viewerState?: Record<string, unknown> };
  w.__viewerState = {
    ...(w.__viewerState ?? {}),
    [source]: {
      position: camera.position.toArray(),
      target: target.toArray(),
    },
  };
}

/**
 * 两个查看器共用的默认机位：距目标 1.2 个场景单位、同一条斜前方视线。
 * 注意：这里的 1.2 / 1.5 是取景用的**场景单位（nu）**，不是米——
 * 重建场景未做米制标定（见 docs/miniature/SCALE-CALIBRATION.md）。
 */
export const FALLBACK_DISTANCE = 1.2;
export const FALLBACK_DIR = new THREE.Vector3(0.55, 0.32, 0.77).normalize();
/** 场景地面以上的取景抬高量（场景单位 nu，不是米） */
export const EYE_HEIGHT = 1.5;

/**
 * 统一默认机位：目标点抬到地面以上 EYE_HEIGHT 个场景单位，
 * 相机落在目标点斜前方 FALLBACK_DISTANCE 个场景单位处。
 * 两侧必须调用同一函数，避免各写一套取景规则。
 */
export function fallbackViewpoint(
  center: THREE.Vector3,
  floorY: number,
): { position: THREE.Vector3; target: THREE.Vector3 } {
  const target = center.clone();
  target.y = Math.max(target.y, floorY + EYE_HEIGHT);
  const position = target.clone().addScaledVector(FALLBACK_DIR, FALLBACK_DISTANCE);
  return { position, target };
}

/** drei OrbitControls（makeDefault 后从 useThree 取到）的最小结构 */
export type ViewerControls = {
  target: THREE.Vector3;
  update?: () => void;
  addEventListener?: (type: string, fn: () => void) => void;
  removeEventListener?: (type: string, fn: () => void) => void;
};
