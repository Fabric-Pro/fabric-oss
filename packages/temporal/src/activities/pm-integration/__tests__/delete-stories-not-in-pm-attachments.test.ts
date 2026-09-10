/**
 * Unit tests for the attachment-cleanup path in `deleteStoriesNotInPMList`.
 *
 * Verifies that R2 attachment objects are reclaimed (via best-effort
 * `deleteObjects`) when PM-sync prunes stories that are no longer in the PM
 * list — closing the orphan-object leak identified in Codex adversarial review
 * Finding 2 (issue #1702).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Heavy-module mock scaffolding — mirrors story-sync-title.test.ts so that
// story-sync.ts resolves without evaluating Prisma / real MCP clients.
// ---------------------------------------------------------------------------

vi.mock("@temporalio/activity", async () => {
	const actual = await vi.importActual<object>("@temporalio/activity");
	return {
		...actual,
		Context: {
			current: () => ({ heartbeat: vi.fn() }),
		},
	};
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	getMcpClientResult: vi.fn(),
	closeMcpClientSafe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

const { resolvePmSource, PMSourceNotFound } = vi.hoisted(() => {
	class PMSourceNotFound extends Error {
		constructor(public reason: string) {
			super(`PM source not resolvable: ${reason}`);
			this.name = "PMSourceNotFound";
		}
	}
	return { resolvePmSource: vi.fn(), PMSourceNotFound };
});
vi.mock("../../pm-source", () => ({ resolvePmSource, PMSourceNotFound }));

const { callPmToolWithFallback } = vi.hoisted(() => ({
	callPmToolWithFallback: vi.fn(),
}));
vi.mock("../../pm-tool-fallback", () => ({
	callPmToolWithFallback,
	GITLAB_REST_CAPABILITIES: {},
}));

vi.mock("../hierarchy-sync", () => ({
	getPmSyncBaseline: vi.fn().mockResolvedValue(null),
	stampPmSyncConflict: vi.fn().mockResolvedValue(undefined),
	stampPmSyncSuccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/integrations/pm", () => ({
	applyLabelStatusMapOnPull: (_state: unknown, _labels: string[]) => ({
		statusId: null,
		labels: [],
	}),
	computeLabelDeltaOnPush: () => ({ addLabels: [], removeLabels: [] }),
	readLabelStatusMap: () => ({}),
}));

// ---------------------------------------------------------------------------
// Hoisted mocks object — all vi.fn()s live here so mocks and test bodies
// share the same references.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
	userStoryFindMany: vi.fn(),
	storyAttachmentFindMany: vi.fn(),
	deleteStory: vi.fn(),
	deleteObjects: vi.fn(),
	loggerWarn: vi.fn(),
	loggerInfo: vi.fn(),
}));

// @repo/database — synchronous factory (no importOriginal) to avoid Prisma.
// Provides everything story-sync.ts imports, plus db.storyAttachment.findMany.
vi.mock("@repo/database", () => ({
	createStory: vi.fn(),
	deleteStory: (...a: unknown[]) => mocks.deleteStory(...a),
	getStoryById: vi.fn(),
	updateStory: vi.fn(),
	updateTask: vi.fn(),
	getMcpConfigById: vi.fn(),
	listStoryStatuses: vi.fn().mockResolvedValue([]),
	formatBackLinkForProvider: (desc: string) => desc,
	normalizeBackLinkFromProvider: (desc: string) => desc,
	HTML_BACK_LINK_RE:
		/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i,
	db: {
		userStory: {
			findMany: (...a: unknown[]) => mocks.userStoryFindMany(...a),
		},
		storyAttachment: {
			findMany: (...a: unknown[]) => mocks.storyAttachmentFindMany(...a),
		},
		projectStoryStatus: { findMany: vi.fn().mockResolvedValue([]) },
	},
}));

// @repo/storage — provides deleteObjects used by the new cleanup block.
vi.mock("@repo/storage", () => ({
	deleteObjects: (...a: unknown[]) => mocks.deleteObjects(...a),
}));

// @repo/config — provides the bucket name.
vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));

// ---------------------------------------------------------------------------
// Import the function under test AFTER all mocks are declared.
// ---------------------------------------------------------------------------

import { logger } from "@repo/logs";
import { deleteStoriesNotInPMList } from "../story-sync";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ID = "proj-1";
const ORG_ID = "org-1";

function makeInput(pmExternalIds: string[], organizationId?: string) {
	return {
		projectId: PROJECT_ID,
		organizationId,
		pmExternalIds,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.clearAllMocks();
	// Default: deleteObjects succeeds with no errors.
	mocks.deleteObjects.mockResolvedValue({ deleted: 1, errors: [] });
	// Default: deleteStory succeeds.
	mocks.deleteStory.mockResolvedValue(undefined);
	// Default: no attachments.
	mocks.storyAttachmentFindMany.mockResolvedValue([]);
});

describe("deleteStoriesNotInPMList — attachment object cleanup", () => {
	it("captures keys and batch-deletes objects for pruned stories", async () => {
		// s1 is pruned (externalId not in PM list), s2 is kept.
		mocks.userStoryFindMany.mockResolvedValue([
			{ id: "s1", identifier: "F-1", externalId: "ext-1" },
			{ id: "s2", identifier: "F-2", externalId: "ext-2" },
		]);
		// s1 has one attachment; s2 is kept so its attachment is irrelevant.
		mocks.storyAttachmentFindMany.mockResolvedValue([
			{ storyId: "s1", storageKey: "story-attachments/p/s1/a.png" },
		]);

		const result = await deleteStoriesNotInPMList(
			makeInput(["ext-2"], ORG_ID), // only ext-2 is in PM
		);

		// Only s1 was deleted.
		expect(result.deletedCount).toBe(1);
		expect(result.deletedIdentifiers).toEqual(["F-1"]);

		// deleteObjects called once with s1's key and the correct bucket.
		expect(mocks.deleteObjects).toHaveBeenCalledTimes(1);
		expect(mocks.deleteObjects).toHaveBeenCalledWith(
			["story-attachments/p/s1/a.png"],
			{ bucket: "project-contexts" },
		);
		expect(mocks.storyAttachmentFindMany).toHaveBeenCalledTimes(1);
		expect(mocks.storyAttachmentFindMany).toHaveBeenCalledWith({
			where: { storyId: { in: ["s1"] } },
			select: { storyId: true, storageKey: true },
		});
	});

	it("does not call deleteObjects when pruned stories have no attachments", async () => {
		mocks.userStoryFindMany.mockResolvedValue([
			{ id: "s1", identifier: "F-1", externalId: "ext-1" },
		]);
		mocks.storyAttachmentFindMany.mockResolvedValue([]); // no attachments

		const result = await deleteStoriesNotInPMList(makeInput([], ORG_ID));

		expect(result.deletedCount).toBe(1);
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
	});

	it("rejects attachment-read failures before starting any story delete", async () => {
		mocks.userStoryFindMany.mockResolvedValue([
			{ id: "s1", identifier: "F-1", externalId: "ext-1" },
		]);
		mocks.storyAttachmentFindMany.mockRejectedValue(
			new Error("attachment read failed"),
		);

		await expect(
			deleteStoriesNotInPMList(makeInput([], ORG_ID)),
		).rejects.toThrow("attachment read failed");
		expect(mocks.deleteStory).not.toHaveBeenCalled();
	});

	it("logs [attachments] warn on deleteObjects errors but resolves with the right count", async () => {
		mocks.userStoryFindMany.mockResolvedValue([
			{ id: "s1", identifier: "F-1", externalId: "ext-1" },
		]);
		mocks.storyAttachmentFindMany.mockResolvedValue([
			{ storyId: "s1", storageKey: "story-attachments/p/s1/b.pdf" },
		]);
		// deleteObjects returns errors (R2 denied).
		mocks.deleteObjects.mockResolvedValue({
			deleted: 0,
			errors: [
				{ key: "story-attachments/p/s1/b.pdf", message: "denied" },
			],
		});

		const result = await deleteStoriesNotInPMList(makeInput([], ORG_ID));

		// Still reports the DB deletion as successful.
		expect(result.deletedCount).toBe(1);

		// A [attachments] warn must have been logged.
		expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
			expect.stringMatching(/\[attachments\]/),
			expect.anything(),
		);
	});

	it("skips object deletion for a story whose deleteStory throws", async () => {
		mocks.userStoryFindMany.mockResolvedValue([
			{ id: "s1", identifier: "F-1", externalId: "ext-1" },
		]);
		mocks.storyAttachmentFindMany.mockResolvedValue([
			{ storyId: "s1", storageKey: "story-attachments/p/s1/c.jpg" },
		]);
		// deleteStory rejects — the story was NOT removed from the DB.
		mocks.deleteStory.mockRejectedValue(new Error("DB constraint"));

		const result = await deleteStoriesNotInPMList(makeInput([], ORG_ID));

		// Nothing was deleted.
		expect(result.deletedCount).toBe(0);
		expect(result.deletedIdentifiers).toEqual([]);

		// deleteObjects must NOT have been called (the row still exists, object
		// should not be orphaned).
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
	});

	it("batches attachments and keeps successful deletes when another delete fails", async () => {
		mocks.userStoryFindMany.mockResolvedValue([
			{ id: "s1", identifier: "F-1", externalId: "ext-1" },
			{ id: "s2", identifier: "F-2", externalId: "ext-2" },
			{ id: "s3", identifier: "F-3", externalId: "ext-3" },
			{ id: "s4", identifier: "F-4", externalId: "ext-4" },
			{ id: "s5", identifier: "F-5", externalId: "ext-5" },
		]);
		mocks.storyAttachmentFindMany.mockResolvedValue([
			{ storyId: "s1", storageKey: "story-attachments/p/s1/a.png" },
			{ storyId: "s2", storageKey: "story-attachments/p/s2/b.png" },
			{ storyId: "s3", storageKey: "story-attachments/p/s3/c.png" },
			{ storyId: "s4", storageKey: "story-attachments/p/s4/d.png" },
			{ storyId: "s5", storageKey: "story-attachments/p/s5/e.png" },
		]);
		let activeDeletes = 0;
		let maxConcurrentDeletes = 0;
		mocks.deleteStory.mockImplementation(async (storyId: string) => {
			activeDeletes++;
			maxConcurrentDeletes = Math.max(
				maxConcurrentDeletes,
				activeDeletes,
			);
			await Promise.resolve();
			activeDeletes--;
			if (storyId === "s2") {
				throw new Error("constraint");
			}
		});

		const result = await deleteStoriesNotInPMList(makeInput([], ORG_ID));

		expect(mocks.storyAttachmentFindMany).toHaveBeenCalledTimes(1);
		expect(mocks.storyAttachmentFindMany).toHaveBeenCalledWith({
			where: { storyId: { in: ["s1", "s2", "s3", "s4", "s5"] } },
			select: { storyId: true, storageKey: true },
		});
		expect(mocks.deleteStory).toHaveBeenCalledTimes(5);
		expect(maxConcurrentDeletes).toBe(4);
		expect(result).toEqual({
			deletedCount: 4,
			deletedIdentifiers: ["F-1", "F-3", "F-4", "F-5"],
		});
		expect(mocks.deleteObjects).toHaveBeenCalledWith(
			[
				"story-attachments/p/s1/a.png",
				"story-attachments/p/s3/c.png",
				"story-attachments/p/s4/d.png",
				"story-attachments/p/s5/e.png",
			],
			{ bucket: "project-contexts" },
		);
	});
});
