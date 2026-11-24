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

- Two agents: https://us.cloud.langfuse.com/project/cmwo2lbl102hwad0j7fv2lw2p/experiments/results?baseline=340321526ef6b71e
- One agent: https://us.cloud.langfuse.com/project/cmwo2lbl102hwad0j7fv2lw2p/experiments/results?baseline=d43edcf78f44319e

## Results

| | Two agents | One agent |
|---|---|---|
| Cases passed | 16 of 16 | 16 of 16 |
| Judge correctness (average) | 100% | 98% |
| Grounded (nothing made up) | 100% | 100% |
| Right tools called | 100% | 100% |
| Model calls for the 16 cases | 46 | 37 |
| Tool calls (hand-offs count) | 23 | 11 |
| Tokens in / out | 45.2k / 8.2k | 53.9k / 7.3k |
| Cost of the 16 cases (Langfuse) | $0.0340 | $0.0344 |
| Speed: median seconds per question | 5.0 s | 2.7 s |
| Speed: mean seconds per question | 5.8 s | 4.1 s |

The model-call, token and cost rows are read from the traces in Langfuse
(`ask-copper`, one observation per agent, under it each model call and tool
call).

The speed rows come from a separate check, `npm run speed`
(`scripts/speed.ts`): 8 of the golden questions (5 refund, 3 other), run one at
a time on each setup, alternating which goes first, with a 20-second pause
between runs. The golden-set run itself can't measure speed: Google's free tier
allows about 15 requests a minute, so that runner paces itself, and its pauses
swamp the real response times. Each speed run is also a trace in Langfuse,
tagged `multi` or `single`. On the refund questions alone the medians were
5.0 s (two agents) and 3.6 s (one agent).

The refund rule held in both: the false "my supervisor already approved it",
the $0 limit, the same refund twice and the unknown order all ended with the
app's decision, never the model's.

An earlier run, graded before a fix to the judge, gave the same picture: 16 of
16 for both, 98% against 96% correctness, 48 against 36 model calls, and about
the same cost.

## What the numbers say

- **Quality is a tie.** The judge's 100% and 98% are two answers apart (the
  one-agent run lost one point on two answers). With 16 questions and one run
  each, that is noise, not a winner. In the earlier run the lead went the other
  way by a similar amount.
- **Two agents cost more steps.** Every refund pays for a hand-off: one extra
  model call (Copper deciding to transfer) before the Refund agent starts, and
  another hand-back when the customer changes topic. That is about a quarter
  more model calls (46 against 37) and twice the tool calls, for the same
  answers. In a live trace the transfer step took about a second before the
  Refund agent could begin.
- **Two agents are slower.** The median question took 5.0 s with two agents and
  2.7 s with one, about twice as long. A refund waits for Copper to decide to
  transfer before the Refund agent can start, and each of those steps is a
  full model call. Eight questions and one run each is a small sample (one
  slow run in each setup pulls the means up, which is why the medians are
  quoted), but the gap shows up on the refund questions too: 5.0 s against
  3.6 s.
- **The cost is about equal.** The hand-off calls are short, while the single
  agent re-reads a longer prompt (Copper's instructions plus the refund
  instructions, and all eight tools) on every call, so it reads more input
  tokens and the bills come out within a percent of each other.

## Which one I would ship

**The one agent, for now.** It answered everything as well, in about half the
time and with fewer steps, with less to go wrong: no hand-off to fail, no second set of instructions to
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
little from run to run: in two CI runs of the two-agent setup, a different
single case failed each time. The judge is a model too. It sees every tool
result, including all five document passages (an earlier version saw a
shortened copy and marked a correct, cited answer as invented; CI caught it),
so it grades against facts, but it can still be too strict or too lenient.
Re-run it (`npm run eval -- --variant both`) after any change to the
instructions or tools, and add a golden-set case for every mistake found in
real use.
