/**
 * Unified Search Handler
 *
 * Handles knowledge search steps by querying all project-attached sources
 * in parallel via the unified search function.
 *
 * Replaces separate project-rag and workspace-rag calls with a single
 * search that fans out to: project contexts, workspace docs,
 * connector-backed docs, and optionally web search.
 *
 * The handler responds to both explicit "unified_search" tool calls
 * and the existing "project_rag_query" / "workspace_rag_query" tool names
 * for backward compatibility.
 */

import type { ConnectorConfig } from "@repo/connectors";
import type { ExecuteStepInput, ExecuteStepOutput } from "../../types";
import type {
	HandlerContext,
	HandlerResult,
	StepHandler,
	ToolCallRecord,
} from "./types";

export class UnifiedSearchHandler implements StepHandler {
	readonly name = "unified-search";
	readonly capabilities = ["unified_search", "project_knowledge_search"];

	canHandle(input: ExecuteStepInput): boolean {
		const app = input.step.app;
		const executor = input.step.executor;

		return Boolean(
			app === "unified_search" ||
				app === "project_rag_query" ||
				app === "workspace_rag_query" ||
				app === "workspace_rag_summarize" ||
				app === "project_knowledge_search" ||
				executor === "unified_search" ||
				executor === "project_rag_query" ||
				executor === "workspace_rag_query" ||
				executor === "workspace_rag_summarize" ||
				executor === "project_knowledge_search" ||
				app?.startsWith("unified_search") ||
				app?.startsWith("project_rag") ||
				app?.startsWith("workspace_rag") ||
				executor?.startsWith("unified_search") ||
				executor?.startsWith("project_rag") ||
				executor?.startsWith("workspace_rag"),
		);
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		const { input } = context;
		const toolName =
			input.step.app || input.step.executor || "unified_search";

		console.log(
			`[UnifiedSearchHandler] Executing unified search: ${toolName}`,
		);

		try {
			const output = await this.executeUnifiedSearch(input, toolName);
			return {
				handled: true,
				output,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error(
				"[UnifiedSearchHandler] Unified search failed:",
				error,
			);
			return {
				handled: false,
				error: `Unified search failed: ${errorMessage}`,
				shouldFallback: false,
			};
		}
	}

	private async executeUnifiedSearch(
		input: ExecuteStepInput,
		toolName: string,
	): Promise<ExecuteStepOutput> {
		const startTime = Date.now();
		const stepInputs = input.step.inputs as
			| Record<string, unknown>
			| undefined;

		const query =
			(stepInputs?.query as string) || input.step.description || "";
		const projectId = input.projectId;
		const workspaceIds =
			(stepInputs?.workspaceIds as string[]) ||
			(input as any).workspaceIds ||
			[];

		if (!query) {
			throw new Error("Query is required for unified search");
		}

		const toolCalls: ToolCallRecord[] = [];
		let result: string;

		if (
			!projectId &&
			toolName.startsWith("workspace_rag") &&
			workspaceIds.length > 0
		) {
			const { retrieveWorkspaceDocumentsActivity } = await import(
				"../../../direct-chat/rag-retrieval"
			);
			const ragResult = await retrieveWorkspaceDocumentsActivity(
				query,
				input.userId,
				input.organizationId,
				workspaceIds,
				undefined,
				10,
				0.3,
			);
			result =
				ragResult.context ||
				`No relevant content found in workspace documents for query: "${query}".`;
			toolCalls.push({
				id: `unified-search-${Date.now()}`,
				name: toolName,
				args: { query, workspaceIds },
				result: {
					chunkCount: ragResult.chunkCount,
					sources: ragResult.sources,
				},
				status: "success",
				durationMs: Date.now() - startTime,
			});
		} else if (!projectId) {
			result =
				"No project is attached to this conversation. " +
				"Please attach a project to enable knowledge search.";
			toolCalls.push({
				id: `unified-search-${Date.now()}`,
				name: toolName,
				args: { query },
				result: { message: "No project attached" },
				status: "success",
				durationMs: Date.now() - startTime,
			});
		} else {
			console.log(
				`[UnifiedSearchHandler] Searching project ${projectId} for: "${query.slice(0, 100)}..."`,
			);

			const { projectSearch, formatUnifiedResultsForPrompt } =
				await import("@repo/rag");
			const { searchAllFederated } = await import("@repo/connectors");
			const { getDataConnections } = await import("@repo/database");

			const explicitSources = stepInputs?.sources as
				| Array<
						| "project-context"
						| "workspace"
						| "connector"
						| "artifact"
						| "web"
				  >
				| undefined;
			const requestedSources =
				explicitSources ??
				(toolName.startsWith("project_rag")
					? (["project-context"] as const)
					: toolName.startsWith("workspace_rag")
						? (["workspace", "connector"] as const)
						: ([
								"project-context",
								...(workspaceIds.length > 0
									? (["workspace", "connector"] as const)
									: []),
							] as const));

			const federatedConnections = requestedSources.includes("connector")
				? await getDataConnections({
						userId: input.userId,
						organizationId: input.organizationId ?? null,
					})
				: [];

			const federatedConfigMap = new Map<string, ConnectorConfig>();
			for (const connection of federatedConnections) {
				if (
					connection.status !== "CONNECTED" &&
					connection.status !== "SYNCING"
				) {
					continue;
				}
				if (
					connection.provider !== "SLACK" &&
					connection.provider !== "GITHUB"
				) {
					continue;
				}

				// GitHub App user tokens expire after 8h, and `DataConnection`
				// holds a COPY taken at link time that nothing ever refreshes —
				// so federated GitHub search silently returned zero results
				// forever, roughly 8h after the connection was linked. Resolve
				// from the WorkflowIntegration that owns the credential instead,
				// which refreshes; fall back to the stored copy for any provider
				// without such an owner.
				let resolvedAccessToken =
					connection.accessToken ||
					((connection.credentials as Record<string, unknown> | null)
						?.accessToken as string | undefined);
				if (connection.provider === "GITHUB") {
					const { getGitHubAccessToken } = await import(
						"@repo/integrations/github"
					);
					resolvedAccessToken =
						(await getGitHubAccessToken(
							input.userId,
							input.organizationId,
						)) ?? resolvedAccessToken;
				}

				federatedConfigMap.set(connection.provider, {
					id: connection.id,
					provider: connection.provider,
					name: connection.name,
					credentials: {
						accessToken: resolvedAccessToken,
						// Slack user token for search:read scope (stored as user_access_token in credentials JSON)
						userAccessToken: (
							connection.credentials as Record<
								string,
								unknown
							> | null
						)?.user_access_token as string | undefined,
						refreshToken:
							connection.refreshToken ||
							((
								connection.credentials as Record<
									string,
									unknown
								> | null
							)?.refreshToken as string | undefined),
						expiresAt: connection.tokenExpiresAt ?? undefined,
						apiKey: (
							connection.credentials as Record<
								string,
								unknown
							> | null
						)?.apiKey as string | undefined,
					},
					providerConfig: ((connection.config as Record<
						string,
						unknown
					> | null) ?? {}) as Record<string, unknown>,
					syncConfig: {
						autoSync: true,
						fullSyncIntervalHours: 24,
						incrementalSyncIntervalMinutes: 60,
						gcIntervalHours: 24,
					},
					status:
						connection.status === "CONNECTED" ||
						connection.status === "SYNCING"
							? "ACTIVE"
							: "ERROR",
					userId: input.userId,
					organizationId: input.organizationId ?? undefined,
					lastSyncAt: connection.lastSyncAt ?? undefined,
					createdAt: connection.createdAt,
					updatedAt: connection.updatedAt,
				});
			}

			const searchResponse = await projectSearch({
				projectId,
				query,
				userId: input.userId,
				organizationId: input.organizationId,
				workspaceIds,
				sources: [...requestedSources],
				perSourceLimit: 5,
				totalLimit: 10,
				federatedSearchFn:
					federatedConfigMap.size > 0
						? async (searchQuery, maxResults) => {
								const results = await searchAllFederated(
									searchQuery,
									federatedConfigMap as Map<
										"SLACK" | "GITHUB",
										ConnectorConfig
									>,
									maxResults,
								);
								return results.map((result) => ({
									id: result.id,
									content: result.content,
									source: {
										type: "connector" as const,
										name: result.sourceName,
										badge: `${result.provider} Live`,
										url: result.url,
										freshness: "live",
										filename: result.title,
									},
									relevance: 0.82,
									metadata: {
										...result.metadata,
										title: result.title,
										author: result.author,
										provider: result.provider,
										externalTimestamp:
											result.externalTimestamp?.toISOString(),
										live: true,
									},
								}));
							}
						: undefined,
			});

			if (searchResponse.results.length > 0) {
				result = formatUnifiedResultsForPrompt(searchResponse);

				toolCalls.push({
					id: `unified-search-${Date.now()}`,
					name: toolName,
					args: {
						query,
						projectId,
						workspaceIds,
						sources: requestedSources,
					},
					result: {
						totalResults: searchResponse.results.length,
						sourceCounts: searchResponse.sourceCounts,
						searchTimeMs: searchResponse.searchTimeMs,
						sources: searchResponse.results.map((r) => ({
							name: r.source.name,
							type: r.source.type,
							badge: r.source.badge,
							relevance: Math.round(r.relevance * 100) / 100,
						})),
					},
					status: "success",
					durationMs: searchResponse.searchTimeMs,
				});

				console.log(
					`[UnifiedSearchHandler] Found ${searchResponse.results.length} results across ${searchResponse.sourcesSearched.join(", ")} in ${searchResponse.searchTimeMs}ms`,
				);
			} else {
				result = `No relevant content found across project knowledge sources for query: "${query}".`;

				toolCalls.push({
					id: `unified-search-${Date.now()}`,
					name: toolName,
					args: {
						query,
						projectId,
						workspaceIds,
						sources: requestedSources,
					},
					result: {
						totalResults: 0,
						sourcesSearched: searchResponse.sourcesSearched,
						sourceErrors: searchResponse.sourceErrors,
					},
					status: "success",
					durationMs: searchResponse.searchTimeMs,
				});
			}
		}

		const _durationMs = Date.now() - startTime;

		return {
			outputs: {
				response: result,
				toolResults: toolCalls,
			},
			variables: {},
			toolCalls,
			response: result,
		};
	}
}
