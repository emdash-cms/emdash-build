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

## Split run plan

Written on 2026-10-22, after the main run and before any split trial.

### Question

The main run found Opus 5.5's sites scored highest and cost about 80 times as much as Luna's. Does a written design handoff carry that design quality? The new arm, `anthropic/claude-opus-5.5>openai/gpt-6-luna`, has Opus design the first build and hand it to Luna to finish.

### The split arm

- **Designer.** Opus 5.5 runs the first build from its first step. It writes the three plan lines, creates the schema with one `apply_schema_plan` call, and writes the design system as source. That means the global stylesheet with its colour, type, and spacing tokens, the base layout, the header, the footer, and small shared components. It then calls `hand_off_design` with a written spec, which is saved as `DESIGN.md`. The spec covers the direction, tokens and type, layout and mobile behaviour, every route's sections, every block type, and imagery with search queries. The designer may only read files, run shell commands, create the schema, refresh types, write or edit files, and hand off. After 8 designer steps, the hand-off is its only tool.
- **Builder.** Luna runs every step after the hand-off, with every other tool. It does settings and menus, block renderers, the homepage, content and images, the remaining routes, and validation with the visual review. It sees the designer's messages, tool calls, and results, but not its reasoning, which one provider cannot replay to another. Its prompt says to follow the spec and reuse the design system.
- **Everything else** runs on Luna: the interview, and entry bodies in `create_entries_batch`.
- **Effort** keeps the labels in "Held constant". The first build step is high, which in the split arm is Opus's first step. Every later step is medium.
- The worker records each turn's steps, step time, and tokens by model, so cost prices each model's tokens at its own rates and the report shows each model's share. The arm's code is in `src/worker/design-handoff.ts` and the two role prompts are in `src/worker/prompts/design-*.md`.

### Design

A new run, `split`, repeats the main design with three arms: `openai/gpt-6-luna`, `anthropic/claude-opus-5.5`, and the split arm. There are 3 briefs and 3 repetitions, giving 9 blocks and 27 trials, with seed 20261022. Luna and Opus run again rather than reusing the main run's trials, because the split arm must share each block's conditions with the arms it is compared to. Measures, trial statuses, the rerun rule, judging, and analysis are the main run's. The judges are `anthropic/claude-sonnet-5.5` and `openai/gpt-6.1-sol`.

Time and quality stay co-primary at α = 0.025 each. The comparisons of interest are the split arm against Opus and against Luna, on quality and on cost. The report also gives the share of Opus's quality lead the split keeps, (split − Luna) / (Opus − Luna) on the mean judge score.

### Gate and pilot

`probe.mjs "anthropic/claude-opus-5.5>openai/gpt-6-luna"` ran a hand-off on the real gateway. Opus wrote a stylesheet and handed off, and Luna recorded the accent colour from Opus's spec. The served models were `claude-opus-5-5` twice, then `openai/gpt-6-luna` twice, with no warnings. The output is in `.model-comparison/probe-handoff.jsonl`. One pilot block (`bakery`, all three arms) runs first under `--run split-pilot` and is not analyzed.

### Predictions

These guesses were written before any split trial.

- The split arm's build turn falls between Luna's and Opus's.
- The split arm costs less than 35% of Opus per build.
- The split arm scores between Luna and Opus and keeps less than half of Opus's lead over Luna.
- The split arm delivers at least 8 of 9 builds.

### Threats to validity

- The designer prompt is new and untuned, while the builder prompt was tuned against Luna.
- The hand-off changes provider mid-turn, so the builder's first step starts without a prompt cache.
- The builder sees the designer's source only as tool-call inputs and the spec. A builder that restyles anyway shows up as a lower score, not as an error.

### Split pilot results

Recorded on 2026-10-22, after the split pilot and before the split run. Pilot data is not analyzed.

- All three arms delivered the `bakery` block, and the model check verified each. The split trial was served by `claude-opus-5-5` and then `gpt-6-luna`.
- The split arm kept its roles. Opus wrote the schema, `global.css`, the base layout, the header, the footer, and seven small components (about 25,000 characters), then a 17,791-character spec. Luna wrote the block renderers, the routes, the content, and the images, and validated.
- The designer's 3 steps took 5.7 minutes and produced 38,077 output tokens, more than the Opus-only build's 35,951 over 11 steps. The written spec restates the design in prose on top of the code. The split build turn took 9.9 minutes against Opus's 5.9 and Luna's 2.9. The time and cost predictions above may fail for this reason.
- The arm is unchanged for the main run. One pilot block is not enough to tune the treatment.

## Split run cut to 5 blocks

Recorded on 2026-10-22 during the split run, after blocks 1 and 2. The user asked for 5 blocks instead of 9, to free the machine for the helper run below. The runner stops after block 5 and the split analysis covers blocks 1 to 5. The cut follows the user's time budget, not the results.

## Helper run plan

Written on 2026-10-22, before any helper trial. This run is exploratory and smaller than the others, at the user's request.

### Question

Does a strong driver with a cheaper helper model build well? Two arms:

- `anthropic/claude-opus-5.5+anthropic/claude-haiku-5.5`: Opus 5.5 drives, Haiku 5.5 helps.
- `openai/gpt-6.1-sol+openai/gpt-6-luna`: GPT-6.1 Sol drives, Luna helps.

### The helper arms

- The driver runs every turn with every tool, on the effort schedule in "Held constant", plus a `delegate` tool. The driver's prompt asks it to delegate content and imagery once the schema exists, to start several tasks in one step so they run at the same time, and to keep the schema, the design, every source file, validation, and the visual review.
- A `delegate` call runs one helper loop on the helper model with the task text only, at low effort, up to 16 steps and 16,384 output tokens per step. The helper's tools are the build turn's own CMS content, taxonomy, byline, menu, settings, and media tools, plus `create_entries_batch` and `run_cms_script`. It has no file, schema, validation, preview, or delete tools. Its calls share the turn's validation state, so a helper's mutation makes validation stale, and a failure it leaves unresolved is the driver's to repair.
- Entry bodies in `create_entries_batch` run on the helper model.
- The worker records helper steps as sub-calls by model, so cost prices them at the helper's rates. The code is in `src/worker/helpers.ts`, with the prompts in `src/worker/prompts/helper.md` and `helper-driver.md`.

### Design

A new run, `helpers`, with the two arms building each block at the same time. There are 5 blocks, which are the first 5 of the 3-brief, 3-repetition schedule (`run.mjs --max-blocks 5`), with seed 20261023. Statuses, the rerun rule, capture, and analysis are the main run's. Sol is a candidate now, so it cannot judge. The judges are `anthropic/claude-sonnet-5.5` and `openai/gpt-6-astra`, which passed the image check. Google models still return "Insufficient balance".

With two arms and 5 blocks, the best possible result, one arm winning all 5, gives an exact two-sided p of 0.0625. No difference can reach significance, so the report describes the results and draws no significance claim.

### Gate

`probe.mjs "openai/gpt-6.1-sol"` passed every builder check: tool loops, effort, the forced tool, caching, edited history, and images. The output is in `.model-comparison/probe-sol.jsonl`. A delegate probe on the real gateway for both lineups is in `.model-comparison/probe-delegate.jsonl`. GPT-6.1 Sol is priced at $2 input, $0.10 cached input, $2.50 cache write, and $10 output per million tokens, with long-context rates over 272,000 tokens, from third-party price trackers.

### Predictions

These guesses were written before any helper trial.

- Opus + Haiku scores higher on design than Sol + Luna.
- Sol + Luna is faster and cheaper per build.
- Each driver delegates at least once in most builds.

### Helper run restarted after block 1

Recorded on 2026-10-22, after the first attempt's block 1 and before any trial of the restarted run. The first attempt is kept in `.model-comparison/helpers-v1/` and is not analyzed.

- Opus never called `delegate`. It did the content itself, and Haiku only wrote entry bodies, so the arm did not test helpers. Sol delegated twice. Delegation was a prompt suggestion, and one driver ignored it.
- The arms now split the work by tools. A driver with helpers cannot create or change entries, taxonomies, bylines, menus, or settings, and cannot search or upload photos, so that work goes through `delegate`. It keeps the read tools, the schema, files, validation, and the preview. The driver prompt says so, and leaves out the `run_cms_script` section.
- Sol's block 1 build ended when OpenAI streamed `server_is_overloaded` (503) mid-response. Turn metrics recorded that error object as "[object Object]". They now keep its message, and a turn that ends on a provider's overloaded error is excluded, like a network failure, so its block reruns.

## Speed run plan

Written on 2026-10-23, before any speed trial. This run is exploratory and small, at the user's request.

### Question

Which settings make an Opus 5.5 build faster, and what do they cost in money and design? In the earlier runs a median Opus build took about 7 minutes. About 3.4 minutes of that was writing roughly 40,000 output tokens, about 2.3 minutes was waiting for each step's first output, and about 1.2 minutes was tools. The per-step wait is mostly not thinking. Opus's median step spends 2.3 seconds before the first byte, 4.1 seconds before the first chunk, and 55 reasoning tokens.

### The arms

A choice string can now end in speed tags, parsed by `parseBuilderLineup` in `src/worker/model.ts`. The three arms build the same brief at the same time.

- `anthropic/claude-opus-5.5` is the baseline, on the effort schedule in "Held constant".
- `anthropic/claude-opus-5.5:fast` asks for fast mode (`speed: "fast"`, beta `fast-mode-2026-02-01`) on every Opus request of the session: the interview, every build step, and entry bodies. Anthropic quotes up to 2.5 times the output speed at twice the price ($8 input and $40 output per million tokens). `analyze.mjs` prices this arm's Opus tokens at twice the standard rates.
- `anthropic/claude-opus-5.5:low` runs every build step after the first at low effort instead of medium. The first step still plans at high effort, and the interview stays at medium.

### Design

A new run, `speed`, with 3 blocks, one per brief (`--reps 1`), seed 20261023. Statuses, the rerun rule, capture, and analysis are the main run's. The judges are the main run's, `anthropic/claude-sonnet-5.5` and `openai/gpt-6.1-sol`.

The main measure is the first build's wall time. The secondary measures are cost, the time split between writing, waiting and tools, and the judges' design score. With 3 arms and 3 blocks no difference can reach significance, so the report describes the results.

### Gate

`probe.mjs "anthropic/claude-opus-5.5:fast"` streams the same long answer four times through the gateway, alternating standard and fast. It has to show the API serving fast mode and a higher output rate before any trial. The output goes to `.model-comparison/probe-speed.jsonl`.

### Predictions

These guesses were written before any speed trial.

- Fast mode cuts the median build time by about 30%, from about 7 minutes to about 5. Writing gets about 2.5 times faster, and waiting and tools stay about the same.
- Fast mode costs about twice the baseline per build.
- Fast mode's design score is within 0.5 of the baseline's, because the model and the prompts are the same.
- Low effort saves less than 10% of the build time, because Opus already thinks little on routine steps.
- Low effort costs about the same as the baseline, and its design score is within 0.5 of the baseline's.

## Luna steps run plan

Written on 2026-10-23, before any trial of this run. The user asked for a faster Luna build that keeps its quality, through fewer model steps.

### Question

Does a prompt that groups independent work into fewer model steps make a Luna build faster without lowering its design score or its delivery rate?

### Where Luna's steps go

From the saved conversations and turn metrics of 26 healthy Luna first builds in the earlier runs (no broken emulation), a mean build of about 4 minutes and 13 steps:

- Before the first code is written, 6.6 steps and 87 seconds, 55 of them waiting for each step's first output. These are the schema plan, photo searches, uploads, content, settings, and menus, mostly one kind per step.
- From the first code write to the first `validate_site`, 2.3 steps and 87 seconds. This is the code itself.
- `validate_site` runs 1.6 times per build. In 12 of 27 builds the first run failed, almost always on a type error, and the repair and second validation cost 27 seconds a build on average. The repeated errors were `entry.title` for `entry.data.title`, `{...entry.edit?.title}`, and reading `.alt` from an image field, whose type also allows a string.
- The final summary step takes about 9 seconds.

The build prompt lists the work as an ordered workflow and says that independent read-only tools may share a step. It never says that independent mutations can share one, and `run_cms_script` can already upload photos, create content, and set up settings and menus in one program.

### The arms

- `openai/gpt-6-luna`, the baseline.
- `openai/gpt-6-luna:batched` adds one prompt section, `src/worker/prompts/build-batched.md`, after the CMS programs section. It maps the workflow onto about four steps: the plan with the schema and every photo search; then all code files in one `write_files` call next to one `run_cms_script` program that uploads the photos and creates the content, settings, and menus; then `validate_site`; then the summary or the fixes. It also lists the three repeated type errors with the correct forms, checked against the `emdash` 1.1.0 types in the sandbox image. The tools, the gates, and the effort are unchanged.

### Design

A new run, `luna-steps`, with 6 blocks: the 3 briefs, 2 repetitions each, seed 20261023, both arms building each block at the same time. Statuses, the rerun rule, capture, and analysis are the main run's. The judges are the main run's, `anthropic/claude-sonnet-5.5` and `openai/gpt-6.1-sol`.

The main measure is the first build's wall time. Quality is guarded by the judges' design score and by delivery. The change counts as keeping quality if the batched arm delivers at least as many builds and its mean design score is no more than 0.5 below the baseline's. With two arms and six blocks, the best possible exact two-sided p is 0.03125.

### Predictions

These guesses were written before any trial of this run.

- The batched arm takes at most 8 steps per build, median, against about 12.
- The batched arm is at least 45 seconds (about 20%) faster per build, median.
- Fewer of its first validations fail.
- Its design score is within 0.5 of the baseline's, and it delivers as many builds.

### Luna steps run restarted after block 1

Recorded on 2026-10-23, after the first attempt's block 1 and before any trial of the restarted run. The first attempt is kept in `.model-comparison/luna-steps-v1/` and is not analyzed.

- In block 1 the batched build took 14 steps and 6.1 minutes, against the baseline's 14 steps and 4.9 minutes. It followed the plan's first step, then lost steps in two places the prompt left to guesswork.
- Three of its four first searches were long keyword lists, and two returned no photos, so it searched three more times. The step plan now asks for queries of two to four words.
- Its one CMS program read the upload result as an array (`uploaded.map is not a function`) and failed after uploading, which took three repair steps. The step plan now gives the result shapes: `upload_media` resolves to `{ results }`, each with a `fieldValue`, and `content_create` to `{ item }`, whose `item.id` is the value a reference takes. 53 earlier programs that set references from `item.id` succeeded.
- The predictions stand as written.

### Second Luna steps run

Recorded on 2026-10-23, after the first run's results and before any trial of the second. The first run left the time difference unclear (each arm won 3 blocks) and brief fidelity lower for the batched arm, so the user asked for 6 more blocks.

- A new run, `luna-steps-2`: the same two arms, prompt, briefs, and judges, 2 repetitions of the 3 briefs, seed 20261024. The worker code and prompts are unchanged from the first run's restarted attempt.
- Both runs are reported on their own and pooled over 12 blocks. With 12 blocks the best possible exact two-sided Wilcoxon p is 0.0005.
- The predictions stand as written, now for the pooled result. Added before this run: brief fidelity for the batched arm stays within 0.5 of the baseline's when pooled.

## Terra vs Luna run plan

Written on 2026-10-26, before any trial of this run. The user asked for a benchmark of GPT-6 Luna against GPT-6.1 Terra at low reasoning effort, each with and without the fewer-steps prompt.

### Question

For a first build in EmDash Build, how does `openai/gpt-6.1-terra` at low reasoning effort compare with `openai/gpt-6-luna` at its production effort on design quality, build time, delivery, and cost? Does the fewer-steps prompt (`build-batched.md`) change either model's time or quality, and does its effect differ between the models?

### Background

OpenAI released GPT-6.1 Terra on 2026-10-26. Its model page lists $1 per million input tokens, $0.05 cached, $1.25 per million for cache writes, and $5 per million output tokens, with prompts over 272,000 tokens at 2× input and 1.5× output. That is 10 times Luna's list price per token ($0.10, $0.01, $0.50). Effort takes `none`, `low`, `medium` (default), `high`, `xhigh`, and `max`. On OpenAI's Agents' Last Exam, Terra scored 55.9% at low effort for $0.16 a task and 57.6% at medium for $0.29. Artificial Analysis puts Terra at low effort below Luna's cost per task on its index, because it uses fewer tokens. Those are general benchmarks, not site building.

### The arms

A 2×2 factorial: model (Luna, Terra at low effort) crossed with prompt (standard, batched). Every arm builds every block at the same time.

| Cell | Choice                                 | Model | Effort               | Prompt   |
| ---- | -------------------------------------- | ----- | -------------------- | -------- |
| A0B0 | `openai/gpt-6-luna`                    | Luna  | production schedule  | standard |
| A0B1 | `openai/gpt-6-luna:batched`            | Luna  | production schedule  | batched  |
| A1B0 | `openai/gpt-6.1-terra:all-low`         | Terra | low on every request | standard |
| A1B1 | `openai/gpt-6.1-terra:all-low:batched` | Terra | low on every request | batched  |

- The production schedule is the main run's: interview medium, first build step high, later build steps medium, entry bodies low.
- The new `:all-low` tag (`parseBuilderLineup` in `src/worker/model.ts`) sets low effort for the interview and every build step, the first build's plan step included. Entry bodies and holding replies are already low. The existing `:low` tag is different: it keeps the plan step at high.
- `:batched` adds `src/worker/prompts/build-batched.md` after the CMS programs section, unchanged from the Luna steps runs.
- The model factor is therefore a configuration, Terra at low effort against Luna as it ships, not the two models at one effort label. Luna at `max` effort is not tested.

### Changed from earlier runs

The gateway's unified API (`/ai/v1/responses`) does not list Terra yet: it answers `Model not found: openai/gpt-6.1-terra`. The gateway's OpenAI endpoint (`gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai/responses`) serves it, billed by the gateway, with the bare id `gpt-6.1-terra`. A new local setting, `AI_GATEWAY_OPENAI_ROUTE=provider`, sends every OpenAI request there, with `cf-aig-authorization` and no provider key. All four arms, the interview, entry bodies, and the judges' OpenAI model use that route in this run, so the route is the same for every arm. Absolute times are not comparable with earlier runs, which used the unified API. Deployed config does not set the variable.

### Gate

Recorded on 2026-10-26, before any trial. Evidence: `.model-comparison/probe-terra.jsonl`.

- `probe.mjs openai/gpt-6.1-terra,openai/gpt-6-luna` on the new route: Terra passed all eight checks (tool loop at low and high effort, low and high effort on a counting problem, a forced tool through `allowed_tools`, a cached prefix, an edited history, an image input). The gateway served `gpt-6.1-terra`.
- Reasoning tokens rose from low to high effort: 63 to 102 on the counting problem, 16 to 30 in the tool loop.
- The cached prefix reported 7,603 of 7,623 input tokens cached.

### Design

- Run `terra-luna`: the 3 briefs (`stargazing`, `bakery`, `editorial`), 3 repetitions, 9 blocks and 36 trials, 9 per arm. Seed 20261026. Launch order within a block is shuffled per block.
- Four builds share the machine in each block (earlier runs had two or three).
- Statuses, the rerun rule (`--rerun-excluded` reruns a whole block), capture, and `analyze.mjs` are the main run's.
- Judges: `anthropic/claude-sonnet-5.5` and `openai/gpt-6.1-sol`, as in the Luna steps runs. Each judge sees each block four times, once with each site in each position.
- Pilot: one block under `--run terra-pilot`, all four arms. It checks that Terra builds and delivers through the sandbox, that the turn metrics show the intended efforts, and that capture and a four-site judgment work. Its data is not analyzed. A harness change it forces is noted here before the main run.

### Measures

- Design quality: the mean `overall` score (1 to 10) across both judges and every label order. Secondary: the six criteria, brief fidelity first.
- Time: the wall time of the `initial-build` turn. Secondary: model wait (time to each step's first output, summed), tool time, step count.
- Delivery: delivered, failed, or excluded, as in the main run.
- Cost: tokens at list prices, low end of the range, with entry bodies (`analyze.mjs`).
- Tokens: output and reasoning tokens per build.

### Analysis

`scripts/model-comparison/factorial.mjs`, written and tested on synthetic data before this run, produces the factorial numbers. `analyze.mjs` produces the per-arm report, the Friedman test, the pairwise tests, and judge agreement.

- The unit is the block. For each block the script forms the model main effect, ((A1B0 + A1B1) − (A0B0 + A0B1)) / 2; the prompt main effect, ((A0B1 + A1B1) − (A0B0 + A1B0)) / 2; the interaction, (A1B1 − A1B0) − (A0B1 − A0B0); and the four simple effects.
- Each contrast gets an exact two-sided Wilcoxon signed-rank p over blocks and a Hodges–Lehmann estimate with its exact confidence interval. With 9 blocks the interval is the 6th to the 40th of the 45 Walsh averages, a 96.1% interval, and the smallest possible p is 0.0039.
- A contrast uses the blocks where every cell it needs delivered and, for scores, was judged. Delivery is reported per arm. As a sensitivity check, `analyze.mjs` ranks a failed build worst in its block.
- Primary family, Holm-adjusted at α = 0.05: the model main effect on the overall score, and the model main effect on build time. Every other contrast is secondary and reported with its exact p, unadjusted.
- Decision rule: Terra at low effort counts as better if its overall score is higher at Holm p < 0.05, or non-inferior (the interval's lower bound above −0.5) and faster at Holm p < 0.05, while delivering at least as many builds. Cost is reported for the product decision and does not enter the rule.

### Manipulation checks

- Effort: every Terra step logs `low`. Luna's first build step logs `high` and later steps `medium`. The source is each step's `effort` in the turn metrics.
- Prompt: the batched arms' build prompts are longer than the standard arms' by the size of `build-batched.md`.
- Model: the gateway serves `gpt-6.1-terra` and `gpt-6-luna` to their arms. The runner excludes a trial whose served model differs.

### Predictions

These guesses were written before any trial of this run.

- Terra at low effort scores at least 0.5 higher overall than Luna (model main effect).
- Terra at low effort builds at least 20% faster than Luna, median.
- Terra at low effort costs 5 to 10 times as much per build as Luna, median.
- The batched prompt cuts the median step count by at least 25% for both models.
- The batched prompt changes neither model's build time by more than 20 seconds (prompt main effect), as in the Luna steps runs, and the interaction on time is under 30 seconds.
- Every arm delivers at least 8 of its 9 builds.

### Known threats to validity

- Terra launched the day of this run. Its latency and capacity may differ later, so the times are a launch-week measurement.
- The route change: see "Changed from earlier runs".
- Four builds share one machine, so tool time includes more contention than in earlier runs. Contention hits every arm in a block alike.
- The builder prompts, including `build-batched.md`, were written and tuned against Luna.
- Effort differs by arm by design (see "The arms").
- One judge, `openai/gpt-6.1-sol`, shares a vendor with both candidates and a release family with Terra. The report gives each judge's means per arm, and Sonnet's are the check for family bias.
- Three briefs and 9 blocks detect large differences only.
- Cost uses list prices. Gateway billing may differ.
- At low effort, Terra's interview may ask different questions. The runner answers any question with the same fixed sentence.

### Pilot restarted after a harness fault

Recorded on 2026-10-26, during the pilot and before the main run. The first pilot attempt is kept in `.model-comparison/terra-pilot-v1/` and is not analyzed.

- Both Terra arms' interviews failed after six attempts with `Model execution failed`, from `api.cloudflare.com`. The worker had never received `AI_GATEWAY_OPENAI_ROUTE`: wrangler passes a `.dev.vars` key to the worker only if `wrangler.jsonc` declares it. The Luna arms had therefore also used the unified API. The probe had passed because it reads `.dev.vars` directly.
- `wrangler.jsonc` now declares `AI_GATEWAY_OPENAI_ROUTE` as an empty var, and `worker-configuration.d.ts` lists it. The pilot reruns as `terra-pilot` with the same seed. The unified API cannot serve Terra, so a Terra turn that the gateway serves shows the route reached the worker. The route is one setting for every OpenAI model in the worker, so the Luna arms take it too.

### Pilot results and changes before the main run

Recorded on 2026-10-26, after the pilot (`.model-comparison/terra-pilot/`, bakery) and before the main run.

- With the route fixed, all four interviews and builds ran. The gateway served `gpt-6.1-terra` to both Terra arms. Every Terra interview and build step logged `low`. Luna's interviews logged `medium`, and its builds `high` then `medium`.
- Terra at low effort and Luna batched delivered. Luna delivered after a repaired validation. Terra batched failed: both of its `validate_site` runs ended with exit code 137 (`astro check` killed), and it then ended its turn. At that moment eight containers were running, the pilot's four plus four from the interrupted first attempt, whose sessions had resumed and not yet reached the app's 10-minute idle stop. Together they held about 27 of Colima's 28 GiB. Luna's first validation was killed the same way.
- Build prompt sizes: both standard arms had 41,652 characters. The batched arms should have 1,835 more, but had 42,800 (Luna) and 39,882 (Terra). The build prompt includes a prefetched snapshot of the scaffold files, and a file the prefetch could not read is listed as missing instead, which shortens the prompt. The report gives each arm's prompt sizes.

Two changes follow, both before any main-run trial:

- `run.mjs --wait-idle`: before each block, the runner waits until the app has idle-stopped every sandbox from earlier blocks, polling `docker ps` for up to 20 minutes, and logs each wait in `block-starts.jsonl`. Every block then starts on an idle machine. The cost is about 10 minutes per block.
- A sandbox command killed for memory is an environment fault, like broken emulation. `oom-check.mjs --run terra-luna` lists trials with an exit code 137 tool result. Each such trial's whole block reruns with `--rerun-block`, and the first attempt is kept under `superseded/`. The check found no such kill in the earlier runs (`main`, `speed`, `luna-steps`, `luna-steps-2`).
