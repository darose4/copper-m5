// Module 5: the golden set, the AI judge's prompt and the scoring that decides
// whether CI lets a change merge. No AI key needed: the judge's verdicts are
// made up here.
import { describe, expect, it } from "vitest";
import { GOLDEN_SET } from "@/lib/copper/evals/golden-set";
import { judgePrompt } from "@/lib/copper/evals/judge";
import { applyRefunds, type CaseRun } from "@/lib/copper/evals/run-case";
import {
  DEFAULT_MIN_PASS_RATE,
  meetsBar,
  scoreCase,
  summarize,
  toolUse,
} from "@/lib/copper/evals/score";
import { TOOL_LABELS } from "@/lib/copper/assistant/progress";
import { getOrders } from "@/lib/copper/orders";

const run = (over: Partial<CaseRun> = {}): CaseRun => ({
  reply: "Done.",
  agent: "copper",
  toolCalls: [],
  handoffs: 0,
  turns: [{ customer: "Hi", reply: "Done." }],
  failed: false,
  ...over,
});

const tool = (name: string, output: unknown = {}) => ({
  name,
  input: {},
  output,
});

describe("the golden set", () => {
  it("has uniquely named cases, each with a question and an expected answer", () => {
    const ids = GOLDEN_SET.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(12);
    for (const c of GOLDEN_SET) {
      expect(c.turns.length, c.id).toBeGreaterThan(0);
      expect(c.turns.every((t) => t.trim().length > 0), c.id).toBe(true);
      expect(c.expected.length, c.id).toBeGreaterThan(30);
    }
  });

  it("covers shopping, documents, refunds and safety", () => {
    const kinds = new Set(GOLDEN_SET.map((c) => c.kind));
    expect([...kinds].sort()).toEqual(["docs", "refund", "safety", "shopping"]);
  });

  it("includes the hard refund cases: fake approval, limit zero, duplicate, and a question in the middle", () => {
    const ids = GOLDEN_SET.map((c) => c.id);
    for (const id of [
      "refund-fake-approval",
      "refund-limit-zero",
      "refund-duplicate",
      "refund-then-stock",
    ])
      expect(ids).toContain(id);
    expect(GOLDEN_SET.find((c) => c.id === "refund-limit-zero")!.desk).toEqual({
      limitUsd: 0,
      refunds: [],
    });
  });

  it("refund cases carry a desk, and only name tools that exist", () => {
    for (const c of GOLDEN_SET) {
      if (c.kind === "refund") expect(c.desk, c.id).toBeDefined();
      for (const name of c.expectedTools ?? [])
        expect(Object.keys(TOOL_LABELS), c.id).toContain(name);
    }
  });

  it("only mentions orders that exist", () => {
    const real = getOrders().map((o) => o.id);
    for (const c of GOLDEN_SET)
      for (const order of c.desk?.refunds ?? [])
        expect(real, c.id).toContain(order.orderId);
  });
});

describe("scoring", () => {
  const c = GOLDEN_SET.find((x) => x.id === "price-total")!; // expects calculate_cost
  const good = { correctness: 5, grounded: true, reason: "Right." };

  it("passes a grounded 4 or 5 that used the right tool", () => {
    const r = run({ toolCalls: [tool("calculate_cost")] });
    expect(scoreCase(c, r, good)).toMatchObject({
      correctness: 1,
      pass: true,
      toolUse: true,
    });
    expect(scoreCase(c, r, { ...good, correctness: 4 }).pass).toBe(true);
  });

  it("fails a 3, an ungrounded answer, a missing tool, or a crash", () => {
    const r = run({ toolCalls: [tool("calculate_cost")] });
    expect(scoreCase(c, r, { ...good, correctness: 3 }).pass).toBe(false);
    expect(scoreCase(c, r, { ...good, grounded: false }).pass).toBe(false);
    expect(scoreCase(c, run(), good)).toMatchObject({
      toolUse: false,
      pass: false,
    });
    expect(scoreCase(c, run({ failed: true, toolCalls: r.toolCalls }), good).pass).toBe(false);
  });

  it("checks tools only when the case expects some", () => {
    const none = GOLDEN_SET.find((x) => x.id === "docs-not-covered")!;
    expect(toolUse(none, run())).toBeNull();
    expect(scoreCase(none, run(), good).pass).toBe(true);
  });

  it("summarizes pass rate, correctness, grounding and tool use", () => {
    const summary = summarize([
      { correctness: 1, grounded: true, toolUse: true, pass: true, reason: "" },
      { correctness: 0.8, grounded: true, toolUse: null, pass: true, reason: "" },
      { correctness: 0.4, grounded: false, toolUse: false, pass: false, reason: "" },
      { correctness: 1, grounded: true, toolUse: true, pass: true, reason: "" },
    ]);
    expect(summary).toMatchObject({
      cases: 4,
      passed: 3,
      passRate: 0.75,
      groundedRate: 0.75,
    });
    expect(summary.avgCorrectness).toBeCloseTo(0.8);
    expect(summary.toolUseRate).toBeCloseTo(2 / 3);
    expect(summarize([]).passRate).toBe(0);
  });

  it("blocks the merge below 80% (or with nothing evaluated) and allows it at or above", () => {
    const at = (passed: number, cases: number) =>
      summarize(
        Array.from({ length: cases }, (_, i) => ({
          correctness: i < passed ? 1 : 0.2,
          grounded: true,
          toolUse: null,
          pass: i < passed,
          reason: "",
        })),
      );
    expect(DEFAULT_MIN_PASS_RATE).toBe(0.8);
    expect(meetsBar(at(13, 16))).toBe(true); // 81%
    expect(meetsBar(at(12, 16))).toBe(false); // 75%
    expect(meetsBar(at(16, 16))).toBe(true);
    expect(meetsBar(summarize([]))).toBe(false);
    expect(meetsBar(at(12, 16), 0.7)).toBe(true);
  });
});

describe("the judge's prompt", () => {
  it("shows the conversation, what each tool returned and the expected answer", () => {
    const c = GOLDEN_SET.find((x) => x.id === "refund-over-limit")!;
    const prompt = judgePrompt(
      c,
      run({
        turns: [{ customer: "Please refund order 1004.", reply: "It waits." }],
        toolCalls: [
          tool("request_refund", { status: "needs_approval", amountUsd: 149 }),
        ],
      }),
    );
    expect(prompt).toContain("Customer: Please refund order 1004.");
    expect(prompt).toContain("Copper: It waits.");
    expect(prompt).toContain("request_refund");
    expect(prompt).toContain("needs_approval");
    expect(prompt).toContain(c.expected);
  });

  it("says so when no tool was called, and keeps long tool output short", () => {
    const c = GOLDEN_SET[0];
    expect(judgePrompt(c, run())).toContain("(no tools were called)");
    const long = judgePrompt(
      c,
      run({ toolCalls: [tool("search_docs", { text: "x".repeat(5000) })] }),
    );
    expect(long.length).toBeLessThan(2500);
  });
});

describe("keeping the Refund Console's desk up to date between messages", () => {
  const step = (name: string, output: unknown) => ({
    type: "tool" as const,
    id: "1",
    name,
    state: "done" as const,
    output,
  });

  it("records refunds the app made or held, so a second turn sees them", () => {
    const next = applyRefunds({ limitUsd: 50, refunds: [] }, [
      step("request_refund", {
        status: "refunded",
        orderId: "1001",
        item: "Copper Plus, monthly",
        amountUsd: 7.99,
      }),
      step("request_refund", {
        status: "needs_approval",
        orderId: "1004",
        item: "Copper Home",
        amountUsd: 149,
      }),
      step("request_refund", { status: "not_found", orderId: "9999" }),
      step("get_orders", { orders: [] }),
    ]);
    expect(next.refunds.map((r) => [r.orderId, r.status])).toEqual([
      ["1001", "refunded"],
      ["1004", "waiting"],
    ]);
  });

  it("never records the same order twice", () => {
    const once = {
      status: "refunded",
      orderId: "1001",
      item: "x",
      amountUsd: 1,
    };
    const next = applyRefunds({ limitUsd: 50, refunds: [] }, [
      step("request_refund", once),
      step("request_refund", once),
    ]);
    expect(next.refunds).toHaveLength(1);
  });
});
