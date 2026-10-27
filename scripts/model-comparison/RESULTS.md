# Builder model comparison results

Run `main`, 2026-10-21. The design, measures, and every change made before the run are in [PLAN.md](PLAN.md). The decision log is [decisions.tsv](decisions.tsv). Regenerate every number below with `node scripts/model-comparison/analyze.mjs --run main`. The raw data stays in `.model-comparison/main/`, which git ignores.

## Summary

GPT-6 Luna is the fastest and cheapest builder by a wide margin, and that result is significant. Both blind judges scored Opus 5.5's sites highest, but the planned test across all three models missed its threshold, so the design result is suggestive, not proven. Opus takes twice Luna's build time and costs about 80 times as much. Haiku 5.5 is not ready for this builder as configured: about a third of its builds fail because it spends its whole output budget reasoning.

|                                           | GPT-6 Luna            | Haiku 5.5         | Opus 5.5          |
| ----------------------------------------- | --------------------- | ----------------- | ----------------- |
| Builds delivered                          | 9/9                   | 6/9               | 9/9               |
| Build turn, median (IQR)                  | **3.5 min** (2.8–3.9) | 4.9 min (4.4–6.6) | 7.0 min (6.8–7.3) |
| Model wait (sum of time to first output)  | 1.8 min               | 3.2 min           | 2.3 min           |
| Reasoning tokens per build, median        | 8,051                 | 38,658            | 8,262             |
| Cost per build at list prices             | $0.02                 | $0.05–0.28        | $1.56–1.67        |
| Design score, mean of blind judges (1–10) | 6.45                  | 6.92              | 8.32              |
| Blocks won on design                      | 1                     | 1                 | 7                 |

All three models ran with the same effort label on every step and through the same builder code. The only difference in the request path is that Claude models use the gateway's Anthropic Messages endpoint, because its Responses endpoint cannot run Claude 5.5 models.

## Verdicts against the plan

Time is VERIFIED. Luna had the shortest build turn in all 9 blocks (Friedman exact p = 0.0003, Kendall's W = 0.75). Luna was faster than Haiku by a median of 1.8 minutes and faster than Opus by 4.1 minutes (exact Wilcoxon, Holm p = 0.012 for each pair). Haiku and Opus did not differ measurably (Holm p = 0.65), partly because Haiku's failures leave only 6 paired blocks.

Design quality is INCONCLUSIVE at the planned threshold. The omnibus test across all three models gives exact p = 0.060, short of the α = 0.025 set for each co-primary measure. The pairwise tests point the same way as every other view of the data: Opus scored above Luna (median +2.3 points) and above Haiku (median +1.8 points), each at Holm p = 0.047. Opus won 7 of 9 blocks and scored highest on every brief: stargazing 8.6, bakery 8.5, editorial 7.8. With nine blocks the omnibus test has little power, so the miss is a limit of this run, not evidence that the models design equally well.

Reliability: Luna and Opus delivered every build. Haiku failed 3 of 9. Two failures hit the build's 32,768-token output cap while reasoning, so no tool call followed. The third finished its turn but failed the build quality check.

Block reruns moved Haiku's count both ways. In blocks 1 and 2, Haiku delivered in the first attempt and failed in the rerun. In block 4 it failed first and delivered in the rerun. Those reruns were triggered by other models' crashed builds, and a Haiku failure that is not a crash never triggers one, so a rerun does not depend on Haiku's result. Counting every attempt in which Haiku finished its turn, superseded ones included, Haiku delivered 9 of 13 (69%), close to the 6 of 9 (67%) in the scored attempts. Both say roughly a third of its builds fail.

Cost: Opus costs about 80 times as much as Luna per build. Haiku's range is wide because its prompts passed the 100,000-token long-context threshold, and the trial record cannot say which requests did.

## Judges

The two model judges agree that Opus is best and disagree about the rest. Their scores per site correlate at Spearman ρ = 0.56 over 24 sites.

| Judge                         | Luna | Haiku | Opus | Own block test   |
| ----------------------------- | ---- | ----- | ---- | ---------------- |
| `anthropic/claude-sonnet-5.5` | 5.35 | 6.50  | 8.54 | exact p = 0.0005 |
| `openai/gpt-6.1-sol`          | 7.56 | 7.33  | 8.11 | exact p = 0.069  |

Sonnet puts Opus 3.2 points above Luna, and Sol puts it 0.6 points above. Sonnet ranks Haiku above Luna, and Sol ranks them level. This pattern fits a family bias in each judge, Anthropic toward Claude and OpenAI toward Luna. The Opus lead survives it, because even the OpenAI judge scores Opus highest. The Luna and Haiku ordering does not survive it. The human scores in the gallery are the tie-breaker.

Position bias is small and was balanced by rotating labels. Mean scores by position were 7.38, 7.25, and 7.17. Each judge agreed with itself across label orders (ρ = 0.92 and 0.94).

By criterion, Luna had the strongest typography after Opus (8.05) and the weakest colour and imagery (6.72) and brief fidelity (6.40). My own read of the sites matches. Luna's sites have bold editorial type but fewer photos and less content, with occasional reused photos and one caption that collides with a badge. Opus builds longer pages with more photography, more pages, and more varied layouts. Haiku's delivered sites follow the brief closely and look plainer.

## Predictions

- Haiku would have the shortest build turn: wrong. Luna was fastest, and Haiku spent the most time waiting on its own reasoning.
- Opus would have the longest build turn: right.
- Opus would score highest on design: right in every summary, though short of the planned significance threshold.
- Opus would cost more than ten times either other model: right against Luna (about 80 times). Against Haiku the ratio is 6 to 31 times, depending on the long-context pricing Haiku actually paid.

## What went wrong during the run, and how it was handled

- amd64 emulation through Rosetta broke 7 times during the run, with no matching sleep event. Running sandboxes kept going, but every new process failed, so a build running at the moment of a break crashed. The runner restarted Colima and reran the whole block, so all three models always shared conditions. Provisioning failed in one more attempt. Of 8 block reruns, every one had a crashed build or excluded trials.
- The rerun rule changed during the run. It started as "emulation broke and a trial did not deliver". After block 3 it became "emulation broke and a build crashed", so a model that finished its turn and failed the checks keeps that failure. The running process kept the first rule, so an audit in `analyze.mjs` checks every rerun, and after the run the audit was corrected to accept attempts whose trials were all excluded. All three versions make the same call on all 8 reruns, so the scored attempts do not depend on which rule applied.
- Earlier failures were fixed before the main run and are recorded in PLAN.md. They include the model pin that wrangler dropped, Claude's rejection of assistant prefill, and network drops while the Mac slept.

## Limits

- Three briefs and nine blocks detect only large differences.
- Design quality rests on two model judges with opposite family leanings, plus the human scores still to come.
- The builder prompts were tuned against Luna models.
- Tool time includes contention among three emulated sandboxes on one Mac. Model wait does not.
- Reasoning effort shares a label across models but not a scale. Haiku reasoned about five times as much as the others at the same labels.
- Claude models receive a slightly different input in one case. When a first build follows an interview that asked no questions, Luna continues its own interview reply, while Claude's input ends at the user's message, because Claude 5.5 rejects a conversation that ends with an assistant message. The reply is a short acknowledgement, and the build prompt carries every instruction.
- Opus builds take longest, so they were the most exposed to emulation breaks and caused most of the reruns. A rerun discards the whole block, the other models' finished builds included.
- Prices for Luna come from third-party trackers, and gateway billing may differ.

## Recommendation

Keep Luna as the default for speed and cost. Consider Opus where design quality matters more than a 4-minute wait and $1.60 per build, for example as an opt-in "premium build". Do not switch to Haiku 5.5 as configured. Its 33% failure rate comes from runaway reasoning, and its sites did not score better than Luna's under the neutral comparison of the two judges.

Two follow-ups would sharpen this:

- Opus for the first build step only, the one that plans the schema and the design, with Luna for the rest. This tests whether most of Opus's design lead comes from planning, at a fraction of the cost.
- Haiku at lower effort, or with a higher output cap, to see whether its failure mode is a setting or the model.

## Split run: Opus designs, Luna builds

Run `split`, 2026-10-22, 5 blocks (cut from 9 at the user's request). The plan, the pilot, and the cut are in [PLAN.md](PLAN.md) under "Split run plan". Regenerate with `node scripts/model-comparison/analyze.mjs --run split`.

|                                    | GPT-6 Luna | Opus 5.5 | Opus designs, Luna builds |
| ---------------------------------- | ---------- | -------- | ------------------------- |
| Builds delivered                   | 5/5        | 5/5      | 2/5                       |
| Build turn, median                 | 3.4 min    | 7.1 min  | 8.5 min                   |
| Cost per build, median (low end)   | $0.02      | $1.53    | $0.92                     |
| Design score, mean of blind judges | 6.22       | 8.25     | 7.92 (2 sites)            |
| Blocks won on design               | 0          | 4        | 1                         |

A written handoff kept much of Opus's look when it worked, but it failed too often, and it was slower and only somewhat cheaper. Opus's design step writes the design system as code and then describes it again in a spec of about 18,000 characters. That step alone produces as much output as a whole Opus build, so the split costs about 60% of Opus and takes longer, because Luna's part comes after it.

Every split failure had the same cause. After the handoff, Luna wrote a long `run_cms_script` with whole article bodies inline. The response came back with the tool call marked `incomplete`, and the AI SDK rejects that stream event, so the turn ended with an error. Luna alone never did this, in this run (5 of 5) or the main run (9 of 9). This is a real defect in the builder. A truncated tool call ends the whole build instead of returning an error the model could act on, and it could reach production, which runs on Luna.

The two split sites that delivered scored 8.83 (above Opus's 7.50 on that block) and 7.00 (below Opus's 9.00). On those two blocks the split kept about three quarters of Opus's lead over Luna. Two sites cannot carry a conclusion. On the bakery block, the split site and Opus's site share the same palette, Fraunces display type, and terracotta accents, which suggests the design system survives the handoff.

Predictions: the split's build turn would fall between Luna's and Opus's, wrong (it was longest). It would cost under 35% of Opus, wrong (about 60%). It would keep less than half of Opus's lead, not supported (about three quarters on 2 sites). It would deliver nearly every build, wrong (2 of 5).

## Helper run: a driver with cheaper helpers

Run `helpers`, 2026-10-22, 5 blocks, two arms. The plan, the restart after block 1, and the reasons are in [PLAN.md](PLAN.md) under "Helper run plan". Regenerate with `node scripts/model-comparison/analyze.mjs --run helpers`.

|                                    | Opus + Haiku helpers | Sol + Luna helpers |
| ---------------------------------- | -------------------- | ------------------ |
| Builds delivered                   | 5/5                  | 5/5                |
| Build turn, median                 | 8.5 min              | 5.4 min            |
| Cost per build, median (low end)   | $1.19                | $0.23              |
| Helper share of that cost          | $0.02–0.03           | about $0.01        |
| Design score, mean of blind judges | 8.00                 | 6.60               |
| Blocks won on design               | 4.5                  | 0.5                |

Every build delivered, and every driver delegated 2 to 5 tasks. Opus + Haiku scored higher in 4 blocks and tied in the bakery block. Sol + Luna was faster in 4 of 5 blocks and cheaper in all 5. With two arms and five blocks no difference can reach significance (the best possible exact p is 0.0625), so these are descriptions, not tests.

The judges were `anthropic/claude-sonnet-5.5` and `openai/gpt-6-astra`, because Sol was a candidate. Sonnet scored the arms 8.30 and 5.80; Astra scored them 7.70 and 7.40. The same family split as the main run shows here.

Helpers are cheap, under 3 cents a build, and nearly all the cost is the driver. Against the single-model arms of the earlier runs, which used different judges and different days, Opus + Haiku cost about 25% less than Opus alone ($1.19 against $1.53–1.67) and took about 1.5 minutes longer, because each helper loop runs inside the driver's turn. Sol + Luna cost about ten times as much as Luna alone ($0.23 against $0.02) and took about 2 minutes longer, for a similar score.

Predictions: Opus + Haiku would score higher, right. Sol + Luna would be faster and cheaper, right. Each driver would delegate in most builds, right once delegation was the only way to write content.

## Speed run: fast mode and low effort for Opus

Run `speed`, 2026-10-23, 3 blocks, three Opus 5.5 arms built at the same time. The plan and the predictions are in [PLAN.md](PLAN.md) under "Speed run plan". Regenerate with `node scripts/model-comparison/analyze.mjs --run speed`.

|                                      | Opus 5.5 | Opus 5.5, fast mode | Opus 5.5, low effort |
| ------------------------------------ | -------- | ------------------- | -------------------- |
| Builds delivered                     | 3/3      | 2/3                 | 2/3                  |
| Build turn, median of delivered      | 6.7 min  | 4.7 min             | 5.8 min              |
| Waiting for each step's first output | 1.7 min  | 1.3 min             | 1.5 min              |
| Writing                              | 3.3 min  | 1.5 min             | 2.6 min              |
| Tools                                | 1.5 min  | 2.0 min             | 1.7 min              |
| Cost per build, median (low end)     | $1.54    | $3.96               | $1.22                |
| Design score, mean of blind judges   | 7.25     | 8.50                | 7.25                 |

Waiting and tools are the report's medians. Writing is each build's step time after the first output minus its tool time, as a median, so the three rows do not add up exactly to the build turn.

The gate probe streamed the same long answer through the gateway four times. The API reported serving fast mode at 203 and 223 output tokens per second, against 77 and 86 at standard speed. The probe output is in `.model-comparison/probe-speed.jsonl`. A first probe attempt showed that the AI Gateway answers a repeated identical request from its response cache, so the probe now varies its prompt.

### Block by block

| Block        | Opus 5.5             | Fast mode            | Low effort           |
| ------------ | -------------------- | -------------------- | -------------------- |
| 1 editorial  | 7.1 min, 7.17, $1.54 | 4.8 min, 8.83, $4.34 | 6.7 min, 7.17, $1.56 |
| 2 bakery     | 6.7 min, delivered   | 3.2 min, save failed | 5.2 min, save failed |
| 3 stargazing | 6.6 min, 7.33, $1.28 | 4.6 min, 8.17, $3.57 | 4.8 min, 7.33, $0.89 |

Each cell gives the build turn, the design score, and the low-end cost.

In block 2 the fast and low-effort builds finished and passed the quality check, then failed to save the session checkpoint after the build. Under the main run's rules they count as failed, and block 2 has no design comparison because only one site delivered. The block's first attempt was superseded because emulation broke during it. In that attempt the baseline failed on the same save error, and fast and low delivered in 3.4 and 5.7 minutes. That makes three save failures in block 2, across all three arms, and none in blocks 1 and 3, so the failure looks unrelated to the arms. The worker does not record the reason for a failed save, and this save error is the most common first-build error across every run so far.

### What it shows

Fast mode was the fastest arm in every block, including both block 2 attempts. It cut the build by about 2 minutes (30%), mostly in writing, which ran about 2.2 times faster. Waiting for each step's first output also dropped by about a quarter. Tool time rose, from 1.5 to 2.0 minutes, so tools are now the largest part of a fast build. Fast mode cost 2.6 times the baseline, more than its doubled price, because the fast builds also read and wrote more tokens (1.26 million input and 60,000 output tokens against 0.85 million and 46,000). It scored highest in both judged blocks with both judges. The model and prompts are the same, and two blocks cannot separate that from chance.

Low effort saved about a minute (13% on the delivered median, 22% counting the block 2 build that finished before its save failed). It did this through fewer steps (median 11 against 14) and less output, and its thinking dropped only slightly. It cost about 20% less than the baseline and tied it on design in both judged blocks. The judges split on it: Sonnet scored it 6.50 against the baseline's 7.33, and Sol scored it 8.00 against 7.17.

With three arms, three blocks, and only two judged blocks, none of these differences is significant. The judges agreed weakly (Spearman ρ = 0.32 over 6 sites).

### Predictions

- Fast mode would cut the build time by about 30%. Right: 6.7 to 4.7 minutes.
- Fast mode would cost about twice the baseline. Wrong: 2.6 times, because its builds used more tokens.
- Fast mode would score within 0.5 of the baseline. Wrong: 1.25 points higher, over two blocks.
- Low effort would save less than 10%. Wrong: it saved 13–22%, through fewer steps rather than less thinking.
- Low effort would cost about the same. Partly wrong: 20% less.
- Low effort would score within 0.5 of the baseline. Right: the same score in both judged blocks.

## Luna steps run: a prompt for fewer model steps

Run `luna-steps`, 2026-10-23, 6 blocks, two Luna arms built at the same time. The plan, the step analysis behind it, the restart after the first attempt's block 1, and the predictions are in [PLAN.md](PLAN.md) under "Luna steps run plan". Regenerate with `node scripts/model-comparison/analyze.mjs --run luna-steps`.

|                                    | GPT-6 Luna | GPT-6 Luna, fewer steps |
| ---------------------------------- | ---------- | ----------------------- |
| Builds delivered                   | 6/6        | 6/6                     |
| Build turn, median                 | 5.0 min    | 3.6 min                 |
| Build turn, mean                   | 4.5 min    | 3.9 min                 |
| Steps, median                      | 13         | 9                       |
| `validate_site` time, median       | 47 s       | 27 s                    |
| Cost per build, median (low end)   | $0.020     | $0.017                  |
| Design score, mean of blind judges | 7.17       | 6.96                    |

### Block by block

| Block        | Luna              | Fewer steps       |
| ------------ | ----------------- | ----------------- |
| 1 editorial  | 5.6 min, 24 steps | 3.8 min, 8 steps  |
| 2 bakery     | 2.7 min, 11 steps | 2.7 min, 5 steps  |
| 3 stargazing | 3.2 min, 10 steps | 3.3 min, 10 steps |
| 4 editorial  | 4.8 min, 12 steps | 6.1 min, 12 steps |
| 5 stargazing | 5.2 min, 13 steps | 4.6 min, 8 steps  |
| 6 bakery     | 5.7 min, 18 steps | 2.8 min, 10 steps |

Emulation broke during blocks 1, 3, and 5, and each reran whole under the main run's rule.

### What it shows

The step plan cut the median build from 13 steps to 9, with the same tools and gates. In block 2 the batched build needed 5 steps.

The time saving is uneven. The arm medians fell by 1.4 minutes, but each arm won 3 blocks, and the median paired difference is 0.28 minutes (exact Wilcoxon p = 0.56). The big savings came in blocks 1 and 6, where plain Luna wandered: 24 steps in block 1, with its content spread over six separate steps, and five validations in block 6. Where plain Luna was already direct, fewer steps saved nothing. Block 2 shows why. The batched build reasoned 5,500 tokens in its few large steps, against the baseline's 2,700 over all of its steps, and that cancelled the waits it skipped. In block 4 the batched build failed validation twice and was 1.3 minutes slower.

Validation failed less often. Four of six plain Luna builds validated more than once, against two of six batched builds, and median validation time fell from 47 to 27 seconds.

Quality held within the pre-set guard: both arms delivered every build, and the batched arm scored 0.21 lower, with a tie on block wins (3 each). Both judges scored it slightly lower (Sonnet 6.50 against 6.58, Sol 7.42 against 7.75). Brief fidelity fell the most, from 7.50 to 6.88, while typography and polish rose. The judges agreed moderately (Spearman ρ = 0.58 over 12 sites).

### Predictions

- At most 8 steps per build, median. Narrowly wrong: 9, down from 13.
- At least 45 seconds (about 20%) faster per build, median. Right on the arm medians (1.4 minutes), but the paired median difference is only 17 seconds and the blocks split 3–3.
- Fewer first validations fail. Right: 2 of 6 builds needed a second validation, against 4 of 6.
- Design score within 0.5, and as many builds delivered. Right: 0.21 lower, 6 of 6 each.

### Second run and the pooled result

Run `luna-steps-2`, 2026-10-23, 6 more blocks with seed 20261024 and nothing else changed. Block 5's first attempt ended in provisioning for both arms ("The previous dev server did not stop cleanly"), so both trials were excluded and the block reran under `--rerun-excluded`. In the rerun the batched build failed: OpenAI ended a `function_call` with `status: "in_progress"` and the AI SDK rejected the stream. It is the same truncated tool call that ended three split-run builds in 40-second steps, so the prompt did not cause it, but under the rules it counts as a failure.

|                                | GPT-6 Luna | GPT-6 Luna, fewer steps |
| ------------------------------ | ---------- | ----------------------- |
| Run 2: builds delivered        | 6/6        | 5/6                     |
| Run 2: build turn, median      | 3.4 min    | 3.4 min                 |
| Run 2: design score            | 7.05       | 7.33                    |
| Pooled: builds delivered       | 12/12      | 11/12                   |
| Pooled: build turn, median     | 4.2 min    | 3.4 min                 |
| Pooled: steps, median          | 11.5       | 8                       |
| Pooled: design score           | 7.11       | 7.13                    |
| Pooled: brief fidelity         | 7.41       | 7.05                    |
| Pooled: cost per build, median | $0.019     | $0.017                  |

The pooled figures come from `scripts/model-comparison/canvas-data.mjs`, which pairs the two builds of each block over both runs. Run 2's own report is `.model-comparison/luna-steps-2/report.md`.

Paired over the 11 blocks where both builds delivered, the batched build was faster in 5 and slower in 6, with a median difference of under a second (exact Wilcoxon p = 1.0). It took fewer steps in 7 blocks and more in 1 (p = 0.14), and the judges preferred it in 6 and the plain build in 5 (p = 0.98). The arm medians differ by 0.8 minutes only because the slow builds fell in different blocks. The pairs show no speed effect.

The step plan does what it says, about 30% fewer steps, but the time stays the same. Bigger steps reason and write more, which uses up the waits they skip. A large batched step that goes wrong costs more to repair. In run 2's block 4, one `write_files` call left a component undefined, the home page rendered truncated, and the build needed 24 steps and 7.5 minutes. Design quality is unchanged, and brief fidelity is 0.36 lower, inside the guard.

The canvas at `.model-comparison/canvas-luna-steps/` shows every site both arms built, with the judges' notes and each build's step strip.

### Pooled predictions

- At most 8 steps per build, median. Right: 8, down from 11.5.
- At least 45 seconds faster per build, median. Wrong. The arm medians differ by 47 seconds, but the paired median difference is under a second and the blocks split 5 to 6.
- Fewer first validations fail. Wrong: 5 of 11 batched builds needed a second validation, against 6 of 12.
- Design score within 0.5, and as many builds delivered. Half right: 7.13 against 7.11, but 11 of 12 delivered against 12 of 12, because of the truncated tool call.
- Brief fidelity within 0.5. Right: 0.36 lower.

### What to do

Don't adopt the step plan for speed. The parts that target failures rather than step size could stand alone: the three type-error notes, short photo queries, and the `upload_media` and `content_create` result shapes. They are untested on their own. Luna's time goes to the work itself, about 80 seconds of code writing per build, and to tools on the emulated sandbox, where one validation takes 25 to 47 seconds.

## Terra run: GPT-6.1 Terra at low effort against Luna, with and without fewer steps

Run `terra-luna`, 2026-10-26 and 27, a 2×2 of model (Luna as it ships, Terra at low effort on every request) and prompt (standard, fewer steps), 9 blocks. The full write-up is [TERRA.md](TERRA.md), and the plan, with its pilot amendments, is in [PLAN.md](PLAN.md) under "Terra vs Luna run plan".

|                                    | Luna    | Luna, fewer steps | Terra low | Terra low, fewer steps |
| ---------------------------------- | ------- | ----------------- | --------- | ---------------------- |
| Builds delivered                   | 9/9     | 8/9               | 8/9       | 9/9                    |
| First build, median                | 4.1 min | 5.0 min           | 1.8 min   | 1.8 min                |
| Steps, median                      | 14      | 8.5               | 8         | 5                      |
| Cost per build, median (low end)   | $0.023  | $0.017            | $0.091    | $0.092                 |
| Design score, mean of blind judges | 6.96    | 7.10              | 6.93      | 7.11                   |

Terra at low effort was faster in all 7 complete blocks, by an estimated 2.65 minutes (Holm p = 0.031), mostly because it waits about 2.6 seconds for each step's first output against Luna's 6.8. Design did not differ on average (−0.10 points, interval −1.88 to 1.78). That interval is too wide to call Terra as good, so the pre-registered rule for "better" is not met. In an unplanned split, Terra scored higher on the one-page bakery brief and lower on the content-heavy editorial and stargazing briefs, where it wrote about half as much and reused photos. Terra costs four to five times as much per build. The fewer-steps prompt again cut steps without changing build time.

The canvas at `.model-comparison/canvas-terra-luna/` shows all 36 sites, every build's step strip, and the statistics.
