"use client";

/**
 * `useConfirmChangesOperationResult` — Fizzy #1412 PR3 §7.4 follow-up.
 *
 * # What this hook does
 *
 * When a user clicks Accept or Reject inside a `<ConfirmChangesDialog>`
 * (the `renderAndWaitForResponse` UI of a `useCopilotAction({ name:
 * "confirm_changes", ... })` registration), this hook fires a persistent
 * `role: "system"` operation-result message into the underlying
 * `AgentConversation` via `agents.conversations.recordOperationResult`.
 *
 * # Why a hook, not inline code in each site
 *
 * `confirm_changes` is registered in 5 different CopilotKit consumer
 * surfaces:
 *
 *   - `apps/web/modules/saas/projects/components/stories/StoryWorkspace.tsx`
 *   - `apps/web/modules/saas/projects/components/DocumentEditor.tsx`
 *   - `apps/web/modules/saas/agents/components/AgentDocumentViewer.tsx`
 *   - `apps/web/modules/saas/agents/components/DocumentGeneratorEditor.tsx`
 *   - `apps/web/modules/saas/prompts/components/PromptContentEnhancer.tsx`
 *
 * Each site owns its own `conversationId` state (the parent of
 * `<CopilotPersistenceHook>` in that surface) and its own `projectId`
 * context. Inlining the `recordOperationResult` call into the
 * `handleAccept`/`handleReject` of each site would duplicate the
 * (a) operation-key generation, (b) error-swallow policy, (c) defensive
 * null-conversationId check, and (d) operation-label boilerplate. This
 * hook centralises all four so a future change to any of them (e.g.
 * switching from random UUID to a content-hash key, or wanting to surface
 * persistence failures as a toast) lands in one place.
 *
 * # How it integrates with the existing flow
 *
 * The hook does NOT replace the `respond?.({ accepted })` call that
 * resolves the CopilotKit tool — that resolution is still the
 * source of truth for the agent's downstream behaviour. The hook is
 * an additive sibling: it persists a record of the outcome to the
 * chat history while the agent flow continues unchanged.
 *
 * Call order in the consumer site:
 *
 *   const recordOperationResult = useConfirmChangesOperationResult({
 *     conversationId: activeAssistantConversationId,
 *     projectId,
 *     organizationId: organizationId ?? null,
 *   });
 *
 *   const handleAccept = async () => {
 *     // ... existing accept work (commit document, save state, etc.) ...
 *     await recordOperationResult({ accepted: true, summary, artifact });
 *     respond?.({ accepted: true });
 *   };
 *
 * # Defensive design
 *
 *   - **`conversationId` may be `null`**: when the feature-assistant
 *     history flag is off, or `<CopilotPersistenceHook>` hasn't lazy-
 *     created the conversation yet, no row exists to append to. The hook
 *     no-ops in that case — the UI flow proceeds normally; the operation
 *     just isn't persisted. This mirrors the same defensive guard
 *     `BacklogChat.tsx` uses in `ensureBacklogConversationId`.
 *
 *   - **API errors are swallowed**: persistence is best-effort. A
 *     network failure or server 500 during `recordOperationResult` MUST
 *     NOT block the user's accept/reject action — they've already done
 *     the cognitive work of deciding. Errors are logged via
 *     `console.warn` for observability but never propagated.
 *
 *   - **`operationKey` is fresh per click**: this prevents one click's
 *     persisted message from being deduplicated against an earlier
 *     click's. The frontend already prevents double-clicks via the
 *     `setIsAwaitingConfirmation(false)` guard in each consumer site,
 *     so duplicate-click protection doesn't need to also live in the
 *     operation key. If the network retries the SAME call internally
 *     (e.g. browser-level retry), the server's `appendConversationMessage`
 *     SELECT FOR UPDATE + operationKey dedup catches it.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useCallback, useRef } from "react";
import type { CompletionEmittingToolName } from "./completion-emitters";

/**
 * Outcomes the server's recordOperationResult handler accepts. Mirrored
 * from `packages/api/modules/agents/procedures/conversations/record-operation-result.ts`
 * (the OperationOutcomeSchema enum). We deliberately do NOT import that
 * schema directly because @repo/api lives in the server-side bundle.
 */
type Outcome = "success" | "failure" | "partial" | "cancelled";

export interface UseConfirmChangesOperationResultArgs {
	/**
	 * The `AgentConversation.id` to append the operation-result message
	 * to. Sourced from the consumer site's local state — typically the
	 * same value passed to `<CopilotPersistenceHook conversationId={...}>`.
	 * `null` is allowed and triggers the no-op defensive path (see hook
	 * doc-comment).
	 */
	conversationId: string | null;
	/**
	 * Project context — required by the server's
	 * `requireProjectPermission(PROJECT_UPDATE)` middleware. Consumer
	 * sites always have this from their RSC route props.
	 */
	projectId: string;
	/**
	 * Active organization context (null in personal mode). Resolved by
	 * the server's `resolveOrganizationId` once the request lands.
	 */
	organizationId: string | null;
	/**
	 * Human-readable label for the operation, surfaced in the
	 * persisted system message and any rendering of it. Defaults to
	 * `"Confirm changes"` — consumer sites can override per-tool
	 * (e.g. `"Apply document edits"` for document-generator surfaces).
	 */
	operationLabel?: string;
	/**
	 * The CopilotKit tool name that emitted this operation. Currently
	 * always `"confirm_changes"` — the only entry in
	 * `COMPLETION_EMITTING_TOOL_NAMES` — but typed so future emitters
	 * (e.g. a hypothetical `apply_diff`) don't need a hook rename.
	 *
	 * @internal Forward-compat scaffolding. The current implementation
	 * does not branch on this value — it exists so the consumer
	 * site's call shape stays stable when a second entry lands in
	 * `COMPLETION_EMITTING_TOOL_NAMES`.
	 */
	toolName?: CompletionEmittingToolName;
}

export interface RecordOnResolveOptions {
	/**
	 * Whether the user accepted (true) or rejected (false) the
	 * confirmation dialog. Maps to `outcome: "success"` vs
	 * `outcome: "cancelled"`. We deliberately do NOT use `"failure"`
	 * for a reject — failure is reserved for technical/system errors,
	 * while user-rejected is a successful flow with a "no" decision.
	 */
	accepted: boolean;
	/**
	 * Short summary surfaced in the persisted system message body.
	 * Falls back to a default ("Changes accepted." / "Changes rejected.")
	 * if omitted.
	 */
	summary?: string;
	/**
	 * Optional artifact link to render alongside the system message
	 * (e.g. the persisted document version URL on accept).
	 */
	artifact?: { label: string; url: string };
	// NOTE: `errorCode` is deliberately NOT part of this interface.
	// This hook only emits `outcome: "success"` (accepted) or
	// `outcome: "cancelled"` (rejected). `errorCode` is a server-
	// schema field meaningful only for `outcome: "failure"`, which
	// is not reachable through the accept/reject flow this helper
	// targets. If a future hook handles tool-level failures it
	// should expose its own interface — exposing errorCode here
	// would suggest a semantic the helper cannot fulfil (Codex
	// round-2 Minor #2).
}

/**
 * Returns a stable async callback that records the outcome of a
 * `confirm_changes` tool resolution into the underlying
 * `AgentConversation`. Safe to call from inside `handleAccept` /
 * `handleReject` of a `useCopilotAction({ renderAndWaitForResponse })`
 * registration.
 */
export function useConfirmChangesOperationResult({
	conversationId,
	projectId,
	organizationId,
	operationLabel = "Confirm changes",
	toolName: _toolName = "confirm_changes",
}: UseConfirmChangesOperationResultArgs): (
	options: RecordOnResolveOptions,
) => Promise<void> {
	// In-flight Promise guard (Codex round-2 Important #2): if the user
	// double-clicks Accept/Reject faster than React can commit the
	// `setIsAwaitingConfirmation(false)` state update in the consumer
	// site, two click handlers can both fire `recordOperationResult`
	// in the same render cycle. Without this ref, they'd use different
	// `operationKey` UUIDs and the server's per-key dedup would NOT
	// catch the duplicate — two operation-result messages would land
	// in the DB. With the ref, the second call returns the in-flight
	// Promise from the first, so only one server roundtrip happens.
	// Ref is cleared on `finally` so a later (post-state-commit) click
	// gets a fresh attempt — e.g. a re-attempted confirmation after a
	// transient error doesn't get blocked forever.
	const inFlightPromiseRef = useRef<Promise<void> | null>(null);

	// Non-async callback so the in-flight Promise dedup (Codex round-2
	// Important #2) returns identity-equal Promises across rapid calls.
	// An `async` callback would wrap the in-flight ref's Promise in a
	// NEW outer Promise per invocation, breaking the `firstCall ===
	// secondCall` contract that lets the cached Promise share results.
	return useCallback(
		(options): Promise<void> => {
			// Defensive null-path. Logs via `console.info` (not silent —
			// Codex round-2 Important #1) so a fresh-session race where
			// `<CopilotPersistenceHook>` hasn't lazy-created the
			// AgentConversation before the user's first confirm_changes
			// click is observable in browser devtools / Sentry breadcrumbs.
			// We deliberately do NOT queue the call to await lazy-create:
			// adding a retry queue + drain semantics would expand scope
			// beyond round-2 follow-up, and the gap is narrow (only the
			// very first turn of a brand-new chat session — subsequent
			// turns always have a resolved `conversationId` from SSR or
			// the previous append).
			if (!conversationId) {
				console.info(
					"[useConfirmChangesOperationResult] Skipping operation-result persistence: conversationId is null. This is expected for the first turn of a fresh session before <CopilotPersistenceHook> lazy-creates the AgentConversation.",
					{ outcome: options.accepted ? "success" : "cancelled" },
				);
				return Promise.resolve();
			}

			// Dedup gate: share an in-flight Promise across rapid double-
			// clicks. See `inFlightPromiseRef` doc-comment above.
			if (inFlightPromiseRef.current) {
				return inFlightPromiseRef.current;
			}

			const outcome: Outcome = options.accepted ? "success" : "cancelled";
			// Fresh UUID per call. Combined with the in-flight guard above,
			// this means: one click → one key → one persisted row. Network-
			// level retries inside oRPC use the same call so the same key
			// → server-side `appendConversationMessage` SELECT FOR UPDATE
			// dedup catches HTTP-level retries.
			const operationKey = crypto.randomUUID();
			const summary =
				options.summary ??
				(options.accepted ? "Changes accepted." : "Changes rejected.");

			const promise = (async () => {
				try {
					await orpcClient.agents.conversations.recordOperationResult(
						{
							conversationId,
							projectId,
							organizationId,
							operationKey,
							outcome,
							operationLabel,
							summary,
							artifact: options.artifact,
						},
					);
				} catch (error) {
					// Best-effort persistence: never block the user's
					// accept/reject action. Log for observability but
					// swallow. Codex round-2 Minor noted that for an
					// audit-trail use case a retry+toast would be needed;
					// the current feature uses chat-history for context,
					// not audit, so warn-log is the right policy.
					console.warn(
						"[useConfirmChangesOperationResult] Failed to record operation result",
						{ conversationId, outcome, error },
					);
				} finally {
					inFlightPromiseRef.current = null;
				}
			})();

			inFlightPromiseRef.current = promise;
			return promise;
		},
		[conversationId, projectId, organizationId, operationLabel],
	);
}
