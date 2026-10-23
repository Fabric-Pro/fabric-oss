import { AIMessage } from "@langchain/core/messages";
import { buildAgentConfigurable } from "@repo/agent-core/services/agent-configurable";
import type { LangGraphExecutor } from "@repo/agent-core/unified-server";
import { convertToSimpleMessages } from "@repo/agent-core/utils/message-converter";
import type { storyBreakdownGraph as agentGraph } from "./agent.js";
import { DEFAULT_RECURSION_LIMIT } from "./utils";

export function createInvokeAgent(
	storyBreakdownGraph: Pick<typeof agentGraph, "invoke">,
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
		const prdContent = (input.prdContent as string) || userMessage;

		console.log("[UnifiedServer] Invoking story_breakdown with:", {
			projectName,
			prdContentLength: prdContent.length,
		});

		// Invoke the LangGraph graph
		const graphResult = await storyBreakdownGraph.invoke(
			{
				messages: [{ role: "user", content: userMessage }],
				prdContent,
				projectName,
				projectDescription,
				tools: [],
			},
			{
				recursionLimit: DEFAULT_RECURSION_LIMIT,
				signal: runtimeConfig?.signal,
				configurable: buildAgentConfigurable(
					input,
					runtimeConfig?.configurable,
				),
			},
		);

		// Cast to access properties
		const result = graphResult as unknown as {
			document?: string;
			messages: unknown[];
			error?: string;
		};

		console.log("[UnifiedServer] Graph result:", {
			hasDocument: !!result.document,
			documentLength: result.document?.length || 0,
		});

		const lastGraphMessage = result.messages?.at(-1);
		const failureText =
			result.error &&
			AIMessage.isInstance(lastGraphMessage) &&
			typeof lastGraphMessage.content === "string"
				? lastGraphMessage.content
				: undefined;

		// Convert BaseMessage[] to simple message format
		const outputMessages = convertToSimpleMessages(result.messages || []);

		return {
			failureText,
			document: result.document || "",
			messages: outputMessages,
			error: result.error,
		};
	};
}
