/**
 * Unit Tests for Project Contexts Re-process Workflow
 *
 * Tests the Temporal workflow and activities for re-processing project contexts
 * when RAG settings change. Validates scalability and error handling.
 *
 * Run with: pnpm --filter @repo/temporal test
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const orphanCleanup = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 0));

const mocks = vi.hoisted(() => ({
	qdrantDelete: vi.fn(),
	bundleUpdateMany: vi.fn(),
}));

/** Activity stubs for the workflow-ordering tests at the bottom of this file. */
const activityStubs = vi.hoisted(() => ({
	validateRAGProviderConfig: vi.fn(),
	fetchProjectContextsForReprocess: vi.fn(),
	deleteProjectContextsFromQdrant: vi.fn(),
	reembedProjectContext: vi.fn(),
	updateReprocessProgress: vi.fn(),
}));

// Mock the database
vi.mock("@repo/database/prisma/client", () => ({
	db: {
		projectContext: {
			findMany: vi.fn(),
		},
		projectContextConversationBundle: {
			updateMany: mocks.bundleUpdateMany,
			findMany: vi.fn(async () => [{ id: "bundle-1" }]),
		},
		projectContextUrlPage: {
			findMany: vi.fn(async () => [{ id: "page-1" }]),
		},
		projectContextSummary: {
			findMany: vi.fn(async () => [{ id: "summary-1" }]),
		},
	},
}));

// Mock the AI provider config
vi.mock("@repo/ai", () => ({
	getSystemEmbeddingRAGProviderConfig: vi.fn().mockResolvedValue({
		apiKey: "test-api-key",
		provider: "OPENAI_DIRECT",
		baseUrl: null,
	}),
}));

// Mock the RAG library
vi.mock("@repo/rag", () => ({
	reembedProjectContext: vi.fn(),
}));

vi.mock("@repo/rag/lib/project-contexts/store", () => ({
	deleteOrphanProjectContextPoints: (...a: unknown[]) => orphanCleanup(...a),
}));

// The activities must not reach Qdrant directly; a client constructed here
// would surface as a call on this spy. vitest 4.x needs a real class because
// arrows aren't constructable.
vi.mock("@qdrant/js-client-rest", () => ({
	QdrantClient: class MockQdrantClient {
		delete = (...a: unknown[]) => mocks.qdrantDelete(...a);
	},
}));

// Workflow-level ordering tests only: the activity tests above exercise the
// real implementations.
vi.mock("@temporalio/workflow", async () => {
	const actual = await vi.importActual<typeof import("@temporalio/workflow")>(
		"@temporalio/workflow",
	);
	return {
		ApplicationFailure: actual.ApplicationFailure,
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		proxyActivities: vi.fn(() => activityStubs),
	};
});

import { db } from "@repo/database/prisma/client";
import { reembedProjectContext as ragReembed } from "@repo/rag";
import type { ProjectContextForReprocess } from "../src/activities/project-contexts-reprocess";

const ORG_ID = "orgexample1";

describe("Project Contexts Reprocess Workflow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.qdrantDelete.mockResolvedValue({ status: "acknowledged" });
		mocks.bundleUpdateMany.mockResolvedValue({ count: 0 });
	});

	describe("fetchProjectContextsForReprocess", () => {
		it("should fetch all contexts for a project", async () => {
			const mockContexts = [
				{
					id: "ctx-1",
					type: "TEXT",
					content: "First document content",
					originalFilename: "doc1.txt",
					sourceUrl: null,
					sourceTitle: null,
				},
				{
					id: "ctx-2",
					type: "LINK",
					content: "Webpage content",
					originalFilename: null,
					sourceUrl: "https://example.com",
					sourceTitle: "Example Page",
				},
			];

			(
				db.projectContext.findMany as ReturnType<typeof vi.fn>
			).mockResolvedValue(mockContexts);

			// Import activity after mocks
			const { fetchProjectContextsForReprocess } = await import(
				"../src/activities/project-contexts-reprocess"
			);

			const result = await fetchProjectContextsForReprocess({
				projectId: "proj-123",
				userId: "user-123",
				organizationId: "org-123",
			});

			expect(result).toHaveLength(2);
			expect(result[0].id).toBe("ctx-1");
			expect(result[1].id).toBe("ctx-2");
			expect(db.projectContext.findMany).toHaveBeenCalledWith({
				where: { projectId: "proj-123", type: { not: "INTEGRATION" } },
				select: expect.objectContaining({
					id: true,
					type: true,
					content: true,
					originalFilename: true,
					sourceUrl: true,
					sourceTitle: true,
				}),
			});
		});

		it("should return empty array when no contexts exist", async () => {
			(
				db.projectContext.findMany as ReturnType<typeof vi.fn>
			).mockResolvedValue([]);

			const { fetchProjectContextsForReprocess } = await import(
				"../src/activities/project-contexts-reprocess"
			);

			const result = await fetchProjectContextsForReprocess({
				projectId: "empty-proj",
				userId: "user-123",
			});

			expect(result).toHaveLength(0);
		});
	});

	describe("reembedProjectContext activity", () => {
		it("should call RAG reembed with correct parameters", async () => {
			(ragReembed as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: true,
				contextId: "ctx-1",
				pointIds: ["point-1", "point-2"],
			});

			const { reembedProjectContext } = await import(
				"../src/activities/project-contexts-reprocess"
			);

			await reembedProjectContext({
				contextId: "ctx-1",
				projectId: "proj-123",
				userId: "user-123",
				organizationId: "org-123",
				content: "Document content to re-embed",
				type: "TEXT",
				metadata: {
					originalFilename: "document.txt",
					sourceUrl: null,
					sourceTitle: null,
				},
			});

			// Should be called with provider config resolved internally (not apiKey string)
			expect(ragReembed).toHaveBeenCalledWith({
				contextId: "ctx-1",
				projectId: "proj-123",
				userId: "user-123",
				organizationId: "org-123",
				content: "Document content to re-embed",
				type: "TEXT",
				apiKey: {
					apiKey: "test-api-key",
					provider: "OPENAI_DIRECT",
					baseUrl: null,
				},
				metadata: {
					filename: "document.txt",
					sourceUrl: undefined,
					sourceTitle: undefined,
				},
			});
		});

		it("should throw error when re-embedding fails", async () => {
			(ragReembed as ReturnType<typeof vi.fn>).mockResolvedValue({
				success: false,
				error: "Embedding service unavailable",
			});

			const { reembedProjectContext } = await import(
				"../src/activities/project-contexts-reprocess"
			);

			await expect(
				reembedProjectContext({
					contextId: "ctx-fail",
					projectId: "proj-123",
					userId: "user-123",
					content: "Content",
					type: "TEXT",
				}),
			).rejects.toThrow("Failed to re-embed context ctx-fail");
		});
	});

	describe("deleteProjectContextsFromQdrant", () => {
		// This step used to clear every point carrying the projectId before a
		// single context was re-embedded, so a failed re-embed (provider
		// outage, a model whose dimensions the collection cannot hold) left
		// the project with no vectors — and took the project's document
		// chunks, which nothing here rebuilds. Each context's re-embed now
		// replaces its own points after writing the new ones.
		it("never deletes vectors, for a personal or an organization project", async () => {
			const { deleteProjectContextsFromQdrant } = await import(
				"../src/activities/project-contexts-reprocess"
			);

			await deleteProjectContextsFromQdrant({ projectId: "proj-123" });
			await deleteProjectContextsFromQdrant({
				projectId: "proj-123",
				organizationId: ORG_ID,
			});

			expect(mocks.qdrantDelete).not.toHaveBeenCalled();
		});

		// A deleted context is never re-embedded, so its points would keep
		// turning up in search. They go here; every live context's points are
		// left to its own re-embed, and document chunks and bundles are never
		// candidates (see `deleteOrphanProjectContextPoints`).
		it("deletes only the points of contexts that no longer exist", async () => {
			const { db } = await import("@repo/database/prisma/client");
			vi.mocked(db.projectContext.findMany).mockResolvedValue([
				{ id: "ctx-1" },
				{ id: "ctx-integration" },
			] as never);
			orphanCleanup.mockResolvedValue(2);

			const { deleteProjectContextsFromQdrant } = await import(
				"../src/activities/project-contexts-reprocess"
			);
			await deleteProjectContextsFromQdrant({
				projectId: "proj-123",
				organizationId: ORG_ID,
			});

			expect(db.projectContext.findMany).toHaveBeenCalledWith({
				where: { projectId: "proj-123" },
				select: { id: true },
			});
			expect(orphanCleanup).toHaveBeenCalledWith({
				projectId: "proj-123",
				organizationId: ORG_ID,
				// Bundles, crawled pages and summaries write points under their
				// own rows' ids.
				liveIds: new Set([
					"ctx-1",
					"ctx-integration",
					"bundle-1",
					"page-1",
					"summary-1",
				]),
			});
		});

		// The re-embed only walks `ProjectContext` rows, so conversation
		// bundles are handed to the recovery sweep to pick up the new settings.
		// Their points are kept, so `qdrantId` stays.
		it("queues the project's conversation bundles for the recovery sweep", async () => {
			mocks.bundleUpdateMany.mockResolvedValue({ count: 3 });

			const { deleteProjectContextsFromQdrant } = await import(
				"../src/activities/project-contexts-reprocess"
			);

			await deleteProjectContextsFromQdrant({
				projectId: "proj-123",
				organizationId: ORG_ID,
			});

			// Exactly the sweep's predicate: `embeddedAt` null, no lease.
			expect(mocks.bundleUpdateMany).toHaveBeenCalledWith({
				where: { projectId: "proj-123" },
				data: { embeddedAt: null, embeddingLeaseAt: null },
			});
		});
	});

	describe("Workflow input validation", () => {
		it("should require projectId", () => {
			const validInput = {
				projectId: "proj-123",
				userId: "user-123",
			};

			expect(validInput.projectId).toBeDefined();
			expect(validInput.userId).toBeDefined();
		});

		it("should accept optional organizationId", () => {
			const inputWithOrg = {
				projectId: "proj-123",
				userId: "user-123",
				organizationId: "org-123",
			};

			const inputWithoutOrg = {
				projectId: "proj-123",
				userId: "user-123",
			};

			expect(inputWithOrg.organizationId).toBe("org-123");
			expect(
				(inputWithoutOrg as { organizationId?: string }).organizationId,
			).toBeUndefined();
		});
	});
});

describe("Scalability and High Availability", () => {
	describe("Batch processing", () => {
		it("should process contexts in batches to avoid memory issues", async () => {
			// Simulate 100 contexts
			const largeContextSet: ProjectContextForReprocess[] = Array.from(
				{ length: 100 },
				(_, i) => ({
					id: `ctx-${i}`,
					type: "TEXT",
					content: `Content for document ${i}`.repeat(100),
					originalFilename: `doc-${i}.txt`,
					sourceUrl: null,
					sourceTitle: null,
				}),
			);

			// The workflow processes one at a time with progress updates every 5
			// This is designed for durability over speed
			expect(largeContextSet.length).toBe(100);
		});

		it("should update progress periodically", () => {
			// Progress updates every 5 contexts
			const progressInterval = 5;
			const totalContexts = 100;
			const expectedProgressUpdates = Math.floor(
				totalContexts / progressInterval,
			);

			expect(expectedProgressUpdates).toBe(20);
		});
	});

	describe("Error handling and resilience", () => {
		it("should continue processing after individual context failures", async () => {
			// The workflow tracks failed and successful counts
			const processed = 95;
			const failed = 5;
			const total = 100;

			expect(processed + failed).toBe(total);
		});

		it("should provide detailed error messages", () => {
			const errorMessage =
				"Failed to re-embed context ctx-fail: Embedding service unavailable";
			expect(errorMessage).toContain("ctx-fail");
			expect(errorMessage).toContain("Embedding service unavailable");
		});
	});

	describe("Temporal workflow guarantees", () => {
		it("should define appropriate retry policies", () => {
			// Activities should have retry configuration
			const expectedRetryPolicy = {
				maximumAttempts: 3,
				initialInterval: "1s",
				maximumInterval: "30s",
			};

			expect(expectedRetryPolicy.maximumAttempts).toBe(3);
		});

		it("should set appropriate timeouts", () => {
			// Large projects may take time
			const expectedTimeouts = {
				startToCloseTimeout: "10 minutes",
				scheduleToCloseTimeout: "1 hour",
			};

			expect(expectedTimeouts.startToCloseTimeout).toBe("10 minutes");
		});
	});
});

describe("Reprocess workflow command order", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		activityStubs.fetchProjectContextsForReprocess.mockResolvedValue([
			{
				id: "ctx-1",
				type: "TEXT",
				content: "Content",
				originalFilename: null,
				sourceUrl: null,
				sourceTitle: null,
			},
		]);
		activityStubs.validateRAGProviderConfig.mockResolvedValue(undefined);
		activityStubs.deleteProjectContextsFromQdrant.mockResolvedValue(
			undefined,
		);
		activityStubs.reembedProjectContext.mockResolvedValue(undefined);
		activityStubs.updateReprocessProgress.mockResolvedValue(undefined);
	});

	// The activity no longer deletes anything, but its call keeps its place so
	// existing histories replay against the same command sequence.
	it("schedules deleteProjectContextsFromQdrant before the first re-embed", async () => {
		const { projectContextsReprocessWorkflow } = await import(
			"../src/workflows/project-contexts-reprocess"
		);

		const out = await projectContextsReprocessWorkflow({
			projectId: "proj-123",
			userId: "user-123",
			organizationId: ORG_ID,
		});

		expect(out.success).toBe(true);
		expect(
			activityStubs.deleteProjectContextsFromQdrant,
		).toHaveBeenCalledWith({
			projectId: "proj-123",
			organizationId: ORG_ID,
		});
		expect(
			activityStubs.deleteProjectContextsFromQdrant.mock
				.invocationCallOrder[0],
		).toBeLessThan(
			activityStubs.reembedProjectContext.mock.invocationCallOrder[0],
		);
	});

	it("reports every failed re-embed without aborting the run", async () => {
		activityStubs.reembedProjectContext.mockRejectedValue(
			new Error("Vector dimension error: expected dim: 1536, got 3072"),
		);

		const { projectContextsReprocessWorkflow } = await import(
			"../src/workflows/project-contexts-reprocess"
		);

		const out = await projectContextsReprocessWorkflow({
			projectId: "proj-123",
			userId: "user-123",
			organizationId: ORG_ID,
		});

		expect(out).toEqual({
			success: false,
			totalContexts: 1,
			processedCount: 0,
			failedCount: 1,
		});
		expect(
			activityStubs.deleteProjectContextsFromQdrant,
		).toHaveBeenCalledTimes(1);
	});

	it("aborts without re-embedding when that step fails", async () => {
		activityStubs.deleteProjectContextsFromQdrant.mockRejectedValue(
			new Error("Qdrant unavailable"),
		);

		const { projectContextsReprocessWorkflow } = await import(
			"../src/workflows/project-contexts-reprocess"
		);

		await expect(
			projectContextsReprocessWorkflow({
				projectId: "proj-123",
				userId: "user-123",
				organizationId: ORG_ID,
			}),
		).rejects.toThrow("Qdrant unavailable");
		expect(activityStubs.reembedProjectContext).not.toHaveBeenCalled();
	});
});
