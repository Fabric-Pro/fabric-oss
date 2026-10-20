import { buildAgentConfigurable } from "@repo/agent-core/services/agent-configurable";
import type { LangGraphExecutor } from "@repo/agent-core/unified-server";
import { convertToSimpleMessages } from "@repo/agent-core/utils/message-converter";
import type { taskPlannerGraph as agentGraph } from "./agent.js";

export function createInvokeAgent(
	taskPlannerGraph: Pick<typeof agentGraph, "invoke">,
): LangGraphExecutor {
	return async (input, runtimeConfig) => {
		const messages = input.messages as Array<{
			role: string;
			content: string;
		}>;
		const lastMessage = messages[messages.length - 1];
		const userMessage = lastMessage?.content || "";
		const projectName = (input.projectName as string) || "Unnamed Project";
		const projectDescription = input.projectDescription as
			| string
			| undefined;
		const techStack = input.techStack as string | undefined;
		const userStory = (input.userStory as string) || userMessage;

		console.log("[UnifiedServer] Invoking task_planner with:", {
			projectName,
			userStoryLength: userStory.length,
			hasTechStack: !!techStack,
		});

		// Invoke the LangGraph graph
		const result = await taskPlannerGraph.invoke(
			{
				messages: [{ role: "user", content: userMessage }],
				userStory,
				projectName,
				projectDescription,
				techStack,
				tools: [],
			},
			{
				configurable: buildAgentConfigurable(
					input,
					runtimeConfig?.configurable,
				),
			},
		);

		console.log("[UnifiedServer] Graph result:", {
			hasDocument: !!result.document,
			documentLength: result.document?.length || 0,
			taskCount: result.decomposedTasks?.length || 0,
		});

		// Convert BaseMessage[] to simple message format for the unified server
		const outputMessages = convertToSimpleMessages(result.messages || []);

		return {
			document: result.document || "",
			messages: outputMessages,
			decomposedTasks: result.decomposedTasks,
			riskAnalysis: result.riskAnalysis,
			dependencyGraph: result.dependencyGraph,
			executionPlan: result.executionPlan,
			error: result.error,
		};
	};
}
