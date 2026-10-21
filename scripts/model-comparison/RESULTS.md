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
