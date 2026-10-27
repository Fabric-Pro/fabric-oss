/**
 * `retrieveWorkspaceDocumentsActivity` narrows its workspace ids to the call's
 * tenant before it reads anything for them.
 *
 * Every workspace search the workers run funnels through this activity, and
 * some callers hand it ids read back from rows saved long before the run: an
 * agent instance's stored `workspaceIds` could name another organization's
 * workspace until instance writes started refusing it. The rule itself is
 * unit-tested with `filterWorkspaceIdsForTenant` in `@repo/database`; these
 * tests pin the activity to it, so a foreign id never reaches the settings
 * lookup, the embedding call or the Qdrant search.
 */

import {
	currentAiCallPurpose,
	runWithAiCallPurpose,
} from "@repo/ai/lib/call-purpose-context";
import { createEmbeddingUsageLoggingMiddleware } from "@repo/ai/lib/usage-logging-middleware";
import { wrapEmbeddingModel } from "ai";
import { MockEmbeddingModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	filterWorkspaceIdsForTenant: vi.fn(),
	getEffectiveRagSettings: vi.fn(),
	searchMultipleWorkspaces: vi.fn(),
	generateEmbedding: vi.fn(),
	rows: vi.fn(),
}));

// Stub data and provider boundaries, and import the retrieval implementation
// directly so its purpose scope runs without loading the RAG barrel.
vi.mock("@repo/database", () => ({
	logAiUsageAsync: mocks.rows,
	db: {
		workspaceDocumentChunk: { findMany: vi.fn() },
		chatDocument: {
			findMany: vi.fn(async () => [
				{ id: "doc-example", filename: "example.txt", status: "READY" },
			]),
		},
	},
	filterWorkspaceIdsForTenant: (...args: unknown[]) =>
		mocks.filterWorkspaceIdsForTenant(...args),
	getDefaultRagSettings: () => ({ topK: 5, similarityThreshold: 0.3 }),
	getEffectiveRagSettings: (...args: unknown[]) =>
		mocks.getEffectiveRagSettings(...args),
}));

vi.mock("@repo/ai", () => ({
	getRAGProviderConfig: vi.fn().mockResolvedValue({ apiKey: "example-key" }),
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
				providerModelId: "example-embedding",
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
}));

vi.mock("@repo/rag/lib/workspace-documents/store", () => ({
	searchMultipleWorkspaces: (...args: unknown[]) =>
		mocks.searchMultipleWorkspaces(...args),
}));

vi.mock("@repo/rag/lib/vector-store", () => ({
	searchSimilarChunks: async () => [],
}));

vi.mock("@repo/rag", async () => ({
	generateEmbedding: (...args: unknown[]) => mocks.generateEmbedding(...args),
	formatContextForLLM: () => "context",
	retrieveContext: (await import("@repo/rag/lib/retrieval/retriever"))
		.retrieveContext,
	generateSparseVector: () => ({ indices: [], values: [] }),
}));

import {
	retrieveRagContextForDirectChatActivity,
	retrieveWorkspaceDocumentsActivity,
} from "../rag-retrieval";

// Which organization hosts each workspace in these tests.
const HOSTING_ORGANIZATION: Record<string, string | null> = {
	"ws-a": "example-org-a",
	"ws-b": "example-org-b",
};

describe("retrieveWorkspaceDocumentsActivity tenant filter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.filterWorkspaceIdsForTenant.mockImplementation(
			async (params: {
				workspaceIds: string[];
				organizationId: string | null | undefined;
			}) => {
				const tenant = params.organizationId ?? null;
				return {
					allowed: params.workspaceIds.filter(
						(id) => HOSTING_ORGANIZATION[id] === tenant,
					),
					dropped: params.workspaceIds.filter(
						(id) => HOSTING_ORGANIZATION[id] !== tenant,
					),
				};
			},
		);
		mocks.getEffectiveRagSettings.mockResolvedValue({
			topK: 5,
			similarityThreshold: 0.3,
		});
		mocks.generateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2] });
		mocks.searchMultipleWorkspaces.mockResolvedValue([]);
	});

	it.each([
		["Direct workflow", { usageConversationId: "example-chat" }],
		["Parlume", undefined],
		[
			"Orchestrator",
			{
				usageConversationId: "example-chat",
				usageOrigin: { featureKey: "chat-agent" as const },
			},
		],
		[
			"alternate feature attribution",
			{ usageOrigin: { featureKey: "report-generation" as const } },
		],
	])(
		"workspace operation owns its label via %s under another scope",
		async (_caller, options) => {
			const seen: (string | undefined)[] = [];
			mocks.generateEmbedding.mockImplementation(async () => {
				seen.push(currentAiCallPurpose());
				return { embedding: [0.1] };
			});
			await runWithAiCallPurpose("compaction", () =>
				retrieveWorkspaceDocumentsActivity(
					"query",
					"user-example",
					"example-org-a",
					["ws-a"],
					undefined,
					undefined,
					undefined,
					options,
				),
			);
			expect(seen).toEqual(["workspace-retrieval-embedding"]);
		},
	);

	it("searches only the workspaces hosted by the caller's organization", async () => {
		await retrieveWorkspaceDocumentsActivity(
			"what changed?",
			"user-1",
			"example-org-a",
			["ws-a", "ws-b"],
		);

		expect(mocks.filterWorkspaceIdsForTenant).toHaveBeenCalledWith({
			workspaceIds: ["ws-a", "ws-b"],
			userId: "user-1",
			organizationId: "example-org-a",
		});
		expect(mocks.searchMultipleWorkspaces).toHaveBeenCalledTimes(1);
		expect(mocks.searchMultipleWorkspaces).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceIds: ["ws-a"],
				organizationId: "example-org-a",
			}),
		);
		expect(mocks.getEffectiveRagSettings).toHaveBeenCalledTimes(1);
		expect(mocks.getEffectiveRagSettings).toHaveBeenCalledWith("ws-a");
	});

	it("returns the empty result without searching when every id is foreign", async () => {
		const result = await retrieveWorkspaceDocumentsActivity(
			"what changed?",
			"user-1",
			"example-org-a",
			["ws-b"],
		);

		expect(result).toEqual({ context: "", chunkCount: 0 });
		expect(mocks.searchMultipleWorkspaces).not.toHaveBeenCalled();
		expect(mocks.generateEmbedding).not.toHaveBeenCalled();
		expect(mocks.getEffectiveRagSettings).not.toHaveBeenCalled();
	});

	it("attributes the query embedding without widening the workspace tenant filter", async () => {
		const usageOrigin = {
			projectId: "origin-project",
			frameId: "origin-frame",
			workflowExecutionId: "origin-execution",
		};
		await retrieveWorkspaceDocumentsActivity(
			"query",
			"user-1",
			"example-org-a",
			["ws-a", "ws-b"],
			undefined,
			undefined,
			undefined,
			{ usageOrigin },
		);
		expect(mocks.generateEmbedding.mock.calls[0][1]).toMatchObject(
			usageOrigin,
		);
		expect(mocks.searchMultipleWorkspaces).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceIds: ["ws-a"],
				organizationId: "example-org-a",
			}),
		);
	});

	it.each(["conversation-example", undefined])(
		"attributes workspace query embeddings to the supplied conversation (%s)",
		async (usageConversationId) => {
			mocks.generateEmbedding.mockResolvedValue({ embedding: [0.1] });
			mocks.filterWorkspaceIdsForTenant.mockResolvedValue({
				allowed: ["ws-a"],
				dropped: [],
			});
			await retrieveWorkspaceDocumentsActivity(
				"query",
				"user-1",
				"example-org-a",
				["ws-a"],
				undefined,
				undefined,
				undefined,
				{ usageConversationId },
			);
			expect(
				mocks.generateEmbedding.mock.calls[0][1].conversationId,
			).toBe(usageConversationId);
		},
	);
	it("labels knowledge-fetcher workspace embeddings by the retrieval operation", async () => {
		const seen: (string | undefined)[] = [];
		mocks.generateEmbedding.mockImplementation(async () => {
			seen.push(currentAiCallPurpose());
			return { embedding: [0.1] };
		});
		const { fetchKnowledgeSources } = await import(
			"../../agent-execution-core/knowledge-fetcher"
		);
		await fetchKnowledgeSources({
			executionId: "example-execution",
			userId: "example-user",
			organizationId: "example-org-a",
			knowledgeSources: [],
			workspaceIds: ["ws-a"],
			query: "example",
		});
		expect(seen).toEqual(["workspace-retrieval-embedding"]);
	});
});

it("attached-document retrieval owns its label under an enclosing scope", async () => {
	mocks.rows.mockClear();
	await runWithAiCallPurpose("compaction", () =>
		retrieveRagContextForDirectChatActivity(
			"query",
			"user-example",
			"example-org-a",
			"chat-example",
			["doc-example"],
		),
	);
	expect(mocks.rows).toHaveBeenCalledTimes(1);
	expect(mocks.rows.mock.calls[0][0]).toMatchObject({
		callPurpose: "chat-document-retrieval-embedding",
	});
});
