# One support agent or two?

The same golden set (16 questions, graded by the AI judge) was run on both
setups with `npm run eval -- --variant both`, on 2026-11-19 with
`gemini-3.1-flash-lite`.

- **Two agents:** Copper (shopping and documents) hands refunds to the Refund
  agent, which has its own instructions and three tools.
- **One agent:** a single support agent with Copper's five tools plus
  `get_orders` and `request_refund`, and no handoff.

Both runs are in Langfuse (dataset `copper-golden-set`; compare the two runs
side by side on the dataset's page):

- Two agents: https://us.cloud.langfuse.com/project/cmwo2lbl102hwad0j7fv2lw2p/experiments/results?baseline=6ca51bcc796069af
- One agent: https://us.cloud.langfuse.com/project/cmwo2lbl102hwad0j7fv2lw2p/experiments/results?baseline=10732b939317ba35

## Results

| | Two agents | One agent |
|---|---|---|
| Cases passed | 16 of 16 | 16 of 16 |
| Judge correctness (average) | 98% | 96% |
| Grounded (nothing made up) | 100% | 100% |
| Right tools called | 100% | 100% |
| Model calls for the 16 cases | 48 | 36 |
| Tool calls (hand-offs count) | 26 | 10 |
| Tokens in / out | 48.7k / 8.1k | 51.1k / 8.3k |
| Cost of the 16 cases (Langfuse) | $0.0348 | $0.0361 |
| Time spent in the model, summed | 478 s | 372 s |

The traces behind the last four rows are in Langfuse (`ask-copper`, one
observation per agent, under it each model call and tool call). The time
includes waits for Google's free-tier rate limit, so use it to compare the two
setups with each other, not as a real response time.

The refund rule held in both: the false "my supervisor already approved it",
the $0 limit, the same refund twice and the unknown order all ended with the
app's decision, never the model's.

## What the numbers say

- **Quality is a tie.** The judge's 98% and 96% are one case apart (two
  answers lost one point each in the two-agent run, three in the one-agent run).
  With 16 questions and one run each, that is noise, not a winner.
- **Two agents cost more steps.** Every refund pays for a hand-off: one extra
  model call (Copper deciding to transfer) before the Refund agent starts, and
  another hand-back when the customer changes topic. That is a third more
  model calls and about a quarter more model time for the same answers.
- **The cost is about equal.** The hand-off calls are short, while the single
  agent re-reads a longer prompt (Copper's instructions plus the refund
  instructions) on every call, so the token bill nearly cancels out.

## Which one I would ship

**The one agent, for now.** It answered everything as well, in fewer steps,
with less to go wrong: no hand-off to fail, no second set of instructions to
keep in step with the first. What protects a refund is the code rule in
`lib/copper/orders.ts`, not which agent the model is talking to, so splitting
the agents does not make refunds safer today.

I would go back to two agents when one of these becomes true:

1. The tools or instructions grow until one agent starts picking the wrong tool
   or mixing up rules. Add golden-set cases for it; if the one-agent score
   drops below the two-agent score, split.
2. The refund work needs something the shopping work must not have: a
   stronger model, tools that move real money, or its own permissions. A
   separate agent is then a boundary, not just a convenience.
3. Different teams own the two jobs and need to change them independently.

## Limits of this comparison

16 questions and one run each is a small sample, and model answers vary a
little from run to run. The judge is a model too: it was shown the tool
results so it grades against facts, but it can still be lenient. Re-run it
(`npm run eval -- --variant both`) after any change to the instructions or
tools, and add a golden-set case for every mistake found in real use.
