// Module 5: the one-agent variant. One support agent with Copper's tools and
// the refund tools together, and no handoff. Mock model, so no AI key.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";
import { SINGLE_AGENT_INSTRUCTIONS } from "@/lib/copper/assistant/instructions";
import { copperTools, singleAgentTools } from "@/lib/copper/assistant/tools";

let models: MockLanguageModelV4[] = [];
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => models.shift(),
}));

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];
const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  finish("stop"),
];
const calls = (toolName: string, input: unknown): StreamPart[] => [
  { type: "tool-input-start", id: "c", toolName },
  { type: "tool-input-end", id: "c" },
  { type: "tool-call", toolCallId: "c", toolName, input: JSON.stringify(input) },
  finish("tool-calls"),
];
const modelStreaming = (...steps: StreamPart[][]) => {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
};
const toolNames = (m: MockLanguageModelV4) =>
  (m.doStreamCalls[0].tools ?? []).map((t) => t.name).sort();

beforeEach(() => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.spyOn(console, "info").mockImplementation(() => {});
  models = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the one-agent variant", () => {
  const desk = { limitUsd: 50, refunds: [] };

  it("has Copper's tools and the refund tools, but no handoff tool", () => {
    expect(Object.keys(singleAgentTools(desk)).sort()).toEqual(
      [
        ...Object.keys(copperTools),
        "get_orders",
        "request_refund",
      ].sort(),
    );
    expect(Object.keys(singleAgentTools(desk))).not.toContain("transfer_to_copper");
    expect(Object.keys(singleAgentTools(desk))).not.toContain(
      "transfer_to_refund_agent",
    );
    // Off the Support page there is no Refund Console, so no refund tools.
    expect(Object.keys(singleAgentTools())).toEqual(Object.keys(copperTools));
  });

  it("answers a refund itself: one agent, all tools, no handoff", async () => {
    const model = modelStreaming(
      calls("request_refund", { orderId: "1001" }),
      says("Your $7.99 is refunded."),
    );
    models = [model];
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    const progress = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Refund order 1001" }],
          useTools: true,
          desk,
          variant: "single",
        })
      ).progress,
    );
    expect(toolNames(model)).toContain("request_refund");
    expect(toolNames(model)).toContain("search_docs");
    expect(toolNames(model).some((n) => n.startsWith("transfer"))).toBe(false);
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain(
      SINGLE_AGENT_INSTRUCTIONS.slice(0, 60),
    );
    expect(progress.steps.map((s) => s.type)).toEqual(["tool"]);
    expect(progress.steps[0]).toMatchObject({
      name: "request_refund",
      output: { status: "refunded", amountUsd: 7.99 },
    });
    expect(progress.agent).toBe("copper");
    expect(progress.reply).toBe("Your $7.99 is refunded.");
  });

  it("the default is still two agents: Copper hands off", async () => {
    const copper = modelStreaming(
      calls("transfer_to_refund_agent", { reason: "refund 1001" }),
    );
    const refund = modelStreaming(says("On it."));
    models = [copper, refund];
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    const progress = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Refund order 1001" }],
          useTools: true,
          desk,
        })
      ).progress,
    );
    expect(progress.steps.some((s) => s.type === "handoff")).toBe(true);
    expect(progress.agent).toBe("refund");
  });
});
