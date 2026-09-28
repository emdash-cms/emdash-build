# Self-healing failures

Status: Approved for implementation by the current user request

Base: `origin/main` at `9b4404e0bb32eaa23a468d5d5e202c641422e3a1`

## Outcome

Temporary infrastructure and connection failures recover without user-visible noise. When bounded recovery cannot finish, the user sees one plain, actionable failure at the surface where they were already working. Primary UI never shows raw infrastructure or React error text, and retries never duplicate a chat turn or destructive action.

## Included scope

- Stage session checkpoints without racing live SQLite WAL files, retry a transient staging or upload failure once, and keep raw details in Logs.
- Remove persistence, provisioning, turn, and Stop error banners from the composer.
- Reconcile chat, questionnaire, incomplete-build, and Stop outcomes against durable agent state before offering a retry.
- Retry transient account/project startup, automatic project metadata writes, dictation transcription, Publish address lookup, and already-reserved deletion cleanup with small bounded delays.
- Retain recorded dictation audio until transcription succeeds or the user replaces it.
- Replace raw React and infrastructure messages in primary UI with stable user-facing copy.
- Add focused failure-path regression tests for every changed behavior.

## Excluded scope

- No project-health pill, save indicator, success toast, visual redesign, or permanent status surface.
- No generic application error framework or retry middleware.
- No infinite retries or retry of validation/authentication failures.
- No preview-recovery, publishing-operation, chat-protocol, or deletion architecture redesign.
- No changes to contextual preview, build-activity, tool-detail, or publish-operation errors that already identify the failed work.

## Design

### Checkpoints

The snapshot staging command copies non-database files while excluding SQLite main, WAL, and SHM files. Each live SQLite database is then copied through SQLite's online backup command, which includes committed WAL data without pausing the dev server. The sandbox image supplies the `sqlite3` CLI. Staging and the existing Artifacts upload each retry at most once. A terminal failure is redacted in durable state and fully recorded in Logs.

The client emits one sticky `Session changes could not be saved` toast keyed to the project. Its Retry action invokes the existing serialized backup queue. Later successful state clears the toast. There is no success toast and no composer banner.

### Ambiguous chat actions

The agent exposes one read-only recovery snapshot containing its durable messages, turn-active flag, and initial-generation state. Client sends carry an explicit message ID. If transport fails, the client reads that snapshot before doing anything else:

- ID present: replace optimistic messages with the durable transcript and do not resend.
- ID absent: replace optimistic messages with the durable transcript and offer one Retry action for the preserved payload.
- snapshot unavailable: do not resend; offer Check again until the outcome can be classified.

Questionnaire and incomplete-build submissions use the same path. Stop is reconciled from `turnActive` plus initial-generation status before another Stop is offered. This adds no new persisted protocol or request ledger.

### Bounded client retries

A small client helper retries an operation up to three total attempts with short increasing delays. Call sites decide what is transient: network errors and 5xx responses retry; 4xx validation, ownership, and authentication responses do not. It is used only where this contract is identical.

- Startup preserves the requested project ID across attempts. New creation uses one client-minted project ID plus a random recovery capability kept through retries and reloads until the first durable brief. The capability can repair ownership only while the project is blank, so an ambiguous response cannot create a second project or permanently lose the first one. Exhausted recovery ends on a contextual Try again screen.
- Automatic title/status writes retry and then show one sticky Retry toast; explicit rename remains contextual.
- Dictation reuses the same Blob and exposes Retry only after automatic attempts fail.
- Publish address lookup retries and then shows an inline Retry action in the open Publish panel.
- A project already marked deletion-pending retries cleanup before showing the existing blocking recovery screen.

### Presentation and privacy

Primary UI uses fixed copy and never interpolates raw thrown messages. Logs retain redacted technical checkpoint and agent details. Existing tool cards and contextual preview/publish failure surfaces remain unchanged. Sticky toasts use `timeout: 0`, high priority, a stable ID, and one action; successful recovery closes them silently.

## Tests

- A SQLite database with active WAL data stages a consistent backup without copying WAL/SHM files; a failed staging attempt retries once.
- Persistence failure shows one sticky safe toast, Retry calls the serialized save, and recovery clears it.
- Dropped chat/questionnaire/incomplete-build/Stop responses reconcile received work and never resend it; confirmed-unsent work gets exactly one retry.
- Startup retries while preserving the requested project and exposes contextual Retry only after exhaustion.
- Automatic metadata persists after a transient failure and reports terminal failure without raw text.
- Dictation retries the same Blob and retains it for manual Retry.
- Publish address lookup retries in place and never asks the user to close/reopen.
- Reserved deletion cleanup retries safely before the blocking screen.
- Composer and React boundary never render raw infrastructure messages.

## Commit plan

1. `fix: make session checkpoints self-healing`
   - Online SQLite backup, one staging retry, redacted persistence state, sticky save Retry toast.
   - Expected: 120-220 production lines, 100-180 test lines.
   - Non-goals: restore format changes, preview lifecycle changes, generic Worker retry helper.

2. `fix: reconcile interrupted chat actions`
   - Read-only recovery snapshot, explicit message IDs, safe send/questionnaire/retry/Stop reconciliation, composer cleanup.
   - Expected: 180-320 production lines, 180-300 test lines.
   - Non-goals: replace the AI chat SDK, add a request ledger, redesign activity cards.

3. `fix: recover transient client operations`
   - Bounded startup/metadata/dictation/address/deletion retries and raw React error removal.
   - Expected: 180-300 production lines, 180-320 test lines.
   - Non-goals: retry non-transient 4xx responses, redesign auth/publish/delete flows.

Line estimates are review alarms, not stop gates. The user explicitly authorized continuing past them when every added line remains necessary to these acceptance criteria.

## Acceptance and review gates

- Recovery success is silent.
- Every retry is bounded and preserves the original operation identity or uses an already-idempotent operation.
- A user is never told to resend until durable state proves the original message was not received.
- No raw infrastructure, SQLite, Git, React, or transport text appears in primary UI.
- Final package typechecks, formatting, focused tests, full applicable tests, combined scope audit, and persistent second-opinion review converge before PR creation.
- This document alone authorizes no later Git or GitHub mutation; the current user request separately authorizes local implementation, commits, push, and PR creation after convergence.
