/**
 * Integration Search
 *
 * Search for available workflow integrations (Slack, GitHub, Linear, etc.)
 * that can be used by the orchestrator as alternatives to MCP servers.
 *
 * IMPROVED (Anthropic Tool Search Pattern):
 * - Uses KEYWORDS in provider metadata for BM25-style deterministic matching
 * - Supports always-available integrations for common services
 * - Hybrid scoring combines keyword + semantic relevance
 */

import type { WorkflowIntegrationProvider } from "@repo/database";
import { db } from "@repo/database";
import {
	integrationExecutorRegistry,
	isRegisteredIntegrationProvider,
	listChatEnabledIntegrationProviders,
	listChatEnabledOperations,
	listRegisteredIntegrationProviders,
} from "@repo/integrations/executor-registry";
import {
	generateEmbedding,
	generateEmbeddings,
} from "@repo/rag/lib/embedding/generator";
import type { TenantContext } from "@repo/rag/lib/embedding/types";
import { cosineSimilarity } from "./capability-embeddings";
import { calculateKeywordMatchScore } from "./capability-keywords";
import type {
	IntegrationProviderMetadata,
	SearchAvailableIntegrationsInput,
	SearchAvailableIntegrationsOutput,
} from "./types";
import { extractQueryWords } from "./utils";

// =============================================================================
// Integration Provider Metadata
// =============================================================================

/**
 * Providers whose execution still lives in IntegrationHandler's legacy switch.
 * Providers with a shared executor are NOT listed here — their metadata is
 * derived from `@repo/integrations/executor-registry` so discovery and
 * execution cannot drift apart.
 */
const LEGACY_PROVIDER_METADATA: Record<string, IntegrationProviderMetadata> = {
	SLACK: {
		description:
			"Send and read messages in Slack channels, search history, browse threads and shared files, and interact with Slack workspaces",
		capabilities: [
			"messaging",
			"notifications",
			"team_communication",
			"channel_posts",
			"channel_history",
			"message_reading",
			"message_search",
			"thread_replies",
			"file_sharing",
		],
		operations: [
			{
				name: "send_message",
				description: "Send a message to a Slack channel",
			},
			{
				name: "post_notification",
				description: "Post a notification or alert",
			},
			{ name: "send_dm", description: "Send a direct message to a user" },
			{
				name: "list_channels",
				description: "List Slack channels linked to a project",
			},
			{
				name: "get_channel_history",
				description: "Read messages and history from a Slack channel",
			},
			{
				name: "read_messages",
				description: "Read and retrieve messages from a Slack channel",
			},
			{
				name: "search_messages",
				description:
					"Search for messages across linked Slack channels by keyword (supports from:, in:, before:, after:, has:link, has:file modifiers)",
			},
			{
				name: "list_thread_replies",
				description:
					"List replies in a Slack message thread, given a channelId and parent message thread_ts",
			},
			{
				name: "get_shared_files",
				description:
					"List files shared in a Slack channel (images, PDFs, attachments)",
			},
		],
		keywords: [
			"send slack message",
			"post to slack",
			"slack notification",
			"message channel",
			"notify team",
			"slack",
			// Search/history-related patterns
			"search slack",
			"slack history",
			"slack channel history",
			"latest slack message",
			"recent slack message",
			"read slack message",
			"find slack messages",
			"slack discussions",
			// Thread-related patterns
			"slack thread",
			"slack replies",
			"thread replies",
			// File-related patterns
			"slack files",
			"slack attachments",
			"files in slack",
			"shared in slack",
			// Common user queries
			"what's in slack",
			"slack update",
			"check slack",
			"show me slack",
		],
	},
	GITHUB: {
		description:
			"Create issues, pull requests, manage repositories, and interact with GitHub",
		capabilities: [
			"issue_tracking",
			"code_management",
			"pull_requests",
			"repository_management",
		],
		operations: [
			{ name: "create_issue", description: "Create a new GitHub issue" },
			{ name: "create_pr", description: "Create a pull request" },
			{ name: "list_issues", description: "List repository issues" },
			{ name: "get_repo", description: "Get repository information" },
		],
		keywords: [
			"create github issue",
			"github pull request",
			"github pr",
			"github issue",
			"github",
		],
	},
	LINEAR: {
		description: "Create issues, manage projects, and track work in Linear",
		capabilities: [
			"issue_tracking",
			"project_management",
			"sprint_planning",
			"task_management",
		],
		operations: [
			{ name: "create_issue", description: "Create a new Linear issue" },
			{ name: "list_issues", description: "List project issues" },
			{ name: "update_issue", description: "Update an issue" },
		],
		keywords: [
			"create linear issue",
			"linear ticket",
			"linear task",
			"linear",
		],
	},
	RESEND: {
		description: "Send transactional emails using Resend email API",
		capabilities: ["email", "transactional_email", "notifications"],
		operations: [{ name: "send_email", description: "Send an email" }],
		keywords: ["send email", "email notification", "email"],
	},
	PERPLEXITY: {
		description:
			"Search the web and get AI-powered answers using Perplexity",
		capabilities: ["web_search", "research", "question_answering"],
		operations: [
			{ name: "search", description: "Search the web with AI" },
			{
				name: "ask",
				description: "Ask a question and get AI-powered answer",
			},
		],
	},
	FIRECRAWL: {
		description: "Crawl and scrape web pages, extract content from URLs",
		capabilities: ["web_scraping", "content_extraction", "url_crawling"],
		operations: [
			{ name: "scrape_url", description: "Scrape content from a URL" },
			{ name: "crawl_site", description: "Crawl a website" },
		],
	},
	FAL: {
		description:
			"Generate images, run AI models, and process media using Fal.ai",
		capabilities: ["image_generation", "ai_models", "media_processing"],
		operations: [
			{
				name: "generate_image",
				description: "Generate an image using AI",
			},
			{ name: "run_model", description: "Run an AI model" },
		],
	},
	CUSTOM_WEBHOOK: {
		description: "Call custom webhooks and external APIs",
		capabilities: ["api_calls", "webhooks", "external_services"],
		operations: [
			{
				name: "call_webhook",
				description: "Call a custom webhook endpoint",
			},
		],
	},
	DATABASE: {
		description: "Query and interact with databases",
		capabilities: ["data_storage", "queries", "data_retrieval"],
		operations: [
			{ name: "query", description: "Execute a database query" },
		],
	},
	MCP: {
		description: "Connect to MCP servers for extended tool capabilities",
		capabilities: ["mcp_tools", "extended_capabilities"],
		operations: [{ name: "call_tool", description: "Call an MCP tool" }],
	},
	AI_GATEWAY: {
		description: "Access AI models through the Vercel AI Gateway",
		capabilities: ["ai_models", "text_generation", "chat"],
		operations: [
			{ name: "generate", description: "Generate text using AI" },
			{ name: "chat", description: "Chat with AI model" },
		],
	},
	MICROSOFT_GRAPH: {
		description:
			"Access Microsoft Teams messages, channels, chats, and shared files using Microsoft Graph API",
		capabilities: [
			"messaging",
			"team_communication",
			"channel_messages",
			"chat_messages",
			"file_sharing",
			"message_search",
		],
		operations: [
			{
				name: "list_teams",
				description: "List all Teams the user has joined",
			},
			{
				name: "list_channels",
				description: "List channels in a specific team",
			},
			{
				name: "search_messages",
				description:
					"Search for messages across Teams channels and chats",
			},
			{
				name: "list_messages",
				description: "List recent messages in a Teams channel",
			},
			{
				name: "get_chat_messages",
				description: "Get messages from a direct or group chat",
			},
			{
				name: "list_chats",
				description: "List direct and group chats for the user",
			},
			{
				name: "get_shared_files",
				description: "Get files shared in a Teams channel",
			},
		],
		keywords: [
			"microsoft teams",
			"teams message",
			"teams channel",
			"teams chat",
			"ms teams",
			"latest teams message",
			"get teams message",
			"read teams message",
			"teams files",
			"team communication",
			// Search-related patterns
			"check my team",
			"show me team",
			"message from team",
			"latest message from",
			"recent message from",
			// Common user queries
			"what's in my teams",
			"teams update",
			"team update",
		],
	},
};

/**
 * Discovery metadata for the providers that have a shared executor. Derived
 * from the registry so a provider's description, capabilities, operations, and
 * keywords have exactly one definition.
 */
function buildRegisteredProviderMetadata(): Record<
	string,
	IntegrationProviderMetadata
> {
	return Object.fromEntries(
		listRegisteredIntegrationProviders().map((provider) => {
			const executor = integrationExecutorRegistry[provider];
			return [
				provider,
				{
					description: executor.description,
					capabilities: [...executor.capabilities],
					operations: Object.entries(executor.operations).map(
						([name, operation]) => ({
							name,
							description: operation.description,
						}),
					),
					keywords: [...executor.providerKeywords],
				},
			];
		}),
	);
}

/**
 * Maps workflow integration providers to their capabilities and descriptions.
 * This provides rich metadata for semantic matching.
 */
export const INTEGRATION_PROVIDER_METADATA: Record<
	string,
	IntegrationProviderMetadata
> = {
	...LEGACY_PROVIDER_METADATA,
	...buildRegisteredProviderMetadata(),
};

/**
 * Get metadata for an integration provider.
 *
 * On the LOOM chat surface, registered providers advertise only their
 * chat-enabled operations — a write operation that is not cleared for chat must
 * never reach the model's tool schema.
 */
export function getIntegrationProviderMetadata(
	provider: string,
	options?: { executionSurface?: "LOOM_CHAT" },
): IntegrationProviderMetadata {
	const metadata = INTEGRATION_PROVIDER_METADATA[provider];
	if (!metadata) {
		return {
			description: `${provider} integration`,
			capabilities: [],
			operations: [],
		};
	}

	// Narrow only registered providers: an unregistered one has no chat-enabled
	// operation list to consult, and blanking its operations here would look like
	// "this integration does nothing" rather than "chat cannot run it".
	if (
		options?.executionSurface === "LOOM_CHAT" &&
		isRegisteredIntegrationProvider(provider)
	) {
		// Copied because the registry hands back its precomputed (frozen-by-
		// contract) list and IntegrationProviderMetadata declares a mutable one.
		return {
			...metadata,
			operations: [...listChatEnabledOperations(provider)],
		};
	}

	return metadata;
}

// =============================================================================
// Integration Search
// =============================================================================

/**
 * Build the Prisma `provider` predicate for a search.
 *
 * Returns `{}` for the default (unfiltered) surface, a `provider` predicate
 * when an explicit provider and/or an execution surface narrows the set, or
 * `null` when the intersection is empty and the caller should short-circuit.
 */
function buildProviderFilter(
	provider: string | undefined,
	executionSurface: "LOOM_CHAT" | undefined,
): Record<string, unknown> | null {
	if (!executionSurface) {
		return provider
			? { provider: provider as WorkflowIntegrationProvider }
			: {};
	}

	const chatProviders = listChatEnabledIntegrationProviders();

	if (!provider) {
		return { provider: { in: chatProviders } };
	}

	// An explicit provider narrows to itself if chat can execute it, and to
	// nothing if it cannot. Kept as a single-element `in` so the emitted
	// predicate has one shape regardless of how it was reached.
	return chatProviders.some((candidate) => candidate === provider)
		? { provider: { in: [provider] } }
		: null;
}

/**
 * Search for available workflow integrations that match the query.
 * Uses semantic (embedding-based) search combined with keyword matching.
 *
 * This allows the orchestrator to use configured integrations (Slack, GitHub, etc.)
 * directly instead of requiring MCP servers for these services.
 */
export async function searchAvailableIntegrations(
	input: SearchAvailableIntegrationsInput,
): Promise<SearchAvailableIntegrationsOutput> {
	const startTime = Date.now();
	console.log(`[SearchIntegrations] Searching for: "${input.query}"`);

	// Query integrations from database
	// If enabledIntegrationIds is an empty array, no integrations are enabled
	if (
		input.enabledIntegrationIds &&
		input.enabledIntegrationIds.length === 0
	) {
		console.log(
			"[SearchIntegrations] No integrations enabled (empty filter)",
		);
		return {
			results: [],
			totalIntegrationsSearched: 0,
			durationMs: Date.now() - startTime,
		};
	}

	// Execution-surface filter. Applied as a database predicate — BEFORE scoring,
	// sorting and `limit` — so a high-scoring provider the surface cannot execute
	// can never crowd an executable one out of the result set. Omitted (the
	// default, used by analyzeAndRoute's planner path) leaves the query and the
	// returned metadata untouched.
	const executionSurface = input.executionSurface;
	const providerFilter = buildProviderFilter(
		input.provider,
		executionSurface,
	);
	if (providerFilter === null) {
		console.log(
			`[SearchIntegrations] Provider "${input.provider}" is not executable on ${executionSurface}`,
		);
		return {
			results: [],
			totalIntegrationsSearched: 0,
			durationMs: Date.now() - startTime,
		};
	}

	const integrations = await db.workflowIntegration.findMany({
		where: {
			...(input.organizationId
				? { organizationId: input.organizationId }
				: { userId: input.userId, organizationId: null }),
			isActive: true,
			...providerFilter,
			// Filter by enabled integration IDs if provided (null = all)
			...(input.enabledIntegrationIds
				? { id: { in: input.enabledIntegrationIds } }
				: {}),
		},
	});

	if (integrations.length === 0) {
		console.log("[SearchIntegrations] No active integrations found");
		return {
			results: [],
			totalIntegrationsSearched: 0,
			durationMs: Date.now() - startTime,
		};
	}

	console.log(
		`[SearchIntegrations] Found ${integrations.length} active integrations`,
	);

	// Generate query embedding for semantic search
	let queryEmbedding: number[] | null = null;
	try {
		const tenantContext: TenantContext = {
			userId: input.userId,
			organizationId: input.organizationId,
		};
		// Credentials are fetched internally by generateEmbedding()
		const result = await generateEmbedding(
			input.query,
			tenantContext,
			undefined,
		);
		queryEmbedding = result.embedding;
	} catch (error) {
		console.warn(
			"[SearchIntegrations] Failed to generate query embedding:",
			error,
		);
	}

	// Generate embeddings for integrations (batch for efficiency)
	const integrationTexts = integrations.map((integration) => {
		const metadata = getIntegrationProviderMetadata(integration.provider, {
			executionSurface,
		});
		// Combine name, provider description, and capabilities for embedding
		return `${integration.name}: ${metadata.description}. Capabilities: ${metadata.capabilities.join(", ")}. Operations: ${metadata.operations.map((op) => op.name).join(", ")}`;
	});

	let integrationEmbeddings: number[][] = [];
	if (queryEmbedding) {
		try {
			const tenantContext: TenantContext = {
				userId: input.userId,
				organizationId: input.organizationId,
			};
			// Credentials are fetched internally by generateEmbeddings()
			const results = await generateEmbeddings(
				integrationTexts,
				tenantContext,
				undefined,
			);
			integrationEmbeddings = results.embeddings;
		} catch (error) {
			console.warn(
				"[SearchIntegrations] Failed to generate integration embeddings:",
				error,
			);
		}
	}

	// ==========================================================================
	// Score integrations using hybrid approach (KEYWORDS + keyword + semantic)
	// ==========================================================================
	const queryLower = input.query.toLowerCase();
	const queryWords = extractQueryWords(input.query);

	const scoredIntegrations = integrations
		.map((integration, index) => {
			const metadata = getIntegrationProviderMetadata(
				integration.provider,
				{ executionSurface },
			);

			// PRIORITY 0: Check KEYWORDS section first (BM25-style exact phrase matching)
			// This is the most deterministic - matches user language directly
			let keywordsScore = 0;
			if (metadata.keywords && metadata.keywords.length > 0) {
				const { score, matchedKeywords } = calculateKeywordMatchScore(
					queryLower,
					metadata.keywords,
				);
				if (score > 0) {
					keywordsScore = score;
					console.log(
						`[SearchIntegrations] KEYWORDS match for ${integration.provider}: ${matchedKeywords.join(", ")} (${(score * 100).toFixed(0)}%)`,
					);
				}
			}

			// If KEYWORDS matched with high confidence, use that directly
			if (keywordsScore >= 0.7) {
				return {
					integration,
					metadata,
					score: keywordsScore,
					matchReason: `KEYWORDS match (${(keywordsScore * 100).toFixed(0)}%)`,
				};
			}

			// Keyword matching (40% weight)
			let keywordScore = 0;
			const matchReasons: string[] = [];

			// Provider name matching
			const providerLower = integration.provider.toLowerCase();
			if (
				queryLower.includes(providerLower) ||
				providerLower.includes(queryLower)
			) {
				keywordScore += 0.4;
				matchReasons.push(`Provider: ${integration.provider}`);
			}

			// Integration name matching
			const nameLower = integration.name.toLowerCase();
			if (
				queryLower.includes(nameLower) ||
				nameLower.includes(queryLower)
			) {
				keywordScore += 0.3;
				matchReasons.push(`Name: ${integration.name}`);
			}

			// Capability matching
			for (const capability of metadata.capabilities) {
				const capLower = capability.toLowerCase().replace(/_/g, " ");
				if (
					queryLower.includes(capLower) ||
					queryWords.some((w) => capLower.includes(w))
				) {
					keywordScore += 0.15;
					matchReasons.push(`Capability: ${capability}`);
				}
			}

			// Operation matching
			for (const op of metadata.operations) {
				const opLower = op.name.toLowerCase().replace(/_/g, " ");
				const opDescLower = op.description.toLowerCase();
				if (
					queryLower.includes(opLower) ||
					queryWords.some((w) => opDescLower.includes(w))
				) {
					keywordScore += 0.2;
					matchReasons.push(`Operation: ${op.name}`);
				}
			}

			// Semantic similarity (60% weight)
			let semanticScore = 0;
			if (queryEmbedding && integrationEmbeddings[index]) {
				semanticScore = cosineSimilarity(
					queryEmbedding,
					integrationEmbeddings[index],
				);
				if (semanticScore > 0.5) {
					matchReasons.push(
						`Semantic similarity: ${(semanticScore * 100).toFixed(0)}%`,
					);
				}
			}

			// Hybrid score
			const normalizedKeyword = Math.min(keywordScore, 1);
			const hybridScore =
				queryEmbedding && integrationEmbeddings[index]
					? 0.4 * normalizedKeyword + 0.6 * semanticScore
					: normalizedKeyword;

			return {
				integration,
				metadata,
				score: hybridScore,
				matchReason: matchReasons.join("; ") || "Semantic match",
			};
		})
		.filter((i) => i.score >= (input.minConfidence || 0.2))
		.sort((a, b) => b.score - a.score)
		.slice(0, input.limit || 5);

	const durationMs = Date.now() - startTime;
	const semanticUsed =
		queryEmbedding !== null && integrationEmbeddings.length > 0;

	console.log(
		`[SearchIntegrations] Found ${scoredIntegrations.length} integrations in ${durationMs}ms (semantic: ${semanticUsed})`,
	);

	return {
		results: scoredIntegrations.map((si) => ({
			integrationId: si.integration.id,
			name: si.integration.name,
			provider: si.integration.provider,
			description: si.metadata.description,
			confidence: si.score,
			matchReason: si.matchReason,
			capabilities: si.metadata.capabilities,
			operations: si.metadata.operations,
			isActive: si.integration.isActive,
		})),
		totalIntegrationsSearched: integrations.length,
		durationMs,
	};
}
