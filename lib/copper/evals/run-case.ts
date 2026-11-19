// Runs one golden-set case through Ask Copper, the way the chat panel would:
// message by message, carrying the conversation and whoever answered last, and
// keeping the Refund Console's desk up to date between messages.
import {
  askCopper,
  type AgentVariant,
  type ChatMessage,
} from "@/lib/copper/assistant/ask";
import { finalValue } from "@/lib/ai/live";
import type { Agent, Step, ToolStep } from "@/lib/copper/assistant/progress";
import type { Desk, Refund } from "@/lib/copper/orders";
import type { GoldenCase } from "@/lib/copper/evals/golden-set";

export type ToolCall = { name: string; input: unknown; output: unknown };

export type CaseRun = {
  /** The last reply. */
  reply: string;
  /** Who wrote it. */
  agent: Agent;
  /** Every tool call in the whole conversation. */
  toolCalls: ToolCall[];
  handoffs: number;
  /** What was said, turn by turn. */
  turns: { customer: string; reply: string }[];
  /** True when Copper ended with an error instead of an answer. */
  failed: boolean;
};

/** What the Refund Console would now show, after the refunds a turn asked for. */
export function applyRefunds(desk: Desk, steps: Step[]): Desk {
  const refunds: Refund[] = [...desk.refunds];
  for (const step of steps) {
    if (step.type !== "tool" || step.name !== "request_refund") continue;
    const out = step.output as
      | { status?: string; orderId?: string; item?: string; amountUsd?: number }
      | undefined;
    if (
      (out?.status === "refunded" || out?.status === "needs_approval") &&
      out.orderId &&
      !refunds.some((r) => r.orderId === out.orderId)
    )
      refunds.push({
        orderId: out.orderId,
        item: out.item ?? "",
        amountUsd: out.amountUsd ?? 0,
        status: out.status === "refunded" ? "refunded" : "waiting",
        by: out.status === "refunded" ? "auto" : "supervisor",
      });
  }
  return { ...desk, refunds };
}

export async function runCase(
  testCase: GoldenCase,
  variant: AgentVariant,
): Promise<CaseRun> {
  const messages: ChatMessage[] = [];
  let desk = testCase.desk;
  let agent: Agent = "copper";
  const run: CaseRun = {
    reply: "",
    agent,
    toolCalls: [],
    handoffs: 0,
    turns: [],
    failed: false,
  };
  for (const customer of testCase.turns) {
    messages.push({ role: "user", content: customer });
    const { progress } = await askCopper({
      messages,
      useTools: true,
      desk,
      agent,
      variant,
    });
    const done = await finalValue(progress);
    messages.push({ role: "assistant", content: done.reply });
    agent = done.agent ?? "copper";
    run.reply = done.reply;
    run.agent = agent;
    run.failed = done.status === "error";
    run.handoffs += done.steps.filter((s) => s.type === "handoff").length;
    run.turns.push({ customer, reply: done.reply });
    run.toolCalls.push(
      ...done.steps
        .filter((s): s is ToolStep => s.type === "tool")
        .map(({ name, input, output }) => ({ name, input, output })),
    );
    if (desk) desk = applyRefunds(desk, done.steps);
  }
  return run;
}
