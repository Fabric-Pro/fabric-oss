/**
 * Built-in Tools for Direct Chat
 *
 * Generic direct chats get a lightweight `webSearch` helper when configured.
 * Agent-bound chats can opt into explicit Fabric tool IDs for deterministic behavior.
 */

import { tool } from "@repo/ai";
import {
	canCreateProjectStory,
	db,
	incrementOrganizationSearchProviderUsage,
	incrementUserSearchProviderUsage,
} from "@repo/database";
import { withDefaultFeature } from "@repo/rag/lib/embedding/usage";
import { createProvider, type WebSearchResult } from "@repo/search";
import { uploadFile } from "@repo/storage";
import { getBaseUrl } from "@repo/utils";
import {
	rethrowIfDispatchStopped,
	throwIfDispatchStopped,
} from "@repo/utils/dispatch-guard";
import { z } from "zod";
import { aiConfigurationRefusalMessage } from "../../lib/ai-configuration-refusal";
import { dispatchLifecycleEvent } from "../../lib/lifecycle-dispatcher";
import { synthesizeToolSpeech } from "../../lib/text-to-speech";
import { COMPANY_CONTEXT_SEARCH_TOOL_NAME } from "../../workflows/orchestrator/company-context-tool-schemas";
import {
	type SecondaryUsageInput,
	secondaryUsageFields,
} from "../../workflows/orchestrator/usage-attribution";
import { resolveSearchProviderForTenant } from "../lib/get-search-provider";
import { getAllFabricAiTools } from "../orchestrator/tools/fabric-ai-tools";
import { jsonSchemaToZod } from "../orchestrator/utils";
import { agentToolDefersStoryDrafting } from "../shared/agent-tool-runtime";
import { canReadChatProject } from "../shared/chat-project-access";
import { getFabricToolDefinitionMap } from "../shared/fabric-content-tools";
import {
	createFirstClassFrame,
	getFirstClassFrame,
	listFirstClassFrames,
	shareFirstClassFrame,
	updateFirstClassFrame,
} from "../shared/frame-service";
import { PROJECT_DOCUMENT_TOOL_IDS } from "../shared/project-document-reads";
import { PROJECT_FEATURE_TOOL_IDS } from "../shared/project-feature-reads";
import {
	buildCodeSearchRepositories,
	buildUnindexedRepositories,
	type CodeSearchRepository,
	codeIndexUnavailableResult,
	describeCodeSearchRepositories,
	repositoryFilterTerm,
	resolveCodeSearchRepository,
} from "./code-search-repositories";
import { retrieveWorkspaceDocumentsActivity } from "./rag-retrieval";

const logger = {
	info: (message: string, data?: Record<string, unknown>) =>
		console.log(`[DirectChat BuiltIn] ${message}`, data || ""),
	error: (message: string, error?: unknown) =>
		console.error(`[DirectChat BuiltIn] ${message}`, error),
	warn: (message: string, data?: Record<string, unknown>) =>
		console.warn(`[DirectChat BuiltIn] ${message}`, data || ""),
};

const fabricToolDefinitions = getFabricToolDefinitionMap(getAllFabricAiTools());

/**
 * Build the Fabric story URL the LLM echoes into Slack/Teams replies.
 *
 * Exported (rather than left as a closure inside `fabric_create_story`) so the
 * worker-env URL shape can be unit-tested without spinning up the entire tool
 * factory + DB mocks. The implementation is a thin wrapper around `getBaseUrl()`
 * — the bug fix lives in `@repo/utils` (APP_URL now flows through the
 * precedence chain), this function exists to be the regression-test seam.
 */
export function buildStoryUrl(args: {
	projectId: string;
	storyId: string;
	slug: string | null;
}): string {
	const base = getBaseUrl();
	return args.slug
		? `${base}/app/${args.slug}/projects/${args.projectId}/stories/${args.storyId}`
		: `${base}/app/projects/${args.projectId}/stories/${args.storyId}`;
}

interface BuiltInToolContext extends SecondaryUsageInput {
	userId: string;
	organizationId?: string;
	workspaceIds?: string[];
	projectId?: string;
	/**
	 * The Advisor's company-context opt-in, carried by the Orchestrator's
	 * catalog adapter. Nothing else sets it, so `createBuiltInTools` (Slack,
	 * Teams, the agent executor) never builds the company context search.
	 */
	companyContextAdvisor?: boolean;
}

interface CreateBuiltInToolsOptions extends BuiltInToolContext {
	enabledFabricToolIds?: string[];
	/** Offered on top of the default set or of an explicit non-empty list. */
	additionalFabricToolIds?: string[];
	/**
	 * Bind the attached project's live roadmap, document and Context-tab
	 * source reads, and its repository code reads, alongside a non-empty
	 * explicit tool list. Set only by the interactive chat, where the project
	 * is the one the user attached; agent runtimes (e.g. Slack triggers acting
	 * as the agent's owner) get them only through their `project-context`
	 * capability.
	 */
	includeProjectFeatureReads?: boolean;
	/** See `CodeSearchToolContext.preferredRepositoryUrl`. */
	preferredRepositoryUrl?: string;
}

async function createWebSearchTool(
	toolName: "webSearch" | "fabric_web_search",
	userId: string,
	organizationId?: string,
): Promise<Record<string, unknown>> {
	const providerConfig = await resolveSearchProviderForTenant(
		userId,
		organizationId,
	);
	if (!providerConfig) {
		return {};
	}

	const searchProvider = createProvider(
		providerConfig.providerName,
		providerConfig.apiKey,
	);
	if (!searchProvider) {
		return {};
	}

	return {
		[toolName]: tool({
			// One description for both names: the shared `fabric_web_search`
			// definition is written for the orchestrator, not for this tool.
			description:
				"Search the web with the workspace's configured search provider. Returns up to maxResults results, each with title, URL and snippet, plus page content, published date and author when the provider supplies them. Use it for current events, recent information, or facts the workspace does not hold. On failure it returns success: false with an error message and no results.",
			inputSchema: z.object({
				query: z.string().describe("The search query to execute"),
				maxResults: z
					.number()
					.min(1)
					.max(20)
					.default(10)
					.describe("Maximum number of results"),
			}),
			execute: async (params): Promise<WebSearchResult> => {
				const startedAt = Date.now();
				try {
					const response = await searchProvider.search(params.query, {
						maxResults: params.maxResults,
						category: "general",
					});

					// Fire-and-forget: increment usage count without blocking the result.
					// Inside a chat turn that stopped during the search, the helper
					// refuses the write itself; the rejection is only logged.
					(organizationId
						? incrementOrganizationSearchProviderUsage({
								organizationId,
								providerName: providerConfig.providerName,
								cost: 0,
							})
						: incrementUserSearchProviderUsage({
								userId,
								providerName: providerConfig.providerName,
								cost: 0,
							})
					).catch((err) => {
						logger.error(
							"Failed to increment search provider usage",
							err,
						);
					});

					return {
						success: true,
						provider: response.providerUsed,
						searchTime: Date.now() - startedAt,
						totalResults: response.results.length,
						results: response.results.map((r) => ({
							title: r.title,
							url: r.url,
							snippet: r.snippet,
							content: r.content,
							publishedDate: r.publishedDate,
							author: r.author,
							images: r.images,
							favicon: r.favicon,
						})),
					};
				} catch (error) {
					return {
						success: false,
						error:
							error instanceof Error
								? error.message
								: "Search failed",
						results: [],
					};
				}
			},
		}),
	};
}

const NO_PROJECT_ACCESS_RESULT = {
	success: false,
	error: "You do not have access to this project's code.",
	results: [],
};

/**
 * The project's code-indexed repositories, with each one's index status.
 * Scoped by `projectId` only — callers check `canReadChatProject` first.
 */
async function loadCodeSearchRepositories(projectId: string): Promise<{
	indexes: Array<{ repositoryIntegrationId: string | null; status: string }>;
	repositories: CodeSearchRepository[];
	/** Connected repositories with no index row, looked up on demand. */
	loadUnindexed: () => Promise<CodeSearchRepository[]>;
}> {
	const { getProjectCodeIndexes } = await import("@repo/database");
	const [indexes, integrations] = await Promise.all([
		getProjectCodeIndexes(projectId),
		db.projectRepositoryIntegration.findMany({
			where: { projectId },
			select: {
				id: true,
				repositoryUrl: true,
				repositoryOwner: true,
				repositoryName: true,
				roleTag: true,
			},
		}),
	]);
	// The project's own legacy repository backs only an index row with no
	// integration, so it is looked up only when there is one.
	const loadLegacy = () =>
		db.project.findUnique({
			where: { id: projectId },
			select: {
				repositoryUrl: true,
				repositoryOwner: true,
				repositoryName: true,
			},
		});
	const legacy = indexes.some(
		(index) => index.repositoryIntegrationId === null,
	)
		? await loadLegacy()
		: null;
	return {
		indexes,
		repositories: buildCodeSearchRepositories(
			indexes,
			integrations,
			legacy,
		),
		// An indexed legacy repository is not unindexed, so the row is only
		// needed when it was not loaded above.
		loadUnindexed: async () =>
			buildUnindexedRepositories(
				indexes,
				integrations,
				legacy ?? (await loadLegacy()),
			),
	};
}

interface CodeSearchToolContext extends BuiltInToolContext {
	/**
	 * Repository the user launched the chat from (the drawer's code context).
	 * Becomes the default scope when it names one of the project's indexed
	 * repositories.
	 */
	preferredRepositoryUrl?: string;
	/**
	 * The chat also offers `code_tree` and `code_file_get` (the
	 * orchestrator's Fabric catalog), so an unsearchable index can point the
	 * model at them.
	 */
	liveRepositoryReads?: boolean;
}

export async function createCodeSearchTool(
	context: CodeSearchToolContext,
): Promise<Record<string, unknown>> {
	const {
		projectId,
		userId,
		organizationId,
		preferredRepositoryUrl,
		liveRepositoryReads,
	} = context;
	if (
		!projectId ||
		!(await canReadChatProject(projectId, userId, organizationId))
	) {
		return {};
	}

	let knownRepositories: CodeSearchRepository[] = [];
	try {
		knownRepositories = (await loadCodeSearchRepositories(projectId))
			.repositories;
	} catch (error) {
		logger.warn("[code_search] Could not list the project's repositories", {
			projectId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	const preferredRepository = preferredRepositoryUrl
		? resolveCodeSearchRepository(knownRepositories, preferredRepositoryUrl)
		: null;

	return {
		code_search: tool({
			description: `Search the project's indexed repository code. Returns file paths, symbols, snippets, citation metadata, and codebase role tags (e.g. Legacy, Primary) when a code index is available. When multiple codebases are attached, attribute findings to their respective codebase and highlight any differences.${describeCodeSearchRepositories(knownRepositories, preferredRepository)}`,
			inputSchema: z.object({
				query: z.string().describe("The code search query"),
				language: z
					.string()
					.optional()
					.describe("Optional language filter"),
				repository: z
					.string()
					.optional()
					.describe(
						'Optional repository to search: its name, owner/name or URL, or "all" for every repository of the project',
					),
				maxResults: z.number().min(1).max(10).default(5),
			}),
			execute: async (args: {
				query: string;
				language?: string;
				repository?: string;
				/** The orchestrator catalog's name for `repository`. */
				repo?: string;
				maxResults?: number;
			}) => {
				if (
					!(await canReadChatProject(
						projectId,
						userId,
						organizationId,
					))
				) {
					return NO_PROJECT_ACCESS_RESULT;
				}
				const {
					indexes: codeIndexes,
					repositories,
					loadUnindexed,
				} = await loadCodeSearchRepositories(projectId);
				const unavailable = (status: string, label?: string) =>
					codeIndexUnavailableResult(status, label, {
						liveRepositoryReads,
					});
				const requested = (args.repository ?? args.repo)?.trim();
				let target: CodeSearchRepository | null = null;
				if (requested && requested.toLowerCase() !== "all") {
					target = resolveCodeSearchRepository(
						repositories,
						requested,
					);
					if (!target) {
						// Connected but never indexed, or nothing indexed at
						// all: the index is unavailable, which no retry fixes,
						// so a plain result rather than a failure (Fizzy #2926;
						// a failure counts toward the three-strike breaker).
						const unindexed = await loadUnindexed();
						const connected = resolveCodeSearchRepository(
							unindexed,
							requested,
						);
						if (connected) {
							return unavailable("missing", connected.label);
						}
						if (repositories.length === 0) {
							// Nothing is searchable, so still not a failure, but
							// the name was not recognised either: say so.
							const result = unavailable(
								codeIndexes[0]?.status ?? "missing",
							);
							return {
								...result,
								message: `${result.message} Note: "${requested}" does not identify one repository connected to this project; connected: ${
									unindexed.map((r) => r.label).join(", ") ||
									"none"
								}.`,
							};
						}
						return {
							success: false,
							message: `"${requested}" does not identify one repository connected to this project. Indexed repositories: ${repositories
								.map((r) => r.label)
								.join(", ")}.${
								unindexed.length > 0
									? ` Connected but not indexed: ${unindexed
											.map((r) => r.label)
											.join(", ")}.`
									: ""
							}`,
							status: "unknown_repository",
						};
					}
				} else if (!requested && preferredRepository) {
					target =
						repositories.find(
							(r) =>
								r.integrationId ===
								preferredRepository.integrationId,
						) ?? null;
				}

				if (target) {
					if (target.status !== "READY") {
						return unavailable(target.status, target.label);
					}
				} else if (
					!codeIndexes.some((index) => index.status === "READY")
				) {
					return unavailable(codeIndexes[0]?.status ?? "missing");
				}

				const { generateEmbedding } = await import(
					"@repo/rag/lib/embedding"
				);
				const { generateSparseVector } = await import(
					"@repo/rag/lib/embedding/sparse"
				);
				const { ensureCollection, getCollectionLayout } = await import(
					"@repo/rag/lib/collection-manager"
				);
				const { qdrantClient } = await import(
					"@repo/rag/lib/project-contexts/client"
				);

				const query = args.query;
				const embeddingResult = await generateEmbedding(
					query,
					withDefaultFeature(
						{
							conversationId: context.usageConversationId,
							userId,
							organizationId,
							...secondaryUsageFields(context),
						},
						"code-index",
					),
				);
				const collectionName = await ensureCollection(
					"project-contexts",
					organizationId,
				);
				const layout = await getCollectionLayout(
					"project-contexts",
					organizationId,
				);
				const baseMust: any[] = [
					{ key: "projectId", match: { value: projectId } },
					{
						key: "contextType",
						match: { any: ["CODE_FILE", "CODE_FILE_SUMMARY"] },
					},
					...(target ? [repositoryFilterTerm(target)] : []),
				];
				const must = [...baseMust];
				if (args.language) {
					must.push({
						key: "language",
						match: { value: args.language },
					});
				}

				// Sanity-check: the index row says READY, but verify the vector
				// store actually has code points for this project. Keep optional
				// user filters (like language) out of this probe so an unsupported
				// filter can still return a normal empty result set.
				try {
					const probe = await qdrantClient.count(collectionName, {
						filter: { must: baseMust },
						exact: false,
					});
					if (!probe || probe.count === 0) {
						return {
							success: false,
							message:
								"Code index marked READY but no code vectors are present. The index may need to be rebuilt.",
							status: "vectors_missing",
						};
					}
				} catch (error) {
					return {
						success: false,
						message: `Code search backend is unavailable: ${
							error instanceof Error
								? error.message
								: String(error)
						}`,
						status: "vector_store_unavailable",
					};
				}

				const maxResults = args.maxResults ?? 5;
				let points: any[] = [];
				if (layout.supportsHybrid && layout.denseVectorName) {
					const sparse = generateSparseVector(query);
					const result = await qdrantClient.query(collectionName, {
						prefetch: [
							{
								query: embeddingResult.embedding,
								using: layout.denseVectorName,
								limit: maxResults * 2,
								filter: { must },
							},
							{
								query: {
									indices: sparse.indices,
									values: sparse.values,
								},
								using: layout.sparseVectorName ?? "sparse",
								limit: maxResults * 2,
								filter: { must },
							},
						],
						query: { fusion: "rrf" },
						limit: maxResults,
						with_payload: true,
					});
					points = result.points ?? [];
				} else {
					const result = await qdrantClient.query(collectionName, {
						query: embeddingResult.embedding,
						limit: maxResults,
						filter: { must },
						with_payload: true,
					});
					points = result.points ?? [];
				}

				const searchedRepository = target?.label ?? "all";
				if (points.length === 0) {
					return { success: true, searchedRepository, results: [] };
				}

				const { getProjectRoleTagMaps, resolveRoleTag } = await import(
					"@repo/rag"
				);
				const roleTagMaps = await getProjectRoleTagMaps(projectId);

				return {
					success: true,
					searchedRepository,
					results: points.map((point) => {
						const payload = point.payload ?? {};
						const repoStr = (payload.repo ||
							(payload.repositoryOwner && payload.repositoryName
								? `${payload.repositoryOwner}/${payload.repositoryName}`
								: undefined)) as string | undefined;
						const roleTag = resolveRoleTag(roleTagMaps, {
							repositoryIntegrationId:
								payload.repositoryIntegrationId as
									| string
									| undefined,
							repo: repoStr,
						});

						const rawExcerpt = (payload.content as string) || "";
						const excerptHeader = roleTag
							? `--- ${roleTag}: ${payload.filePath || "file"} ---\n`
							: "";
						const excerpt = `${excerptHeader}${rawExcerpt}`;

						return {
							score: point.score,
							filePath: payload.filePath,
							language: payload.language,
							symbolName: payload.symbolName,
							symbolType: payload.symbolType,
							repository: repoStr,
							roleTag: roleTag ?? undefined,
							excerpt,
							citation: {
								projectId,
								filePath: payload.filePath,
								contextType: payload.contextType,
								roleTag: roleTag ?? undefined,
							},
						};
					}),
				};
			},
		} as unknown as Parameters<typeof tool>[0]),
	};
}

async function createSymbolSearchTool(
	context: BuiltInToolContext,
): Promise<Record<string, unknown>> {
	const { projectId, userId, organizationId } = context;
	if (
		!projectId ||
		!(await canReadChatProject(projectId, userId, organizationId))
	) {
		return {};
	}

	return {
		symbol_search: tool({
			description:
				"Search for code symbols (functions, classes, enums, interfaces, consts) in a project's code index by name.",
			inputSchema: z.object({
				query: z.string().describe("Symbol name to search for"),
				type: z
					.string()
					.optional()
					.describe(
						"Optional symbol type filter: function, class, enum, interface, const",
					),
				maxResults: z.number().min(1).max(20).default(10),
			}),
			execute: async (args: {
				query: string;
				type?: string;
				maxResults?: number;
			}) => {
				if (
					!(await canReadChatProject(
						projectId,
						userId,
						organizationId,
					))
				) {
					return NO_PROJECT_ACCESS_RESULT;
				}
				const { searchCodeSymbols } = await import("@repo/database");

				const symbols = await searchCodeSymbols({
					projectId,
					query: args.query,
					type: args.type ?? null,
					userId,
					organizationId: organizationId ?? null,
					limit: args.maxResults ?? 10,
				});

				if (symbols.length === 0) {
					return {
						success: true,
						results: [],
						message: `No symbols found matching "${args.query}"`,
					};
				}

				return {
					success: true,
					results: symbols.map((s) => ({
						name: s.name,
						type: s.type,
						filePath: s.filePath,
						lineStart: s.lineStart,
						lineEnd: s.lineEnd,
						signature: s.signature,
						language: s.language,
					})),
				};
			},
		} as unknown as Parameters<typeof tool>[0]),
	};
}

export async function createFabricTool(
	toolId: string,
	context: BuiltInToolContext,
): Promise<Record<string, unknown>> {
	const { userId, organizationId, workspaceIds } = context;
	const projectId = context.projectId;
	const toolDefinition = fabricToolDefinitions.get(toolId);
	if (!toolDefinition?.inputSchema) {
		return {};
	}

	// The workspace reads search only the chat's attached workspaces. With
	// none attached every call fails, and each failure spends one of the
	// turn's steps (Fizzy #3215), so the tool is not offered at all.
	if (
		(toolId === "workspace_rag_query" ||
			toolId === "workspace_rag_summarize") &&
		(!workspaceIds || workspaceIds.length === 0)
	) {
		return {};
	}

	if (toolId === "fabric_web_search") {
		return createWebSearchTool("fabric_web_search", userId, organizationId);
	}

	if (toolId === "fabric_scrape_url") {
		return {
			fabric_scrape_url: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					const { scrapeUrlActivity } = await import("../fabric-ai");
					const result = await scrapeUrlActivity({
						url: (args.url as string) || "",
						userId,
						organizationId,
					});

					return result.success
						? {
								content: result.content,
								durationMs: result.durationMs,
							}
						: { error: result.error || "URL scrape failed" };
				},
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "fabric_search_and_analyze") {
		return {
			fabric_search_and_analyze: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					const { searchAndAnalyzeActivity } = await import(
						"../fabric-ai"
					);
					const result = await searchAndAnalyzeActivity({
						question: (args.query as string) || "",
						pattern: ((args.pattern as string) ||
							"summarize") as any,
						userId,
						organizationId,
						projectId,
						...secondaryUsageFields(context),
					});

					return result.success
						? {
								analysis: result.analysis,
								durationMs: result.durationMs,
								metadata: result.metadata,
							}
						: {
								error:
									result.error || "Search and analyze failed",
							};
				},
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "fabric_scrape_and_analyze") {
		return {
			fabric_scrape_and_analyze: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					const { scrapeAndAnalyzeActivity } = await import(
						"../fabric-ai"
					);
					const result = await scrapeAndAnalyzeActivity({
						url: (args.url as string) || "",
						pattern: ((args.pattern as string) ||
							"summarize") as any,
						userId,
						organizationId,
						projectId,
						...secondaryUsageFields(context),
					});

					return result.success
						? {
								analysis: result.analysis,
								durationMs: result.durationMs,
								metadata: result.metadata,
							}
						: {
								error:
									result.error || "Scrape and analyze failed",
							};
				},
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "workspace_rag_query") {
		return {
			workspace_rag_query: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					if (!workspaceIds || workspaceIds.length === 0) {
						return {
							error: "No workspaces are attached to this chat.",
						};
					}

					const result = await retrieveWorkspaceDocumentsActivity(
						(args.query as string) || "",
						userId,
						organizationId,
						workspaceIds,
						undefined,
						typeof args.topK === "number" ? args.topK : undefined,
						typeof args.minSimilarity === "number"
							? args.minSimilarity
							: undefined,
						{
							usageConversationId: context.usageConversationId,
							...(context.usageOrigin
								? { usageOrigin: context.usageOrigin }
								: {}),
						},
					);

					return {
						response: result.context.replace(/^[\s\n]*/, "").trim(),
						chunkCount: result.chunkCount,
						sources: result.sources,
					};
				},
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "workspace_rag_summarize") {
		return {
			workspace_rag_summarize: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					if (!workspaceIds || workspaceIds.length === 0) {
						return {
							error: "No workspaces are attached to this chat.",
						};
					}

					const query =
						(args.query as string) ||
						"summarize all attached workspace documents";
					const result = await retrieveWorkspaceDocumentsActivity(
						query,
						userId,
						organizationId,
						workspaceIds,
						undefined,
						typeof args.topK === "number" ? args.topK : 20,
						undefined,
						{
							usageConversationId: context.usageConversationId,
							...(context.usageOrigin
								? { usageOrigin: context.usageOrigin }
								: {}),
						},
					);

					return {
						response: result.context.replace(/^[\s\n]*/, "").trim(),
						documentsProcessed: result.sources?.length || 0,
						sources: result.sources,
					};
				},
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "project_rag_query") {
		return {
			project_rag_query: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					if (!projectId) {
						return {
							error: "No project is attached to this chat.",
						};
					}

					const { retrieveProjectContextsActivity } = await import(
						"../project-metadata"
					);
					const result = await retrieveProjectContextsActivity(
						(args.query as string) || "",
						projectId,
						userId,
						organizationId,
						typeof args.topK === "number" ? args.topK : undefined,
						{
							usageConversationId: context.usageConversationId,
							...(context.usageOrigin
								? { usageOrigin: context.usageOrigin }
								: {}),
						},
					);

					return {
						response: result.context.replace(/^[\s\n]*/, "").trim(),
						contextCount: result.chunkCount,
					};
				},
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "fabric_list_meeting_transcripts") {
		return {
			fabric_list_meeting_transcripts: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					if (!projectId) {
						return {
							error: "No project is attached to this chat.",
						};
					}

					const {
						listProjectMeetingTranscripts,
						readTranscriptFilters,
					} = await import("../shared/meeting-transcript-listing");

					const listing = await listProjectMeetingTranscripts({
						projectId,
						userId,
						organizationId,
						filters: readTranscriptFilters(args),
					});

					return {
						response: listing.response,
						transcriptCount: listing.transcriptCount,
						total: listing.total,
					};
				},
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (
		toolId === "fabric_list_project_features" ||
		toolId === "fabric_get_project_feature"
	) {
		return {
			[toolId]: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					const { getProjectFeature, listProjectFeatures } =
						await import("../shared/project-feature-reads");
					const read =
						toolId === "fabric_list_project_features"
							? listProjectFeatures
							: getProjectFeature;
					return read(args, { projectId, userId });
				},
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (
		toolId === "fabric_list_project_documents" ||
		toolId === "fabric_get_project_document" ||
		toolId === "fabric_list_project_sources" ||
		toolId === "fabric_get_project_source"
	) {
		return {
			[toolId]: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					const reads = await import(
						"../shared/project-document-reads"
					);
					const read = {
						fabric_list_project_documents:
							reads.listProjectDocuments,
						fabric_get_project_document: reads.getProjectDocument,
						fabric_list_project_sources: reads.listProjectSources,
						fabric_get_project_source: reads.getProjectSource,
					}[toolId as (typeof PROJECT_DOCUMENT_TOOL_IDS)[number]];
					return read(args, { projectId, userId });
				},
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	// The organization's company context, for an Advisor turn that opted in
	// (Fizzy #2719). Refused before anything loads without the opt-in, so an
	// explicit tool list naming it builds nothing. Every call re-checks
	// membership and the feature gate, and takes the organization from the
	// project when the chat has one.
	if (toolId === COMPANY_CONTEXT_SEARCH_TOOL_NAME) {
		if (context.companyContextAdvisor !== true) {
			return {};
		}
		const { createCompanyContextTools } = await import(
			"./company-context-tool"
		);
		return createCompanyContextTools({
			usageConversationId: context.usageConversationId,
			companyContextAdvisor: context.companyContextAdvisor,
			userId,
			organizationId,
			projectId,
		});
	}

	if (toolId === "search_slack_messages") {
		return {
			search_slack_messages: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					if (!projectId) {
						return {
							error: "No project is attached to this chat.",
						};
					}

					const { searchProjectSlackMessages } = await import(
						"../search-project-slack-messages"
					);
					const limit =
						typeof args.limit === "number" ? args.limit : 15;
					return searchProjectSlackMessages({
						projectId,
						query: (args.query as string) || "",
						userId,
						organizationId,
						limit: Math.min(Math.max(1, limit), 50),
					});
				},
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "search_teams_messages") {
		return {
			search_teams_messages: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					if (!projectId) {
						return {
							error: "No project is attached to this chat.",
						};
					}

					const { searchProjectTeamsMessages } = await import(
						"../search-project-teams-messages"
					);
					const limit =
						typeof args.limit === "number" ? args.limit : 15;
					return searchProjectTeamsMessages({
						projectId,
						query: (args.query as string) || "",
						userId,
						organizationId,
						limit: Math.min(Math.max(1, limit), 50),
					});
				},
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "fabric_create_story") {
		// Org slug is invariant for the lifetime of this tool instance — cache
		// the lookup so repeat calls in one chat turn don't re-hit Postgres.
		let slugPromise: Promise<string | null> | undefined;
		const getOrgSlug = (): Promise<string | null> => {
			if (!organizationId) {
				return Promise.resolve(null);
			}
			slugPromise ??= db.organization
				.findUnique({
					where: { id: organizationId },
					select: { slug: true },
				})
				.then((o) => o?.slug ?? null);
			return slugPromise;
		};
		return {
			fabric_create_story: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					if (!projectId) {
						return {
							error: "No project is bound to this agent. Enable the Project Context tool and pick a project first.",
						};
					}

					// Use the STORY_CREATE-aware permission check, not just
					// hasProjectAccess (which grants Viewers/Commenters too).
					// The API procedure gates with requireProjectPermission(
					// STORY_CREATE); this path must match.
					const canCreate = await canCreateProjectStory(
						projectId,
						userId,
					);
					if (!canCreate) {
						return {
							error: "Agent owner lacks permission to create stories in this project.",
						};
					}

					// F-171: `kind` is now a soft hint, not a directive. The
					// classifier in createStoryFromProposal decides the canonical
					// kind from `request` and overrides this when warranted.
					// Agents that have no opinion can simply omit it.
					const kindHint: "FEATURE" | "BUG" | undefined =
						args.kind === "BUG"
							? "BUG"
							: args.kind === "FEATURE"
								? "FEATURE"
								: undefined;
					const title =
						typeof args.title === "string" ? args.title.trim() : "";
					const request =
						typeof args.request === "string"
							? args.request.trim()
							: "";
					if (!request) {
						return {
							error: "`request` is required to create a story.",
						};
					}

					const priority =
						typeof args.priority === "string"
							? (args.priority as
									| "P0_CRITICAL"
									| "P1_HIGH"
									| "P2_MEDIUM"
									| "P3_LOW")
							: "P2_MEDIUM";
					const size =
						typeof args.size === "string"
							? (args.size as "XS" | "S" | "M" | "L" | "XL")
							: undefined;

					// F-171 reporter tracking: agents (Slack, Teams, etc.) pass
					// these when they have upstream context. Manual-UI callers
					// don't go through this tool; the create-story procedure
					// populates MANUAL there.
					const reporterSource =
						args.reporterSource === "SLACK" ||
						args.reporterSource === "TEAMS" ||
						args.reporterSource === "MANUAL"
							? (args.reporterSource as
									| "SLACK"
									| "TEAMS"
									| "MANUAL")
							: undefined;
					const reporterSourceUrl =
						typeof args.reporterSourceUrl === "string" &&
						args.reporterSourceUrl.trim().length > 0
							? args.reporterSourceUrl.trim()
							: undefined;
					const reporterName =
						typeof args.reporterName === "string" &&
						args.reporterName.trim().length > 0
							? args.reporterName.trim()
							: undefined;

					const { createStoryFromProposal } = await import(
						"../../lib/create-story-from-proposal"
					);
					const { triggerDuplicateDetection } = await import(
						"../../lib/trigger-duplicate-detection"
					);
					const { enqueuePmSyncFromActivity } = await import(
						"../../lib/enqueue-pm-sync-from-activity"
					);
					const { getTemporalClient } = await import("../../client");
					const {
						generateStoryTitleFromDescription,
						mapCreationSource,
						mapStoryTitleSourceToEnum,
					} = await import("@repo/ai/lib/story-title-generator");

					// If the agent omitted `title`, generate one server-side from
					// `request`. Mirrors the createStoryProcedure path so all
					// create surfaces share one helper + telemetry contract.
					let resolvedTitle = title;
					let aiGeneratedTitle = false;
					let resolvedTitleSource:
						| "ai"
						| "description-fallback"
						| "untitled-fallback"
						| null = null;

					if (!title) {
						// Title generator needs a kind hint to bias copy; use
						// the agent's hint when present, otherwise FEATURE.
						// The classifier later determines the canonical kind
						// for storage — title style is a minor cosmetic.
						//
						// Pass `request` as both the
						// description AND `originContext` for the title prompt
						// so the model can clarify ambiguous descriptions
						// (matches the tool description string). The
						// `creationSource` falls back to "API" when the agent
						// didn't supply a reporter source. JSON parse +
						// fallback chain live inside the helper — no executor
						// changes there.
						const generated =
							await generateStoryTitleFromDescription(
								request,
								kindHint ?? "FEATURE",
								{
									userId,
									organizationId: organizationId ?? undefined,
									projectId,
									originContext: request,
									creationSource: mapCreationSource(
										reporterSource,
										"API",
									),
								},
							);
						resolvedTitle = generated.title;
						aiGeneratedTitle = generated.source === "ai";
						resolvedTitleSource = generated.source;
					}

					// Title-collision dedup. Agents (Slack, Teams, in-app chat
					// tools) routinely call this tool multiple times across
					// turns or with paraphrased intent; without a guard each
					// call would happily materialize a duplicate-by-title row
					// (identifiers stay unique thanks to the atomic counter,
					// but content-equivalent rows still pile up). When a
					// match is found we return the existing identifier to the
					// agent instead of creating a duplicate — the LLM can
					// then tell the user "that's already on the roadmap as
					// F-12; want me to update it?". Mirrors the AI Update
					// sidebar guard + the Teams/Slack approve-pending-
					// proposal dedup.
					const { buildBacklogDedupGuard, inferDedupFamily } =
						await import("@repo/database");
					const dedupGuard = await buildBacklogDedupGuard(projectId);
					const dedupFamily = inferDedupFamily({
						kindOverride: kindHint ?? null,
						type: kindHint === "BUG" ? "bug" : "feature",
					});
					const collision = dedupGuard.findCollision(
						dedupFamily,
						resolvedTitle,
					);
					if (collision) {
						logger.info(
							"[fabric_create_story] Skipping duplicate CREATE — title matches existing item",
							{
								projectId,
								family: dedupFamily,
								title: resolvedTitle,
								existingIdentifier:
									collision.existingIdentifier,
								existingId: collision.existingId,
							},
						);
						return {
							skipped: true,
							existingIdentifier: collision.existingIdentifier,
							existingId: collision.existingId,
							message: `A ${
								dedupFamily === "BUG" ? "bug" : "feature"
							} titled "${resolvedTitle}" already exists in this project as ${
								collision.existingIdentifier
							}. Returned the existing item instead of creating a duplicate; update that row if changes are needed.`,
						};
					}

					try {
						// Look up the project's PM config once up-front so we can
						// (a) stamp `pmAutoSyncEnabled=true` at row creation
						// rather than via a follow-up write, and (b) decide
						// whether to enqueue an initial PM push after success.
						// Both gates are silent: a project with no PM tool wired
						// up behaves exactly as before (Fabric-only create).
						const projectForPmGate = await db.project.findUnique({
							where: { id: projectId },
							select: {
								projectManagementMcpConfigId: true,
								projectManagementContainerId: true,
							},
						});
						const pmConfigured =
							!!projectForPmGate?.projectManagementMcpConfigId &&
							!!projectForPmGate?.projectManagementContainerId;

						// Kick off slug fetch in parallel with story creation —
						// the slug doesn't depend on the new story's id.
						const slugP = getOrgSlug();
						// A run that answers a person while it works (a voice
						// meeting) cannot wait about a minute for the drafting
						// model. It creates the item from the person's own words,
						// takes the kind the agent named instead of classifying
						// it, and has the body drafted afterwards.
						const deferDrafting = agentToolDefersStoryDrafting();
						const result = await createStoryFromProposal({
							projectId,
							createdById: userId,
							organizationId,
							title: resolvedTitle,
							// Pass the user's request as the raw description too,
							// so the no-prompt / AI-failure fallback in
							// createStoryFromProposal still retains content
							// instead of persisting only the short title.
							description: request,
							kind: kindHint,
							priority,
							size,
							source: "CUSTOM_AGENT",
							draftingStage: "PLACEHOLDER",
							reporterSource,
							reporterSourceUrl,
							reporterName,
							// When the project has a PM tool wired up, stamp the
							// per-row gate so later Fabric edits also push to
							// PM (see `[[project_pm_sync_gate]]`). Without
							// this, every agent-created story would be
							// Fabric-only forever.
							enablePmAutoSync: pmConfigured ? true : undefined,
							...(deferDrafting && {
								skipClassifier: true,
								skipDrafting: true,
								bodyAlreadyDrafted: true,
							}),
						});
						const slug = await slugP;

						// Best-effort telemetry persistence — story creation must
						// not fail on a metadata-write hiccup. Each write from
						// here on first checks that the chat turn this runs in
						// has not stopped or used its token allowance (outside
						// the try, so the catch never absorbs the stop).
						throwIfDispatchStopped();
						try {
							await db.userStory.update({
								where: { id: result.story.id },
								data: {
									aiGeneratedTitle,
									titleSource: resolvedTitleSource
										? mapStoryTitleSourceToEnum(
												resolvedTitleSource,
											)
										: null,
								},
							});
						} catch (telemetryError) {
							logger.warn(
								"[fabric_create_story] failed to persist AI-title telemetry",
								{ error: telemetryError },
							);
						}

						// Dispatch the same story.created lifecycle event the
						// API procedure sends — otherwise lifecycle-triggered
						// agents/automations fire for manual Add Feature but
						// silently miss tool-created stories. The helper reads
						// the triggers first and checks the turn again
						// immediately before each workflow start.
						throwIfDispatchStopped();
						dispatchLifecycleEvent({
							resource: "story",
							event: "created",
							projectId,
							entityId: result.story.id,
							userId,
							organizationId: organizationId ?? null,
							data: {
								storyId: result.story.id,
								title: result.story.title,
								statusId: result.story.statusId,
								aiDrafted: result.aiDrafted,
								aiGeneratedTitle,
								titleSource: resolvedTitleSource,
							},
						}).catch((error) => {
							logger.warn(
								"[LifecycleDispatcher] Story created dispatch failed",
								{ error, storyId: result.story.id },
							);
						});

						// Initial PM push. Only runs when the project has a PM
						// tool wired up; the helper itself short-circuits with
						// a typed reason if the calling user lacks resolvable
						// MCP credentials, so this is safe to call
						// unconditionally inside the gate. Fire-and-forget:
						// a failed start whose workflow Temporal has no record
						// of stamps `lastPmSyncStatus = FAILED` on the row
						// (surfaced via the roadmap badge); one whose outcome
						// Temporal could not confirm stays PENDING for the
						// stuck-sync watchdog.
						if (pmConfigured) {
							const itemTypeForEnqueue =
								result.story.kind === "BUG" ? "bug" : "story";
							// Refuses the whole push up front; the helper reads
							// the project and the user's credentials first, and
							// checks the turn again immediately before the
							// PENDING stamp; once stamped, the workflow start
							// goes out with it.
							throwIfDispatchStopped();
							try {
								const temporalClient =
									await getTemporalClient();
								const enqueueResult =
									await enqueuePmSyncFromActivity({
										itemId: result.story.id,
										itemType: itemTypeForEnqueue,
										projectId,
										userId,
										organizationId: organizationId ?? null,
										temporalClient,
										triggerSource: "agent-create",
									});
								logger.info(
									"[fabric_create_story] enqueued PM sync for agent-created story",
									{
										storyId: result.story.id,
										enqueued: enqueueResult.enqueued,
										reason: enqueueResult.reason,
										workflowId: enqueueResult.workflowId,
									},
								);
							} catch (enqueueErr) {
								// A turn stop is not a failed push to log past:
								// the duplicate detection below must not start.
								rethrowIfDispatchStopped(enqueueErr);
								logger.warn(
									"[fabric_create_story] enqueuePmSyncFromActivity threw — story persisted without sync attempt",
									{
										storyId: result.story.id,
										errorName:
											enqueueErr instanceof Error
												? enqueueErr.name
												: "Unknown",
										message:
											enqueueErr instanceof Error
												? enqueueErr.message
												: String(enqueueErr),
									},
								);
							}
						}

						// Automatic semantic duplicate detection over the newly
						// created story — catches different-title near-duplicates
						// the exact-title guard above cannot. Enqueued as a
						// fire-and-forget, retried Temporal workflow (NOT awaited
						// inline) so it never blocks the tool result and a transient
						// embedding/LLM blip is retried with backoff. Confirmed
						// pairs become PENDING StoryDuplicateLinks → the same roadmap
						// "Possible duplicate" chip + Merge/Dismiss dialog.
						// The helper checks the turn again immediately before
						// the workflow start, after its availability probe.
						if (deferDrafting) {
							const { triggerStoryBodyDraft } = await import(
								"../../lib/trigger-story-body-draft"
							);
							throwIfDispatchStopped();
							await triggerStoryBodyDraft({
								storyId: result.story.id,
								projectId,
								userId,
								organizationId,
								targetKind:
									result.story.kind === "BUG"
										? "BUG"
										: "FEATURE",
							});
						}
						throwIfDispatchStopped();
						await triggerDuplicateDetection({
							projectId,
							userId,
							organizationId,
							targetStoryIds: [result.story.id],
						});

						return {
							storyId: result.story.id,
							identifier: result.story.identifier,
							title: result.story.title,
							// Canonical kind from the classifier (may differ
							// from kindHint if the classifier overrode it).
							kind: result.story.kind,
							url: buildStoryUrl({
								projectId,
								storyId: result.story.id,
								slug,
							}),
							aiDrafted: result.aiDrafted,
							...(deferDrafting && {
								draftingInBackground: true,
							}),
						};
					} catch (error) {
						rethrowIfDispatchStopped(error);
						logger.error("fabric_create_story failed", error);
						return {
							error:
								aiConfigurationRefusalMessage(error) ??
								(error instanceof Error
									? error.message
									: "Failed to create story."),
						};
					}
				},
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "fabric_create_frame") {
		return {
			fabric_create_frame: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) =>
					createFirstClassFrame({
						args,
						userId,
						organizationId,
					}),
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "fabric_create_slideshow") {
		return {
			fabric_create_slideshow: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) =>
					createFirstClassFrame({
						args: { ...args, kind: "slideshow" },
						userId,
						organizationId,
					}),
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "fabric_update_frame") {
		return {
			fabric_update_frame: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) =>
					updateFirstClassFrame({ args, userId, organizationId }),
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "fabric_get_frame") {
		return {
			fabric_get_frame: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) =>
					getFirstClassFrame({ args, userId, organizationId }),
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "fabric_list_frames") {
		return {
			fabric_list_frames: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async () =>
					listFirstClassFrames({ userId, organizationId }),
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "fabric_share_frame") {
		return {
			fabric_share_frame: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) =>
					shareFirstClassFrame({ args, userId, organizationId }),
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "fabric_generate_image") {
		return {
			fabric_generate_image: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					const { generateImageActivity } = await import(
						"../image-generation"
					);
					const prompt = (args.prompt as string) || "";
					if (!prompt) {
						return {
							error: "Prompt is required for image generation",
						};
					}

					const imageResult = await generateImageActivity({
						usageConversationId: context.usageConversationId,
						...(context.usageOrigin
							? { usageOrigin: context.usageOrigin }
							: {}),
						prompt,
						provider:
							(args.provider as "gateway" | "fal" | "gemini") ||
							"gateway",
						aspectRatio: (args.aspectRatio as string) || "1:1",
						quality: (args.quality as string) || "medium",
						model: args.model as string | undefined,
						inputImagePath: args.inputImage as string | undefined,
						gatewayModel: args.gatewayModel as string | undefined,
						userId,
						organizationId,
					});

					if (!imageResult.success) {
						return {
							error:
								imageResult.error || "Image generation failed",
						};
					}

					const orgParam = organizationId
						? `&orgId=${encodeURIComponent(organizationId)}`
						: "";
					const imageDisplayUrl = imageResult.storagePath
						? `/api/storage/image?path=${encodeURIComponent(imageResult.storagePath)}${orgParam}`
						: imageResult.imageUrl;

					return {
						imageUrl: imageDisplayUrl,
						storagePath: imageResult.storagePath,
						mimeType: "image/png",
						name: "generated-image.png",
						text: imageResult.text,
						width: imageResult.width,
						height: imageResult.height,
						provider: imageResult.provider,
						model: imageResult.model,
					};
				},
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	if (toolId === "fabric_text_to_speech") {
		return {
			fabric_text_to_speech: tool({
				description: toolDefinition.description || toolId,
				inputSchema: jsonSchemaToZod(toolDefinition.inputSchema),
				execute: async (args: Record<string, unknown>) => {
					const text = (args.text as string) || "";
					const voice = (args.voice as string) || "alloy";
					const speed = (args.speed as number) || 1.0;

					if (!text) {
						return {
							error: "Text is required for speech generation",
						};
					}

					const speech = await synthesizeToolSpeech({
						usageConversationId: context.usageConversationId,
						...(context.usageOrigin
							? { usageOrigin: context.usageOrigin }
							: {}),
						userId,
						organizationId,
						text,
						voice,
						speed,
					});
					if (!speech.ok) {
						return { error: speech.error };
					}

					const audioBuffer = speech.audio;
					const audioKey = `tts/${userId}/${Date.now()}.mp3`;
					throwIfDispatchStopped();
					await uploadFile(audioKey, audioBuffer, {
						bucket:
							process.env
								.NEXT_PUBLIC_CHAT_DOCUMENTS_BUCKET_NAME ||
							"chat-documents",
						contentType: "audio/mpeg",
					});

					const orgParam = organizationId
						? `&orgId=${encodeURIComponent(organizationId)}`
						: "";
					return {
						audioUrl: `/api/storage/image?path=${encodeURIComponent(audioKey)}${orgParam}`,
						format: "mp3",
						response: "Audio generated successfully.",
					};
				},
			} as unknown as Parameters<typeof tool>[0]),
		};
	}

	return {};
}

export async function createBuiltInTools(
	options: CreateBuiltInToolsOptions,
): Promise<Record<string, unknown>> {
	const {
		userId,
		organizationId,
		enabledFabricToolIds,
		additionalFabricToolIds = [],
		workspaceIds,
		projectId,
		includeProjectFeatureReads = false,
		preferredRepositoryUrl,
	} = options;

	if (Array.isArray(enabledFabricToolIds)) {
		if (enabledFabricToolIds.length === 0) {
			return {};
		}

		const tools: Record<string, unknown> = {};
		// In the interactive chat the attached project's live roadmap reads
		// ride along with any explicit tool list: the full-page chat sends its
		// Fabric tool toggles, which never name project tools, and without
		// these the model can only answer a roadmap question from the prompt's
		// top-15 snapshot (Fizzy #2309/#2310). The document and source reads
		// ride along for the same reason: a documents question otherwise
		// gets a semantic-search sample (Fizzy #2578). Read-only and gated on the
		// user's project access, so a chosen tool set gains no write path.
		const toolIds = [
			...new Set([
				...enabledFabricToolIds,
				...additionalFabricToolIds,
				...(projectId && includeProjectFeatureReads
					? [
							...PROJECT_FEATURE_TOOL_IDS,
							...PROJECT_DOCUMENT_TOOL_IDS,
						]
					: []),
			]),
		];
		for (const toolId of toolIds) {
			Object.assign(
				tools,
				await createFabricTool(toolId, {
					usageConversationId: options.usageConversationId,
					...(options.usageOrigin
						? { usageOrigin: options.usageOrigin }
						: {}),
					userId,
					organizationId,
					workspaceIds,
					projectId,
				}),
			);
		}
		// The repository reads ride along too. The source list tells the model
		// to use code_search for code, so without it a codebase question loops
		// on fabric_list_project_sources until the step limit (Fizzy #2869).
		// Bound with the same inputs as on the default bundle.
		if (projectId && includeProjectFeatureReads) {
			Object.assign(
				tools,
				await createCodeSearchTool({
					usageConversationId: options.usageConversationId,
					...(options.usageOrigin
						? { usageOrigin: options.usageOrigin }
						: {}),
					userId,
					organizationId,
					workspaceIds,
					projectId,
					preferredRepositoryUrl,
				}),
				await createSymbolSearchTool({
					userId,
					organizationId,
					workspaceIds,
					projectId,
				}),
			);
		}
		return tools;
	}

	const tools = await createWebSearchTool(
		"webSearch",
		userId,
		organizationId,
	);
	if (projectId) {
		Object.assign(
			tools,
			await createFabricTool("project_rag_query", {
				usageConversationId: options.usageConversationId,
				...(options.usageOrigin
					? { usageOrigin: options.usageOrigin }
					: {}),
				userId,
				organizationId,
				workspaceIds,
				projectId,
			}),
			// Paired with project_rag_query deliberately: RAG cannot answer a
			// date question, so wherever it is offered this must be too, or the
			// model has no correct way to answer one (Fizzy #2473).
			await createFabricTool("fabric_list_meeting_transcripts", {
				userId,
				organizationId,
				workspaceIds,
				projectId,
			}),
			await createFabricTool("fabric_list_project_features", {
				userId,
				organizationId,
				workspaceIds,
				projectId,
			}),
			await createFabricTool("fabric_get_project_feature", {
				userId,
				organizationId,
				workspaceIds,
				projectId,
			}),
			await createFabricTool("fabric_list_project_documents", {
				userId,
				organizationId,
				workspaceIds,
				projectId,
			}),
			await createFabricTool("fabric_get_project_document", {
				userId,
				organizationId,
				workspaceIds,
				projectId,
			}),
			await createFabricTool("fabric_list_project_sources", {
				userId,
				organizationId,
				workspaceIds,
				projectId,
			}),
			await createFabricTool("fabric_get_project_source", {
				userId,
				organizationId,
				workspaceIds,
				projectId,
			}),
			await createFabricTool("search_slack_messages", {
				userId,
				organizationId,
				workspaceIds,
				projectId,
			}),
			await createFabricTool("search_teams_messages", {
				userId,
				organizationId,
				workspaceIds,
				projectId,
			}),
			await createCodeSearchTool({
				usageConversationId: options.usageConversationId,
				...(options.usageOrigin
					? { usageOrigin: options.usageOrigin }
					: {}),
				userId,
				organizationId,
				workspaceIds,
				projectId,
				preferredRepositoryUrl,
			}),
			await createSymbolSearchTool({
				userId,
				organizationId,
				workspaceIds,
				projectId,
			}),
		);
	}
	for (const toolId of additionalFabricToolIds) {
		Object.assign(
			tools,
			await createFabricTool(toolId, {
				usageConversationId: options.usageConversationId,
				...(options.usageOrigin
					? { usageOrigin: options.usageOrigin }
					: {}),
				userId,
				organizationId,
				workspaceIds,
				projectId,
			}),
		);
	}

	return tools;
}
