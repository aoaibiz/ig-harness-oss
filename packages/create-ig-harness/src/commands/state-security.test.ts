import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadState } from "./setup.js";
import {
  loadDeployedState,
  requireCompleteDeployedState,
  writeAdminBuildEnv,
} from "./update.js";

const dirs: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ig-harness-state-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("restart state secret migration", () => {
  it("scrubs legacy setup secrets and retains only non-secret progress", () => {
    const dir = tempRepo();
    const path = join(dir, ".ig-harness-setup.json");
    writeFileSync(path, JSON.stringify({
      metaAppSecret: "test-meta-secret-not-real",
      metaAccessToken: "test-access-token-not-real",
      metaVerifyToken: "test-verify-token-not-real",
      apiKey: "test-api-key-not-real",
      accountId: "test-account-id",
      resourceSuffix: "abcd1234",
      completedSteps: ["credentials", "r2bucket", "secrets"],
    }));

    const state = loadState(dir);
    const stored = JSON.parse(readFileSync(path, "utf8"));

    expect(state.accountId).toBe("test-account-id");
    expect(state.completedSteps).toEqual(["r2bucket"]);
    expect(stored).not.toHaveProperty("metaAppSecret");
    expect(stored).not.toHaveProperty("metaAccessToken");
    expect(stored).not.toHaveProperty("metaVerifyToken");
    expect(stored).not.toHaveProperty("apiKey");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("replaces a legacy deployed API key with its non-secret project name", () => {
    const dir = tempRepo();
    const path = join(dir, ".ig-harness-deployed.json");
    writeFileSync(path, JSON.stringify({
      apiKey: "01234567-test-api-key-not-real",
      workerName: "ig-harness-test",
      accountId: "test-account-id",
    }));

    const state = loadDeployedState(dir);
    const stored = JSON.parse(readFileSync(path, "utf8"));

    expect(state?.adminProjectName).toBe("ih-admin-01234567");
    expect(stored).not.toHaveProperty("apiKey");
    expect(stored.adminProjectName).toBe("ih-admin-01234567");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("upgrades the complete deployed state written by the previous public release", () => {
    const dir = tempRepo();
    const path = join(dir, ".ig-harness-deployed.json");
    writeFileSync(path, JSON.stringify({
      apiKey: "89abcdef-test-api-key-not-real",
      workerUrl: "https://ig-harness-a1b2c3d4.example.workers.dev",
      adminUrl: "https://ih-admin-89abcdef.example.pages.dev",
      workerName: "ig-harness-a1b2c3d4",
      d1DatabaseId: "test-database-id",
      d1DatabaseName: "ig-harness-a1b2c3d4",
      accountId: "test-account-id",
    }));

    const state = requireCompleteDeployedState(loadDeployedState(dir));
    const stored = JSON.parse(readFileSync(path, "utf8"));

    expect(state.r2BucketName).toBe("ig-harness-a1b2c3d4-images");
    expect(state.adminProjectName).toBe("ih-admin-89abcdef");
    expect(stored.r2BucketName).toBe("ig-harness-a1b2c3d4-images");
    expect(stored).not.toHaveProperty("apiKey");
  });

  it("stops update when exact target state is missing or incomplete", () => {
    expect(() => requireCompleteDeployedState(null)).toThrow("updateを停止しました");
    expect(() => requireCompleteDeployedState({
      workerName: "ig-harness-test",
      accountId: "test-account-id",
    })).toThrow("d1DatabaseId");
  });

  it("pins the admin rebuild to the deployed Worker URL", () => {
    const dir = tempRepo();
    const webDir = join(dir, "apps/web");

    writeAdminBuildEnv(webDir, "https://ig-harness-test.example.workers.dev");

    expect(readFileSync(join(webDir, ".env.production"), "utf8")).toBe(
      "NEXT_PUBLIC_API_URL=https://ig-harness-test.example.workers.dev\n",
    );
  });
});
