/**
 * Workspace RAG Handler
 *
 * Handles dynamic workspace document retrieval during step execution.
 * This is the recommended approach for RAG - retrieve on-demand rather than upfront.
 *
 * Benefits:
 * - Only retrieves documents when actually needed
 * - Can use refined queries from planning (better retrieval quality)
 * - Supports iterative retrieval (retrieve → analyze → retrieve more)
 * - Scales to large document sets (100k+ documents)
 * - Reduces latency for queries that don't need workspace docs
 */

import type { ExecuteStepInput, ExecuteStepOutput } from "../../types";
import type {
	HandlerContext,
	HandlerResult,
	StepHandler,
	ToolCallRecord,
} from "./types";

export class WorkspaceRagHandler implements StepHandler {
	readonly name = "workspace-rag";
	readonly capabilities = ["workspace_rag"];

	canHandle(input: ExecuteStepInput): boolean {
		const app = input.step.app;
		const executor = input.step.executor;

		// Check if this is a workspace RAG tool
		return Boolean(
			app === "workspace_rag_query" ||
				app === "workspace_rag_summarize" ||
				executor === "workspace_rag_query" ||
				executor === "workspace_rag_summarize" ||
				app?.startsWith("workspace_rag") ||
				executor?.startsWith("workspace_rag"),
		);
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		const { input } = context;
		const toolName =
			input.step.app || input.step.executor || "workspace_rag_query";

		console.log(
			`[WorkspaceRagHandler] Executing workspace RAG: ${toolName}`,
		);

		try {
			const output = await this.executeWorkspaceRag(input, toolName);
			return {
				handled: true,
				output,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error("[WorkspaceRagHandler] Workspace RAG failed:", error);
			return {
				handled: false,
				error: `Workspace RAG ${toolName} failed: ${errorMessage}`,
				shouldFallback: false,
			};
		}
	}

	private async executeWorkspaceRag(
		input: ExecuteStepInput,
		toolName: string,
	): Promise<ExecuteStepOutput> {
		const startTime = Date.now();
		const stepInputs = input.step.inputs as
			| Record<string, unknown>
			| undefined;

		console.log(`[WorkspaceRagHandler] Workspace RAG tool: ${toolName}`, {
			stepId: input.step.id,
			inputs: stepInputs,
		});

		// Import RAG activity dynamically to avoid circular deps
		const { retrieveWorkspaceDocumentsActivity } = await import(
			"../../../direct-chat/rag-retrieval"
		);

		const toolCalls: ToolCallRecord[] = [];
		let result: string;

		// Extract parameters
		const query =
			(stepInputs?.query as string) || input.step.description || "";
		const workspaceIds =
			(stepInputs?.workspaceIds as string[]) || input.workspaceIds || [];
		const topK =
			(stepInputs?.topK as number) ||
			(stepInputs?.maxResults as number) ||
			10;
		const minSimilarity = (stepInputs?.minSimilarity as number) || 0.3;

		if (!query) {
			throw new Error("Query is required for workspace RAG");
		}

		if (workspaceIds.length === 0) {
			// No workspaces configured - return helpful message
			result =
				"No workspace documents are available. Please attach documents to a workspace to enable document search.";
			toolCalls.push({
				id: `workspace-rag-${Date.now()}`,
				name: toolName,
				args: { query },
				result: { message: "No workspaces configured" },
				status: "success",
				durationMs: Date.now() - startTime,
			});
		} else {
			console.log(
				`[WorkspaceRagHandler] Searching ${workspaceIds.length} workspace(s) for: "${query.slice(0, 100)}..."`,
			);

			const ragStartTime = Date.now();
			const ragResult = await retrieveWorkspaceDocumentsActivity(
				query,
				input.userId,
				input.organizationId,
				workspaceIds,
				undefined,
				topK,
				minSimilarity,
			);

			const ragDurationMs = Date.now() - ragStartTime;

			if (ragResult.context && ragResult.chunkCount > 0) {
				result = ragResult.context;
				console.log(
					`[WorkspaceRagHandler] Found ${ragResult.chunkCount} relevant chunks in ${ragDurationMs}ms`,
				);

				toolCalls.push({
					id: `workspace-rag-${Date.now()}`,
					name: toolName,
					args: { query, workspaceIds, topK, minSimilarity },
					result: {
						chunkCount: ragResult.chunkCount,
						contextLength: result.length,
						sources: ragResult.sources,
					},
					status: "success",
					durationMs: ragDurationMs,
				});
			} else {
				result = `No relevant content found in workspace documents for query: "${query}". The documents may not contain information related to this query, or you may need to adjust the search terms.`;
				console.log(
					`[WorkspaceRagHandler] No relevant chunks found in ${ragDurationMs}ms`,
				);

				toolCalls.push({
					id: `workspace-rag-${Date.now()}`,
					name: toolName,
					args: { query, workspaceIds, topK, minSimilarity },
					result: {
						chunkCount: 0,
						message: "No relevant content found",
					},
					status: "success",
					durationMs: ragDurationMs,
				});
			}
		}

		const durationMs = Date.now() - startTime;
		console.log(
			`[WorkspaceRagHandler] Workspace RAG completed in ${durationMs}ms`,
		);

		return {
			outputs: {
				response: result,
				toolResults: toolCalls,
				workspaceRagTool: toolName,
			},
			variables: {},
			toolCalls,
			response: result,
		};
	}
}
