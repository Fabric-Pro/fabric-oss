---
title: AI Assistant misreports codebase availability ("no repository attached")
date: 2026-06-26
category: integration-issues
module: AI assistant codebase availability
problem_type: integration_issue
component: assistant
symptoms:
  - "Assistant replies \"No KBase is currently attached to this project\" when a repo IS connected"
  - "Assistant says \"Codebase (no repository attached or analysis not completed)\" for token-expired or unindexed repos"
  - "A repo OAuth token expiring silently breaks the AI codebase workflow with no signal to non-connecting users"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [codebase-availability, repo-integration, token-expired, agent-context, notifications, discriminated-state]
---

# AI Assistant misreports codebase availability ("no repository attached")

## Problem

The AI Assistant told users *"No KBase is currently attached to this project"* (and the context preamble said *"Codebase (no repository attached or analysis not completed)"*) even when a repository **was** connected in project settings — because its OAuth token had expired or its code index had not been built. A PM staring at a clearly-connected repo correctly read this as a bug.

## Symptoms

- Assistant claims no codebase is attached despite a connected GitHub/GitLab/ADO repo visible in Settings → Execution.
- The same flat message appears for four distinct underlying states: genuinely not-connected, code-search toggle off, credentials expired, and index not yet built.
- Confirmed on staging: `projects/repositoryIntegrations/list` returned `status: "TOKEN_EXPIRED"` while `agents/codeIndex/status` returned `"MISSING"` — repo connected, code unqueryable, message said "not attached."

## What Didn't Work

- **A single `hasCodebase` boolean.** `getProjectContextAvailability()` derived availability from the legacy `Project.codeAnalysisStatus` doc-generation field (`codeAnalysisCount > 0 && codeAnalysisStatus === "COMPLETED"`). That boolean collapsed not-connected / disabled / expired / not-indexed into one message, and keyed off a signal the assistant's code search doesn't even use.
- **Fixing only the formatter string.** The bug had a *second* source: an instruction in the agent's project-context block literally told the LLM to say *"No codebase is currently attached to this project."* as its example. Correcting the data signal without rewriting that instruction would have left the model parroting the old phrasing.
- **Assuming the proactive notification needed building.** Planning assumed "notify on token expiry" was new work; reading the code showed it already shipped (2026-06-19 `repo-connection-self-healing-status`) — the real gap was *who* it reached.

## Solution

Three changes, all behavior-preserving except the intended corrections:

**1. Replace the boolean with a discriminated `codebaseState`** derived from the signals the assistant actually uses — `ProjectRepositoryIntegration.status` + `ProjectCodeIndex.status` + `ProjectRagSettings.codeSearchEnabled` — in `packages/database/prisma/queries/projects/contexts.ts`:

```ts
export type CodebaseState =
  | "available" | "not-connected" | "code-search-disabled"
  | "credentials-expired" | "not-indexed" | "indexing-failed";

// Pure + unit-testable without a DB. Precedence (first match wins):
export function deriveCodebaseState(input: {
  integrationStatuses: string[];
  codeSearchEnabled: boolean;
  codeIndexStatus: string | null;
}): CodebaseState {
  // A DISCONNECTED row is detached (tokens wiped) -> doesn't count as connected.
  const connected = input.integrationStatuses.filter((s) => s !== "DISCONNECTED");
  if (connected.length === 0) return "not-connected";
  if (!input.codeSearchEnabled) return "code-search-disabled";
  if (!connected.includes("ACTIVE")) return "credentials-expired";
  if (input.codeIndexStatus === null || input.codeIndexStatus === "PENDING" || input.codeIndexStatus === "INDEXING") return "not-indexed";
  if (input.codeIndexStatus === "FAILED") return "indexing-failed";
  if (input.codeIndexStatus === "READY" || input.codeIndexStatus === "STALE") return "available";
  return "not-indexed"; // unknown/future status -> safe default
}
```

The formatter (`formatContextAvailabilityText`) renders a distinct, actionable line per state (re-authenticate / enable code search / still indexing), with `hasCodebase = codebaseState === "available"` kept for backward compatibility.

**2. Fix the LLM instruction too.** In `packages/temporal/src/activities/shared/project-context-block.ts`, the instruction that hardcoded *"No codebase is currently attached"* was rewritten to relay the specific reason from Context Sources, and `codebaseState` is threaded through `getProjectMetadataActivity` → the context block → the formatter.

**3. Broaden the expiry notification's recipients** in `packages/database/prisma/queries/repo-integration-notifications.ts`: fan out to the connecting user **plus** project owners/admins (`getProjectMembers` role filter), using the established `getEnabledRecipientsForCategory` batched preference filter and a **per-(integration, recipient)** dedupe key — mirroring `pm-conflict-notifications.ts`.

## Why This Works

The original message lied because it answered a 2-dimensional question (is a repo connected? × is its code usable?) with a 1-bit boolean derived from the *wrong* signal. Deriving a discriminated state from the same signals the code-search engine consults makes the message and the engine agree, and surfacing the precise reason turns a dead-end into a fix path.

## Prevention

- **Prefer a discriminated state over a boolean when a message must distinguish "why not."** A boolean that fans out to multiple distinct user situations is a latent "misleading message" bug. Extract the derivation as a pure function so each state is unit-testable without a DB.
- **A user-facing string can have more than one source.** When fixing assistant/LLM output, check both the data the model receives *and* any hardcoded example phrasing in its prompt/instructions — fixing one and not the other leaves the symptom alive.
- **Verify "this feature is new" against the code before building it.** Plans are hypotheses; ground truth is the code. Here the notification already existed — the work was extending its recipients, and a naive add would have duplicated it.
- **Per-collection dedupe keys silently swallow fan-outs.** A notification dedupe key scoped to `integrationId` alone collapses an N-recipient fan-out to one row (the rest hit the unique-index and are swallowed as P2002). Scope the key per-(entity, recipient), and reuse `getEnabledRecipientsForCategory` for the batched preference filter (pattern: `pm-conflict-notifications.ts`, `repo-integration-notifications.ts`).
- **Don't leave a test asserting an unreachable production path.** A test that passes while asserting behavior no caller can trigger gives false confidence — delete it or wire the path. (Code review caught a `recipientUserId: null` fan-out test whose three callers all guard against null first.)
- **Local-env gotcha (Windows/Aspire):** after a package rename lands on `master` (here `code-understanding` → `atlas`), a stale generated Prisma client makes `tsc` fail with errors in files you didn't touch (e.g. `Property 'atlasConversation' does not exist on PrismaClient`). Fix with `pnpm install` + `pnpm --filter @repo/database generate` before trusting type-check. (auto memory [claude]: corroborated by the "legacy remediation baseline" and "local dev gotchas" notes — local Windows typecheck phantoms come from stale/missing generated artifacts, not the diff.)
- **`packages/atlas/src/credentials.ts` cannot be edited by an agent** — a project `block-secret-paths` hook matches the `credential` filename pattern (false positive for this source file). Design fixes to avoid editing it, or have a human apply changes there.

## Related Issues

- Prior art the notification extends: `docs/superpowers/plans/2026-06-19-repo-connection-self-healing-status-part1.md`
