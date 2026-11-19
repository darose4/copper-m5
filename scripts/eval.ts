// Runs the golden set against Ask Copper and grades every answer with the AI
// judge (Module 5). Scores go to Langfuse as a dataset run, so two setups can
// be compared side by side, and to the terminal and the CI summary.
//
//   npm run eval                      the two-agent setup (what ships)
//   npm run eval -- --variant both    two agents, then one agent, compared
//   npm run eval -- --variant single  one support agent with every tool
//   npm run eval -- --only refund-under-limit,docs-error-code
//
// It exits with an error when fewer than 80% of the cases pass (change it with
// --min-pass-rate 0.9), so CI blocks the merge. Needs GOOGLE_GENERATIVE_AI_API_KEY;
// Langfuse is used when LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and
// LANGFUSE_BASE_URL are set.
import { appendFileSync, writeFileSync } from "node:fs";
import { LangfuseClient } from "@langfuse/client";
import { isAiConfigured } from "@/lib/ai/call";
import {
  flushTraces,
  isTracingConfigured,
  langfuseConfig,
  setupTracing,
} from "@/lib/ai/tracing";
import type { AgentVariant } from "@/lib/copper/assistant/ask";
import { GOLDEN_SET, type GoldenCase } from "@/lib/copper/evals/golden-set";
import { judge } from "@/lib/copper/evals/judge";
import { type CaseRun, runCase } from "@/lib/copper/evals/run-case";
import {
  type CaseScores,
  DEFAULT_MIN_PASS_RATE,
  meetsBar,
  scoreCase,
  summarize,
  type Summary,
} from "@/lib/copper/evals/score";

const DATASET = "copper-golden-set";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Google's free tier allows about 15 model requests a minute, and one golden
 * question takes several (each agent step, the search and the judge). So every
 * request to Google waits its turn, and one Google says to retry is retried
 * after the wait it asks for. Set EVAL_RPM to change the pace.
 */
function paceGoogleRequests(perMinute: number) {
  const realFetch = globalThis.fetch;
  const gap = 60_000 / perMinute;
  let nextSlot = 0;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.includes("generativelanguage.googleapis.com"))
      return realFetch(input, init);
    for (let attempt = 0; ; attempt++) {
      const slot = Math.max(Date.now(), nextSlot);
      nextSlot = slot + gap;
      if (slot > Date.now()) await sleep(slot - Date.now());
      const response = await realFetch(input, init);
      if (response.status !== 429 || attempt >= 5) return response;
      const body = await response.text();
      const asked = /retry in ([\d.]+)s/i.exec(body)?.[1];
      const wait = (asked ? Number(asked) : 20) + 1;
      console.log(`Google asked us to slow down; waiting ${Math.ceil(wait)}s...`);
      nextSlot = Math.max(nextSlot, Date.now() + wait * 1000);
    }
  };
}

type Args = {
  variants: AgentVariant[];
  only: string[] | null;
  minPassRate: number;
  concurrency: number;
};

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const variant = get("variant") ?? "multi";
  if (!["multi", "single", "both"].includes(variant))
    throw new Error(`--variant must be multi, single or both (got "${variant}")`);
  return {
    variants:
      variant === "both" ? ["multi", "single"] : [variant as AgentVariant],
    only: get("only")?.split(",") ?? null,
    minPassRate: Number(get("min-pass-rate") ?? DEFAULT_MIN_PASS_RATE),
    concurrency: Number(get("concurrency") ?? 2),
  };
}

type CaseResult = {
  testCase: GoldenCase;
  run: CaseRun;
  scores: CaseScores;
  ms: number;
};

/** Runs `work` on every item, `limit` at a time, keeping the order. */
async function pool<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]);
      }
    }),
  );
  return out;
}

/** Makes sure the Langfuse dataset holds exactly the golden set's cases. */
async function syncDataset(langfuse: LangfuseClient, cases: GoldenCase[]) {
  try {
    await langfuse.dataset.get(DATASET);
  } catch {
    await langfuse.api.datasets.create({
      name: DATASET,
      description:
        "Copper's golden set: questions with a known good answer (lib/copper/evals/golden-set.ts).",
    });
  }
  for (const c of cases)
    await langfuse.dataset.createItem({
      datasetName: DATASET,
      id: c.id,
      input: { id: c.id, turns: c.turns, desk: c.desk ?? null },
      expectedOutput: c.expected,
      metadata: { kind: c.kind, expectedTools: c.expectedTools ?? [] },
    });
}

async function evaluateVariant(
  variant: AgentVariant,
  cases: GoldenCase[],
  args: Args,
  langfuse: LangfuseClient | null,
): Promise<{ results: CaseResult[]; runUrl?: string }> {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const done = new Map<string, CaseResult>();
  const started = new Map<string, number>();

  const task = async ({ input }: { input?: { id: string } }) => {
    const testCase = byId.get(input!.id)!;
    started.set(testCase.id, performance.now());
    return runCase(testCase, variant);
  };

  const evaluator = async ({
    input,
    output,
  }: {
    input: { id: string };
    output: CaseRun;
  }) => {
    const testCase = byId.get(input.id)!;
    const verdict = await judge(testCase, output);
    const scores = scoreCase(testCase, output, verdict);
    done.set(testCase.id, {
      testCase,
      run: output,
      scores,
      ms: Math.round(performance.now() - (started.get(testCase.id) ?? 0)),
    });
    return [
      {
        name: "correctness",
        value: scores.correctness,
        comment: scores.reason,
      },
      { name: "grounded", value: scores.grounded ? 1 : 0, dataType: "BOOLEAN" as const },
      ...(scores.toolUse === null
        ? []
        : [
            {
              name: "tool_use",
              value: scores.toolUse ? 1 : 0,
              dataType: "BOOLEAN" as const,
            },
          ]),
      { name: "pass", value: scores.pass ? 1 : 0, dataType: "BOOLEAN" as const },
    ];
  };

  if (!langfuse) {
    await pool(cases, args.concurrency, async (testCase) => {
      const output = await task({ input: { id: testCase.id } });
      await evaluator({ input: { id: testCase.id }, output });
    });
    return { results: cases.map((c) => done.get(c.id)!) };
  }

  const dataset = await langfuse.dataset.get(DATASET);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  // The dataset's own items (so the run is linked to it), limited to the cases asked for.
  const experiment = await langfuse.experiment.run({
    data: dataset.items.filter((item) => byId.has(item.id)),
    name: `copper-${variant}`,
    runName: `${variant}-${stamp}`,
    description:
      variant === "multi"
        ? "Two agents: Copper and the Refund agent, with a handoff."
        : "One support agent with every tool and no handoff.",
    metadata: { variant },
    maxConcurrency: args.concurrency,
    task: task as never,
    evaluators: [evaluator as never],
    runEvaluators: [
      async ({ itemResults }) => {
        const all = itemResults
          .map((r) => done.get((r.item as { input: { id: string } }).input.id))
          .filter((r): r is CaseResult => Boolean(r));
        const s = summarize(all.map((r) => r.scores));
        return [
          { name: "pass_rate", value: s.passRate },
          { name: "avg_correctness", value: s.avgCorrectness },
          { name: "grounded_rate", value: s.groundedRate },
        ];
      },
    ],
  });
  return {
    results: cases.map((c) => done.get(c.id)!).filter(Boolean),
    runUrl: experiment.datasetRunUrl ?? experiment.experimentUrl,
  };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);

function print(variant: AgentVariant, results: CaseResult[], summary: Summary) {
  console.log(`\n=== ${variant === "multi" ? "Two agents" : "One agent"} (${variant}) ===`);
  for (const { testCase, run, scores, ms } of results) {
    const mark = scores.pass ? "PASS" : "FAIL";
    console.log(
      `${mark}  ${testCase.id}  ${scores.correctness * 5}/5  ${(ms / 1000).toFixed(1)}s  tools: ${[...new Set(run.toolCalls.map((c) => c.name))].join(", ") || "none"}`,
    );
    if (!scores.pass) {
      console.log(`      judge: ${scores.reason}`);
      console.log(`      reply: ${run.reply.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
  console.log(
    `${summary.passed} of ${summary.cases} passed (${pct(summary.passRate)}) · correctness ${pct(summary.avgCorrectness)} · grounded ${pct(summary.groundedRate)} · right tools ${pct(summary.toolUseRate)}`,
  );
}

function markdown(
  rows: { variant: AgentVariant; summary: Summary; runUrl?: string }[],
  results: Map<AgentVariant, CaseResult[]>,
  minPassRate: number,
): string {
  const head = `## Golden-set evaluation\n\n| Setup | Passed | Pass rate | Correctness | Grounded | Right tools |\n|---|---|---|---|---|---|\n`;
  const lines = rows
    .map(
      ({ variant, summary: s, runUrl }) =>
        `| ${variant === "multi" ? "Two agents" : "One agent"}${runUrl ? ` ([Langfuse](${runUrl}))` : ""} | ${s.passed}/${s.cases} | ${pct(s.passRate)} | ${pct(s.avgCorrectness)} | ${pct(s.groundedRate)} | ${pct(s.toolUseRate)} |`,
    )
    .join("\n");
  const failed = [...results.entries()].flatMap(([variant, rs]) =>
    rs
      .filter((r) => !r.scores.pass)
      .map((r) => `- **${variant}** \`${r.testCase.id}\` (${r.scores.correctness * 5}/5): ${r.scores.reason}`),
  );
  return `${head}${lines}\n\nThe bar to merge: ${pct(minPassRate)} of cases pass.\n${
    failed.length ? `\n### Cases that failed\n${failed.join("\n")}\n` : ""
  }`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!isAiConfigured()) {
    console.error(
      "Set GOOGLE_GENERATIVE_AI_API_KEY (in .env.local, or an Actions secret) to run the evaluation.",
    );
    process.exit(1);
  }
  const cases = args.only
    ? GOLDEN_SET.filter((c) => args.only!.includes(c.id))
    : GOLDEN_SET;
  if (cases.length === 0) {
    console.error("No golden-set case matches --only.");
    process.exit(1);
  }

  paceGoogleRequests(Number(process.env.EVAL_RPM ?? 12));
  setupTracing();
  const langfuse = isTracingConfigured()
    ? new LangfuseClient(langfuseConfig())
    : null;
  if (langfuse) await syncDataset(langfuse, GOLDEN_SET);
  else
    console.log(
      "Langfuse keys aren't set, so scores stay in this terminal. Add them to see traces and dataset runs.",
    );

  const rows: { variant: AgentVariant; summary: Summary; runUrl?: string }[] = [];
  const all = new Map<AgentVariant, CaseResult[]>();
  for (const variant of args.variants) {
    const { results, runUrl } = await evaluateVariant(variant, cases, args, langfuse);
    const summary = summarize(results.map((r) => r.scores));
    print(variant, results, summary);
    if (runUrl) console.log(`Langfuse: ${runUrl}`);
    rows.push({ variant, summary, runUrl });
    all.set(variant, results);
  }

  const report = markdown(rows, all, args.minPassRate);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  writeFileSync(
    "eval-results.json",
    JSON.stringify(
      rows.map(({ variant, summary, runUrl }) => ({
        variant,
        summary,
        runUrl,
        cases: all.get(variant)!.map((r) => ({
          id: r.testCase.id,
          ...r.scores,
          ms: r.ms,
          handoffs: r.run.handoffs,
          reply: r.run.reply,
        })),
      })),
      null,
      2,
    ),
  );

  await langfuse?.flush();
  await flushTraces();

  // The first setup listed is the one that would ship, so it is the gate.
  const gate = rows[0].summary;
  const ok = meetsBar(gate, args.minPassRate);
  console.log(
    ok
      ? `\nThe golden set passes: ${pct(gate.passRate)} is at or above ${pct(args.minPassRate)}.`
      : `\nThe golden set fails: ${pct(gate.passRate)} is below ${pct(args.minPassRate)}.`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
