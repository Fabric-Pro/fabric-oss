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

const generateText = vi.fn();
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
		metadata: {},
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
			findUnique: vi.fn(async () => ({
				id: "workspace-1",
				organizationId: "org-1",
				type: "TEAM",
				_count: { documents: 0 },
			})),
		},
		workspaceDocumentChunk: { count: vi.fn(async () => 0) },
	},
	hasWorkspaceAccess: vi.fn(async () => true),
}));

vi.mock("@repo/rag", () => ({
	generateSparseVector: vi.fn(() => ({ indices: [], values: [] })),
	searchWorkspaceChunks: vi.fn(async () => []),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: vi.fn(async () => ({
		user: { id: "user-1" },
		session: {},
	})),
}));

vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	embed: vi.fn(async () => ({ embedding: [0.1, 0.2], usage: { tokens: 1 } })),
}));

const { POST } = await import("../route");

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
