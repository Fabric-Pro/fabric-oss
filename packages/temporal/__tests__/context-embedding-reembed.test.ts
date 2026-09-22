/**
 * `reembed` on the context-embedding path (Fizzy #2616).
 *
 * A synced knowledge file whose content was replaced is embedded again under
 * the same context id, and chunk points are keyed `<contextId>-chunk-N`. A
 * version with fewer chunks than the one before it would leave the tail of
 * the old version in Qdrant, answering searches with text the file no longer
 * has. So a replace asks for `reembed: true`, and the activity then deletes
 * every point for the context by filter — strictly, so a failed delete fails
 * the activity and Temporal retries it — and only then embeds.
 *
 * Two replaces inside the embedding window each start a workflow, and each
 * activity reads the row when it runs, so they can interleave: A reads V2, B
 * reads V3, B embeds V3, A embeds V2. The activity therefore re-reads the
 * row's `contentHash` after embedding and goes round again while it moved,
 * bounded, and marks `embeddedAt` only for the version it actually embedded.
 *
 * `deleteProjectContext` and `embedProjectContext` are mocked separately (not
 * `reembedProjectContext` whole) so the order and the failure paths are
 * observable.
 *
 * The workflow only carries the flag through to the activity; its control
 * flow is unchanged, and an input without the flag schedules the activity
 * with exactly the arguments it always did.
 *
 * Run with: pnpm --filter @repo/temporal test -- __tests__/context-embedding-reembed.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	embedProjectContext: vi.fn(),
	reembedProjectContext: vi.fn(),
	deleteProjectContext: vi.fn(),
	getSystemRAGProviderConfig: vi.fn(),
	updateContextExtractionStatus: vi.fn(),
	recordContextIndexingFailure: vi.fn(),
	findUnique: vi.fn(),
	updateMany: vi.fn(),
	embedSingleContextActivity: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class extends Error {},
	getSystemRAGProviderConfig: mocks.getSystemRAGProviderConfig,
}));

vi.mock("@repo/database", () => ({
	db: {
		projectContext: {
			findUnique: mocks.findUnique,
			updateMany: mocks.updateMany,
		},
	},
	updateContextExtractionStatus: mocks.updateContextExtractionStatus,
	recordContextIndexingFailure: mocks.recordContextIndexingFailure,
}));

vi.mock("@repo/rag", () => ({
	embedProjectContext: mocks.embedProjectContext,
	reembedProjectContext: mocks.reembedProjectContext,
	deleteProjectContext: mocks.deleteProjectContext,
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

vi.mock("../src/activities/lib/activity-logger", () => ({
	activityLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@temporalio/workflow", () => ({
	ApplicationFailure: {
		nonRetryable: (message: string) => new Error(message),
	},
	proxyActivities: vi.fn(() => ({
		embedSingleContextActivity: mocks.embedSingleContextActivity,
	})),
}));

import { embedSingleContextActivity } from "../src/activities/context-embedding";
import { contextEmbeddingWorkflow } from "../src/workflows/context-embedding";

const input = {
	contextId: "ctx-1",
	projectId: "proj-1",
	userId: "user-1",
	organizationId: "org-1",
	type: "TEXT",
	metadata: {
		filename: "docs/architecture.md",
		sourceTitle: "architecture.md",
	},
};

const V2 = { content: "# Architecture\n\nv2\n", contentHash: "a".repeat(64) };
const V3 = { content: "# Architecture\n\nv3\n", contentHash: "b".repeat(64) };

const embedded = { success: true, qdrantId: "ctx-1-chunk-0", chunksCreated: 2 };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSystemRAGProviderConfig.mockResolvedValue({ apiKey: "key" });
	mocks.embedProjectContext.mockResolvedValue(embedded);
	mocks.reembedProjectContext.mockResolvedValue(embedded);
	mocks.deleteProjectContext.mockResolvedValue(undefined);
	mocks.updateContextExtractionStatus.mockResolvedValue(undefined);
	mocks.recordContextIndexingFailure.mockResolvedValue(undefined);
	// Reset, not just clear: a test that queues `mockResolvedValueOnce`
	// values must not leak unconsumed ones into the next.
	mocks.findUnique.mockReset();
	mocks.findUnique.mockResolvedValue(V2);
	mocks.updateMany.mockResolvedValue({ count: 1 });
	mocks.embedSingleContextActivity.mockResolvedValue({
		success: true,
		qdrantId: "ctx-1-chunk-0",
	});
});

describe("embedSingleContextActivity — reembed", () => {
	it("deletes the old chunks strictly, then embeds the stored version", async () => {
		const result = await embedSingleContextActivity({
			...input,
			reembed: true,
		});

		expect(result).toEqual({ success: true, qdrantId: "ctx-1-chunk-0" });
		expect(mocks.deleteProjectContext).toHaveBeenCalledTimes(1);
		expect(mocks.deleteProjectContext).toHaveBeenCalledWith(
			"ctx-1",
			"org-1",
			undefined,
			{ strict: true },
		);
		expect(mocks.embedProjectContext).toHaveBeenCalledTimes(1);
		expect(mocks.embedProjectContext).toHaveBeenCalledWith(
			expect.objectContaining({
				contextId: "ctx-1",
				projectId: "proj-1",
				organizationId: "org-1",
				// Read back from the row: the caller did not send the body.
				content: V2.content,
				metadata: input.metadata,
				// The activity marks the row itself, for the version it
				// embedded, rather than letting the embed mark whatever the
				// row holds by then.
				skipDbUpdate: true,
			}),
		);
		expect(
			mocks.deleteProjectContext.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.embedProjectContext.mock.invocationCallOrder[0]);
		expect(mocks.reembedProjectContext).not.toHaveBeenCalled();
		expect(mocks.updateMany).toHaveBeenCalledTimes(1);
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "ctx-1", contentHash: V2.contentHash },
			data: { qdrantId: "ctx-1-chunk-0", embeddedAt: expect.any(Date) },
		});
		expect(mocks.updateContextExtractionStatus).toHaveBeenCalledWith(
			"ctx-1",
			"COMPLETED",
			{ extractionError: null },
		);
	});

	it("deletes the row's points and embeds nothing when the row is gone", async () => {
		// A retry after the missing-row cleanup failed: the row is gone but
		// points from the earlier attempt may still be in the index.
		mocks.findUnique.mockReset();
		mocks.findUnique.mockResolvedValue(null);

		const result = await embedSingleContextActivity({
			...input,
			reembed: true,
		});

		expect(result).toEqual({ success: true });
		expect(mocks.deleteProjectContext).toHaveBeenCalledTimes(1);
		expect(mocks.deleteProjectContext).toHaveBeenCalledWith(
			"ctx-1",
			"org-1",
			undefined,
			{ strict: true },
		);
		expect(mocks.embedProjectContext).not.toHaveBeenCalled();
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("fails the activity, and embeds nothing, when the delete fails", async () => {
		// Swallowing this would leave a shrunk file's stale tail in the index
		// while the activity reports success, and Temporal would never retry.
		mocks.deleteProjectContext.mockRejectedValue(
			new Error("Failed to delete project context: qdrant unavailable"),
		);

		await expect(
			embedSingleContextActivity({ ...input, reembed: true }),
		).rejects.toThrow("qdrant unavailable");

		expect(mocks.embedProjectContext).not.toHaveBeenCalled();
		expect(mocks.updateMany).not.toHaveBeenCalled();
		expect(mocks.updateContextExtractionStatus).not.toHaveBeenCalled();
		expect(mocks.recordContextIndexingFailure).toHaveBeenCalledWith(
			"ctx-1",
			"Search indexing failed: Failed to delete project context: qdrant unavailable",
		);
	});

	it("embeds again when the row was replaced while it was embedding, ending on the newer version", async () => {
		// First read: V2. Post-embed re-read: V3 (another replace landed).
		// The second pass reads V3's content; its re-read confirms V3.
		mocks.findUnique
			.mockResolvedValueOnce(V2)
			.mockResolvedValueOnce({ contentHash: V3.contentHash })
			.mockResolvedValueOnce(V3)
			.mockResolvedValueOnce({ contentHash: V3.contentHash });

		const result = await embedSingleContextActivity({
			...input,
			reembed: true,
		});

		expect(result.success).toBe(true);
		expect(mocks.embedProjectContext).toHaveBeenCalledTimes(2);
		expect(mocks.embedProjectContext.mock.calls[0][0].content).toBe(
			V2.content,
		);
		expect(mocks.embedProjectContext.mock.calls[1][0].content).toBe(
			V3.content,
		);
		// Each pass deletes before it embeds, so V2's chunks do not outlive
		// the pass that replaced them.
		expect(mocks.deleteProjectContext).toHaveBeenCalledTimes(2);
		expect(
			mocks.deleteProjectContext.mock.invocationCallOrder[1],
		).toBeLessThan(mocks.embedProjectContext.mock.invocationCallOrder[1]);
		expect(
			mocks.embedProjectContext.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.deleteProjectContext.mock.invocationCallOrder[1]);
		// Marked once, for V3 only.
		expect(mocks.updateMany).toHaveBeenCalledTimes(1);
		expect(mocks.updateMany.mock.calls[0][0].where).toEqual({
			id: "ctx-1",
			contentHash: V3.contentHash,
		});
	});

	it("throws after the bound when the row never settles, and marks nothing", async () => {
		let version = 0;
		mocks.findUnique.mockImplementation(async () => {
			version += 1;
			return {
				content: `# Architecture\n\nv${version}\n`,
				contentHash: String(version).padStart(64, "0"),
			};
		});

		await expect(
			embedSingleContextActivity({ ...input, reembed: true }),
		).rejects.toThrow(/kept changing/);

		expect(mocks.embedProjectContext).toHaveBeenCalledTimes(3);
		expect(mocks.deleteProjectContext).toHaveBeenCalledTimes(3);
		expect(mocks.updateMany).not.toHaveBeenCalled();
		expect(mocks.updateContextExtractionStatus).not.toHaveBeenCalled();
	});

	it("embeds without deleting when reembed is not set", async () => {
		await embedSingleContextActivity(input);

		expect(mocks.embedProjectContext).toHaveBeenCalledTimes(1);
		expect(mocks.embedProjectContext.mock.calls[0][0]).not.toHaveProperty(
			"skipDbUpdate",
		);
		expect(mocks.deleteProjectContext).not.toHaveBeenCalled();
		expect(mocks.reembedProjectContext).not.toHaveBeenCalled();
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("embeds without deleting when reembed is false", async () => {
		await embedSingleContextActivity({ ...input, reembed: false });

		expect(mocks.embedProjectContext).toHaveBeenCalledTimes(1);
		expect(mocks.deleteProjectContext).not.toHaveBeenCalled();
		expect(mocks.reembedProjectContext).not.toHaveBeenCalled();
	});

	it("treats a failed re-embed like a failed embed, so Temporal retries it", async () => {
		mocks.embedProjectContext.mockResolvedValue({
			success: false,
			error: "deployment does not exist",
		});

		await expect(
			embedSingleContextActivity({ ...input, reembed: true }),
		).rejects.toThrow("deployment does not exist");
		expect(mocks.updateMany).not.toHaveBeenCalled();
		expect(mocks.recordContextIndexingFailure).toHaveBeenCalledWith(
			"ctx-1",
			"Search indexing failed: deployment does not exist",
		);
	});
});

describe("contextEmbeddingWorkflow — reembed passes through", () => {
	it("hands reembed to the activity", async () => {
		await contextEmbeddingWorkflow({ ...input, reembed: true });

		expect(mocks.embedSingleContextActivity).toHaveBeenCalledWith(
			expect.objectContaining({ contextId: "ctx-1", reembed: true }),
		);
	});

	it("schedules the activity with the same arguments as before when the flag is absent", async () => {
		await contextEmbeddingWorkflow(input);

		const [args] = mocks.embedSingleContextActivity.mock.calls[0];
		// `undefined` is dropped by the payload converter, so an input
		// without the flag serialises exactly as it did before the field
		// existed.
		expect(JSON.parse(JSON.stringify(args))).toEqual({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: "org-1",
			type: "TEXT",
			metadata: input.metadata,
		});
	});
});
