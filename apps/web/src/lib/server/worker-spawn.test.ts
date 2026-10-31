import { describe, expect, it } from "vitest";
import { buildWslScript, toWslPath } from "./worker-spawn";

describe("toWslPath", () => {
  it("把盘符路径转成 /mnt/<drive>", () => {
    expect(toWslPath("C:\\Users\\a\\b")).toBe("/mnt/c/Users/a/b");
    expect(toWslPath("D:/work/x")).toBe("/mnt/d/work/x");
  });

  it("已是 POSIX 路径时只统一分隔符", () => {
    expect(toWslPath("/root/data")).toBe("/root/data");
    expect(toWslPath("relative\\dir")).toBe("relative/dir");
  });
});

describe("buildWslScript", () => {
  const script = buildWslScript("11111111-2222-3333-4444-555555555555", "/mnt/c/repo", "/mnt/c/repo/data");

  it("先重定向日志再启动，避免 detached wsl.exe 丢输出", () => {
    const logIdx = script.indexOf("exec >> ");
    const pythonIdx = script.indexOf("exec python");
    expect(logIdx).toBeGreaterThan(-1);
    expect(pythonIdx).toBeGreaterThan(logIdx);
    expect(script).toContain("/mnt/c/repo/data/tasks/11111111-2222-3333-4444-555555555555/worker.log");
  });

  it("激活 conda 环境并在服务目录执行 run-task", () => {
    expect(script).toContain("conda activate miniverse");
    expect(script).toContain("cd '/mnt/c/repo/services/reconstruction'");
    expect(script).toContain("exec python -u -m app.main run-task");
    expect(script).toContain("--data-dir '/mnt/c/repo/data'");
  });

  it("转义路径中的单引号，避免破坏脚本", () => {
    const quoted = buildWslScript("id", "/mnt/c/it's a repo", "/mnt/c/data");
    expect(quoted).toContain(`'/mnt/c/it'\\''s a repo/services/reconstruction'`);
  });
});
