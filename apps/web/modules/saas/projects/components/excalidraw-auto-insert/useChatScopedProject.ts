"use client";

/**
 * Per-surface adapters that translate a chat session into the
 * `{ projectId, organizationId, lastUserPromptForMessage }` triple the
 * Excalidraw auto-insert button needs.
 *
 * Each adapter is a separate exported hook so a surface only pulls in
 * the context it actually mounts (Nexus mounts the multi-agent stream,
 * Loom mounts the orchestrator stream, etc.). Picking the adapter at
 * call time would couple every surface to every other surface's hook
 * graph and violate the rules-of-hooks contract.
 *
 * Spec sections:
 *   - § 6.3 / FR-3   Title derivation context (per-surface user-prompt
 *                    lookup) feeds `deriveDiagramTitle` (A5).
 *   - § 8 (table)    `useChatScopedProject` row in the components map.
 *   - § 12           `chatScope` fields drive `diagram_auto_inserted` /
 *                    `diagram_auto_insert_blocked` properties.
 *
 * Adapter contracts:
 *   - `useChatScopedProjectFromLauncher()`           — in-feature AI
 *     Assistant (`FabricDirectChat`). Reads
 *     `useFabricAgentLauncher().launchContext`.
 *   - `useChatScopedProjectFromOrchestratorStream()` — Loom orchestrator
 *     chat (`FabricTemporalOrchestratorChat`). Reads the orchestrator
 *     stream hook.
 *   - `useChatScopedProjectFromMultiAgentStream()`   — Nexus
 *     (`CopilotPage`). Reads the multi-agent stream hook.
 *   - `useChatScopedProjectFromCopilotChat()`        — in-document
 *     Copilot sidebar (`CopilotAssistantMessage`). Reads CopilotKit's
 *     `useCopilotChat().visibleMessages`.
 *
 * All four return the same shape:
 *
 *   interface ChatScope {
 *     projectId: string | null;
 *     organizationId: string | null;
 *     lastUserPromptForMessage(messageId: string): string | null;
 *   }
 *
 * `null` for `projectId` / `organizationId` means the chat isn't bound
 * to a project — the button's render-decision branch (D2) hides the
 * button in that case. The title-derivation lookup
 * `lastUserPromptForMessage` returns `null` when there's no preceding
 * user message; the caller passes that to `deriveDiagramTitle` (A5),
 * which falls back to "Untitled diagram from chat".
 *
 * Adapters are intentionally side-effect-free — they call the upstream
 * hook(s) and return memoised callbacks. The button hook (D1) is the
 * place where state lives.
 */

import { useFabricAgentLauncher } from "@saas/agents/components/FabricAgentLauncher";
import type {
	ConversationTurn,
	MultiAgentToolCall,
} from "@saas/agents/hooks/useMultiAgentStream";
import type { OrchestratorStreamMessage } from "@saas/agents/hooks/useOrchestratorStream";
import { useCallback, useMemo } from "react";

/** The shared return shape every adapter produces. */
export interface ChatScope {
	/** Project the chat is scoped to, or `null` if the chat is unbound. */
	projectId: string | null;
	/** Organization the chat is scoped to, or `null` in personal scope. */
	organizationId: string | null;
	/**
	 * Walk the chat history backward from `messageId` (the assistant
	 * message that produced the `create_view` tool result) to the most
	 * recent preceding `user`-role message and return its text.
	 *
	 * Returns `null` when no preceding user message exists. The caller
	 * passes the result to `deriveDiagramTitle` (A5), which handles
	 * trimming + the 60-char cap + the empty/whitespace fallback.
	 */
	lastUserPromptForMessage(messageId: string): string | null;
}

// ----------------------------------------------------------------------
// Top-level convenience export
// ----------------------------------------------------------------------

/**
 * Top-level placeholder. The four per-surface adapters are the actual
 * entrypoints (see file header rationale). This export exists only to
 * give downstream code one canonical module name to import from when
 * documenting the contract; calling it directly is not supported.
 *
 * @returns The same shape every adapter returns, with `null` scope and
 *          a no-op `lastUserPromptForMessage`.
 */
export function useChatScopedProject(): ChatScope {
	return useMemo<ChatScope>(
		() => ({
			projectId: null,
			organizationId: null,
			lastUserPromptForMessage: () => null,
		}),
		[],
	);
}

// ----------------------------------------------------------------------
// Adapter: in-feature AI Assistant — FabricDirectChat
// ----------------------------------------------------------------------

/**
 * In-feature AI Assistant context comes from
 * `useFabricAgentLauncher().launchContext`. The launcher is the source
 * of truth for the `projectId` / `storyId` triple when the user opens
 * the floating Fabric Agent panel from a feature or document page.
 *
 * The launcher context has a `prompt` field that carries the canned
 * launcher prompt (or the user's typed prompt if they've started a
 * conversation). For the title-derivation lookup we use that text as
 * the user prompt because the launcher doesn't expose a full message
 * history.
 *
 * No-message-history adapter: `lastUserPromptForMessage` ignores the
 * supplied `messageId` and returns the launcher's `prompt` field if
 * present. This matches spec § 6.3 — the in-feature surface uses the
 * launcher prompt as the user prompt for title derivation.
 */
export function useChatScopedProjectFromLauncher(): ChatScope {
	const { launchContext } = useFabricAgentLauncher();
	const projectId = launchContext?.projectId ?? null;
	const prompt = launchContext?.prompt ?? null;

	// Launcher context never carries `organizationId` directly; the
	// surface that mounts the in-feature chat already knows the active
	// org via `useOrganizationContext()` — D1/D2 will pass it down.
	const organizationId: string | null = null;

	const lastUserPromptForMessage = useCallback(
		(_messageId: string): string | null => {
			return prompt && prompt.length > 0 ? prompt : null;
		},
		[prompt],
	);

	return useMemo<ChatScope>(
		() => ({
			projectId,
			organizationId,
			lastUserPromptForMessage,
		}),
		[projectId, organizationId, lastUserPromptForMessage],
	);
}

// ----------------------------------------------------------------------
// Adapter: Loom — useOrchestratorStream
// ----------------------------------------------------------------------

/**
 * Argument shape for the orchestrator-stream adapter.
 *
 * The orchestrator stream is mounted by `FabricTemporalOrchestratorChat`
 * — that component already knows the active project + org from its
 * page context. We accept the values as args (rather than calling
 * `useOrganizationContext()` here) so the adapter stays a pure read of
 * the orchestrator-stream context and doesn't double-import the org
 * context from a hook the surface already has on hand.
 */
export interface UseChatScopedProjectFromOrchestratorStreamOptions {
	projectId: string | null;
	organizationId: string | null;
	/** The full `messages` array produced by `useOrchestratorStream`. */
	messages: ReadonlyArray<OrchestratorStreamMessage>;
}

/**
 * Loom orchestrator adapter. The orchestrator surfaces a single linear
 * `messages` array (`useOrchestratorStream.ts:62,350` and
 * `OrchestratorStreamMessage` at line 72-96). The adapter walks the
 * array backward from the assistant message id to the most recent
 * `user`-role message.
 */
export function useChatScopedProjectFromOrchestratorStream(
	options: UseChatScopedProjectFromOrchestratorStreamOptions,
): ChatScope {
	const { projectId, organizationId, messages } = options;

	const lastUserPromptForMessage = useCallback(
		(messageId: string): string | null => {
			if (messages.length === 0) {
				return null;
			}
			const targetIndex = messages.findIndex(
				(message) => message.id === messageId,
			);
			// If we can't find the message (e.g. it hasn't been hydrated
			// yet), scan the entire history — the most recent user message
			// is still the best fallback we can produce.
			const upperBound =
				targetIndex === -1 ? messages.length : targetIndex;
			for (let index = upperBound - 1; index >= 0; index--) {
				const candidate = messages[index];
				if (candidate && candidate.role === "user") {
					return candidate.content ?? null;
				}
			}
			return null;
		},
		[messages],
	);

	return useMemo<ChatScope>(
		() => ({
			projectId,
			organizationId,
			lastUserPromptForMessage,
		}),
		[projectId, organizationId, lastUserPromptForMessage],
	);
}

// ----------------------------------------------------------------------
// Adapter: Nexus — useMultiAgentStream
// ----------------------------------------------------------------------

/**
 * Argument shape for the multi-agent-stream adapter (Nexus).
 *
 * Nexus uses `ConversationTurn[]`, where each turn pairs one user
 * message string with N agent responses (one per `@agent` selected).
 * The adapter accepts the turns directly so the consumer surface can
 * pass `useMultiAgentStream().turns`.
 *
 * `agentMessageIdToTurnIndex` is a map from an agent-response message
 * id (the assistant tool-call's id) back to the turn it belongs to.
 * Each agent response carries `toolCalls: MultiAgentToolCall[]`; the
 * caller indexes by the tool-call message id and we walk back to the
 * turn's `userMessage`. If the caller doesn't pre-compute the map,
 * pass `null` and the adapter falls back to walking every turn.
 */
export interface UseChatScopedProjectFromMultiAgentStreamOptions {
	projectId: string | null;
	organizationId: string | null;
	turns: ReadonlyArray<ConversationTurn>;
}

/**
 * Nexus adapter. Walks the conversation turns backward from the
 * `messageId` (which on Nexus is the agent's tool-call id, accessible
 * via `MultiAgentToolCall.id`) until it finds the turn that contains a
 * matching tool call. That turn's `userMessage` is the user prompt for
 * title derivation.
 *
 * If the `messageId` isn't a known tool-call id (e.g. the caller is
 * looking at a streaming partial), fall back to the most recent turn's
 * `userMessage`.
 */
export function useChatScopedProjectFromMultiAgentStream(
	options: UseChatScopedProjectFromMultiAgentStreamOptions,
): ChatScope {
	const { projectId, organizationId, turns } = options;

	const lastUserPromptForMessage = useCallback(
		(messageId: string): string | null => {
			if (turns.length === 0) {
				return null;
			}
			// Walk backward — the user is almost always looking at recent
			// chat, so the matching turn is near the end of the array.
			for (
				let turnIndex = turns.length - 1;
				turnIndex >= 0;
				turnIndex--
			) {
				const turn = turns[turnIndex];
				if (!turn) {
					continue;
				}
				for (const response of turn.agentResponses.values()) {
					const toolCalls: ReadonlyArray<MultiAgentToolCall> =
						response.toolCalls ?? [];
					const found = toolCalls.some(
						(call) => call.id === messageId,
					);
					if (found) {
						return turn.userMessage ?? null;
					}
				}
			}
			// Fallback: the most recent turn's user message. Matches the
			// in-document Copilot adapter's "no match -> latest" rule and
			// keeps title derivation useful for streaming partials.
			const last = turns[turns.length - 1];
			return last?.userMessage ?? null;
		},
		[turns],
	);

	return useMemo<ChatScope>(
		() => ({
			projectId,
			organizationId,
			lastUserPromptForMessage,
		}),
		[projectId, organizationId, lastUserPromptForMessage],
	);
}

// ----------------------------------------------------------------------
// Adapter: in-document Copilot — useCopilotChat
// ----------------------------------------------------------------------

/**
 * Minimal shape of a CopilotKit chat message that the adapter cares
 * about. CopilotKit exposes a `visibleMessages` array of `Message`
 * objects with varying subclasses (`TextMessage`, `ActionExecutionMessage`,
 * `ResultMessage`). We only need `id`, `role`, and `content` (which
 * `TextMessage` exposes for user messages).
 *
 * Modeled as `unknown[]` in the public option type to match
 * CopilotKit's typings — internal narrowing happens in the loop body.
 */
export interface UseChatScopedProjectFromCopilotChatOptions {
	projectId: string | null;
	organizationId: string | null;
	/**
	 * The `visibleMessages` array returned by
	 * `useCopilotChat()` (`@copilotkit/react-core`). Passed in by the
	 * caller so the adapter doesn't need to import CopilotKit (which
	 * would force every consumer of this file to ship the CopilotKit
	 * bundle even on surfaces that don't use it).
	 */
	visibleMessages: ReadonlyArray<unknown>;
}

/**
 * Type-guard for CopilotKit `TextMessage` shape. Returns `true` for
 * any object that exposes a string `role` and string `content`.
 */
function isCopilotTextMessage(value: unknown): value is {
	id: string;
	role: string;
	content: string;
} {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.role === "string" &&
		typeof candidate.content === "string"
	);
}

/**
 * In-document Copilot adapter. CopilotKit's `useCopilotChat()` returns
 * `visibleMessages`, which interleaves user / assistant text messages
 * with action-execution and result messages. We only walk the
 * user-role text messages.
 */
export function useChatScopedProjectFromCopilotChat(
	options: UseChatScopedProjectFromCopilotChatOptions,
): ChatScope {
	const { projectId, organizationId, visibleMessages } = options;

	const lastUserPromptForMessage = useCallback(
		(messageId: string): string | null => {
			if (visibleMessages.length === 0) {
				return null;
			}
			const targetIndex = visibleMessages.findIndex(
				(message) =>
					typeof message === "object" &&
					message !== null &&
					(message as { id?: string }).id === messageId,
			);
			const upperBound =
				targetIndex === -1 ? visibleMessages.length : targetIndex;
			for (let index = upperBound - 1; index >= 0; index--) {
				const candidate = visibleMessages[index];
				if (
					isCopilotTextMessage(candidate) &&
					candidate.role === "user"
				) {
					return candidate.content;
				}
			}
			return null;
		},
		[visibleMessages],
	);

	return useMemo<ChatScope>(
		() => ({
			projectId,
			organizationId,
			lastUserPromptForMessage,
		}),
		[projectId, organizationId, lastUserPromptForMessage],
	);
}
