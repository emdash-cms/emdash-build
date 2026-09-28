# Build recovery and activity clarity

Status: Approved for implementation by the current user request

Base: `origin/main` at `2fccf5ebbab90dbd29d658b12e684a1e6ea4a446`

## Purpose

Make a normal first-site build recover cleanly from correctable source mistakes without exposing
raw agent protocol text or presenting already-fixed problems as permanent customer-facing errors.
The exact observed failure was an eight-file `write_files` call that mixed existing and new files:
the real Sandbox SDK threw `FileNotFoundError` while preflighting a new destination, so the atomic
batch wrote nothing. A later rendered-site audit correctly caught the resulting missing blocks
module and the agent repaired it.

The validator remains a completion guard. This work removes the avoidable batch failure and makes
the activity timeline distinguish an active/recovered correction from a build that truly ended
broken.

## Included scope

- Make `write_files` treat the Sandbox SDK's file-not-found error as an absent destination that
  may be created, including the anchored plain-Error message produced when local Sandbox RPC
  flattens the structured error.
- Preserve current batch validation, atomic rollback, mutation convergence, one preview refresh,
  and one Artifacts checkpoint.
- Keep every other preflight read failure fail-closed before the first write.
- Suppress settled long internal build prose, leaked `to=functions...` protocol text, and an
  immediately adjacent JSON-only argument fragment from the customer activity timeline.
- Preserve the stored transcript and server logs; suppressed text is presentation-only and is
  never parsed or executed as a tool call.
- Present a completed source/validation failure as recovering while the turn is live, recovered
  after a later successful `validate_site`, and terminal only when the turn ends without that
  evidence.
- Present interrupted validation and preview attempts as retrying while live and retry-succeeded
  after a later successful attempt, without mislabeling transport failures as site defects.
- Use plain validation copy in the visible outcome while retaining raw tool input/output behind
  the existing technical-details disclosure for diagnosis.
- Add focused production-realistic tests and perform one real generated-site acceptance journey.

## Explicit non-goals

- No prompt expansion; the current prompt already forbids simulated tool-call prose.
- No model, provider, AI SDK, MCP, or tool-name changes.
- No generic retry/error framework and no automatic execution of text that resembles a tool call.
- No changes to schema/blocks behavior, validation rules, Sandbox lifecycle, Artifacts,
  provisioning, recovery, publishing, or release-lock behavior.
- No attempt to guarantee that validation never finds a real defect. Correctly detected defects
  must still block completion.
- No dependency additions to silence unrelated Vite optimiser warnings.

## Verified current behavior

- `write_files` promises create-or-overwrite behavior and records whether each destination existed
  so a failed batch can restore or delete attempted files.
- Its preflight currently accepts a missing-file result shaped as `{ success: false }`, but returns
  failure when `Sandbox.readFile()` throws. Sandbox `0.12.10` uses a structured
  `FileNotFoundError` with code `FILE_NOT_FOUND`; the real local RPC boundary was also observed
  flattening it to a plain `Error` whose message starts `FileNotFoundError: File not found:`.
- The unit harness models missing files only as `{ success: false }`, so the production mismatch is
  untested.
- `validate_site` runs static checks and then renders/crawls public routes. The observed static
  checks passed and the rendered audit correctly returned HTTP 500 for the missing import.
- `ToolCard` currently treats every completed `success: false` result as permanently red, without
  considering later validation in the same turn.
- `BuildDetails` intentionally renders leaked pseudo-tool prose inside a `Verbose build notes`
  disclosure. A short adjacent JSON fragment does not match that classifier and renders as an
  ordinary note.

## Design

### Batch preflight

Add a small local predicate for the Sandbox error shape. It recognizes file absence from the
structured `name` or `code` used by the installed SDK and the exact anchored prefix emitted when
RPC flattens that same error. Only that error becomes `{ existed: false }`. Abort, runtime
replacement, transport, permission, directory, and arbitrary read failures retain the existing
zero-write failure behavior.

No retry is added. Once preflight completes, writes and rollback use the existing serial atomic
path. The change therefore adds no extra successful-path Sandbox calls, preview refreshes, or
checkpoints.

### Activity classification

Classification is derived from the selected turn's existing parts; it adds no persisted state.

- A structured, non-retryable `validate_site` result with `success: false` is recovered only when a
  later `validate_site` succeeds.
- Validation tool/transport errors, retryable observation races, and failed preview captures use a
  distinct interrupted state. They become `retrying` only while the same reply is live and
  `retry-succeeded` only after a later successful call of the same tool. Without that evidence,
  they remain terminal failures. Raw errors stay inside Technical details.
- A failed `write_file`, `write_files`, `edit_file`, or `edit_files` result with
  `changed: false` is recovered only when a later successful source mutation is followed by a
  successful `validate_site`. Validation alone cannot prove the skipped edit was applied.
- An ambiguous source failure with `changed: true`, missing structured output, or occurring after
  the latest successful validation remains a real failure.
- Before recovery evidence exists, a completed correctable failure is neutral only when it belongs
  to the currently live reply (`index >= liveFromPart`). Historical stopped-attempt failures remain
  terminal until later recovery evidence exists. If the turn stops or fails first, current failures
  also become terminal and red.
- CMS, schema, media, publishing, persistence, and infrastructure failures are never reclassified
  by site validation.

`ToolCard` receives only this presentation state and chooses truthful copy:

- recovering validation: `Found a site issue · fixing`
- recovered validation: `Fixed a site issue`
- interrupted validation/preview: `Validation/Preview interrupted · retrying`
- successful retry: `Validation/Preview retry succeeded`
- recovering source mutation: `Adjusting file update`
- recovered source mutation: `File update corrected`
- terminal: existing error label and danger treatment

Recovered/recovering validation details use calm explanatory copy. A terminal validation outcome
uses a human description such as `The homepage could not render (HTTP 500)` instead of exposing
the internal reason token `http-status`. The nested technical disclosure remains available.

### Internal prose

Remove the `VerboseBuildNotes` customer component. During an initial-generation group:

- protocol-looking text is suppressed immediately, including while streaming;
- a JSON object text part immediately following that protocol-looking part is also suppressed;
- other long intermediate prose stays readable while streaming and is omitted after it settles;
- the accepted final build summary and ordinary short progress notes remain unchanged.

The transcript is not rewritten or filtered before the model sees it. The filter cannot trigger a
tool and cannot mutate the site.

## Accessibility and visual behavior

- Recovery is communicated in text, not color alone.
- Neutral/recovered rows retain the existing keyboard-accessible disclosure and do not shimmer
  after the underlying tool has completed.
- Terminal errors keep the existing danger treatment.
- No new animation, dependency, modal, toast, or layout surface is introduced.
- Changing a row from recovering to recovered happens in place so the activity order remains
  stable.

## Tests and acceptance

### Focused tests

- A batch containing one existing file and multiple new files succeeds when each missing read
  throws the real structured Sandbox error shape.
- The batch still fails before writing on a non-not-found read error.
- Existing rollback, one-reload, one-checkpoint, idempotency, and cancellation tests remain green.
- Live correctable source and validation failures use neutral recovery copy.
- A later successful source repair and validation changes only eligible earlier failures to
  recovered copy; validation without a repair does not.
- Ambiguous `changed: true`, post-validation, CMS, and terminal failures remain errors.
- Protocol-looking prose, its immediately adjacent JSON fragment, and settled long internal prose
  are absent from activity; the final summary and short progress prose remain.
- Validation outcomes use readable route/status text while technical details remain expandable.

### Real acceptance journey

Run one bakery-style blank-scaffold build through schema, typed block renderers, content, validation,
and final preview. Inspect the raw tool trace and customer activity. The journey passes when:

- new source destinations can be created in one coherent `write_files` batch;
- there is no file-not-found batch failure for a new destination;
- any correctable intermediate source/render issue is calm while active and recovered after the
  successful final validation;
- the ready activity contains no `Verbose build notes`, tool-call syntax, or orphaned JSON;
- final validation and preview still gate readiness.

Run focused tests, `pnpm check`, `pnpm format`, the application and Worker suites, production build,
`git diff --check`, and a merge-tree check against current `origin/main` before submission.

## Implementation commits

1. `fix: let source batches create new files`
   - Files: `src/worker/tools.ts`, `test/tools.test.ts`.
   - Expected: 15-35 production lines and 35-80 test lines.
   - Excludes activity UI and prompt changes.

2. `fix: present recovered build corrections calmly`
   - Files: `src/client/components/BuildDetails.tsx`,
     `src/client/components/ToolCard.tsx`, and focused UI tests.
   - Expected: 70-150 production lines and 100-220 test lines.
   - Excludes server transcript mutation, generic error handling, and unrelated activity redesign.

Line estimates are review alarms, not stop gates. The user explicitly approved continuing past
them when every added line remains required by this specification.

## Review and authority

After both implementation commits, run a persistent GPT-5.6 Sol high second-opinion adversarial
review of the complete branch diff. Evaluate every finding, patch valid in-scope findings, rerun
relevant checks, and continue the same reviewer session until it reports clean or nits-only.

The current user request pre-approves this specification and separately authorizes implementation,
local commits, pushing the finished branch, and opening a pull request after review convergence.
It does not authorize merge, deployment, release, or production activation.
