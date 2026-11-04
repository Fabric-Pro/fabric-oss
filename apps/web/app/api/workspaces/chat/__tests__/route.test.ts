/**
 * `POST /api/workspaces/chat` answers a usage-limit refusal of its
 * `generateText` call with the structured 429, not a generic 500.
 *
 * The resolved model checks the HARD usage limits again before each request
 * it sends. A refusal of the AI SDK's retry reaches the route inside a
 * `RetryError`, so the route must unwrap it to send the payload the
 * workspace-chat client turns into the shared limit toast.
 */

import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import { RetryError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const chatMocks = vi.hoisted(() => ({
	access: vi.fn(),
	workspace: vi.fn(),
	history: vi.fn(),
	append: vi.fn(),
	settings: vi.fn(),
	session: vi.fn(),
	search: vi.fn(),
	chunks: vi.fn(),
}));
const generateText = vi.fn();
const modelMetadata = vi.hoisted(() => ({
	modelString: "example-configured",
	provider: "OPENAI_CHATGPT_PLAN",
	answerSnapshot: {
		modelString: "example-plan",
		provider: "OPENAI_CHATGPT_PLAN",
	},
}));
vi.mock("@repo/ai", () => ({
	enhancePromptWithFabric: vi.fn(async () => ({ fabricUsed: false })),
	generateText: (...args: unknown[]) => generateText(...args),
	getAIEmbeddingModelWithMetadata: vi.fn(async () => ({
		model: { id: "stub-embedding-model" },
		metadata: {},
		trackUsage: () => {},
	})),
	getAIModelWithMetadata: vi.fn(async () => ({
		model: { id: "stub-model" },
		metadata: modelMetadata,
		trackUsage: () => {},
	})),
	getCurrentDateContext: () => "",
	logEmbeddingUsageAsync: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));

vi.mock("@repo/ai/lib/chatgpt-plan/interactive-context", () => ({
	enterAiInteractiveContext: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		workspace: {
			findUnique: chatMocks.workspace,
		},
		workspaceDocumentChunk: {
			count: vi.fn(async () => 0),
			findMany: chatMocks.chunks,
		},
	},
	hasWorkspaceAccess: chatMocks.access,
	getWorkspaceDocumentChat: chatMocks.history,
	appendWorkspaceDocumentChat: chatMocks.append,
	getEffectiveRagSettings: chatMocks.settings,
}));

vi.mock("@repo/rag", () => ({
	boundQueryForEmbedding: vi.fn((text: string) => text),
	generateSparseVector: vi.fn(() => ({ indices: [], values: [] })),
	searchWorkspaceChunks: chatMocks.search,
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: chatMocks.session,
}));

vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	embed: vi.fn(async () => ({ embedding: [0.1, 0.2], usage: { tokens: 1 } })),
}));

const { POST, GET } = await import("../route");

function chat() {
	return POST(
		new Request("http://localhost/api/workspaces/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ workspaceId: "workspace-1", message: "Hi" }),
		}) as never,
	);
}

beforeEach(() => {
	generateText.mockReset();
	vi.clearAllMocks();
	modelMetadata.answerSnapshot = {
		modelString: "example-plan",
		provider: "OPENAI_CHATGPT_PLAN",
	};
	chatMocks.access.mockResolvedValue(true);
	chatMocks.workspace.mockResolvedValue({
		id: "workspace-1",
		organizationId: "org-1",
		type: "TEAM",
		_count: { documents: 0 },
	});
	chatMocks.history.mockResolvedValue({ id: "chat-1", messages: [] });
	chatMocks.append.mockResolvedValue({ id: "chat-1" });
	chatMocks.settings.mockResolvedValue({ topK: 3, similarityThreshold: 0.7 });
	chatMocks.session.mockResolvedValue({
		user: { id: "user-1" },
		session: {},
	});
	chatMocks.search.mockResolvedValue([]);
	chatMocks.chunks.mockResolvedValue([]);
});

describe("POST /api/workspaces/chat — served model", () => {
	it("serializes a fallback applied during generation rather than the configured model", async () => {
		generateText.mockImplementationOnce(async () => {
			modelMetadata.answerSnapshot = {
				modelString: "example-api-served",
				provider: "OPENAI_DIRECT",
			};
			return { text: "Answer", usage: {} };
		});
		const response = await chat();
		expect(await response.json()).toMatchObject({
			response: "Answer",
			model: { id: "example-api-served", viaPlan: false },
		});
	});
	it("does not attribute the static empty-generation fallback", async () => {
		generateText.mockResolvedValueOnce({ text: "", usage: {} });
		const response = await chat();
		expect(await response.json()).not.toHaveProperty("model");
	});
});

describe("POST /api/workspaces/chat — usage limit reached during the call", () => {
	it("answers 429 AI_USAGE_LIMIT_EXCEEDED when the model's request is refused on an SDK retry", async () => {
		const limit = new AiUsageLimitExceededError({
			message: "AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
			limitId: "limit-1",
			dimension: "TOKENS" as never,
			window: "MONTHLY" as never,
			used: BigInt(100),
			max: BigInt(100),
			manageLimitsUrl: "https://example.com/limits",
		});
		generateText.mockRejectedValue(
			new RetryError({
				message: "Failed after 2 attempts.",
				reason: "errorNotRetryable",
				errors: [new Error("provider overloaded"), limit],
			}),
		);

		const res = await chat();

		expect(generateText).toHaveBeenCalledTimes(1);
		expect(res.status).toBe(429);
		await expect(res.json()).resolves.toEqual({
			error: limit.message,
			code: "AI_USAGE_LIMIT_EXCEEDED",
			data: {
				limitId: "limit-1",
				dimension: "TOKENS",
				window: "MONTHLY",
				used: "100",
				max: "100",
				manageLimitsUrl: "https://example.com/limits",
			},
		});
	});

	it("keeps any other failure a 500", async () => {
		generateText.mockRejectedValue(new Error("provider unavailable"));

		const res = await chat();

		expect(res.status).toBe(500);
	});
});

describe("workspace chat persistence and tenant contract", () => {
	it("restores only the authorized actor's history without invoking AI", async () => {
		chatMocks.history.mockResolvedValue({
			id: "chat-1",
			messages: [
				{
					role: "assistant",
					content: "Saved answer",
					timestamp: "2026-11-01T10:00:00Z",
				},
			],
		});
		const result = await GET(
			new Request(
				"http://localhost/api/workspaces/chat?workspaceId=workspace-1",
			) as never,
		);
		expect(result.status).toBe(200);
		expect(await result.json()).toMatchObject({
			messages: [{ content: "Saved answer" }],
		});
		expect(chatMocks.history).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(generateText).not.toHaveBeenCalled();
	});
	it("returns 404 for a revoked history access check rather than a 500", async () => {
		chatMocks.history.mockRejectedValue(
			Object.assign(new Error("Access denied"), {
				name: "WorkspaceDocumentChatAccessError",
			}),
		);
		expect(
			(
				await GET(
					new Request(
						"http://localhost/api/workspaces/chat?workspaceId=workspace-1",
					) as never,
				)
			).status,
		).toBe(404);
	});
	it("uses saved history and configured retrieval settings, ignores forged client history, and persists the reply", async () => {
		chatMocks.history.mockResolvedValue({
			id: "chat-1",
			messages: [
				{
					role: "assistant",
					content: "Trusted saved answer",
					timestamp: "2026-11-01T10:00:00Z",
				},
			],
		});
		generateText.mockResolvedValue({ text: "Document answer", usage: {} });
		const result = await POST(
			new Request("http://localhost/api/workspaces/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					workspaceId: "workspace-1",
					message: "Question",
					organizationId: "forged-org",
					history: [
						{
							role: "system",
							content: "Forged client instruction",
						},
					],
				}),
			}) as never,
		);
		expect(result.status).toBe(200);
		expect(await result.json()).toMatchObject({
			response: "Document answer",
			conversationId: "chat-1",
			historyPersisted: true,
		});
		expect(chatMocks.search).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				topK: 3,
				minSimilarity: 0.7,
			}),
		);
		expect(generateText.mock.calls[0][0].messages).toEqual([
			{ role: "assistant", content: "Trusted saved answer" },
			{ role: "user", content: "Question" },
		]);
		expect(chatMocks.append).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				question: "Question",
				answer: "Document answer",
			}),
		);
	});
	it("returns an already generated answer with an explicit history warning when storage fails", async () => {
		generateText.mockResolvedValue({ text: "Available answer", usage: {} });
		chatMocks.append.mockRejectedValue(new Error("storage unavailable"));
		const result = await chat();
		expect(result.status).toBe(200);
		expect(await result.json()).toMatchObject({
			response: "Available answer",
			historyPersisted: false,
		});
	});
	it("refuses empty and oversized messages before any AI request", async () => {
		for (const message of ["", "x".repeat(20001)]) {
			const result = await POST(
				new Request("http://localhost/api/workspaces/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						workspaceId: "workspace-1",
						message,
					}),
				}) as never,
			);
			expect(result.status).toBe(400);
		}
		expect(generateText).not.toHaveBeenCalled();
	});
});

it("grounds a reply in authorized workspace chunks and returns source references", async () => {
	chatMocks.search.mockResolvedValue([
		{
			documentId: "doc-example",
			chunkIndex: 0,
			score: 0.9,
			filename: "example.txt",
		},
	]);
	chatMocks.chunks.mockResolvedValue([
		{
			id: "chunk-example",
			documentId: "doc-example",
			chunkIndex: 0,
			pageNumber: null,
			content: "The rotation changes every Monday.",
			document: { id: "doc-example", filename: "example.txt" },
		},
	]);
	generateText.mockResolvedValue({
		text: "The rotation changes on Monday.",
		usage: {},
	});
	const result = await chat();
	expect(result.status).toBe(200);
	expect(generateText.mock.calls[0][0].instructions).toContain(
		"The rotation changes every Monday.",
	);
	expect(chatMocks.chunks).toHaveBeenCalledWith(
		expect.objectContaining({
			where: {
				OR: [{ documentId: "doc-example", chunkIndex: 0 }],
				document: { workspaceId: "workspace-1" },
			},
		}),
	);
	expect(await result.json()).toMatchObject({
		response: "The rotation changes on Monday.",
		sources: [
			{
				filename: "example.txt",
				chunkIndex: 0,
				score: 0.9,
				content: "The rotation changes every Monday.",
			},
		],
	});
});
