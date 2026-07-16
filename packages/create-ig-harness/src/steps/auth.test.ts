import { describe, expect, it, vi } from "vitest";
import { connectWithApiToken, parseCloudflareAccounts } from "./auth.js";

describe("connectWithApiToken", () => {
  it("uses the trimmed token through the scoped Wrangler setter", async () => {
    let scopedToken: string | undefined;
    const setToken = vi.fn((token: string | undefined) => { scopedToken = token });
    const verify = vi.fn(async () => scopedToken === "test-valid-token-for-ig-mate");

    await connectWithApiToken("  test-valid-token-for-ig-mate  ", setToken, verify);

    expect(verify).toHaveBeenCalledOnce();
    expect(scopedToken).toBe("test-valid-token-for-ig-mate");
    expect(process.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
  });

  it("clears a rejected token from the scoped Wrangler setter", async () => {
    let scopedToken: string | undefined;
    const setToken = (token: string | undefined) => { scopedToken = token };

    await expect(
      connectWithApiToken("test-rejected-token-for-ig-mate", setToken, async () => false),
    ).rejects.toThrow("API tokenを確認できませんでした");

    expect(scopedToken).toBeUndefined();
  });

  it("rejects empty input without calling Cloudflare", async () => {
    const setToken = vi.fn();
    const verify = vi.fn(async () => true);

    await expect(connectWithApiToken("   ", setToken, verify)).rejects.toThrow(
      "API tokenを入力してください",
    );

    expect(setToken).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("clears the scoped token when Cloudflare verification throws", async () => {
    let scopedToken: string | undefined;
    const setToken = (token: string | undefined) => { scopedToken = token };

    await expect(
      connectWithApiToken("test-error-token-for-ig-mate", setToken, async () => {
        throw new Error("network unavailable");
      }),
    ).rejects.toThrow("network unavailable");

    expect(scopedToken).toBeUndefined();
  });
});

describe("parseCloudflareAccounts", () => {
  it("returns every distinct account instead of silently taking the first", () => {
    const output = [
      "│ Account Name │ Account ID                       │",
      "│ Personal     │ aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa │",
      "│ Test Company │ bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb │",
    ].join("\n");

    expect(parseCloudflareAccounts(output)).toEqual([
      { name: "Personal", id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { name: "Test Company", id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    ]);
  });
});
