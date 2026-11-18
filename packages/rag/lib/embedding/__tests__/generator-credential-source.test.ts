/**
 * A failed embedding names the key it was sent with (Fizzy #3571). The AI
 * Gateway's rejection text tells the reader to set `AI_GATEWAY_API_KEY`
 * whoever owned the rejected key, so a caller that logs only the message
 * points an organization's revoked key at the platform's environment.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { embedMock, embedManyMock, metadata } = vi.hoisted(() => ({
	embedMock: vi.fn(),
	embedManyMock: vi.fn(),
	metadata: {
		canonicalName: "text-embedding-3-small",
		modelString: "openai/text-embedding-3-small",
		selectionSource: "test",
		provider: "VERCEL_GATEWAY",
		configSource: null as "user" | "organization" | null,
	},
}));

vi.mock("ai", () => ({
	embed: embedMock,
	embedMany: embedManyMock,
}));

vi.mock("@repo/ai", () => ({
	getAIEmbeddingModelWithMetadata: vi.fn(async () => ({
		model: { id: "text-embedding-3-small" },
		metadata,
		trackUsage: vi.fn(),
	})),
	logEmbeddingUsageAsync: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { EmbeddingGenerationError } from "../errors";
import { generateEmbedding, generateEmbeddings } from "../generator";

const TENANT = { userId: "user-1", organizationId: "org-1" };

function gatewayRejection(): Error {
	return Object.assign(
		new Error(
			"AI Gateway authentication failed: Invalid API key or token.",
		),
		{ name: "GatewayAuthenticationError", statusCode: 401 },
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe.each([
	["organization", "organization"],
	["user", "user"],
	[null, "platform"],
] as const)("a key with config source %s", (configSource, credentialSource) => {
	beforeEach(() => {
		metadata.configSource = configSource;
	});

	it("generateEmbedding names it on the failure", async () => {
		const rejection = gatewayRejection();
		embedMock.mockRejectedValue(rejection);

		const error = await generateEmbedding("hello", TENANT).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(EmbeddingGenerationError);
		expect(error).toMatchObject({
			message:
				"Embedding generation failed: AI Gateway authentication failed: Invalid API key or token.",
			cause: rejection,
			credentialSource,
			provider: "VERCEL_GATEWAY",
		});
	});

	it("generateEmbeddings names it on the failure", async () => {
		const rejection = gatewayRejection();
		embedManyMock.mockRejectedValue(rejection);

		const error = await generateEmbeddings(["a", "b"], TENANT).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(EmbeddingGenerationError);
		expect(error).toMatchObject({
			message:
				"Batch embedding generation failed: AI Gateway authentication failed: Invalid API key or token.",
			cause: rejection,
			credentialSource,
			provider: "VERCEL_GATEWAY",
		});
	});
});
