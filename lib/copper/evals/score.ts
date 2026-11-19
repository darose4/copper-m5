// Turns the judge's verdict into scores, and the scores into a pass or fail for
// CI. No AI and no network in here, so it is easy to test.
import type { GoldenCase } from "@/lib/copper/evals/golden-set";
import type { Verdict } from "@/lib/copper/evals/judge";
import type { CaseRun } from "@/lib/copper/evals/run-case";

/** A case passes when the judge gives 4 or 5 out of 5, grounded, and the right tools were used. */
export const PASSING_CORRECTNESS = 4;

/** CI fails when fewer than this share of the golden set passes. */
export const DEFAULT_MIN_PASS_RATE = 0.8;

export type CaseScores = {
  /** 0 to 1: the judge's 1 to 5, scaled. */
  correctness: number;
  grounded: boolean;
  /** Were all the expected tools called? Null when the case expects none. */
  toolUse: boolean | null;
  pass: boolean;
  reason: string;
};

/** Did the run call every tool the case expects? Null when it expects none. */
export function toolUse(testCase: GoldenCase, run: CaseRun): boolean | null {
  if (!testCase.expectedTools?.length) return null;
  const used = new Set(run.toolCalls.map((c) => c.name));
  return testCase.expectedTools.every((name) => used.has(name));
}

export function scoreCase(
  testCase: GoldenCase,
  run: CaseRun,
  verdict: Verdict,
): CaseScores {
  const tools = toolUse(testCase, run);
  return {
    correctness: verdict.correctness / 5,
    grounded: verdict.grounded,
    toolUse: tools,
    pass:
      !run.failed &&
      verdict.correctness >= PASSING_CORRECTNESS &&
      verdict.grounded &&
      tools !== false,
    reason: verdict.reason,
  };
}

export type Summary = {
  cases: number;
  passed: number;
  passRate: number;
  avgCorrectness: number;
  groundedRate: number;
  /** Null when no case expects a tool. */
  toolUseRate: number | null;
};

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

export function summarize(scores: CaseScores[]): Summary {
  const tools = scores.flatMap((s) => (s.toolUse === null ? [] : [s.toolUse]));
  const passed = scores.filter((s) => s.pass).length;
  return {
    cases: scores.length,
    passed,
    passRate: scores.length ? passed / scores.length : 0,
    avgCorrectness: mean(scores.map((s) => s.correctness)),
    groundedRate: mean(scores.map((s) => (s.grounded ? 1 : 0))),
    toolUseRate: tools.length ? mean(tools.map((t) => (t ? 1 : 0))) : null,
  };
}

/** True when the golden set passes well enough to ship. */
export function meetsBar(
  summary: Summary,
  minPassRate = DEFAULT_MIN_PASS_RATE,
): boolean {
  return summary.cases > 0 && summary.passRate >= minPassRate;
}
