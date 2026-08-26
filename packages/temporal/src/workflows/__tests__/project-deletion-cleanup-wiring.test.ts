import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	permanentDeleteProjectFromDbActivity: vi.fn(),
	deleteProjectFromQdrantActivity: vi.fn(),
	deleteProjectAttachmentsFromStorageActivity: vi.fn(),
	captureProjectDocumentIdsActivity: vi.fn(),
	deleteProjectDocumentBlobsFromStorageActivity: vi.fn(),
	getExpiredProjectsActivity: vi.fn(),
	getProjectsNeedingReminderActivity: vi.fn(),
	sendProjectDeletionReminderActivity: vi.fn(),
}));
const wf = vi.hoisted(() => ({ patched: vi.fn() }));

vi.mock("@temporalio/workflow", async () => {
	const actual = await vi.importActual<typeof import("@temporalio/workflow")>(
		"@temporalio/workflow",
	);
	return {
		ApplicationFailure: actual.ApplicationFailure,
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		patched: (...a: unknown[]) => wf.patched(...a),
		proxyActivities: vi.fn(() => activityStubs),
	};
});

import {
	projectDeleteCleanupWorkflow,
	projectPermanentDeleteWorkflow,
} from "../project-deletion";

beforeEach(() => {
	vi.clearAllMocks();
	wf.patched.mockReturnValue(true);
	activityStubs.permanentDeleteProjectFromDbActivity.mockResolvedValue({
		success: true,
	});
	activityStubs.deleteProjectFromQdrantActivity.mockResolvedValue({
		success: true,
	});
	activityStubs.deleteProjectAttachmentsFromStorageActivity.mockResolvedValue(
		{ deleted: 0, pages: 1 },
	);
	activityStubs.captureProjectDocumentIdsActivity.mockResolvedValue({
		documentIds: [],
	});
	activityStubs.deleteProjectDocumentBlobsFromStorageActivity.mockResolvedValue(
		{ deleted: 0, pages: 0 },
	);
	activityStubs.getProjectsNeedingReminderActivity.mockResolvedValue([]);
	activityStubs.getExpiredProjectsActivity.mockResolvedValue([]);
});

describe("projectPermanentDeleteWorkflow — attachment cleanup wiring", () => {
	it("schedules cleanup AFTER Qdrant when the patch is active", async () => {
		const out = await projectPermanentDeleteWorkflow({
			projectId: "p1",
			userId: "u1",
			organizationId: "o1",
		});
		expect(out.success).toBe(true);
		expect(
			activityStubs.deleteProjectAttachmentsFromStorageActivity,
		).toHaveBeenCalledWith({
			projectId: "p1",
		});
		expect(
			activityStubs.deleteProjectFromQdrantActivity.mock
				.invocationCallOrder[0],
		).toBeLessThan(
			activityStubs.deleteProjectAttachmentsFromStorageActivity.mock
				.invocationCallOrder[0],
		);
	});

	it("does NOT schedule cleanup when the patch is inactive (replay of pre-change history)", async () => {
		wf.patched.mockReturnValue(false);
		await projectPermanentDeleteWorkflow({ projectId: "p1", userId: "u1" });
		expect(
			activityStubs.deleteProjectAttachmentsFromStorageActivity,
		).not.toHaveBeenCalled();
	});

	it("swallows a cleanup failure — workflow still succeeds (project is deleted)", async () => {
		activityStubs.deleteProjectAttachmentsFromStorageActivity.mockRejectedValue(
			new Error("bucket down"),
		);
		const out = await projectPermanentDeleteWorkflow({
			projectId: "p1",
			userId: "u1",
		});
		expect(out.success).toBe(true);
	});
});

describe("projectDeleteCleanupWorkflow — attachment cleanup wiring", () => {
	it("schedules cleanup once per expired project, AFTER that project's Qdrant step, gated by the patch id", async () => {
		activityStubs.getExpiredProjectsActivity.mockResolvedValue([
			{ id: "p1", name: "P1", organizationId: "o1" },
			{ id: "p2", name: "P2", organizationId: null },
		]);
		const out = await projectDeleteCleanupWorkflow({ batchSize: 100 });
		expect(out.projectsDeleted).toBe(2);
		expect(
			activityStubs.deleteProjectAttachmentsFromStorageActivity,
		).toHaveBeenCalledTimes(2);
		expect(
			activityStubs.deleteProjectAttachmentsFromStorageActivity,
		).toHaveBeenNthCalledWith(1, {
			projectId: "p1",
		});
		expect(
			activityStubs.deleteProjectAttachmentsFromStorageActivity,
		).toHaveBeenNthCalledWith(2, {
			projectId: "p2",
		});
		// The scheduled loop must use the SAME patch id.
		expect(wf.patched).toHaveBeenCalledWith(
			"attachment-r2-cleanup-on-project-delete",
		);
		// Per-project ordering: each project's Qdrant call precedes its cleanup call.
		const qOrder =
			activityStubs.deleteProjectFromQdrantActivity.mock
				.invocationCallOrder;
		const cOrder =
			activityStubs.deleteProjectAttachmentsFromStorageActivity.mock
				.invocationCallOrder;
		expect(qOrder[0]).toBeLessThan(cOrder[0]);
		expect(qOrder[1]).toBeLessThan(cOrder[1]);
	});

	it("does NOT schedule cleanup in the scheduled loop when the patch is inactive", async () => {
		wf.patched.mockReturnValue(false);
		activityStubs.getExpiredProjectsActivity.mockResolvedValue([
			{ id: "p1", name: "P1", organizationId: null },
		]);
		const out = await projectDeleteCleanupWorkflow({ batchSize: 100 });
		expect(out.projectsDeleted).toBe(1);
		expect(
			activityStubs.deleteProjectAttachmentsFromStorageActivity,
		).not.toHaveBeenCalled();
	});

	it("a cleanup failure for one project does not fail the run", async () => {
		activityStubs.getExpiredProjectsActivity.mockResolvedValue([
			{ id: "p1", name: "P1", organizationId: null },
		]);
		activityStubs.deleteProjectAttachmentsFromStorageActivity.mockRejectedValue(
			new Error("denied"),
		);
		const out = await projectDeleteCleanupWorkflow({ batchSize: 100 });
		expect(out.success).toBe(true);
		expect(out.projectsDeleted).toBe(1);
	});
});

describe("projectPermanentDeleteWorkflow — document-blob cleanup wiring (M12)", () => {
	it("captures document ids BEFORE the DB delete and purges blobs AFTER, gated by the patch id", async () => {
		activityStubs.captureProjectDocumentIdsActivity.mockResolvedValue({
			documentIds: ["d1", "d2"],
		});
		const out = await projectPermanentDeleteWorkflow({
			projectId: "p1",
			userId: "u1",
			organizationId: "o1",
		});
		expect(out.success).toBe(true);

		const captureOrder =
			activityStubs.captureProjectDocumentIdsActivity.mock
				.invocationCallOrder[0];
		const dbOrder =
			activityStubs.permanentDeleteProjectFromDbActivity.mock
				.invocationCallOrder[0];
		// capture runs BEFORE the DB cascade (ids would be gone after)
		expect(captureOrder).toBeLessThan(dbOrder);

		expect(
			activityStubs.deleteProjectDocumentBlobsFromStorageActivity,
		).toHaveBeenCalledWith({ projectId: "p1", documentIds: ["d1", "d2"] });
		const blobOrder =
			activityStubs.deleteProjectDocumentBlobsFromStorageActivity.mock
				.invocationCallOrder[0];
		// blob purge runs AFTER the DB delete
		expect(dbOrder).toBeLessThan(blobOrder);

		expect(wf.patched).toHaveBeenCalledWith(
			"project-document-blob-cleanup-on-delete",
		);
	});

	it("skips the blob purge when the project has no documents", async () => {
		activityStubs.captureProjectDocumentIdsActivity.mockResolvedValue({
			documentIds: [],
		});
		await projectPermanentDeleteWorkflow({ projectId: "p1", userId: "u1" });
		expect(
			activityStubs.deleteProjectDocumentBlobsFromStorageActivity,
		).not.toHaveBeenCalled();
	});

	it("does NOT capture or purge when the patch is inactive (replay of pre-change history)", async () => {
		wf.patched.mockReturnValue(false);
		await projectPermanentDeleteWorkflow({ projectId: "p1", userId: "u1" });
		expect(
			activityStubs.captureProjectDocumentIdsActivity,
		).not.toHaveBeenCalled();
		expect(
			activityStubs.deleteProjectDocumentBlobsFromStorageActivity,
		).not.toHaveBeenCalled();
	});
});
