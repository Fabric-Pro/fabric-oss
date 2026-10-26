import {
	currentAiCallPurpose,
	runWithAiCallPurpose,
} from "@repo/ai/lib/call-purpose-context";
import {
	createEmbeddingUsageLoggingMiddleware,
	createUsageLoggingMiddleware,
} from "@repo/ai/lib/usage-logging-middleware";
import { MockActivityEnvironment } from "@temporalio/testing";
import { wrapEmbeddingModel, wrapLanguageModel } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: vi.fn() }));
vi.mock("@repo/database", () => ({
	logAiUsageAsync: h.rows,
	db: {
		companyContextSource: {
			findMany: async () => [{ id: "example-source" }],
		},
	},
	filterWorkspaceIdsForTenant: async ({
		workspaceIds,
	}: {
		workspaceIds: string[];
	}) => ({ allowed: workspaceIds, dropped: [] }),
	getDefaultRagSettings: () => ({ topK: 5, similarityThreshold: 0.1 }),
	getEffectiveRagSettings: async () => ({
		topK: 5,
		similarityThreshold: 0.1,
	}),
	getProjectRagSettings: async () => ({ similarityThreshold: 0.1 }),
	companyContextReadyWhere: () => ({}),
	isFeatureEnabled: async () => true,
	isOrganizationMember: async () => true,
}));
vi.mock("@repo/ai", async () => ({
	getAIEmbeddingModelWithMetadata: async (
		context: Record<string, unknown>,
	) => ({
		model: wrapEmbeddingModel({
			model: new MockEmbeddingModelV4({
				doEmbed: async () => ({
					embeddings: [[0.1]],
					usage: { tokens: 1 },
					warnings: [],
				}),
			}),
			middleware: createEmbeddingUsageLoggingMiddleware({
				...context,
				provider: "VERCEL_GATEWAY",
				providerModelId: "example-project",
			}),
		}),
		metadata: {
			canonicalName: "text-embedding-3-small",
			modelString: "openai/text-embedding-3-small",
			provider: "VERCEL_GATEWAY",
			selectionSource: "system_default",
		},
		trackUsage: vi.fn(),
	}),
	logEmbeddingUsageAsync: vi.fn(),
	tool: (definition: unknown) => definition,
	getRAGProviderConfig: async () => ({
		provider: "VERCEL_GATEWAY",
		apiKey: "example-key",
	}),
	resolveOpenAiApiKey: async () => "example-key",
	AUDIO_PROVIDER_REQUIRED: {},
	isVercelGatewayKey: () => true,
	getAIModelWithMetadata: async (
		_request: unknown,
		context: Record<string, unknown>,
	) => ({
		model: wrapLanguageModel({
			model: new MockLanguageModelV4({
				doGenerate: async () => ({
					content: [{ type: "text", text: "NO" }],
					finishReason: { unified: "stop", raw: "stop" },
					usage: {
						inputTokens: {
							total: 1,
							noCache: 1,
							cacheRead: 0,
							cacheWrite: 0,
						},
						outputTokens: { total: 1, text: 1, reasoning: 0 },
					},
					warnings: [],
				}),
			}),
			middleware: createUsageLoggingMiddleware({
				...context,
				provider: "VERCEL_GATEWAY",
				providerModelId: "example-language",
			}),
		}),
	}),
	getAIDecisionModelWithMetadata: async () => {
		throw new Error("example decision unavailable");
	},
	createDecisionCapture: () => ({ run: (fn: () => unknown) => fn() }),
	recordDecisionOutcome: vi.fn(),
	experimental_decide: vi.fn(),
	createGateway: () => Object.assign(() => ({}), { imageModel: () => ({}) }),
	generateText: async () => ({
		text: "example",
		files: [{ uint8Array: new Uint8Array([1]), mediaType: "image/png" }],
	}),
}));
vi.mock("@repo/storage", () => ({
	uploadFile: async () => {},
	getSignedUrl: async () => "https://example.com/image.png",
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../lib/get-search-provider", () => ({
	resolveSearchProviderForTenant: async () => null,
}));
vi.mock("../../lib/get-web-scraper", () => ({
	getWebScraperForTenant: async () => null,
}));
vi.mock("../../../lib/company-context-chat-access", () => ({
	resolveCompanyContextChatAccess: async () => ({
		organizationId: "example-org",
		readySourceCount: 1,
	}),
}));
vi.mock("../../orchestrator/utils", () => ({
	jsonSchemaToZod: (schema: unknown) => schema,
}));
vi.mock("../../orchestrator/utils/partykit-publisher", () => ({
	publishStepProgress: vi.fn(),
	publishToolComplete: vi.fn(),
	publishToolStart: vi.fn(),
}));
vi.mock("@repo/fabric-ai", () => ({
	createFabricClient: () => ({
		scrapeUrl: async () => "example",
		searchWeb: async () => "example",
	}),
	executePatternHybrid: async () => {
		await (
			createUsageLoggingMiddleware({
				provider: "VERCEL_GATEWAY",
				providerModelId: "example-analysis",
			}) as any
		).wrapGenerate({
			doGenerate: async () => ({
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			}),
		});
		return { success: true, output: "example", metadata: {} };
	},
}));
vi.mock("@repo/rag/lib/workspace-documents/store", () => ({
	searchMultipleWorkspaces: async () => [],
}));
vi.mock("@repo/rag/lib/project-contexts/store", () => ({
	searchSimilarProjectContexts: async () => [],
}));
vi.mock("@repo/rag/lib/project-contexts/summary-injection", () => ({
	applyContextSummary: (rows: unknown) => rows,
}));
vi.mock("@repo/rag", async () => ({
	generateEmbedding: async () => {
		await (
			createEmbeddingUsageLoggingMiddleware({
				provider: "VERCEL_GATEWAY",
				providerModelId: "example-embedding",
			}) as any
		).wrapEmbed({ doEmbed: async () => ({ usage: { tokens: 1 } }) });
		return { embedding: [0.1], model: "example-model" };
	},
	generateSparseVector: () => ({ indices: [], values: [] }),
	formatContextForLLM: () => "example",
	retrieveProjectContexts: (
		await import("@repo/rag/lib/project-contexts/retrieval")
	).retrieveProjectContexts,
	contextMetaHeader: () => "",
	formatContextsForPrompt: () => "",
	resolveCompanyEmbeddingModel: async () => ({
		supported: true,
		identity: "example-model",
	}),
	companyEmbeddingIdentity: () => "example-model",
	COMPANY_EMBEDDING_RESOLUTION: {},
	searchCompanyContexts: async () => [],
}));

import { searchCompanyContext } from "../../../lib/company-context-search";
import { synthesizeToolSpeech } from "../../../lib/text-to-speech";
import {
	scrapeAndAnalyzeActivity,
	searchAndAnalyzeActivity,
} from "../../fabric-ai";
import { generateImageActivity } from "../../image-generation";
import { checkCompletionClaimActivity } from "../../orchestrator/execution/check-completion-claim";
import { runFabricCatalogTool } from "../../orchestrator/execution/fabric-catalog-adapter";
import { FabricAiHandler } from "../../orchestrator/execution/handlers/fabric-ai-handler";
import { ProjectRagHandler } from "../../orchestrator/execution/handlers/project-rag-handler";
import { UnifiedSearchHandler } from "../../orchestrator/execution/handlers/unified-search-handler";
import { WorkspaceRagHandler } from "../../orchestrator/execution/handlers/workspace-rag-handler";
import { summarizeLargeToolResult } from "../../orchestrator/execution/summarize-tool-result";
import { retrieveProjectContextsActivity } from "../../project-metadata";
import { createFabricTool } from "../built-in-tools";
import { createCompanyContextTools } from "../company-context-tool";
import { withUnbackedClaimNotice } from "../completion-claim-notice";
import { retrieveWorkspaceDocumentsActivity } from "../rag-retrieval";

const context = {
	userId: "example-user",
	organizationId: "example-org",
	projectId: "example-project",
	workspaceIds: ["example-workspace"],
	companyContextAdvisor: true,
};
const args = {
	query: "example",
	question: "example",
	prompt: "example",
	text: "example",
	url: "https://example.com",
	pattern: "summarize",
	provider: "gateway",
};
async function builder(name: string) {
	const tools =
		name === "search_company_context"
			? createCompanyContextTools(context)
			: await createFabricTool(name, context);
	return (tools[name] as any).execute(args);
}
async function handler(name: string) {
	const selected =
		name === "project_rag_query"
			? new ProjectRagHandler()
			: name.startsWith("workspace_rag")
				? new WorkspaceRagHandler()
				: new FabricAiHandler();
	return selected.execute({
		input: {
			...context,
			previousStepResults: [],
			step: { id: "example-step", app: name, inputs: args },
		},
		variables: {},
		toolCalls: [],
		startTime: Date.now(),
	} as any);
}
const operations = [
	{
		label: "result-summary-single",
		name: "result summarizer",
		callers: [
			[
				"Orchestrator activity",
				() =>
					summarizeLargeToolResult({
						...context,
						featureKey: "chat-agent",
						toolName: "example",
						toolResult: "example",
						userQuery: "example",
						maxOutputLength: 100,
					}),
			],
			[
				"report in-process",
				() =>
					summarizeLargeToolResult({
						...context,
						featureKey: "report-generation",
						toolName: "example",
						toolResult: "example",
						userQuery: "example",
						maxOutputLength: 100,
					}),
			],
		],
	},
	{
		label: "completion-judge",
		name: "completion judge",
		callers: [
			[
				"Direct notice",
				() =>
					withUnbackedClaimNotice({
						...context,
						userRequest: "example",
						reply: "Done",
						toolsEnabled: true,
						toolCallCount: 0,
						voiceTurn: false,
					}),
			],
			[
				"Orchestrator workflow",
				() =>
					checkCompletionClaimActivity({
						...context,
						conversationId: "example-conversation",
						userRequest: "example",
						reply: "Done",
					}),
			],
		],
	},
	{
		label: "workspace-retrieval-embedding",
		name: "workspace_rag_query",
		callers: [
			[
				"Direct workflow / Parlume initial retrieval",
				() =>
					retrieveWorkspaceDocumentsActivity(
						"example",
						context.userId,
						context.organizationId,
						context.workspaceIds,
					),
			],
			[
				"Direct / Parlume tool builder",
				() => builder("workspace_rag_query"),
			],
			["Orchestrator step", () => handler("workspace_rag_query")],
			[
				"Direct / Parlume summarize tool",
				() => builder("workspace_rag_summarize"),
			],
			[
				"Orchestrator summarize step",
				() => handler("workspace_rag_summarize"),
			],
			[
				"Orchestrator unified search",
				() =>
					new UnifiedSearchHandler().execute({
						input: {
							...context,
							projectId: undefined,
							step: {
								id: "example-step",
								app: "workspace_rag_query",
								inputs: args,
							},
						},
						variables: {},
						toolCalls: [],
						startTime: Date.now(),
					} as any),
			],
		],
	},
	{
		label: "project-retrieval-embedding",
		name: "project_rag_query",
		callers: [
			["Direct / Parlume builder", () => builder("project_rag_query")],
			["Orchestrator step", () => handler("project_rag_query")],
			[
				"Orchestrator inline activity",
				() =>
					retrieveProjectContextsActivity(
						"example",
						context.projectId,
						context.userId,
						context.organizationId,
					),
			],
		],
	},
	{
		label: "company-context-embedding",
		name: "search_company_context",
		callers: [
			["Direct builder", () => builder("search_company_context")],
			[
				"Orchestrator catalog",
				() =>
					runFabricCatalogTool({
						...context,
						toolName: "search_company_context",
						args,
					}),
			],
			[
				"document generation shared search",
				() =>
					searchCompanyContext({
						...context,
						query: "example",
						minSimilarity: 0.1,
						timeoutMs: 1000,
						logContext: {},
					}),
			],
		],
	},
	...(
		[
			[
				"speech-generation",
				"fabric_text_to_speech",
				() =>
					synthesizeToolSpeech({
						...context,
						text: "example",
						voice: "alloy",
						speed: 1,
					}),
			],
			[
				"image-generation",
				"fabric_generate_image",
				() =>
					generateImageActivity({
						...context,
						prompt: "example",
						provider: "gateway",
					}),
			],
			[
				"search-analysis",
				"fabric_search_and_analyze",
				() =>
					searchAndAnalyzeActivity({
						...context,
						question: "example",
						pattern: "summarize",
					}),
			],
			[
				"scrape-analysis",
				"fabric_scrape_and_analyze",
				() =>
					scrapeAndAnalyzeActivity({
						...context,
						url: "https://example.com",
						pattern: "summarize",
					}),
			],
		] as const
	).map(([label, name, inline]) => ({
		label,
		name,
		callers: [
			["Direct / Parlume builder", () => builder(name)],
			["Orchestrator step", () => handler(name)],
			["in-process activity", inline],
			...(name === "fabric_text_to_speech"
				? [
						[
							"Orchestrator catalog",
							() =>
								runFabricCatalogTool({
									...context,
									toolName: name,
									args,
								}),
						],
					]
				: []),
		],
	})),
];

beforeEach(() => {
	h.rows.mockClear();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(new Uint8Array([1]))),
	);
});
afterEach(() => vi.unstubAllGlobals());

it.each(
	operations.flatMap(({ label, name, callers }) =>
		callers.map(([caller, run]) => ({
			label,
			name,
			caller,
			run: run as () => Promise<unknown>,
		})),
	),
)(
	"$name labels its model rows $label through $caller under an unrelated scope",
	async ({ label, run }) => {
		await new MockActivityEnvironment().run(() =>
			runWithAiCallPurpose("compaction", run),
		);
		expect(h.rows.mock.calls.length).toBeGreaterThan(0);
		expect(h.rows.mock.calls.map(([row]) => row.callPurpose)).toEqual([
			label,
		]);
		expect(currentAiCallPurpose()).toBeUndefined();
	},
);
