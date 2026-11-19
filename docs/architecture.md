# Architecture

How the Copper State Labs app fits together. Each module adds a section at the
end (see [Adding a module](#adding-a-module)) when it changes how the app
works: new pages, tables or AI calls.

_Fictional â€” for educational use._

## The starter app (Module 0)

A Next.js app that builds, runs and deploys with **no environment variables**.
A Google AI Studio key is optional until a module needs one.

| Piece | Where | What it does |
|---|---|---|
| Pages | `app/` | `layout.tsx` sets the fonts and theme; `page.tsx` is the placeholder home page |
| Brand components | `components/copper/` | `Logo`, `SiteHeader`, `SiteFooter`, `ModeToggle` |
| UI kit | `components/ui/` (shadcn), `components/ai-elements/` (AI Elements) | The only UI libraries the app uses |
| Setup card | `components/setup-required.tsx` | `<SetupRequired service="ai" />`, shown instead of a page whose service isn't configured |
| Company catalog | `lib/copper/catalog.ts`, `lib/copper/data/catalog.json` | Product, plan and privacy facts from the Product Bible (Sections 3, 4, 8 and 10). Pages read prices and plan details from here instead of typing them (added in the Module 1 starter) |
| AI wrapper | `lib/ai/call.ts` | `callText` and `callObject`: every model call goes through these and is logged to the terminal |
| Models and prices | `lib/ai/models.ts`, `lib/ai/pricing.ts` | The approved Gemini models and their token prices |

## Data flow

1. A user opens a page in `app/`.
2. Server code checks what's configured (`isAiConfigured()`). If the key is
   missing, the page renders `<SetupRequired />` instead of crashing.
3. Data comes from files under `lib/copper/data/`.
4. AI requests go through `callText` / `callObject` in `lib/ai/call.ts`, which
   calls Google and then prints one `[ai_calls]` line: `module`, `feature`,
   `model`, tokens, `cost_usd`, `latency_ms`, `ok`.

```ts
const { text } = await callText(
  { module: 2, feature: "ask-copper" },
  { prompt },
);
```

## Two kinds of "AI tiers"

Don't mix these up:

- **Copper State Labs' product tiers** (On-device, Raw Ore, Refined, the
  Copper Cloud) are part of the fictional company. They are facts in the
  [Product Bible](copper-state-labs/product-bible.md) and rows in the `ai_tiers`
  table.
- **The models this app calls** are real Claude models listed in
  `lib/ai/models.ts`. Their cost is logged in `ai_calls`.

## Decisions

- **No environment variables required.** Every service is optional, so a fresh
  clone builds and deploys before any accounts are set up.
- **One AI wrapper.** Routing every call through `lib/ai/call.ts` gives one
  place to log cost and latency per module and feature.
- **No authentication or row-level security yet.** They arrive in a later
  module.

## Adding a module

When a module changes how the app fits together, add a section here:

```md
## Module N: <feature name>

**Summary:** one or two sentences: what this adds and why.

| Piece | Where | What it does |
|---|---|---|
| Page / route | `app/...` | |
| Components | `components/...` | |
| Data | `lib/copper/data/...` | Data files added |
| AI calls | `lib/ai/call.ts` (module, feature) | Model, prompt purpose, expected cost per call |

**Data flow:** user action â†’ page â†’ server code â†’ database / model â†’ response.

**Decisions and trade-offs:** what you chose, the alternatives, and why.

**Risks and open questions:** cost, privacy, accuracy or safety risks, and how
you handle them.
```

## Module 3 starter: Ask Copper

**Summary:** Ask Copper, the Module 2 shopping chatbot, finished: a floating
chat panel that answers prices, totals and stock with four tools and shows
each step. Module 3 teaches it to answer from the customer documents.

| Piece | Where | What it does |
|---|---|---|
| Component | `components/copper/ask-copper.tsx` | The launcher and chat panel, mounted from `app/page.tsx` and opened by the header's `#ask` link. Draws each answer as stations: the tools on offer, thinking, each tool call, then the reply |
| Server Action | `lib/copper/assistant/ask.ts` | `askCopper()`: streams the conversation with `callStream`, up to 5 steps, and sends each step back as a live `Progress` |
| Tools | `lib/copper/assistant/tools.ts` | `copperTools`: `get_products`, `get_prices`, `calculate_cost`, `check_availability` |
| Instructions | `lib/copper/assistant/instructions.ts` | `COPPER_INSTRUCTIONS`. Copper says it can't help yet with warranty, setup, troubleshooting or privacy |
| Data | `lib/copper/inventory.ts`, `lib/copper/documents.ts` | Stock from `lib/copper/data/inventory.json`; `DOCUMENTS`: the four customer documents and their PDF paths under `public/docs/`. The PDFs are added in class |
| AI calls | `{ module: 2, feature: "ask-copper" }` | One streamed call per question |

## Module 3: Document passages and embeddings

**Summary:** The four customer PDFs in `public/docs/` are split into passages
of a few sentences and embedded with Gemini, so Ask Copper can find the
passages that answer a question and cite their page.

| Piece | Where | What it does |
|---|---|---|
| Build script | `scripts/embed-docs.mjs` (`npm run embed-docs`) | Reads each PDF in `DOCUMENTS` page by page (with `unpdf`), splits pages with `splitPage()`, embeds every passage and writes the JSON. Re-run it when a PDF changes |
| Splitter | `lib/copper/split-passages.ts` | `splitPage()`: drops the footer lines, then groups sentences three at a time (at most ~600 characters) |
| Data | `lib/copper/data/passages.json`, `lib/copper/passages.ts` | `PASSAGES`: `documentId`, `title`, `page`, `text` (starts with the document title) and `embedding`. Importing it loads every passage into memory once per server |
| Tool | `lib/copper/assistant/tools.ts` | `search_docs`: embeds the question, ranks every passage by cosine similarity and returns the 5 closest with title, page, a `/docs/<file>.pdf#page=N` link and a score. The tool card lists them with links; the instructions tell Copper to use it for setup, troubleshooting, warranty and policy questions and to cite the page |
| Citations | `lib/copper/assistant/citations.ts`, `lib/copper/assistant/instructions.ts` | Copper answers document questions only from `search_docs`, ends every sentence with `[Title, p. N]`, and says "I couldn't find that in our support docs" otherwise. `splitCitations()` lets the panel link each citation to that PDF page; unknown titles stay plain text |
| AI calls | `callEmbedMany` in `lib/ai/call.ts`, `{ module: 3, feature: "embed-docs" }` | `gemini-embedding-2` at 768 dimensions. One call per run of the script, plus one `{ module: 3, feature: "search-docs" }` call per search. Google doesn't report embedding tokens, so the log's tokens and cost are null |

**Data flow:** PDF â†’ pages â†’ passages â†’ Gemini embeddings â†’ `passages.json` â†’
`PASSAGES` in memory. Question â†’ `search_docs` â†’ question embedding â†’ 5
closest passages â†’ Copper answers from them and cites the page.

**Decisions and trade-offs:** A JSON file in memory instead of a vector
database: about 120 passages is under 1 MB, so searching all of them is
instant and needs no new service. 768 dimensions instead of 3072 keeps the
file small with little loss in accuracy. The title goes at the start of each
passage so similar passages from different documents (Copper Home vs. Copper
Notes) embed differently.

**Risks and open questions:** Questions must be embedded with the same model
and dimensions (`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`) or the search
returns nonsense. Tables lose their columns when turned into text. Embeddings match meaning
better than exact strings, so an error code like C-47 can rank below other
error-code passages (it was third in testing); keyword search alongside would fix that.

## Module 4: Refund agent, handoff and approvals

**Summary:** On the Support page, Copper hands refund requests to a second
agent, the Refund agent, with its own instructions and tools. The app (code,
not the model) compares the order amount with an auto-refund limit you can
change: at or under it, the refund goes through; over it, the refund waits on
the Refund Console until a person clicks Approve or Reject, and the Refund
agent tells the customer.

| Piece | Where | What it does |
|---|---|---|
| Orders and the rule | `lib/copper/orders.ts`, `lib/copper/data/orders.json` | Maya Reyes's four orders (#1001 to #1004). `requestRefund()` decides: `refunded` at or under the limit, `needs_approval` over it; an order already decided keeps its status; `not_found` for unknown numbers |
| Handoffs | `lib/copper/assistant/tools.ts`, `ask.ts` | Copper's `transfer_to_refund_agent` (Support page only) and the Refund agent's `transfer_to_copper`. Each ends that agent's turn (`hasToolCall`); the other agent answers the same conversation. The agent that ends a turn answers the next message |
| Refund agent | `lib/copper/assistant/instructions.ts` (`REFUND_AGENT_INSTRUCTIONS`), `tools.ts` (`refundAgentTools`) | `get_orders` and `request_refund`, built on the desk the chat sends. Copper can't use these |
| Refund Console | `app/support/page.tsx`, `components/copper/refund-console.tsx` | The auto-refund limit ($50 to start), the refunds waiting for approval with Approve and Reject, and the orders with their status. State lives in the page: a reload starts fresh |
| Chat panel | `components/copper/ask-copper.tsx` | With `support`, sends the desk (limit and refunds so far) and the current agent with each message, puts each `request_refund` decision on the console, and sends the console's "[Refund Console] A supervisor approved â€¦" note to the Refund agent, which tells the customer. Shows each handoff as its own station |
| AI calls | `{ module: 2, feature: "ask-copper" }`, `{ module: 4, feature: "refund-agent" }` | One call per agent in a turn |

**Data flow:** question â†’ Copper â†’ `transfer_to_refund_agent` â†’ Refund agent
â†’ `request_refund` â†’ the app compares the amount with the limit â†’ refunded,
or waiting on the Refund Console â†’ Approve or Reject â†’ console note â†’ Refund
agent tells the customer.

**Decisions and trade-offs:** The refund decision is code, so the model can't
argue past the limit. Two agents keep refund tools away from Copper. A real
handoff (the other agent answers) rather than an agent called as a tool keeps
one voice per reply. The console's state lives in the browser and goes with
each message, so there's nothing to set up and nothing stored on the server;
the cost is that a reload forgets every refund.

**Risks and open questions:** A customer can claim a supervisor already
approved; the Refund agent must still ask the app. Setting the limit to 0
sends every refund to a person. A real app needs a database so refunds
survive a reload and several supervisors see the same queue.

## Module 5 starter

**Summary:** Module 4 as finished. Module 5 makes Ask Copper safe to ship:
the tests and a golden-set evaluation with an AI judge run in GitHub Actions
on every pull request, with `main` protected; every AI call is traced in
Langfuse; and one support agent that does everything is compared with the two
agents on the same golden set. Langfuse is the only eval and monitoring tool.

## Module 5: Safe to ship

**Summary:** Four things that make Ask Copper safe to change. (1) The tests,
and a golden-set evaluation, run in GitHub Actions on every pull request, and
`main` is protected so a failing check blocks the merge. (2) Every question is
traced in Langfuse. (3) A golden set of questions is graded by an AI judge, and
the scores are kept in Langfuse. (4) One support agent with every tool is
compared with the two agents on the same golden set. Langfuse is the only eval
and monitoring tool.

| Piece | Where | What it does |
|---|---|---|
| CI | `.github/workflows/ci.yml` | `check` (lint, typecheck, tests, build on Linux, macOS and Windows) on every push and pull request; `eval` (the golden set) on every pull request. Needs the Actions secrets `GOOGLE_GENERATIVE_AI_API_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` |
| Branch protection | Settings of the GitHub repo (set with `gh api`) | `main` takes changes only through a pull request, and `check (ubuntu-latest)` and `eval` must pass first. Nobody pushes to `main` directly, the repo's owner included |
| Tracing | `instrumentation.ts`, `lib/ai/tracing.ts` | Registers the AI SDK's OpenTelemetry spans and sends them to Langfuse when the Langfuse keys are set. Does nothing without them |
| One trace per question | `lib/copper/assistant/ask.ts` | The trace `ask-copper` holds one observation per agent (`copper-agent`, `refund-agent` or `single-agent`), and under it each model call (tokens, cost, time) and each tool call. Tags say which variant ran |
| Golden set | `lib/copper/evals/golden-set.ts` | 16 questions with what a good answer says: prices, stock, documents, the refund rule (under the limit, over it, a false "my supervisor approved it", limit $0, the same refund twice, an unknown order), a hand-back mid-conversation and a prompt-injection attempt |
| AI judge | `lib/copper/evals/judge.ts` | A Gemini call through `lib/ai/call.ts` that gets the conversation, every tool result and the expected answer, and returns a 1 to 5 score, a grounded yes or no, and a reason |
| Scoring and the bar | `lib/copper/evals/score.ts` | A case passes with 4 or more, grounded, and the expected tools called. CI fails below an 80% pass rate |
| Runner | `scripts/eval.ts` (`npm run eval`) | Runs the cases, grades them, writes `eval-results.json` and the CI summary, and records a dataset run in Langfuse (`copper-golden-set`). `--variant both` runs the two setups so Langfuse can compare them |
| One agent | `singleAgentTools()` in `tools.ts`, `SINGLE_AGENT_INSTRUCTIONS` in `instructions.ts` | One support agent with Copper's five tools plus `get_orders` and `request_refund`, and no handoff. Only the evaluation uses it (`variant: "single"`) |
| AI calls | `{ module: 5, feature: "judge" }`, `{ module: 5, feature: "single-agent" }` | One judge call per case; the one-agent variant is one streamed call per question |

**Data flow:** a golden-set case â†’ `runCase()` asks Ask Copper the way the chat
panel would â†’ the answer and every tool call â†’ the judge grades it â†’ scores â†’
Langfuse (dataset run and traces), the terminal and the CI summary. A failing
pass rate fails the `eval` job, and GitHub blocks the merge.

**Decisions and trade-offs:** The gate is a pass rate, not a perfect score,
because a model's answers vary a little from run to run. CI requires the Linux
check and `eval`; macOS and Windows still run but don't block, because the
`start-module` test is slow enough on those runners to time out now and then.
The evaluation paces itself to 12 requests a minute (`EVAL_RPM`) because
Google's free tier allows about 15. The chat panel never sends `variant`, so
what shoppers use doesn't change.

**Risks and open questions:** The judge is a model too, so it can be wrong or
lenient; it sees the tool results, which makes it grade against facts rather
than style, and the failing cases are listed with its reasons so a person can
check. Traces keep customers' messages and Copper's answers, so a real launch
needs a retention and privacy decision. The golden set is only as good as its
questions: add a case for every mistake found in production.

The one-agent versus two-agent comparison, with the Langfuse run links and a recommendation, is in [single-vs-multi-agent.md](single-vs-multi-agent.md).
