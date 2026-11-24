// Measures how fast Ask Copper answers on the two setups (Module 5, part 4):
// the same questions, one at a time, alternating between the two agents and the
// one agent, with a pause between runs so Google's free-tier rate limit never
// adds waiting time. The golden-set run (scripts/eval.ts) can't measure speed
// because it paces its own requests.
//
//   npm run speed
//
// Each run is a normal Ask Copper question, so it also shows up in Langfuse
// (trace "ask-copper", tagged "multi" or "single").
import { isAiConfigured } from "@/lib/ai/call";
import { finalValue } from "@/lib/ai/live";
import { flushTraces, setupTracing } from "@/lib/ai/tracing";
import { askCopper, type AgentVariant } from "@/lib/copper/assistant/ask";
import { GOLDEN_SET } from "@/lib/copper/evals/golden-set";

/** Refund questions (where the handoff happens) and ordinary ones (where it doesn't). */
const QUESTIONS: { id: string; group: "refund" | "other" }[] = [
  { id: "refund-under-limit", group: "refund" },
  { id: "refund-over-limit", group: "refund" },
  { id: "refund-duplicate", group: "refund" },
  { id: "refund-status", group: "refund" },
  { id: "refund-unknown-order", group: "refund" },
  { id: "price-total", group: "other" },
  { id: "stock-backordered", group: "other" },
  { id: "docs-error-code", group: "other" },
];

const PAUSE_MS = 20_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Run = {
  id: string;
  group: "refund" | "other";
  variant: AgentVariant;
  seconds: number;
  handoffs: number;
  ok: boolean;
};

async function once(
  id: string,
  group: "refund" | "other",
  variant: AgentVariant,
): Promise<Run> {
  const testCase = GOLDEN_SET.find((c) => c.id === id)!;
  const started = performance.now();
  const { progress } = await askCopper({
    messages: [{ role: "user", content: testCase.turns[0] }],
    useTools: true,
    desk: testCase.desk,
    variant,
  });
  const done = await finalValue(progress);
  const seconds = (performance.now() - started) / 1000;
  return {
    id,
    group,
    variant,
    seconds,
    handoffs: done.steps.filter((s) => s.type === "handoff").length,
    ok: done.status === "done",
  };
}

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;

async function main() {
  if (!isAiConfigured()) {
    console.error("Set GOOGLE_GENERATIVE_AI_API_KEY to run the speed check.");
    process.exit(1);
  }
  setupTracing();
  const runs: Run[] = [];
  for (const [i, { id, group }] of QUESTIONS.entries()) {
    // Alternate who goes first so neither setup always gets the warmer start.
    const order: AgentVariant[] = i % 2 === 0 ? ["multi", "single"] : ["single", "multi"];
    for (const variant of order) {
      let run = await once(id, group, variant);
      if (!run.ok) {
        // A failed run (usually Google's limit) isn't a speed: wait and try once more.
        await sleep(60_000);
        run = await once(id, group, variant);
      }
      runs.push(run);
      console.log(
        `${run.ok ? "ok  " : "FAIL"} ${variant.padEnd(6)} ${id.padEnd(22)} ${run.seconds.toFixed(1)}s  handoffs: ${run.handoffs}`,
      );
      await sleep(PAUSE_MS);
    }
  }

  console.log("\nseconds per question (successful runs only)");
  console.log("setup   | group  | runs | median | mean");
  const rows: unknown[] = [];
  for (const variant of ["multi", "single"] as const)
    for (const group of ["refund", "other", "all"] as const) {
      const sel = runs.filter(
        (r) =>
          r.ok && r.variant === variant && (group === "all" || r.group === group),
      );
      const secs = sel.map((r) => r.seconds);
      console.log(
        `${variant.padEnd(7)} | ${group.padEnd(6)} | ${String(sel.length).padStart(4)} | ${median(secs).toFixed(1).padStart(5)}s | ${mean(secs).toFixed(1)}s`,
      );
      rows.push({ variant, group, runs: sel.length, medianSec: median(secs), meanSec: mean(secs) });
    }
  console.log("\n" + JSON.stringify({ runs, summary: rows }));
  await flushTraces();
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
