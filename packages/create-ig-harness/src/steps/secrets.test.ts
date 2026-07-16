import { describe, expect, it } from "vitest";
import { buildSecretBindings } from "./secrets.js";

describe("buildSecretBindings", () => {
  it("does not claim unused token-at-rest encryption", () => {
    const bindings = buildSecretBindings({
      workerName: "ig-test",
      metaAppSecret: "app-secret",
      metaAccessToken: "access-token",
      metaVerifyToken: "verify-token",
      igUserId: "ig-user",
      apiKey: "api-key",
    });

    expect(bindings).not.toHaveProperty("IG_TOKEN_ENC_KEY");
    expect(bindings).toMatchObject({
      IG_APP_SECRET: "app-secret",
      IG_ACCESS_TOKEN: "access-token",
      IG_VERIFY_TOKEN: "verify-token",
    });
  });
});
