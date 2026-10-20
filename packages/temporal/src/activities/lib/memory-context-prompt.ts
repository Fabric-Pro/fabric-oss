/**
 * How each assistant engine is told about what it recalls from earlier
 * conversations and runs, resolved from the Prompt Library.
 *
 * The wording is not code: it is the `orchestrator_memory_context` and
 * `direct_chat_memory_context` SYSTEM prompts, editable per user, project or
 * organization, with the seeded bodies used when nothing is bound or a bound
 * body will not render. Only the recalled data comes from code. Lookup,
 * rendering and the fallback are `resolveBoundPromptText`'s.
 *
 * Resolved inside activities, never in a workflow, so it adds no command to
 * any workflow's history.
 */

import {
	DIRECT_CHAT_MEMORY_FALLBACK_BODY,
	DIRECT_CHAT_MEMORY_PROMPT_AGENT_KEY,
} from "@repo/utils/direct-chat-memory-prompt";
import {
	ORCHESTRATOR_MEMORY_FALLBACK_BODY,
	ORCHESTRATOR_MEMORY_PROMPT_AGENT_KEY,
} from "@repo/utils/orchestrator-memory-prompt";
import { type BoundPromptScope, resolveBoundPromptText } from "./bound-prompt";

export async function resolveOrchestratorMemoryPrompt(
	input: BoundPromptScope & { variables: Record<string, unknown> },
): Promise<string> {
	const { variables, ...scope } = input;
	const resolved = await resolveBoundPromptText({
		agentKey: ORCHESTRATOR_MEMORY_PROMPT_AGENT_KEY,
		fallbackBody: ORCHESTRATOR_MEMORY_FALLBACK_BODY,
		variables,
		scope,
		escape: false,
	});
	return resolved.text.trim();
}

/** Trusted guidance only: the recalled executions are fenced elsewhere. */
export async function resolveDirectChatMemoryPrompt(
	scope: BoundPromptScope,
): Promise<string> {
	const resolved = await resolveBoundPromptText({
		agentKey: DIRECT_CHAT_MEMORY_PROMPT_AGENT_KEY,
		fallbackBody: DIRECT_CHAT_MEMORY_FALLBACK_BODY,
		variables: {},
		scope,
		escape: false,
	});
	return resolved.text.trim();
}
