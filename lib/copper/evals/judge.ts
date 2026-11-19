// The AI judge (Module 5): a second Gemini call that grades what Ask Copper
// said against the golden set's expected answer. Like every other AI call it
// goes through lib/ai/call.ts, so it is logged and traced too.
import { z } from "zod";
import { callObject } from "@/lib/ai/call";
import type { GoldenCase } from "@/lib/copper/evals/golden-set";
import type { CaseRun } from "@/lib/copper/evals/run-case";

export const verdictSchema = z.object({
  correctness: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe(
      "5 = says everything the expected answer says and nothing that contradicts it. 4 = right, but misses a small detail. 3 = partly right. 2 = mostly wrong. 1 = wrong, unsafe or no answer.",
    ),
  grounded: z
    .boolean()
    .describe(
      "True only if every fact, price, date and policy in the answer comes from the tool results shown, and it promises nothing the tools didn't confirm.",
    ),
  reason: z.string().describe("One or two sentences on why."),
});

export type Verdict = z.infer<typeof verdictSchema>;

const clip = (value: unknown, max = 900) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/**
 * What a tool returned, as the judge reads it. Document passages are shown in
 * full (title, page and text for all five), because the answer can come from
 * any of them: cutting the list short made the judge think a correct,
 * cited answer was invented. Everything else is kept short.
 */
function describeOutput(name: string, output: unknown): string {
  const matches = (output as { matches?: unknown })?.matches;
  if (name === "search_docs" && Array.isArray(matches))
    return `these passages:\n${matches
      .map(
        (m: { title?: string; page?: number; text?: string }) =>
          `   - [${m.title}, p. ${m.page}] ${clip(m.text ?? "", 500)}`,
      )
      .join("\n")}`;
  return clip(output);
}

/** What the judge reads: the conversation and what each tool returned. */
export function judgePrompt(testCase: GoldenCase, run: CaseRun): string {
  const conversation = run.turns
    .map((t) => `Customer: ${t.customer}\nCopper: ${t.reply}`)
    .join("\n\n");
  const tools = run.toolCalls.length
    ? run.toolCalls
        .map(
          (c, i) =>
            `${i + 1}. ${c.name}(${clip(c.input, 200)}) returned ${describeOutput(c.name, c.output)}`,
        )
        .join("\n")
    : "(no tools were called)";
  return `You grade a customer-support chatbot for Copper State Labs.

CONVERSATION
${conversation}

TOOL CALLS AND RESULTS
${tools}

WHAT A GOOD FINAL ANSWER SAYS
${testCase.expected}

Grade the chatbot's final reply only. Judge meaning, not exact wording. Extra friendly words are fine; extra facts that the tool results don't support are not. A reply that promises or states a refund that the tool results do not show was made is wrong and not grounded.`;
}

export async function judge(
  testCase: GoldenCase,
  run: CaseRun,
): Promise<Verdict> {
  const { output } = await callObject(
    { module: 5, feature: "judge" },
    { prompt: judgePrompt(testCase, run), schema: verdictSchema },
  );
  return output;
}
