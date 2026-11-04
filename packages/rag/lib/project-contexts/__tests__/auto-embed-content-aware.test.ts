/**
 * `embedProjectContext` with content-type chunking on: the router cuts the
 * content by profile and every point carries the profile, its reason and the
 * project's chunking version; the row records the version it was written at.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	storeProjectContext: vi.fn(),
	get generateQueryEmbedding() {
		return (this as { generateEmbedding: unknown }).generateEmbedding;
	},
	generateEmbedding: vi.fn(),
	getProjectRagSettings: vi.fn(),
	markContextAsEmbedded: vi.fn(),
	markProjectContextChunkingVersion: vi.fn(),
	isFeatureEnabled: vi.fn(),
}));

vi.mock("@repo/ai", async () => ({
	assertEmbeddingModelUsable: vi.fn(),
	isPermanentProviderFailure: (
		await import("@repo/ai/lib/usage-logging-middleware")
	).isPermanentProviderFailure,
}));

vi.mock("../store", () => ({
	storeProjectContext: mocks.storeProjectContext,
	listProjectContextPointIds: vi.fn(async () => []),
	deleteProjectContextPoints: vi.fn(),
	deleteProjectContext: vi.fn(),
}));

vi.mock("../../company-contexts/store", () => ({
	storeCompanyContextPoints: vi.fn(),
}));

vi.mock("../../embedding", () => ({
	get generateQueryEmbedding() {
		return (this as { generateEmbedding: unknown }).generateEmbedding;
	},
	generateEmbedding: mocks.generateEmbedding,
	generateEmbeddings: vi.fn(),
}));

vi.mock("../../chunking", async () => {
	const actual =
		await vi.importActual<typeof import("../../chunking")>(
			"../../chunking",
		);
	return {
		...actual,
		// No model call: each chunk is embedded as it is.
		enrichChunksWithTenantContext: vi.fn(
			async (input: Array<{ index: number; content: string }>) =>
				input.map((chunk) => ({
					...chunk,
					enrichedContent: chunk.content,
					originalContent: chunk.content,
				})),
		),
	};
});

vi.mock("@repo/database", () => ({
	getOrganizationRagSettings: vi.fn(),
	getProjectRagSettings: mocks.getProjectRagSettings,
	getDefaultRagSettings: vi.fn(),
	isFeatureEnabled: mocks.isFeatureEnabled,
	markContextAsEmbedded: mocks.markContextAsEmbedded,
	markProjectContextChunkingVersion: mocks.markProjectContextChunkingVersion,
	setContextEnrichmentRetryAt: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { enrichChunksWithTenantContext } from "../../chunking";
import { embedProjectContext } from "../auto-embed";

const BACKLOG = [
	"# Backlog",
	...Array.from(
		{ length: 60 },
		(_, i) => `- EX-${i + 1} ${"Backlog item text ".repeat(4)}`,
	),
].join("\n");

function options() {
	return {
		contextId: "ctx-1",
		projectId: "proj-1",
		userId: "user-1",
		organizationId: "org-example",
		content: BACKLOG,
		type: "FILE",
		apiKey: { apiKey: "test-key", provider: "OPENAI_DIRECT" },
		metadata: { filename: "backlog.md", mimeType: "text/markdown" },
		contentKind: "backlog" as const,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.generateEmbedding.mockResolvedValue({
		embedding: [0.1, 0.2],
		model: "text-embedding-3-small",
		tokens: 4,
	});
	mocks.storeProjectContext.mockImplementation(
		async ({ contextId }: { contextId: string }) => `pt:${contextId}`,
	);
	mocks.getProjectRagSettings.mockResolvedValue({
		chunkSize: 3000,
		chunkOverlap: 500,
		splitMethod: "DOCUMENT",
		chunkByContentType: true,
		chunkProfiles: null,
		chunkingVersion: 2,
	});
});

describe("embedProjectContext with content-type chunking", () => {
	it("stores item chunks with profile, reason and chunking version", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(true);
		const result = await embedProjectContext(options());

		expect(result.success).toBe(true);
		expect(mocks.storeProjectContext.mock.calls.length).toBeGreaterThan(1);
		for (const [call] of mocks.storeProjectContext.mock.calls) {
			expect(call.metadata).toMatchObject({
				profile: "items",
				profileReason: "kind",
				chunkingVersion: 2,
				originalContextId: "ctx-1",
			});
		}
		expect(mocks.markProjectContextChunkingVersion).toHaveBeenCalledWith(
			"ctx-1",
			2,
		);
	});

	it("takes today's path when the flag is off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);
		const result = await embedProjectContext(options());

		expect(result.success).toBe(true);
		for (const [call] of mocks.storeProjectContext.mock.calls) {
			expect(call.metadata).not.toHaveProperty("profile");
		}
		expect(mocks.markProjectContextChunkingVersion).not.toHaveBeenCalled();
	});
});

it.each([401, 429])(
	"probes before enrichment and preserves classification for HTTP %i",
	async (statusCode) => {
		mocks.generateEmbedding.mockRejectedValue(
			Object.assign(new Error("Provider rejected request"), {
				statusCode,
			}),
		);
		const result = await embedProjectContext(options());
		expect(enrichChunksWithTenantContext).not.toHaveBeenCalled();
		expect(mocks.generateEmbedding).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(false);
		expect(result.permanentFailure ?? false).toBe(statusCode === 401);
		expect(mocks.storeProjectContext).not.toHaveBeenCalled();
	},
);

it.each([401, 429])(
	"stops the chunk loop if HTTP %i begins after the probe",
	async (statusCode) => {
		mocks.generateEmbedding
			.mockResolvedValueOnce({ embedding: [0.1, 0.2] })
			.mockRejectedValue(
				Object.assign(new Error("Provider rejected request"), {
					statusCode,
				}),
			);
		const result = await embedProjectContext(options());
		expect(mocks.generateEmbedding).toHaveBeenCalledTimes(2);
		expect(result.success).toBe(false);
		expect(result.permanentFailure ?? false).toBe(statusCode === 401);
		expect(mocks.storeProjectContext).not.toHaveBeenCalled();
	},
);
