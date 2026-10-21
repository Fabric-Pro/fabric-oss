import { buildAgentConfigurable } from "@repo/agent-core/services/agent-configurable";
import type { LangGraphExecutor } from "@repo/agent-core/unified-server";
import { convertToSimpleMessages } from "@repo/agent-core/utils/message-converter";
import type { backlogUpdaterGraph as agentGraph } from "./agent.js";
import { DEFAULT_RECURSION_LIMIT } from "./utils";

/**
 * Extract backlog-updater-specific state from CopilotKit input.
 * CopilotKit sends state via body.state (useCoAgent) and body.forwardedProps.
 */
export function extractState(input: Record<string, unknown>) {
	const state = (input.state || {}) as Record<string, unknown>;
	const forwardedProps = (input.forwardedProps || {}) as Record<
		string,
		unknown
	>;

	return {
		projectId:
			(state.projectId as string) ||
			(forwardedProps.projectId as string) ||
			(input.projectId as string) ||
			"",
		projectName:
			(state.projectName as string) ||
			(forwardedProps.projectName as string) ||
			(input.projectName as string) ||
			"",
		organizationId:
			(state.organizationId as string) ||
			(forwardedProps.organizationId as string) ||
			(input.organizationId as string) ||
			undefined,
		hasTeamsIntegration:
			(state.hasTeamsIntegration as boolean) ??
			(forwardedProps.hasTeamsIntegration as boolean) ??
			(input.hasTeamsIntegration as boolean) ??
			false,
		hasSlackIntegration:
			(state.hasSlackIntegration as boolean) ??
			(forwardedProps.hasSlackIntegration as boolean) ??
			(input.hasSlackIntegration as boolean) ??
			false,
		analysisStatus: (state.analysisStatus ??
			forwardedProps.analysisStatus ??
			input.analysisStatus) as string | undefined,
		lastProposalSummary: (state.lastProposalSummary ??
			forwardedProps.lastProposalSummary ??
			input.lastProposalSummary) as string | undefined,

		hasNotionIntegration:
			(state.hasNotionIntegration as boolean) ??
			(forwardedProps.hasNotionIntegration as boolean) ??
			(input.hasNotionIntegration as boolean) ??
			false,
		hasPMTool:
			(state.hasPMTool as boolean) ??
			(forwardedProps.hasPMTool as boolean) ??
			(input.hasPMTool as boolean) ??
			false,
		pmToolName:
			(state.pmToolName as string) ||
			(forwardedProps.pmToolName as string) ||
			(input.pmToolName as string) ||
			undefined,
		backlogSummary:
			(state.backlogSummary as string) ||
			(forwardedProps.backlogSummary as string) ||
			(input.backlogSummary as string) ||
			"",
	};
}

export function createInvokeAgent(
	backlogUpdaterGraph: Pick<typeof agentGraph, "invoke">,
): LangGraphExecutor {
	return async (input, runtimeConfig) => {
		const messages = input.messages as Array<{
			role: string;
			content: string;
		}>;
		const lastMessage = messages[messages.length - 1];
		const userMessage = lastMessage?.content || "";
		const agentState = extractState(input);

		console.log("[UnifiedServer] Invoking backlog_updater with:", {
			projectId: agentState.projectId,
			projectName: agentState.projectName,
			messageCount: messages.length,
		});

		const result = await backlogUpdaterGraph.invoke(
			{
				messages: [{ role: "user", content: userMessage }],
				...agentState,
				tools: [],
			},
			{
				recursionLimit: DEFAULT_RECURSION_LIMIT,
				configurable: buildAgentConfigurable(
					input,
					runtimeConfig?.configurable,
				),
			},
		);

		const outputMessages = convertToSimpleMessages(result.messages || []);

		return {
			messages: outputMessages,
			analysisStatus: result.analysisStatus,
			lastProposalSummary: result.lastProposalSummary,
			error: result.error,
		};
	};
}
