# How to compare builder models

These scripts run the comparison described in [PLAN.md](PLAN.md). Results go to `.model-comparison/<run>/`, which git ignores. Run every step from the repository root, outside any sandbox. The steps need the network, Docker, and Chrome.

1. Add a valid `AI_GATEWAY_TOKEN` to `.dev.vars`. Add the models to compare as `BUILDER_MODEL_CHOICES`, separated by commas. The dev server lets a project pin only a model in this list.
2. Check that every model works on the builder's request path.

   ```bash
   node --import ./scripts/model-comparison/ts-resolve.mjs scripts/model-comparison/probe.mjs
   ```

   Each line is one check for one model. Start the run only when every model passes the gate in [PLAN.md](PLAN.md#gate-before-the-first-trial). Every check prints `"ok":true`, `reasoning` tokens rise from `effortLow` to `effortHigh`, the tool loops report cached tokens, and `servedModel` matches the model. The probe and the judge import the worker's own model code, which `ts-resolve.mjs` lets plain Node load.

3. Start the dev server with `pnpm dev`.
4. Run the pilot block, check its trials and screenshots, then run the trials. Rerun the same command to resume after an interruption. The runner skips the trials already recorded in `trials.jsonl`. If it reports excluded trials, add `--rerun-excluded` to rerun their blocks.

   ```bash
   node scripts/model-comparison/run.mjs --run pilot --briefs bakery --reps 1
   ```

   ```bash
   node scripts/model-comparison/run.mjs --run 2026-10-models
   ```

5. Judge the sites blind with judges that are not candidates.

   ```bash
   node --import ./scripts/model-comparison/ts-resolve.mjs scripts/model-comparison/judge.mjs --run 2026-10-models --judges anthropic/claude-sonnet-5.5,openai/gpt-6.1-sol
   ```

6. Optional: score the sites yourself. Open `.model-comparison/2026-10-models/gallery.html`, score every site, and click **Download verdicts**. Then import the file.

   ```bash
   node scripts/model-comparison/gallery.mjs --run 2026-10-models
   node scripts/model-comparison/gallery.mjs --run 2026-10-models --import ~/Downloads/human-verdicts.json
   ```

7. Write the report, `summary.json`, and `trials.csv`.

   ```bash
   node scripts/model-comparison/analyze.mjs --run 2026-10-models
   ```

8. Optional: write a labeled review page, `review.html`, that shows each block's sites side by side with the model, timing, cost, judge scores, and judge notes. It reads `summary.json`, so run it after `analyze.mjs`.

   ```bash
   node scripts/model-comparison/review.mjs --run 2026-10-models
   ```

9. Optional, for a 2×2 run: `factorial.mjs` forms the two main effects, their interaction, and the simple effects per block, with exact Wilcoxon p-values and Hodges–Lehmann intervals, and checks each arm's effort and prompt size. List the four arms in the order A0B0, A0B1, A1B0, A1B1.

   ```bash
   node scripts/model-comparison/factorial.mjs --run terra-luna --cells openai/gpt-6-luna,openai/gpt-6-luna:batched,openai/gpt-6.1-terra:all-low,openai/gpt-6.1-terra:all-low:batched
   ```

With four or more arms, pass `--wait-idle` to `run.mjs`. Each block then starts only after the app has stopped the earlier blocks' sandboxes, which otherwise linger for 10 minutes and can exhaust Colima's memory. `oom-check.mjs --run <name>` lists trials in which a sandbox command was killed for memory. Rerun those blocks with `--rerun-block`. A model that the gateway's unified API does not list yet can still run through its OpenAI endpoint with `AI_GATEWAY_OPENAI_ROUTE=provider` in `.dev.vars`.

`capture-check.mjs` and `stats-check.mjs` check the screenshot capture and the statistics against known answers. Run them after changing either one.
