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
 * Resolved inside activities, so prompt lookup adds no command to
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
import {
	type BoundPromptScope,
	type ResolvedBoundPrompt,
	resolveBoundPromptText,
} from "./bound-prompt";
import { renderBoundPromptBody } from "./render-bound-prompt-body";

/** One activity load uses one prompt version while trimming its episodes. */
export type MemoryPromptBindingSnapshot = { resolved?: ResolvedBoundPrompt };

export async function resolveOrchestratorMemoryPrompt(
	input: BoundPromptScope & {
		variables: Record<string, unknown>;
		bindingSnapshot?: MemoryPromptBindingSnapshot;
	},
): Promise<string> {
	const { variables, bindingSnapshot, ...scope } = input;
	if (bindingSnapshot?.resolved) {
		const prompt = bindingSnapshot.resolved.prompt;
		const rendered = await renderBoundPromptBody({
			body: prompt?.version.content ?? ORCHESTRATOR_MEMORY_FALLBACK_BODY,
			format: prompt?.format ?? "HANDLEBARS",
			fallbackBody: ORCHESTRATOR_MEMORY_FALLBACK_BODY,
			variables,
			escape: false,
			logTag: ORCHESTRATOR_MEMORY_PROMPT_AGENT_KEY,
		});
		return rendered.text.trim();
	}
	const resolved = await resolveBoundPromptText({
		agentKey: ORCHESTRATOR_MEMORY_PROMPT_AGENT_KEY,
		fallbackBody: ORCHESTRATOR_MEMORY_FALLBACK_BODY,
		variables,
		scope,
		escape: false,
	});
	if (bindingSnapshot) {
		bindingSnapshot.resolved = resolved;
	}
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
