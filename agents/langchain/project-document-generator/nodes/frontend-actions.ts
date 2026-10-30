/**
 * The frontend actions a run's graph binds.
 *
 * CopilotKit sends the page's frontend actions with each run: under
 * `state.copilotkit.actions` (CopilotKit SDK) or `tools` (AG-UI). The graph
 * binds them as tools and ends its turn on a call to one, so the browser runs
 * it. An MCP server's own tool is not one of them, since the browser cannot
 * run it, and is dropped here should one be forwarded. Underscores alone mark
 * nothing: the editor's actions include `ask_clarifying_question` and
 * `github_get_file_contents`.
 *
 * A classified Proposal run binds only the actions that leave Main alone, as
 * the agent defines them (`proposalFrontendActions`).
 */

import {
	type ProposalClientConfig,
	proposalFrontendActions,
} from "./proposal-client-mode";

/**
 * The actions the request carried: the CopilotKit SDK's state first, else
 * the AG-UI `tools`.
 */
export function offeredFrontendActions(
	input: Record<string, unknown>,
): unknown[] {
	const stateCopilotkit = (
		input.state as { copilotkit?: unknown } | undefined
	)?.copilotkit as { actions?: unknown } | undefined;
	const offered = stateCopilotkit?.actions || input.tools || [];
	return Array.isArray(offered) ? offered : [];
}

/**
 * Whether an offered tool looks like an MCP server's tool: a defensive check
 * for one forwarded with the page's actions, narrower than the name filter it
 * replaces, which also dropped any name with more than one underscore. It
 * looks for `_isMCPTool`, or a name holding `__` or both a hyphen and an
 * underscore (`example-mcp_search`); no registered frontend action's name
 * does.
 *
 * In practice no such tool arrives: CopilotKit's runtime sets `_isMCPTool` only
 * on the actions it runs itself, which never reach this external agent, and
 * the Fabric MCP gateway's `{server}__{tool}` names do not arrive through
 * CopilotKit.
 *
 * The managed-default Excalidraw `create_view` carries none of them: the
 * browser registers and runs it, so it is a frontend action.
 */
function isMcpServerTool(action: unknown): boolean {
	if (!action || typeof action !== "object") {
		return false;
	}
	const { name, _isMCPTool } = action as {
		name?: unknown;
		_isMCPTool?: unknown;
	};
	if (_isMCPTool === true) {
		return true;
	}
	if (typeof name !== "string") {
		return false;
	}
	return name.includes("__") || (name.includes("-") && name.includes("_"));
}

/**
 * The frontend actions the graph binds for this run: every offered action
 * but an MCP server's tool, and on a classified Proposal run only the
 * allow-listed ones, each as the agent defines it.
 */
export function selectFrontendActions(
	offered: readonly unknown[],
	proposalConfig: ProposalClientConfig,
): unknown[] {
	const frontendActions = offered.filter(
		(action) => !isMcpServerTool(action),
	);
	return proposalConfig.mode === "none"
		? frontendActions
		: proposalFrontendActions(
				frontendActions,
				proposalConfig.clarifyingPolicy,
			);
}
