import type * as THREE from "three";

/**
 * 渲染循环兜底：探测 rAF 冻结（窗口被遮挡时 Chromium 原生遮挡检测会停掉 rAF，
 * 而 R3F 的 always/demand 两种 frameloop 最终都依赖 rAF），冻结时用 setInterval
 * 直驱 gl.render。前台正常环境下自动不启用，零额外开销。
 */
export function installRenderFallback(
  gl: { render: (scene: THREE.Scene, camera: THREE.Camera) => void },
  scene: THREE.Scene,
  camera: THREE.Camera
): () => void {
  let rafAlive = false;
  requestAnimationFrame(() => {
    rafAlive = true;
  });

  let interval: ReturnType<typeof setInterval> | null = null;
  const timer = setTimeout(() => {
    if (rafAlive) return;
    interval = setInterval(() => {
      try {
        gl.render(scene, camera);
      } catch {
        // 渲染异常不应中断兜底循环
      }
    }, 250);
  }, 400);

  return () => {
    clearTimeout(timer);
    if (interval) clearInterval(interval);
  };
}
