# Builder model comparison plan

This plan was written before any trial ran. A change made after data exists gets a dated note at the end, with its reason.

## Question

For a first build in EmDash Build, how do `openai/gpt-6-luna`, `anthropic/claude-haiku-5.5`, and `anthropic/claude-opus-5.5` compare on time to a finished site, on design quality, on reliability, and on cost, with reasoning effort held equal?

## Design

The experiment is a randomized complete block design. A block is one brief at one repetition. In each block, all three models build the same brief at the same time against one local dev server, so machine load, gateway latency, and time of day affect every model alike.

- Briefs: `stargazing`, `bakery`, and `editorial` from `scripts/smoke-briefs.json`.
- Repetitions: 3, giving 9 blocks and 27 trials, 9 per model.
- Order: `run.mjs` shuffles the brief order within each repetition with a seeded generator. The seed and the schedule are in `design.json`. A resumed run reads the schedule from `design.json`.
- Scope: the first build only. The follow-up edit turn is not run.

## Held constant

- Every model gets the same words. The first message is the brief's `prompt` followed by its `answer`. If the interview asks questions, the runner replies with one fixed sentence that adds nothing ("Everything I know is in my first message. Use your judgment for anything else.").
- The system prompt, tools, scaffold, and validation gates are those of one commit, recorded in `design.json`. Uncommitted changes go into `design.diff`.
- Every model goes through the same request path: `createBuilderModel` and the AI Gateway endpoint at `/ai/v1/responses`. Only the model id differs. A project pins its model on its first chat request, from a local client only, and only if `BUILDER_MODEL_CHOICES` lists the model. Only local dev config sets that variable.
- Reasoning effort follows the production schedule in `src/worker/model.ts`, the same for every model.

  | Phase                                      | Effort |
  | ------------------------------------------ | ------ |
  | Interview                                  | medium |
  | Holding reply                              | low    |
  | First build step (plans schema and design) | high   |
  | Later build steps                          | medium |
  | Entry bodies in `create_entries_batch`     | low    |

  A shared effort label does not guarantee equal thinking across vendors. The report gives each model's reasoning tokens so the realized effort is visible.

- Unsplash, the sandbox image, the dev server, and the 60-minute trial timeout are the same for every trial.

## Gate before the first trial

`probe.mjs` runs every check for every model: a tool loop at low and at high effort, a forced tool through `allowed_tools`, a cached prefix, an edited history, and an image input. Each check prints the model id the gateway served. The run starts only when, for every model:

- every check passes,
- reasoning tokens rise from low to high effort, which shows effort reaches the model,
- the cached prefix reports cached tokens, and
- the served model id matches the requested one.

If `forcedTool` fails for a model, a forced step for that model restricts the step's tool list to the one tool (the AI SDK's `activeTools`) with `toolChoice: "auto"`, and a step that excludes `exec` restricts the list to the other tools. This is the closest equivalent the model accepts, and the report states that the model ran with it. If another check fails, the run does not start, and the failure is reported.

## Measures

Time comes from the worker's turn metrics and milestones.

- Primary time measure: the wall time of the `initial-build` turn.
- Secondary time measures: the time from the container start to the `complete` milestone, the model wait (the sum of each step's time to first output), tool time, and step count. The container starts within a second or two of the first message.

Each trial gets one status.

- Delivered: the build finished, passed the build quality check, and passed the public site audit.
- Failed: the model ran and did not deliver.
- Excluded: the model never got a fair run. The reasons are provisioning, a gateway authentication error, no turn at all, or a model mismatch, where the worker's label or the model id the gateway served differs from the requested model. An excluded trial is not scored. `run.mjs --rerun-excluded` reruns its whole block, so all three models share the same conditions again.

Cost is tokens multiplied by list prices, including entry-body sub-calls. The trial record has no per-step prompt sizes, so cost is a range. The low end uses standard rates. The high end charges uncached input at the cache-write price, and applies long-context rates to every request if any prompt passed the threshold (100,000 tokens for Haiku, 272,000 for Luna). The prices are in `analyze.mjs`.

Design quality comes from blind judges.

- Primary quality measure: the mean `overall` score (1 to 10) across the model judges and every label order. A site counts only if every model judge scored it.
- Secondary quality measures: the per-criterion scores (layout, typography, colour and imagery, brief fidelity, polish, mobile), plus objective page checks (broken images, horizontal overflow on a phone).

Time and quality are co-primary. Each is tested at α = 0.025 (Bonferroni over the two).

## Judging protocol

`capture.mjs` screenshots the home page at 1440px and 390px wide, and up to three linked pages at 1440px, right after each build. `judge.mjs` sends each block's delivered sites to every judge as "Site 1", "Site 2", and "Site 3", with the first message the models received and the rubric. Judges never see a model name, trial id, or project id. Each judge sees every block once per site position, rotating the labels, so every site takes every position once. A judge's order for a block depends only on the seed, the judge, and the block. A verdict that leaves out a site or a score is an error and is retried, never scored.

The judge sees the first four 1800px tiles of the desktop home page (about 7,200px), the first two tiles of the phone home page (about 3,400px), and the first tile of each inner page. The full pages are in the gallery.

The judges come from three model families: Anthropic (`claude-fable-5.1`, which is not a candidate), OpenAI (a model other than Luna), and Google (neutral). The probe confirms the exact ids before judging starts. Two judges share a family with a candidate, and two of the three candidates are Anthropic models. For that reason the report gives each judge's mean per candidate and each judge's own block test, and the Google judge's result is the sensitivity check for family bias.

`gallery.mjs` writes a blind page for a human judge. It copies the images under opaque names, uses its own letters, and keeps the key in `gallery-key.json` outside the page. Human scores are reported beside the model judges' scores, not averaged into them.

## Analysis

`analyze.mjs` produces every number in the report.

- Each measure gets a Friedman test over blocks with an exact p-value. Every block's ranks are permuted, so the test needs no chi-square approximation at n = 9. Kendall's W comes with it.
- A failed build ranks worst in its block. A block is left out of a measure when a model has no scored trial in it, or a delivered site has no value for the measure (a capture or judge gap). Harness gaps never count against a model.
- Pairs get an exact Wilcoxon signed-rank test on block-paired differences, with Holm correction across the three pairs. A block where one side failed counts as the largest difference, in the other side's favour. The reported median difference uses only blocks where both sides delivered.
- Medians come with the interquartile range and the full range.
- The report gives judge agreement (Spearman ρ between judges, human included), order consistency (ρ between the first two label orders), mean score by label position, and each judge's mean per candidate.

## Predictions

These guesses were written before any data existed.

- Haiku has the shortest build turn, and Opus has the longest.
- Opus has the highest overall design score.
- Opus costs more than ten times as much per build as either of the others.

## Known threats to validity

- The builder prompts were tuned against Luna models, which may favour Luna.
- For Anthropic models, the gateway translates Responses requests. The gate above tests effort, caching, forced tools, edited history, and images. A provider that silently drops reasoning from an edited history passes the gate but loses that reasoning. Every build step rewrites earlier tool results when it drops superseded screenshots, so this can affect the Anthropic models and not Luna.
- Entry bodies have a 4,096-token output cap that includes reasoning, so a model that thinks longer there may retry more often.
- Three builds share one machine. Tool time includes contention, and screenshots of a finished site run while sibling builds may still be working. Model wait is not affected.
- Three briefs and 9 blocks detect large differences only. With 9 blocks, an exact Wilcoxon test reaches p < 0.05 only if one model wins at least 7 of the 9 blocks and its losses are among the smallest differences.

## Pilot

One block (`bakery`, all three models) runs first under `--run pilot`. It checks the harness end to end: the pinned and served model, screenshots, and a judge verdict. Its data is not part of the analysis. If the pilot forces a change to the harness, the change is noted here before the main run starts.

## Revisions before any trial

An independent review of the plan and harness, before any trial, led to these changes. Every model now receives the brief and its direction in the first message. Excluded trials are rerun by whole block, and only failures where the model ran are scored. Harness gaps leave a block out rather than ranking a site worst. Labels rotate once per site position. The served model id is checked. The Friedman p-value is exact. Cost is a range that includes cache writes and long-context rates. The human gallery is blind. The forced-tool remedy is set in advance.

## Gate results and changes before the pilot

These were recorded on 2026-10-21, before any trial ran. The evidence is in `.model-comparison/probe-builder-path.jsonl` and `.model-comparison/routes.jsonl`.

- The gateway's Responses endpoint cannot run Claude 5.5 models. It translates effort into budgeted thinking, which Haiku 5.5 rejects, and it does not translate Opus 5.5 requests at all. Claude models now go to the gateway's Anthropic Messages endpoint through `@ai-sdk/anthropic`, with adaptive thinking, the same effort label per step as Luna, and automatic prompt caching. Luna keeps the Responses endpoint. The gateway lists Claude models as `anthropic/claude-haiku-5.5` and `anthropic/claude-opus-5.5`.
- All three models passed the tool loops, the edited history, the image input, and the served-model check. Reasoning tokens rose from low to high effort on a counting problem: Luna 148 to 224, Haiku 281 to 627, Opus 123 to 166.
- Caching works for every model across the steps of one turn, which is how a build reuses its prompt. For Claude, two separate requests that share only a system prompt do not share a cache, because automatic caching marks the end of each request. The gate criterion is now "the tool loop reports cached tokens", which all three meet. The first step of each turn is uncached for every model, because the build prompt differs from the interview prompt.
- Luna and Haiku accept a forced tool. Opus 5.5 does not, so it runs with the remedy set above: the SDK sends only the forced tool, with `auto`. In the probe, Opus declined to call it, because the task hid the information it needed. The pilot shows how this plays out on the builder's forced final preview.
- Judges: `anthropic/claude-fable-5.1` on the Anthropic endpoint and `openai/gpt-6.1-sol` on the Responses endpoint. Google models return "Insufficient balance" on this gateway, so the neutral Google judge waits for credit. Without it, the per-judge table is the only check for family bias.

## Pilot results and changes before the main run

Recorded on 2026-10-21, after the pilot and before the main run. Pilot data is not analyzed.

- `BUILDER_MODEL_CHOICES` never reached the worker at first, because wrangler loads only declared keys from `.dev.vars` when the config lists required secrets. Every pilot project built with the default model, and the model check would have excluded those trials. The variable is now declared empty in `wrangler.jsonc`.
- Claude 5.5 models reject a conversation that ends with an assistant message. A first build after an interview without questions continues the interview's reply, which Luna's API accepts. For Claude, the turn's input now ends at the latest user or tool message. The reply stays in the stored conversation.
- A trial whose turn ended on a lost connection is excluded, as an infrastructure failure. One pilot trial died when the Mac slept.
- amd64 emulation through Rosetta broke three times in five hours, with no sleep event to explain it. Running containers continue, but every new process in the sandbox fails. The runner checks emulation before each block, restarts Colima when it is broken (`--heal-emulation`), and reruns a whole block if emulation broke during it and a trial did not deliver. A block whose trials all delivered stands.
- In the final pilot, Luna and Opus delivered. Haiku failed when one step spent 31,820 of the build's 32,768 output tokens on reasoning, so it never made its tool call. That cap is the product's own and applies to every model, so such a failure counts.
- `claude-fable-5.1` is not available on this gateway, because Anthropic requires data retention for it. The Anthropic-family judge is `anthropic/claude-sonnet-5.5`, which is not a candidate. On the pilot block, Sonnet scored Opus 9 and Luna 6, and GPT-6.1 Sol scored Luna 9 and Opus 8, the same in both label orders. That split follows model family, which makes the per-judge table, a Google judge, and the human scores necessary before drawing a quality conclusion.
- Final judges, chosen by the user before the main run's results: `anthropic/claude-sonnet-5.5` and `openai/gpt-6.1-sol` as model judges, plus the user's blind scores from the gallery. No Google judge. With one judge per candidate family, the per-judge table and the human scores carry the check for family bias.
