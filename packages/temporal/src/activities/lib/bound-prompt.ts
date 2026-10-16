/**
 * Turning a Prompt Library prompt into the text a model is given: look up the
 * body bound to an agent key, render it against the run's facts, and fall back
 * to the seeded body when nothing is bound or the bound body will not render.
 *
 * Several unattended features read their wording this way (the scheduled agent
 * task, the meeting agenda). The guards that decide "this body did not render"
 * are subtle and were copied between them, so they live once, in
 * `renderBoundPromptBody`.
 *
 * Resolved inside an activity, never in a workflow, so it adds no command to
 * any workflow's history.
 */

import { getBoundPromptForAgent } from "@repo/database";
import { logger } from "@repo/logs";
import { renderBoundPromptBody } from "./render-bound-prompt-body";

export type BoundPromptSource =
	| "BOUND"
	| "DEFAULT_UNBOUND"
	| "DEFAULT_RENDER_FAILED";

export type BoundPrompt = NonNullable<
	Awaited<ReturnType<typeof getBoundPromptForAgent>>
>;

export interface BoundPromptScope {
	userId: string;
	organizationId?: string;
	projectId?: string;
}

export interface ResolvedBoundPrompt {
	text: string;
	/**
	 * Which prompt actually shaped the run. A run on the default because the
	 * bound prompt would not render reads exactly like one on the bound prompt,
	 * so this is the one fact about it a reader cannot recover from the output.
	 */
	source: BoundPromptSource;
	/** The bound prompt's version, when one was used. */
	promptVersion: number | null;
	formatOverridden: boolean;
	/** The bound prompt row, when one is bound. */
	prompt: BoundPrompt | null;
}

/**
 * The text of the prompt bound to `agentKey` for `scope` (user, project or
 * organization, as the library resolves it), rendered against `variables`.
 *
 * A prompt library that cannot be read is treated as "nothing bound": an
 * unattended run should not fail because of it, and the seeded body is the
 * house default.
 */
export async function resolveBoundPromptText(input: {
	agentKey: string;
	fallbackBody: string;
	variables: Record<string, unknown>;
	scope: BoundPromptScope;
	/** HTML-escape `{{ }}` values. Off for prompts whose facts are not markup. */
	escape?: boolean;
}): Promise<ResolvedBoundPrompt> {
	const logTag = input.agentKey;
	let prompt: BoundPrompt | null;
	try {
		prompt = await getBoundPromptForAgent({
			agentName: input.agentKey,
			documentType: "GENERAL",
			storyKind: null,
			userId: input.scope.userId,
			organizationId: input.scope.organizationId,
			projectId: input.scope.projectId,
		});
	} catch (error) {
		logger.warn(
			`[${logTag}] could not read the bound prompt; using the default body`,
			{ error: error instanceof Error ? error.message : String(error) },
		);
		prompt = null;
	}

	const rendered = await renderBoundPromptBody({
		body: prompt?.version.content ?? input.fallbackBody,
		format: prompt?.format ?? "HANDLEBARS",
		fallbackBody: input.fallbackBody,
		variables: input.variables,
		escape: input.escape,
		logTag,
	});
	if (!prompt) {
		return {
			text: rendered.text,
			source: "DEFAULT_UNBOUND",
			promptVersion: null,
			formatOverridden: false,
			prompt: null,
		};
	}
	return {
		text: rendered.text,
		source: rendered.recovered ? "DEFAULT_RENDER_FAILED" : "BOUND",
		promptVersion: rendered.recovered ? null : prompt.version.version,
		formatOverridden: rendered.formatOverridden,
		prompt,
	};
}
