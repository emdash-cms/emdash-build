# GPT-6.1 Terra at low effort against GPT-6 Luna, with and without a fewer-steps prompt

A 2×2 randomized complete block experiment on EmDash Build first builds. Run `terra-luna`, 2026-10-26 and 27. The plan was written before any trial and is in [PLAN.md](PLAN.md) under "Terra vs Luna run plan", with its dated amendments. Raw data stays in `.model-comparison/terra-luna/`, which git ignores.

## Abstract

GPT-6.1 Terra at low reasoning effort built EmDash sites in less than half the time GPT-6 Luna takes as it ships: a median first build of 1.8 minutes against 4.1, faster in all 7 blocks where every arm delivered (Hodges–Lehmann estimate −2.65 minutes, 95.3% interval −3.33 to −1.85, Holm p = 0.031). About three quarters of the saving was time spent waiting for each step's first output. Design quality did not differ measurably (estimate −0.10 points on a 10-point scale, interval −1.88 to 1.78, p = 0.81), but the interval is too wide to show that Terra is as good, so the pre-registered rule for calling Terra better is not met. Exploratory analysis suggests the quality depends on the brief: Terra scored higher on a one-page bakery site and lower on content-heavy editorial and event sites, where it wrote about half as much and reused photos. Terra cost four to five times as much per build at list prices (about $0.09 against $0.02). Each model delivered 17 of 18 builds. A prompt that groups work into fewer model steps cut steps by about a third for both models and again left build time unchanged.

## Methods

### Arms

Four arms cross two factors. Every arm built every block at the same time against one local dev server.

| Cell | Choice                                 | Model         | Reasoning effort     | Prompt      |
| ---- | -------------------------------------- | ------------- | -------------------- | ----------- |
| A0B0 | `openai/gpt-6-luna`                    | GPT-6 Luna    | production schedule  | standard    |
| A0B1 | `openai/gpt-6-luna:batched`            | GPT-6 Luna    | production schedule  | fewer steps |
| A1B0 | `openai/gpt-6.1-terra:all-low`         | GPT-6.1 Terra | low on every request | standard    |
| A1B1 | `openai/gpt-6.1-terra:all-low:batched` | GPT-6.1 Terra | low on every request | fewer steps |

The production schedule is medium for the interview, high for the first build step (which plans the schema and design), and medium for later steps. The `:all-low` tag sets low for the interview and every build step. Entry bodies run at low in every arm. The fewer-steps prompt is `src/worker/prompts/build-batched.md` (1,835 characters), unchanged from the Luna steps runs. It maps a first build onto about four steps and lists three type errors with their correct forms.

The model factor compares two configurations, Terra at low effort and Luna as it ships, not two models at one effort label.

### Request path

The gateway's unified API did not list Terra on its launch day, so every OpenAI request in this run, for all four arms and the OpenAI judge, went to the gateway's OpenAI endpoint (`AI_GATEWAY_OPENAI_ROUTE=provider`). Earlier runs used the unified API, so their absolute times are not comparable with this run's.

### Procedure

- 3 briefs (`stargazing`, `bakery`, `editorial`) × 3 repetitions = 9 blocks, 36 trials. The brief order within each repetition and the launch order within each block were shuffled with seed 20261026 (`design.json`).
- Each arm received the brief's prompt and direction as its first message. Any interview question got the same fixed reply.
- Before each block the runner waited until the app had idle-stopped every sandbox from earlier blocks (`--wait-idle`), so each block started on an idle machine. The waits are in `block-starts.jsonl`.
- A pilot block (`terra-pilot`, not analyzed) found two harness faults, both fixed before the main run: the route setting did not reach the worker, and eight concurrent containers ran out of memory. PLAN.md records both.

### Measures

- Design quality: two blind judges, `anthropic/claude-sonnet-5.5` and `openai/gpt-6.1-sol`, scored each block's delivered sites from screenshots (1440px desktop, 390px phone, up to three inner pages), once per label rotation, so each site took each position once. The overall score is the mean over judges and rotations. A block with one delivered site was not judged.
- Build time: wall time of the first build turn. Also model wait (time to each step's first output, summed), tool time, and step count.
- Delivery: a trial delivered if its build finished, passed the build quality check, and passed the public site audit.
- Cost: tokens at list prices, low end of the range (standard rates, uncached input at the input price), entry bodies included. Terra: $1, $0.05 cached, $5 output per million tokens. Luna: $0.10, $0.01, $0.50.

### Analysis

Per block, `factorial.mjs` forms the model main effect ((A1B0 + A1B1) − (A0B0 + A0B1)) / 2, the prompt main effect ((A0B1 + A1B1) − (A0B0 + A1B0)) / 2, their interaction (A1B1 − A1B0) − (A0B1 − A0B0), and the four simple effects. Each gets an exact two-sided Wilcoxon signed-rank p over blocks and a Hodges–Lehmann (HL) estimate with an exact confidence interval. With 9 blocks the interval runs from the 6th to the 40th of the 45 Walsh averages, a 96.1% interval, and the smallest possible p is 0.0039. A contrast uses the blocks where every cell it needs delivered and, for scores, was judged.

The primary family is the model main effect on the overall score and on build time, Holm-adjusted at α = 0.05. Every other test is secondary and reported unadjusted. `analyze.mjs` adds the exact Friedman test over all four arms (a failed build ranks worst in its block), the pairwise tests, and judge agreement.

## Results

The run had 36 trials in 9 blocks, with no excluded trials, no block reruns, no broken emulation, and no memory kills. Two builds failed, one Luna fewer-steps build (block 3) and one Terra standard build (block 9), so the factorial contrasts, which need all four cells, use the other 7 blocks.

### Primary outcomes

| Measure                      | Effect                    | Blocks | Terra better / worse | HL estimate | 95.3% interval | p     | Holm p |
| ---------------------------- | ------------------------- | ------ | -------------------- | ----------- | -------------- | ----- | ------ |
| Design score, overall (1–10) | Terra − Luna, main effect | 7      | 3 / 4                | −0.10       | −1.88 to 1.78  | 0.813 | 0.813  |
| First build, minutes         | Terra − Luna, main effect | 7      | 7 / 0                | −2.65       | −3.33 to −1.85 | 0.016 | 0.031  |

With 7 blocks, p = 0.016 is the smallest value the exact test can give. Within each prompt, Terra was faster in all 8 blocks where both builds delivered: by 2.30 minutes with the standard prompt (interval −3.42 to −1.57) and 3.06 minutes with the fewer-steps prompt (−3.66 to −2.30), each p = 0.008.

Against the decision rule: the overall score is not higher, and non-inferiority is not shown, because the interval's lower bound (−1.88) is below −0.5. Terra is faster at Holm p < 0.05 and delivers as many builds. Terra at low effort therefore does not count as better under the rule. The quality result is inconclusive, not a demonstrated tie.

### Per arm

Medians [interquartile range] over delivered builds. Scores are means over judged sites.

|                                           | Luna             | Luna, fewer steps | Terra low        | Terra low, fewer steps |
| ----------------------------------------- | ---------------- | ----------------- | ---------------- | ---------------------- |
| Builds delivered                          | 9/9              | 8/9               | 8/9              | 9/9                    |
| First build, minutes                      | 4.09 [3.07–4.94] | 4.98 [4.47–5.30]  | 1.82 [1.72–2.08] | 1.82 [1.59–1.84]       |
| Container start to finished site, minutes | 5.3              | 5.9               | 2.8              | 2.7                    |
| Waiting for first output, minutes         | 2.0              | 3.6               | 0.3              | 1.0                    |
| Model steps                               | 14 [11–15]       | 8.5 [8–10]        | 8 [7.5–8.25]     | 5 [5–5]                |
| Output tokens                             | 18.8k            | 15.8k             | 5.8k             | 5.5k                   |
| Reasoning tokens                          | 6.0k             | 4.6k              | 0.1k             | 0.1k                   |
| Builds that needed a second validation    | 3                | 5                 | 0                | 0                      |
| Cost per build, list price (low end)      | $0.023           | $0.017            | $0.091           | $0.092                 |
| Design score, overall                     | 6.96             | 7.10              | 6.93             | 7.11                   |
| Brief fidelity                            | 7.59             | 7.59              | 6.83             | 7.13                   |

Over all four arms, build time differed (exact Friedman p < 0.0001, Kendall's W = 0.74, a failed build ranked worst). Terra with the fewer-steps prompt was the fastest arm in 8 of 9 blocks and Terra with the standard prompt in the other. The overall score did not differ (Friedman p = 0.95, W = 0.02). Block wins on design were 3, 2, 1, and 3.

### Where the time went

|                                       | Luna  | Luna, fewer steps | Terra low | Terra low, fewer steps |
| ------------------------------------- | ----- | ----------------- | --------- | ---------------------- |
| Time to a step's first output, median | 6.8 s | 10.9 s            | 2.6 s     | 3.0 s                  |
| Reasoning tokens per step, median     | 228   | 473               | 0         | 9                      |

Of Terra's 2.65-minute saving, 2.04 minutes (interval 1.19 to 2.53, p = 0.016) was waiting for first output: Terra at low effort answers each step almost without reasoning, and it took 4.6 fewer steps per build (p = 0.016). It also wrote 11,000 fewer output tokens per build (p = 0.016), half of them reasoning. Every delivered Terra build passed its first and only validation. Writing speed cannot be separated from tool time in these metrics, because the AI SDK runs a tool while the model is still writing the step's next call.

### Design quality in detail

No criterion differed at p < 0.05. Terra's arms scored higher on layout (+0.53, p = 0.38) and typography (+0.30), and lower on brief fidelity (−0.55, p = 0.58) and mobile (−0.39).

| Judge                         | Luna | Luna, fewer steps | Terra low | Terra low, fewer steps | Own Friedman p |
| ----------------------------- | ---- | ----------------- | --------- | ---------------------- | -------------- |
| `anthropic/claude-sonnet-5.5` | 6.66 | 6.84              | 6.41      | 6.70                   | 0.85           |
| `openai/gpt-6.1-sol`          | 7.26 | 7.36              | 7.46      | 7.51                   | 0.89           |

The judges leaned opposite ways: Sonnet put the Terra arms about 0.2 below Luna's, and Sol, a sibling of Terra, about 0.2 above. Neither judge's own test approached significance. They agreed on individual sites (Spearman ρ = 0.77 over 34 sites), each agreed with itself across label orders (ρ = 0.84 and 0.85), and mean scores by label position were 7.10, 7.01, 7.02, and 6.96.

**Exploratory: brief by model.** This split was not planned and has 2 or 3 sites per cell.

| Brief                                    | Luna | Luna, fewer steps | Terra low | Terra low, fewer steps |
| ---------------------------------------- | ---- | ----------------- | --------- | ---------------------- |
| Bakery (one page)                        | 6.60 | 6.48              | 7.83      | 8.65                   |
| Stargazing (events, membership, contact) | 7.31 | 7.79              | 6.25      | 7.09                   |
| Editorial (stories, sections, writers)   | 6.97 | 7.00              | 6.49      | 5.58                   |

Terra wrote about half as much content as Luna on every brief (non-reasoning output of 4,200 to 7,700 tokens against 9,000 to 14,800), and on the editorial brief it ran 3.0 photo searches per build against Luna's 6.3. Both judges' notes on the weakest Terra editorial sites name the same faults: the same few photos repeated across stories, no visible authors, a clipped mobile menu. On the one-page bakery brief, lean output cost nothing: Terra with the fewer-steps prompt had the top score in all three bakery blocks. A plausible reading is that low effort suits small sites and shortchanges content-heavy ones. It needs a planned test.

### Reliability

- Luna, fewer steps, block 3: OpenAI ended a `function_call` with `status: "in_progress"` and the AI SDK rejected the stream. This is the truncated tool call seen in earlier runs. It now occurred through the gateway's OpenAI endpoint as well as the unified API. A fix is in progress on branch `noah/vigorous-murdock-676461`, which is not merged here.
- Terra low, block 9: the first build step wrote "I'm sorry—I wasn't able to build the site in this response." (49 output tokens, 28 of them reasoning) and called no tool. It had all 53 tools and the full 41,652-character prompt. The builder ended the turn rather than retrying.

### Cost

Terra cost $0.07 more per build (interval $0.07 to $0.08, p = 0.016), four times Luna's cost with the standard prompt and 5.4 times with the fewer-steps prompt. Its per-token price is 10 times Luna's. Its builds used about a third of Luna's input tokens (177,000 against 486,000) and a third of its output tokens, which recovered about half of the price difference. Terra's cached share of input was lower (66% and 43% against 79% and 73%), because shorter builds reuse their prompt over fewer steps.

### The fewer-steps prompt

The fewer-steps prompt cut steps by 3.25 per build (interval 1.5 to 6.0, p = 0.016) and added 1.00 minute of waiting for first output (0.77 to 1.34, p = 0.016), because bigger steps reason longer before they write. Build time did not change (+0.14 minutes, −0.55 to 0.73, p = 0.94), which repeats the Luna steps runs. For Luna it was 0.52 minutes slower (p = 0.25). For Terra it was 0.09 minutes faster, in 7 of 8 blocks (p = 0.11). Terra reasons so little that a bigger step adds less waiting (interaction on waiting −0.53 minutes, p = 0.031, unadjusted). The design score did not change (+0.22, p = 0.61).

### Predictions against outcomes

| Prediction, written before the run                                                                | Outcome                                                                                            |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Terra scores at least 0.5 higher overall                                                          | Wrong. −0.10, interval −1.88 to 1.78.                                                              |
| Terra builds at least 20% faster, median                                                          | Right. 1.8 against 4.1 minutes, 56% faster.                                                        |
| Terra costs 5 to 10 times as much per build                                                       | Nearly right. 4.0 times with the standard prompt, 5.4 times with the fewer-steps prompt.           |
| The fewer-steps prompt cuts median steps by at least 25% for both models                          | Right. Luna 14 to 8.5 (39%), Terra 8 to 5 (38%).                                                   |
| The prompt changes build time by no more than 20 seconds, and the interaction is under 30 seconds | Right on the main effect (+8 seconds). The interaction was 31 seconds, not significant (p = 0.30). |
| Every arm delivers at least 8 of 9 builds                                                         | Right. 9, 8, 8, and 9.                                                                             |

### Manipulation checks and conduct

- Effort: all 93 Terra build steps and all 18 Terra interviews logged `low`. Luna's interviews logged `medium`, its first build steps `high` (18 of 18), and its later steps `medium`.
- Prompt: every standard build prompt had 41,652 characters and every fewer-steps prompt 43,487, exactly 1,835 more. The pilot's shortfall did not recur once blocks started on an idle machine.
- Model: the gateway served `gpt-6.1-terra` to every Terra request and `gpt-6-luna` to every Luna request.
- Waits before blocks: 8.3 to 11.0 minutes, after which no earlier sandbox was running.
- Timing: the first block started at 23:56 UTC on 2026-10-26 and the last trial ended at about 02:18 UTC. Judging of blocks 1 to 8 (68 verdicts in all, none failed) ran during block 9's wait and build. It only resized images on the machine.

## Discussion

Terra at low effort is the largest speed improvement measured in this study. It halves the time a user waits for a first site, from about 5.3 minutes after the container starts to about 2.8, with the same delivery rate. The mechanism is simple: at low effort Terra answers each step at once, without the hidden reasoning that makes Luna wait about 7 seconds per step, and it finishes in fewer steps with no failed validations.

The price is about 7 cents more per build. That is four to five times Luna but small next to Opus 5.5's $1.56 in the main run. The claim that motivated this run, that Terra at low effort costs about what Luna does at maximum effort, could not be tested: Luna ran its production schedule, not `max`. Against Luna as it ships, Terra costs more.

Quality is the open question. On average the two models tied, but 7 blocks leave room for anything from a 1.9-point loss to a 1.8-point gain. The brief split points to a specific weakness: Terra writes lean sites, which suits a one-page bakery and shortchanges a magazine with many stories. That is a hypothesis from 2 or 3 sites per cell, and a follow-up should test it directly.

The fewer-steps prompt has now failed to save time in three runs. It moves time from many small waits into fewer, longer ones.

### Threats to validity

- Terra launched the day of the run. Its latency may change as launch traffic settles, and the times are a launch-week measurement.
- All OpenAI requests used the gateway's OpenAI endpoint, not the unified API of earlier runs, so absolute times are not comparable across runs. Both models shared the route.
- The model factor confounds model and effort by design. Terra ran at low effort and Luna at its production schedule.
- Four builds shared one machine. Waiting for idle machines before each block removed carry-over between blocks, but not contention within a block, which every arm shared.
- The builder prompts, including the fewer-steps section, were tuned on Luna.
- One judge, GPT-6.1 Sol, is a sibling of Terra. Its lean toward Terra (+0.2) is the same size as Sonnet's lean away from it (−0.2), and neither is significant.
- With 7 complete blocks the design-score interval is about ±1.8 points. Only large quality differences could have been detected.
- Costs use list prices. Gateway billing may differ.

### Recommendation

1. Terra at low effort is worth adopting for speed if about 7 cents more per build is acceptable, after two fixes. First, a first-build step that ends without a tool call should be retried, not accepted as a finished turn. Second, the content-heavy weakness needs a planned test: a prompt nudge for distinct photos per entry and fuller entries, or medium effort on content-heavy briefs.
2. Repeat the Terra arm once launch-week load settles and the gateway's unified API lists Terra, to confirm the times on the production route.
3. Drop the fewer-steps prompt as a speed change. Its type-error notes and result shapes could still be tested on their own.

## Reproduce

```bash
node scripts/model-comparison/run.mjs --run terra-luna --models openai/gpt-6-luna,openai/gpt-6-luna:batched,openai/gpt-6.1-terra:all-low,openai/gpt-6.1-terra:all-low:batched --reps 3 --seed 20261026 --heal-emulation --wait-idle
```

```bash
node --import ./scripts/model-comparison/ts-resolve.mjs scripts/model-comparison/judge.mjs --run terra-luna --judges anthropic/claude-sonnet-5.5,openai/gpt-6.1-sol
```

```bash
node scripts/model-comparison/analyze.mjs --run terra-luna
```

```bash
node scripts/model-comparison/factorial.mjs --run terra-luna --cells openai/gpt-6-luna,openai/gpt-6-luna:batched,openai/gpt-6.1-terra:all-low,openai/gpt-6.1-terra:all-low:batched
```

```bash
node scripts/model-comparison/oom-check.mjs --run terra-luna
```

The run needs `AI_GATEWAY_OPENAI_ROUTE=provider` and the four choices in `BUILDER_MODEL_CHOICES` in `.dev.vars`. The outputs are `.model-comparison/terra-luna/report.md`, `factorial.md`, and `review.html`, and the canvas at `.model-comparison/canvas-terra-luna/`.
