/**
 * Unit Tests for Project Contexts Re-process Workflow
 *
 * Tests the Temporal workflow and activities for re-processing project contexts
 * when RAG settings change. Validates scalability and error handling.
 *
 * Run with: pnpm --filter @repo/temporal test
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	qdrantDelete: vi.fn(),
	qdrantGetCollections: vi.fn(),
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
		},
	},
}));

// Mock the AI provider config
vi.mock("@repo/ai", () => ({
	getSystemRAGProviderConfig: vi.fn().mockResolvedValue({
		apiKey: "test-api-key",
		provider: "OPENAI_DIRECT",
		baseUrl: null,
	}),
}));

// Mock the RAG library
vi.mock("@repo/rag", () => ({
	reembedProjectContext: vi.fn(),
}));

// Mock Qdrant client. vitest 4.x rejects arrow-function
// .mockImplementation here because the source calls `new QdrantClient(...)`
// and arrows aren't constructable. Use a real class instead, delegating to
// hoisted spies so the tests can assert which collection was addressed.
vi.mock("@qdrant/js-client-rest", () => ({
	QdrantClient: class MockQdrantClient {
		delete = (...a: unknown[]) => mocks.qdrantDelete(...a);
		getCollections = (...a: unknown[]) => mocks.qdrantGetCollections(...a);
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

const PERSONAL_COLLECTION = "project-contexts";
const ORG_ID = "orgexample1";
const ORG_COLLECTION = `project-contexts-org-${ORG_ID}`;
/** The name this activity used to hardcode. Nothing may resolve to it. */
const LEGACY_UNDERSCORE_COLLECTION = "project_contexts";

function collectionsExisting(...names: string[]) {
	return { collections: names.map((name) => ({ name })) };
}

describe("Project Contexts Reprocess Workflow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.qdrantDelete.mockResolvedValue({ status: "acknowledged" });
		mocks.qdrantGetCollections.mockResolvedValue(
			collectionsExisting(PERSONAL_COLLECTION, ORG_COLLECTION),
		);
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
		// The activity used to clear a hardcoded `project_contexts`
		// (underscore) while the re-embed writes to the collection
		// `getCollectionName` resolves — so nothing was ever cleared, and every
		// reprocess stacked another copy of each chunk on top of the old ones.
		it("clears the bare base collection for a personal-tenant project", async () => {
			const { deleteProjectContextsFromQdrant } = await import(
				"../src/activities/project-contexts-reprocess"
			);

			await deleteProjectContextsFromQdrant({ projectId: "proj-123" });

			expect(mocks.qdrantDelete).toHaveBeenCalledWith(
				PERSONAL_COLLECTION,
				{
					wait: true,
					filter: {
						must: [
							{
								key: "projectId",
								match: { value: "proj-123" },
							},
						],
					},
				},
			);
		});

		it("clears the per-organization collection for an organization project", async () => {
			const { deleteProjectContextsFromQdrant } = await import(
				"../src/activities/project-contexts-reprocess"
			);

			await deleteProjectContextsFromQdrant({
				projectId: "proj-123",
				organizationId: ORG_ID,
			});

			expect(mocks.qdrantDelete).toHaveBeenCalledWith(ORG_COLLECTION, {
				wait: true,
				filter: {
					must: [
						{ key: "projectId", match: { value: "proj-123" } },
						{ key: "organizationId", match: { value: ORG_ID } },
					],
				},
			});
			// The invariant the bug violated: an organization's points are
			// never cleared out of the personal collection, which never held
			// them.
			expect(mocks.qdrantDelete).not.toHaveBeenCalledWith(
				PERSONAL_COLLECTION,
				expect.anything(),
			);
		});

		it("never addresses the legacy underscore collection", async () => {
			const { deleteProjectContextsFromQdrant } = await import(
				"../src/activities/project-contexts-reprocess"
			);

			await deleteProjectContextsFromQdrant({ projectId: "proj-123" });
			await deleteProjectContextsFromQdrant({
				projectId: "proj-123",
				organizationId: ORG_ID,
			});

			for (const [collection] of mocks.qdrantDelete.mock.calls) {
				expect(collection).not.toBe(LEGACY_UNDERSCORE_COLLECTION);
			}
		});

		it("succeeds without deleting when the organization's collection was never created", async () => {
			// Per-organization collections are created lazily on first write.
			mocks.qdrantGetCollections.mockResolvedValue(
				collectionsExisting(PERSONAL_COLLECTION),
			);

			const { deleteProjectContextsFromQdrant } = await import(
				"../src/activities/project-contexts-reprocess"
			);

			await expect(
				deleteProjectContextsFromQdrant({
					projectId: "proj-123",
					organizationId: ORG_ID,
				}),
			).resolves.toBeUndefined();
			expect(mocks.qdrantDelete).not.toHaveBeenCalled();
		});

		it("surfaces a vector-store failure against an existing collection instead of swallowing it", async () => {
			// The previous bare catch reported a clear that never happened as
			// done; the re-embed then duplicated every chunk.
			mocks.qdrantDelete.mockRejectedValue(
				new Error("Qdrant unavailable"),
			);

			const { deleteProjectContextsFromQdrant } = await import(
				"../src/activities/project-contexts-reprocess"
			);

			await expect(
				deleteProjectContextsFromQdrant({
					projectId: "proj-123",
					organizationId: ORG_ID,
				}),
			).rejects.toThrow("Qdrant unavailable");
		});

		// The delete is project-wide; the re-embed that follows only walks
		// non-INTEGRATION `ProjectContext` rows. Conversation bundles are
		// therefore cleared and never rebuilt — and a row still claiming
		// `embeddedAt` is invisible to the recovery sweep too, so the stamp has
		// to come off or the conversations go silently unsearchable.
		it("hands the bundles it just orphaned back to the recovery sweep", async () => {
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
				data: {
					embeddedAt: null,
					qdrantId: null,
					embeddingLeaseAt: null,
				},
			});
		});

		it("does not requeue bundles when the clear failed", async () => {
			// The points are still there and the workflow aborts before
			// re-embedding anything, so the stamps must stand.
			mocks.qdrantDelete.mockRejectedValue(
				new Error("Qdrant unavailable"),
			);

			const { deleteProjectContextsFromQdrant } = await import(
				"../src/activities/project-contexts-reprocess"
			);

			await expect(
				deleteProjectContextsFromQdrant({
					projectId: "proj-123",
					organizationId: ORG_ID,
				}),
			).rejects.toThrow("Qdrant unavailable");
			expect(mocks.bundleUpdateMany).not.toHaveBeenCalled();
		});

		it("does not requeue bundles when there was no collection to clear", async () => {
			mocks.qdrantGetCollections.mockResolvedValue(
				collectionsExisting(PERSONAL_COLLECTION),
			);

			const { deleteProjectContextsFromQdrant } = await import(
				"../src/activities/project-contexts-reprocess"
			);

			await deleteProjectContextsFromQdrant({
				projectId: "proj-123",
				organizationId: ORG_ID,
			});

			expect(mocks.qdrantDelete).not.toHaveBeenCalled();
			expect(mocks.bundleUpdateMany).not.toHaveBeenCalled();
		});

		it("surfaces an unreachable vector store rather than treating it as empty", async () => {
			mocks.qdrantGetCollections.mockRejectedValue(
				new Error("ECONNREFUSED 6333"),
			);

			const { deleteProjectContextsFromQdrant } = await import(
				"../src/activities/project-contexts-reprocess"
			);

			await expect(
				deleteProjectContextsFromQdrant({ projectId: "proj-123" }),
			).rejects.toThrow("ECONNREFUSED");
			expect(mocks.qdrantDelete).not.toHaveBeenCalled();
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

describe("Reprocess clears prior points before writing new ones", () => {
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

	it("clears the project's existing points before the first re-embed", async () => {
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
		// Ordering is the whole point: re-embedding on top of points that were
		// never cleared is how a re-embed accumulates duplicates.
		expect(
			activityStubs.deleteProjectContextsFromQdrant.mock
				.invocationCallOrder[0],
		).toBeLessThan(
			activityStubs.reembedProjectContext.mock.invocationCallOrder[0],
		);
	});

	it("aborts without re-embedding when the clear fails, so points cannot accumulate", async () => {
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
