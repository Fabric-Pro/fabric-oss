/**
 * Project RAG Handler
 *
 * Handles dynamic project document retrieval during step execution.
 * Uses the project's RAG pipeline (Qdrant vector search + reranking)
 * to find relevant project contexts on-demand.
 *
 * Benefits:
 * - Only retrieves project documents when actually needed
 * - Can use refined queries from planning (better retrieval quality)
 * - Leverages project-specific RAG settings (topK, reranking, etc.)
 * - Reduces latency for queries that don't need project context
 */

import type { ExecuteStepInput, ExecuteStepOutput } from "../../types";
import type {
	HandlerContext,
	HandlerResult,
	StepHandler,
	ToolCallRecord,
} from "./types";

export class ProjectRagHandler implements StepHandler {
	readonly name = "project-rag";
	readonly capabilities = ["project_rag"];

	canHandle(input: ExecuteStepInput): boolean {
		const app = input.step.app;
		const executor = input.step.executor;

		// Check if this is a project RAG tool
		return Boolean(
			app === "project_rag_query" ||
				executor === "project_rag_query" ||
				app?.startsWith("project_rag") ||
				executor?.startsWith("project_rag"),
		);
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		const { input } = context;
		const toolName =
			input.step.app || input.step.executor || "project_rag_query";

		console.log(`[ProjectRagHandler] Executing project RAG: ${toolName}`);

		try {
			const output = await this.executeProjectRag(input, toolName);
			return {
				handled: true,
				output,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error("[ProjectRagHandler] Project RAG failed:", error);
			return {
				handled: false,
				error: `Project RAG ${toolName} failed: ${errorMessage}`,
				shouldFallback: false,
			};
		}
	}

	private async executeProjectRag(
		input: ExecuteStepInput,
		toolName: string,
	): Promise<ExecuteStepOutput> {
		const startTime = Date.now();
		const stepInputs = input.step.inputs as
			| Record<string, unknown>
			| undefined;

		console.log(`[ProjectRagHandler] Project RAG tool: ${toolName}`, {
			stepId: input.step.id,
			inputs: stepInputs,
			projectId: input.projectId,
		});

		const toolCalls: ToolCallRecord[] = [];
		let result: string;

		// Extract query parameter
		const query =
			(stepInputs?.query as string) || input.step.description || "";
		const projectId = input.projectId;

		if (!query) {
			throw new Error("Query is required for project RAG");
		}

		if (!projectId) {
			// No project attached - return helpful message
			result =
				"No project is attached to this conversation. Please attach a project to enable project-specific context search. " +
				"You can attach a project using the project picker in the chat interface.";
			toolCalls.push({
				id: `project-rag-${Date.now()}`,
				name: toolName,
				args: { query },
				result: { message: "No project attached" },
				status: "success",
				durationMs: Date.now() - startTime,
			});
		} else {
			console.log(
				`[ProjectRagHandler] Searching project ${projectId} for: "${query.slice(0, 100)}..."`,
			);

			const { retrieveProjectContexts, formatContextsForPrompt } =
				await import("@repo/rag");

			const ragStartTime = Date.now();
			const contexts = await retrieveProjectContexts({
				projectId,
				query,
				userId: input.userId,
				organizationId: input.organizationId,
			});

			const ragDurationMs = Date.now() - ragStartTime;

			if (contexts.length > 0) {
				// Format contexts with source attribution
				result = formatContextsForPrompt(contexts);
				console.log(
					`[ProjectRagHandler] Found ${contexts.length} relevant contexts in ${ragDurationMs}ms`,
				);

				toolCalls.push({
					id: `project-rag-${Date.now()}`,
					name: toolName,
					args: { query, projectId },
					result: {
						contextCount: contexts.length,
						contentLength: result.length,
						sources: contexts.map((ctx) => ({
							name:
								ctx.filename ||
								ctx.sourceTitle ||
								`Context ${ctx.id.slice(0, 8)}`,
							type: ctx.type,
							relevance: Math.round(ctx.score * 100) / 100,
						})),
					},
					status: "success",
					durationMs: ragDurationMs,
				});
			} else {
				result = `No relevant content found in project documents for query: "${query}". The project may not contain information related to this query, or you may need to adjust the search terms.`;
				console.log(
					`[ProjectRagHandler] No relevant contexts found in ${ragDurationMs}ms`,
				);

				toolCalls.push({
					id: `project-rag-${Date.now()}`,
					name: toolName,
					args: { query, projectId },
					result: {
						contextCount: 0,
						message: "No relevant content found",
					},
					status: "success",
					durationMs: ragDurationMs,
				});
			}
		}

		const durationMs = Date.now() - startTime;
		console.log(
			`[ProjectRagHandler] Project RAG completed in ${durationMs}ms`,
		);

		return {
			outputs: {
				response: result,
				toolResults: toolCalls,
				projectRagTool: toolName,
			},
			variables: {},
			toolCalls,
			response: result,
		};
	}
}
