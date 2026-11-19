// Module 5: tracing in Langfuse switches on only when the keys are set, and
// never breaks the app when they aren't.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushTraces,
  isTracingConfigured,
  langfuseConfig,
  setupTracing,
} from "@/lib/ai/tracing";

afterEach(() => vi.unstubAllEnvs());

describe("Langfuse tracing", () => {
  it("is off without the keys, and setting it up does nothing", () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    expect(isTracingConfigured()).toBe(false);
    expect(setupTracing()).toBe(false);
  });

  it("needs both keys", () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "  ");
    expect(isTracingConfigured()).toBe(false);
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    expect(isTracingConfigured()).toBe(true);
  });

  it("trims line breaks and spaces off the settings, and defaults the host", () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test\r\n");
    vi.stubEnv("LANGFUSE_SECRET_KEY", " sk-lf-test\n");
    vi.stubEnv("LANGFUSE_BASE_URL", "https://us.cloud.langfuse.com\r\n");
    expect(langfuseConfig()).toEqual({
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      baseUrl: "https://us.cloud.langfuse.com",
    });
    vi.stubEnv("LANGFUSE_BASE_URL", "");
    expect(langfuseConfig().baseUrl).toBe("https://cloud.langfuse.com");
  });

  it("flushing with nothing set up returns at once", async () => {
    await expect(flushTraces()).resolves.toBeUndefined();
  });

  it("Next.js's register() is safe with no keys, and does nothing outside Node", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    const { register } = await import("@/instrumentation");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await expect(register()).resolves.toBeUndefined();
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await expect(register()).resolves.toBeUndefined();
  });
});
