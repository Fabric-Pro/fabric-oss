/**
 * The instructions an Agent Task step gives its agent, resolved from the
 * Prompt Library.
 *
 * The wording is not code: it is the `workflow_agent_task` SYSTEM prompt,
 * editable per user, project or organization, with the seeded body
 * (`AGENT_TASK_FALLBACK_BODY`) used when nothing is bound — a not-yet-seeded
 * environment — or when a bound body will not render. Only the facts the body
 * is rendered against come from code. Lookup, rendering and the fallback are
 * `resolveBoundPromptText`'s.
 *
 * Resolved inside the step's activity, never in a workflow, so it adds no
 * command to any workflow's history.
 */

import {
	AGENT_TASK_FALLBACK_BODY,
	AGENT_TASK_PROMPT_AGENT_KEY,
} from "@repo/utils/agent-task-prompt";
import { type BoundPromptSource, resolveBoundPromptText } from "./bound-prompt";

export type AgentTaskInstructionsSource = BoundPromptSource;

export interface AgentTaskInstructions {
	text: string;
	/**
	 * Which prompt actually shaped the run. A run on the default because the
	 * bound prompt would not render reads exactly like one on the bound prompt,
	 * so this is the one fact about it a reader cannot recover from the output.
	 */
	source: AgentTaskInstructionsSource;
	/** The bound prompt's version, when one was used. */
	promptVersion: number | null;
}

export interface ResolveAgentTaskInstructionsInput {
	userId: string;
	organizationId: string;
	projectId?: string;
	outputFormat: "html" | "markdown";
	/** Whether the user message ends with a block of upstream data. */
	hasUpstreamData: boolean;
	/** The per-run id that delimits that block. */
	boundary: string;
}

export async function resolveAgentTaskInstructions(
	input: ResolveAgentTaskInstructionsInput,
): Promise<AgentTaskInstructions> {
	const resolved = await resolveBoundPromptText({
		agentKey: AGENT_TASK_PROMPT_AGENT_KEY,
		fallbackBody: AGENT_TASK_FALLBACK_BODY,
		variables: {
			output_format: input.outputFormat,
			output_is_html: input.outputFormat === "html",
			output_is_markdown: input.outputFormat === "markdown",
			has_upstream_data: input.hasUpstreamData,
			boundary: input.boundary,
		},
		scope: {
			userId: input.userId,
			organizationId: input.organizationId,
			projectId: input.projectId,
		},
		escape: false,
	});
	return {
		text: resolved.text.trim(),
		source: resolved.source,
		promptVersion: resolved.promptVersion,
	};
}
