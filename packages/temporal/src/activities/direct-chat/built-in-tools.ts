/**
 * Built-in Tools for Direct Chat
 *
 * Generic direct chats get a lightweight `webSearch` helper when configured.
 * Agent-bound chats can opt into explicit Fabric tool IDs for deterministic behavior.
 */

import { resolveOpenAiApiKey, tool } from "@repo/ai";
import {
	canCreateProjectStory,
	db,
	getMergedSearchProviderConfigs,
	getSearchProviderConfig,
	incrementOrganizationSearchProviderUsage,
	incrementUserSearchProviderUsage,
} from "@repo/database";
import { createProvider, type WebSearchResult } from "@repo/search";
import { uploadFile } from "@repo/storage";
import { decryptApiKey, getBaseUrl } from "@repo/utils";
import { z } from "zod";
import { dispatchLifecycleEvent } from "../../lib/lifecycle-dispatcher";
import { getAllFabricAiTools } from "../orchestrator/tools/fabric-ai-tools";
import { jsonSchemaToZod } from "../orchestrator/utils";
import { getFabricToolDefinitionMap } from "../shared/fabric-content-tools";
import {
	createFirstClassFrame,
	getFirstClassFrame,
	listFirstClassFrames,
	shareFirstClassFrame,
	updateFirstClassFrame,
} from "../shared/frame-service";
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

interface BuiltInToolContext {
	userId: string;
	organizationId?: string;
	workspaceIds?: string[];
	projectId?: string;
}

interface CreateBuiltInToolsOptions extends BuiltInToolContext {
	enabledFabricToolIds?: string[];
}

async function getSearchProvider(
	userId: string,
	organizationId?: string,
): Promise<{ apiKey: string; providerName: string } | null> {
	const configs = await getMergedSearchProviderConfigs({
		userId,
		organizationId,
	});

	const defaultProvider = configs.find(
		(c) => c.isDefault && c.enabled && c.encryptedApiKey,
	);
	if (defaultProvider) {
		try {
			const encryptedApiKey = defaultProvider.encryptedApiKey;
			if (!encryptedApiKey) {
				return null;
			}
			return {
				apiKey: decryptApiKey(encryptedApiKey),
				providerName: defaultProvider.providerName,
			};
		} catch (error) {
			logger.error("Failed to decrypt default search provider API key", {
				error,
				providerName: defaultProvider.providerName,
			});
		}
	}

	for (const config of configs) {
		if (config.enabled && config.encryptedApiKey) {
			try {
				return {
					apiKey: decryptApiKey(config.encryptedApiKey),
					providerName: config.providerName,
				};
			} catch (error) {
				logger.error("Failed to decrypt search provider API key", {
					error,
					providerName: config.providerName,
				});
			}
		}
	}

	const fallbackPriority = ["exa", "parallel", "tavily", "firecrawl"];
	const configuredNames = new Set(configs.map((c) => c.providerName));

	for (const providerName of fallbackPriority) {
		if (configuredNames.has(providerName)) {
			continue;
		}

		const config = await getSearchProviderConfig({
			userId,
			organizationId: organizationId || undefined,
			providerName,
		});

		if (config?.encryptedApiKey && config.enabled) {
			try {
				return {
					apiKey: decryptApiKey(config.encryptedApiKey),
					providerName,
				};
			} catch (error) {
				logger.error(
					"Failed to decrypt fallback search provider API key",
					{
						error,
						providerName,
					},
				);
			}
		}
	}

	return null;
}

async function createWebSearchTool(
	toolName: "webSearch" | "fabric_web_search",
	userId: string,
	organizationId?: string,
): Promise<Record<string, unknown>> {
	const providerConfig = await getSearchProvider(userId, organizationId);
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
			description:
				toolName === "webSearch"
					? "Search the web for current information."
					: fabricToolDefinitions.get(toolName)?.description ||
						"Search the web for current information.",
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

					// Fire-and-forget: increment usage count without blocking the result
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

async function createCodeSearchTool(
	context: BuiltInToolContext,
): Promise<Record<string, unknown>> {
	const { projectId, userId, organizationId } = context;
	if (!projectId) {
		return {};
	}

	return {
		code_search: tool({
			description:
				"Search the project's indexed repository code. Returns file paths, symbols, snippets, citation metadata, and codebase role tags (e.g. Legacy, Primary) when a code index is available. When multiple codebases are attached, attribute findings to their respective codebase and highlight any differences.",
			inputSchema: z.object({
				query: z.string().describe("The code search query"),
				language: z
					.string()
					.optional()
					.describe("Optional language filter"),
				maxResults: z.number().min(1).max(10).default(5),
			}),
			execute: async (args: {
				query: string;
				language?: string;
				maxResults?: number;
			}) => {
				const { getProjectCodeIndexes } = await import(
					"@repo/database"
				);
				const codeIndexes = await getProjectCodeIndexes(projectId);
				const readyIndex = codeIndexes.find(
					(index) => index.status === "READY",
				);
				if (!readyIndex) {
					return {
						success: false,
						message:
							"Code index is not ready for this project yet.",
						status: codeIndexes[0]?.status ?? "missing",
					};
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
				const embeddingResult = await generateEmbedding(query, {
					userId,
					organizationId,
				});
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

				if (points.length === 0) {
					return { success: true, results: [] };
				}

				const { getProjectRoleTagMaps, resolveRoleTag } = await import(
					"@repo/rag"
				);
				const roleTagMaps = await getProjectRoleTagMaps(projectId);

				return {
					success: true,
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
	if (!projectId) {
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

async function createFabricTool(
	toolId: string,
	context: BuiltInToolContext,
): Promise<Record<string, unknown>> {
	const { userId, organizationId, workspaceIds } = context;
	const projectId = context.projectId;
	const toolDefinition = fabricToolDefinitions.get(toolId);
	if (!toolDefinition?.inputSchema) {
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
					);

					return {
						response: result.context.replace(/^[\s\n]*/, "").trim(),
						contextCount: result.chunkCount,
					};
				},
			} as unknown as Parameters<typeof tool>[0]),
		};
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
						});
						const slug = await slugP;

						// Best-effort telemetry persistence — story creation must
						// not fail on a metadata-write hiccup.
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
						// silently miss tool-created stories.
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
						// failure stamps `lastPmSyncStatus = FAILED` on the
						// row and surfaces via the existing roadmap badge.
						if (pmConfigured) {
							const itemTypeForEnqueue =
								result.story.kind === "BUG" ? "bug" : "story";
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
						};
					} catch (error) {
						logger.error("fabric_create_story failed", error);
						return {
							error:
								error instanceof Error
									? error.message
									: "Failed to create story.",
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

					// This path calls OpenAI's TTS endpoint directly, so it needs the
					// tenant's OpenAI key specifically, decrypted — not whichever
					// provider the tenant's default model selection resolved to.
					const openAiApiKey = await resolveOpenAiApiKey({
						userId,
						organizationId,
					});

					if (!openAiApiKey) {
						return {
							error: "No OpenAI API key configured for text-to-speech",
						};
					}

					const response = await fetch(
						"https://api.openai.com/v1/audio/speech",
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${openAiApiKey}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								model: "tts-1",
								input: text.substring(0, 4096),
								voice,
								speed: Math.min(4.0, Math.max(0.25, speed)),
								response_format: "mp3",
							}),
						},
					);

					if (!response.ok) {
						return {
							error: `TTS API error ${response.status}: ${await response.text()}`,
						};
					}

					const audioBuffer = Buffer.from(
						await response.arrayBuffer(),
					);
					const audioKey = `tts/${userId}/${Date.now()}.mp3`;
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
		workspaceIds,
		projectId,
	} = options;

	if (Array.isArray(enabledFabricToolIds)) {
		if (enabledFabricToolIds.length === 0) {
			return {};
		}

		const tools: Record<string, unknown> = {};
		for (const toolId of enabledFabricToolIds) {
			Object.assign(
				tools,
				await createFabricTool(toolId, {
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
				userId,
				organizationId,
				workspaceIds,
				projectId,
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
