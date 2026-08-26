/**
 * Attachment-push failure reporting (Fizzy #1745, AC-4/AC-9/AC-10).
 *
 * AC-4 requires a failed attachment upload to appear "in the Fabric sync log
 * and notification centre". Before this round the push path handled
 * `reconciled.failures` with a bare `logger.warn` and then stamped the run
 * `SUCCESS` unconditionally, so a push in which every file failed rendered as
 * a green row in Sync History and produced no notification — a silent
 * failure of exactly the kind the card's UC-3 is written against.
 *
 * These tests drive the REAL adapter (bytes mocked at `@repo/storage`, the
 * GitLab response stubbed at `fetch`) rather than a stub adapter, so the
 * descriptive message added for AC-10 is proven to survive all the way into
 * the sync-log row a person actually reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", async () => {
	const actual = await vi.importActual<object>("@temporalio/activity");
	return {
		...actual,
		Context: { current: () => ({ heartbeat: vi.fn() }) },
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

vi.mock("@repo/storage", () => ({
	downloadFile: vi.fn(async () => ({
		data: Buffer.from([1, 2, 3]),
		contentType: "application/pdf",
		size: 3,
	})),
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

const {
	getStoryById,
	updateStory,
	findManyStatuses,
	getStoryAttachmentsForSync,
	updateStoryAttachmentSyncState,
	findUniqueProject,
	createPmSyncLog,
	createPmAttachmentSyncFailedNotification,
} = vi.hoisted(() => ({
	getStoryById: vi.fn(),
	updateStory: vi.fn(),
	findManyStatuses: vi.fn(),
	getStoryAttachmentsForSync: vi.fn(),
	updateStoryAttachmentSyncState: vi.fn(),
	findUniqueProject: vi.fn(),
	createPmSyncLog: vi.fn(),
	createPmAttachmentSyncFailedNotification: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	createStory: vi.fn(),
	deleteStory: vi.fn(),
	getStoryById,
	updateStory,
	updateTask: vi.fn(),
	getMcpConfigById: vi.fn(),
	isProjectReadOnly: vi.fn(async () => false),
	listStoryStatuses: vi.fn().mockResolvedValue([]),
	formatBackLinkForProvider: (desc: string) => desc,
	normalizeBackLinkFromProvider: (desc: string) => desc,
	HTML_BACK_LINK_RE:
		/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i,
	getStoryAttachmentsForSync,
	updateStoryAttachmentSyncState,
	createPmSyncLog,
	createPmAttachmentSyncFailedNotification,
	db: {
		projectStoryStatus: { findMany: findManyStatuses },
		project: { findUnique: findUniqueProject },
	},
}));

const { ingestPulledImages } = vi.hoisted(() => ({
	ingestPulledImages: vi.fn(),
}));
vi.mock("@repo/integrations/pm/pull-image-ingest", () => ({
	ingestPulledImages,
	buildGitLabIngestOptions: vi.fn(() => ({})),
	stripFailedMediaPlaceholders: (d: string) => d,
	stripGitLabImageAttributes: (d: string) => d,
}));
vi.mock("@repo/integrations/pm/pull-image-store", () => ({
	createStoryMediaPullStore: vi.fn(() => ({})),
}));

vi.mock("@repo/integrations/pm", () => ({
	applyLabelStatusMapOnPull: () => ({ kind: "none", remainingLabels: [] }),
	computeLabelDeltaOnPush: () => ({ addLabels: [], removeLabels: [] }),
	readLabelStatusMap: () => ({}),
}));

vi.mock("../hierarchy-sync", () => ({
	getPmSyncBaseline: vi.fn().mockResolvedValue(null),
	stampPmSyncConflict: vi.fn().mockResolvedValue(undefined),
	stampPmSyncSuccess: vi.fn().mockResolvedValue(undefined),
}));

import { syncGitLabStoryViaRest } from "../gitlab-rest-story-sync";
import { getPmSyncBaseline, stampPmSyncConflict } from "../hierarchy-sync";

const STORY_TITLE = "Add login";

function makeStory(overrides: Record<string, unknown> = {}) {
	return {
		id: "story-1",
		projectId: "proj-1",
		identifier: "12",
		title: STORY_TITLE,
		description: "Body",
		acceptanceCriteria: null,
		releaseNotes: null,
		priority: null,
		size: null,
		storyPoints: null,
		labels: [],
		statusId: "status-todo",
		lastSyncedStatusId: null,
		externalId: "42",
		externalUrl: "https://gitlab.com/g/p/-/issues/42",
		externalMcpServerId: "server-1",
		pmTicketTerminal: false,
		draftingStage: null,
		pmAutoHidden: false,
		...overrides,
	};
}

const REST_SOURCE = {
	kind: "rest-gitlab" as const,
	token: "TOK",
	baseUrl: "https://gitlab.com/api/v4",
	projectId: "100",
};

const baseInput = {
	storyId: "story-1",
	projectId: "proj-1",
	mcpConfigId: null,
	mcpServerId: "server-1",
	containerId: "100",
	userId: "user-1",
	organizationId: "org-1",
	additionalContext: {},
};

function unlockedRow(id: string, filename: string) {
	return {
		id,
		filename,
		mimeType: "application/pdf",
		storageKey: `story-attachments/proj-1/story-1/${id}.pdf`,
		designation: "UNLOCKED" as const,
		source: "FABRIC" as const,
		contentHash: null,
		externalAttachmentId: null,
	};
}

/** Every `createPmSyncLog` row written during the run, in call order. */
function syncLogRows(): Array<{
	status: string;
	errorPayload?: { errorMessage?: string; reason?: string } | null;
}> {
	return createPmSyncLog.mock.calls.map((c) => c[0]);
}

const ORIGINAL_FLAG = process.env.FABRIC_FEATURE_PM_ATTACHMENT_SYNC;

describe("GitLab attachment push failure reporting (Fizzy #1745, AC-4)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resolvePmSource.mockResolvedValue(REST_SOURCE);
		updateStory.mockResolvedValue(undefined);
		findManyStatuses.mockResolvedValue([]);
		updateStoryAttachmentSyncState.mockResolvedValue(undefined);
		createPmSyncLog.mockResolvedValue({ id: "log-1" });
		createPmAttachmentSyncFailedNotification.mockResolvedValue(undefined);
		findUniqueProject.mockResolvedValue({ syncAttachments: true });
		callPmToolWithFallback.mockResolvedValue({
			externalId: "42",
			externalUrl: "https://gitlab.com/g/p/-/issues/42",
			title: STORY_TITLE,
		});
		process.env.FABRIC_FEATURE_PM_ATTACHMENT_SYNC = "true";
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (ORIGINAL_FLAG === undefined) {
			delete process.env.FABRIC_FEATURE_PM_ATTACHMENT_SYNC;
		} else {
			process.env.FABRIC_FEATURE_PM_ATTACHMENT_SYNC = ORIGINAL_FLAG;
		}
	});

	it("writes a FAILURE sync-log row naming the file GitLab refused (AC-4)", async () => {
		getStoryById.mockResolvedValue(makeStory());
		getStoryAttachmentsForSync.mockResolvedValue([
			unlockedRow("att-1", "spec.pdf"),
		]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("forbidden", { status: 403 })),
		);

		await syncGitLabStoryViaRest({
			...baseInput,
			direction: "push",
		} as never);

		const failures = syncLogRows().filter((r) => r.status === "FAILURE");
		expect(failures).toHaveLength(1);
		expect(failures[0]?.errorPayload?.reason).toBe(
			"attachment-push-failed",
		);
		// `list-pm-sync-log.ts` reduces errorPayload to ONE line, reading
		// `errorMessage` first — so the filename and the cause have to be in
		// that key or the Sync History row says nothing useful.
		expect(failures[0]?.errorPayload?.errorMessage).toContain("spec.pdf");
		expect(failures[0]?.errorPayload?.errorMessage).toMatch(/api.*scope/i);
	});

	it("still succeeds and uploads the rest when only one file of three fails (AC-4, UC-3)", async () => {
		getStoryById.mockResolvedValue(makeStory());
		getStoryAttachmentsForSync.mockResolvedValue([
			unlockedRow("att-1", "one.pdf"),
			unlockedRow("att-2", "two.pdf"),
			unlockedRow("att-3", "three.pdf"),
		]);
		let call = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				call += 1;
				return call === 2
					? new Response("too large", { status: 413 })
					: new Response(
							JSON.stringify({
								url: `/uploads/${"a".repeat(32)}/f.pdf`,
							}),
							{
								status: 201,
								headers: {
									"content-type": "application/json",
								},
							},
						);
			}),
		);

		await syncGitLabStoryViaRest({
			...baseInput,
			direction: "push",
		} as never);

		// The other two reached GitLab and were persisted.
		expect(updateStoryAttachmentSyncState).toHaveBeenCalledTimes(2);

		const failures = syncLogRows().filter((r) => r.status === "FAILURE");
		expect(failures).toHaveLength(1);
		expect(failures[0]?.errorPayload?.errorMessage).toContain("two.pdf");
		expect(failures[0]?.errorPayload?.errorMessage).toMatch(/too large/i);
		// The work item itself did sync — the story-level row stays SUCCESS.
		expect(syncLogRows().some((r) => r.status === "SUCCESS")).toBe(true);
	});

	it("notifies the notification centre with the same summary the sync log carries (AC-4)", async () => {
		getStoryById.mockResolvedValue(makeStory());
		getStoryAttachmentsForSync.mockResolvedValue([
			unlockedRow("att-1", "spec.pdf"),
		]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("forbidden", { status: 403 })),
		);

		await syncGitLabStoryViaRest({
			...baseInput,
			direction: "push",
		} as never);

		expect(createPmAttachmentSyncFailedNotification).toHaveBeenCalledTimes(
			1,
		);
		const arg = createPmAttachmentSyncFailedNotification.mock
			.calls[0]?.[0] as {
			actorUserId: string;
			projectId: string;
			storyId: string;
			organizationId: string | null;
			failureSummary: string;
			pmToolLabel: string;
		};
		expect(arg.actorUserId).toBe("user-1");
		expect(arg.projectId).toBe("proj-1");
		expect(arg.storyId).toBe("story-1");
		expect(arg.organizationId).toBe("org-1");
		expect(arg.pmToolLabel).toBe("GitLab");
		// Same string as the sync-log row's errorMessage — one summary, two
		// surfaces, so the two can never tell a person different stories.
		const failure = syncLogRows().find((r) => r.status === "FAILURE");
		expect(arg.failureSummary).toBe(failure?.errorPayload?.errorMessage);
	});

	it("does not let a failing notification dispatch break the push (AC-4)", async () => {
		getStoryById.mockResolvedValue(makeStory());
		getStoryAttachmentsForSync.mockResolvedValue([
			unlockedRow("att-1", "spec.pdf"),
		]);
		createPmAttachmentSyncFailedNotification.mockRejectedValue(
			new Error("inbox down"),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("forbidden", { status: 403 })),
		);

		const result = await syncGitLabStoryViaRest({
			...baseInput,
			direction: "push",
		} as never);

		expect((result as { success?: boolean }).success).toBe(true);
	});

	// The reporting must sit AFTER the push actually lands. The push-time
	// conflict guard returns early, and updateItem/createItem can throw — in
	// either case nothing reached the work item, so an "attachments failed to
	// sync" row alongside the CONFLICT row would tell the reader the rest of
	// the push succeeded when none of it did.
	it("reports nothing when the push aborts on a conflict before the work item is written", async () => {
		getStoryById.mockResolvedValue(makeStory());
		getStoryAttachmentsForSync.mockResolvedValue([
			unlockedRow("att-1", "spec.pdf"),
		]);
		// A baseline that cannot match the live remote content: a genuine
		// external edit, so the guard conflicts and returns.
		vi.mocked(getPmSyncBaseline).mockResolvedValueOnce("stale-baseline");
		callPmToolWithFallback.mockImplementation(async (args: unknown) => {
			const tool = (args as { call: { tool: string } }).call.tool;
			if (tool === "fetchItem") {
				return {
					title: "Edited in GitLab",
					description: "Someone else changed this",
					externalUrl: "https://gitlab.com/g/p/-/issues/42",
					labels: [],
					state: "opened",
				};
			}
			return {
				externalId: "42",
				externalUrl: "https://gitlab.com/g/p/-/issues/42",
				title: STORY_TITLE,
			};
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("forbidden", { status: 403 })),
		);

		const result = await syncGitLabStoryViaRest({
			...baseInput,
			direction: "push",
		} as never);

		expect((result as { errorCode?: string }).errorCode).toBe(
			"PM_SYNC_CONFLICT",
		);
		expect(stampPmSyncConflict).toHaveBeenCalled();
		const attachmentRows = syncLogRows().filter(
			(r) => r.errorPayload?.reason === "attachment-push-failed",
		);
		expect(attachmentRows).toEqual([]);
		expect(createPmAttachmentSyncFailedNotification).not.toHaveBeenCalled();
	});

	it("reports nothing when the work-item write itself throws", async () => {
		getStoryById.mockResolvedValue(makeStory());
		getStoryAttachmentsForSync.mockResolvedValue([
			unlockedRow("att-1", "spec.pdf"),
		]);
		callPmToolWithFallback.mockRejectedValue(new Error("GitLab 500"));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("forbidden", { status: 403 })),
		);

		await syncGitLabStoryViaRest({
			...baseInput,
			direction: "push",
		} as never).catch(() => undefined);

		const attachmentRows = syncLogRows().filter(
			(r) => r.errorPayload?.reason === "attachment-push-failed",
		);
		expect(attachmentRows).toEqual([]);
		expect(createPmAttachmentSyncFailedNotification).not.toHaveBeenCalled();
	});

	it("writes no FAILURE row when every attachment uploads cleanly", async () => {
		getStoryById.mockResolvedValue(makeStory());
		getStoryAttachmentsForSync.mockResolvedValue([
			unlockedRow("att-1", "spec.pdf"),
		]);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							url: `/uploads/${"a".repeat(32)}/spec.pdf`,
						}),
						{
							status: 201,
							headers: { "content-type": "application/json" },
						},
					),
			),
		);

		await syncGitLabStoryViaRest({
			...baseInput,
			direction: "push",
		} as never);

		expect(syncLogRows().filter((r) => r.status === "FAILURE")).toEqual([]);
	});
});
