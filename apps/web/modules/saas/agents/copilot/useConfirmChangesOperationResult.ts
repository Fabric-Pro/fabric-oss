"use client";

/**
 * Best-effort chat-history messages for confirm_changes in StoryWorkspace and
 * DocumentEditor. Verdict capture lives in useConfirmChangesVerdict so it does
 * not depend on conversation creation or the eventual save result.
 *
 * Other registrations are DocumentGeneratorEditor, PromptContentEnhancer, and
 * TopicAssistant. The first two record verdicts without chat messages.
 * TopicAssistant records rejections separately; accepted rewrites are measured
 * when analysis-revision.ts saves the resulting revision.
 * StoryWorkspace intentionally posts an accept message after its save answers.
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
	 * `null` skips this chat message; the separate verdict recorder still runs.
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
	 * What became of an accepted change, when it is not a plain success
	 * (Fizzy #2946): `"failure"` — the save of the accepted text was
	 * refused; `"partial"` — the accepted text stays in the editor, not
	 * saved yet. Overrides the outcome `accepted` maps to.
	 */
	outcome?: "failure" | "partial";
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
	/**
	 * One key per operation, sent as the server's `operationKey` (Fizzy
	 * #2946). An accept is recorded when its save answers, so its record
	 * can overlap the record of another proposal: calls are held back
	 * only while one with the same key is in flight. Calls without a key
	 * share one slot (the double-click guard below) and get a fresh key
	 * each.
	 */
	operationKey?: string;
	// NOTE: `errorCode` is deliberately NOT part of this interface.
	// A `"failure"` reaches this helper only through `outcome`, for an
	// accepted change whose save was refused (Fizzy #2946); the
	// `summary` says so in the reader's words, and no caller has a
	// stable code to give. Exposing errorCode here would suggest a
	// semantic the helper cannot fulfil (Codex round-2 Minor #2).
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
	// The entry is cleared once the call settles so a later (post-state-
	// commit) click gets a fresh attempt — e.g. a re-attempted
	// confirmation after a transient error doesn't get blocked forever.
	//
	// Per operation (Fizzy #2946): keyed by `options.operationKey`, so an
	// accept recorded when its save answers is never swallowed by the
	// record of another proposal in flight at that moment. Calls without
	// a key share the `null` slot, as every call shared one before.
	const inFlightRef = useRef(new Map<string | null, Promise<void>>());

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
			const outcome: Outcome =
				options.outcome ?? (options.accepted ? "success" : "cancelled");
			if (!conversationId) {
				console.info(
					"[useConfirmChangesOperationResult] Skipping operation-result persistence: conversationId is null. This is expected for the first turn of a fresh session before <CopilotPersistenceHook> lazy-creates the AgentConversation.",
					{ outcome },
				);
				return Promise.resolve();
			}

			// Dedup gate: share an in-flight Promise across rapid double-
			// clicks of one operation. See `inFlightRef` doc-comment above.
			// An empty key is none.
			const inFlightKey = options.operationKey || null;
			const inFlight = inFlightRef.current.get(inFlightKey);
			if (inFlight) {
				return inFlight;
			}

			// The caller's key, or a fresh UUID per call. Combined with the
			// in-flight guard above, this means: one operation → one key →
			// one persisted row. Network-level retries inside oRPC use the
			// same call so the same key → server-side
			// `appendConversationMessage` SELECT FOR UPDATE dedup catches
			// HTTP-level retries.
			const operationKey = options.operationKey || crypto.randomUUID();
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
				}
			})();

			// Cleared after it settles, and only if it is still the one
			// held: registered once it is stored, so even a call that
			// settles at once never leaves its entry behind.
			inFlightRef.current.set(inFlightKey, promise);
			void promise.then(() => {
				if (inFlightRef.current.get(inFlightKey) === promise) {
					inFlightRef.current.delete(inFlightKey);
				}
			});
			return promise;
		},
		[conversationId, projectId, organizationId, operationLabel],
	);
}
