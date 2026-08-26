/**
 * PULL-HALF WIRING (Fizzy #1745, AC-5/AC-7/AC-9).
 *
 * Proves the pull path actually reaches the engine and that what the engine
 * reports reaches a person: the sync log and the notification centre. The
 * engine's own rules are covered in reconcile-pulled-attachments.test.ts;
 * these tests are about the wiring around it.
 *
 * Adapted from the push-side harness below.
 *
 * Original header:
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
	importPulledStoryAttachment,
	recordStoryAttachmentSyncIssue,
} = vi.hoisted(() => ({
	importPulledStoryAttachment: vi.fn(),
	recordStoryAttachmentSyncIssue: vi.fn(),
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
	importPulledStoryAttachment,
	recordStoryAttachmentSyncIssue,
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

const STORY_TITLE = "Add login";
const HUMAN_SECRET = "e".repeat(32);
const HUMAN_LINK = `/uploads/${HUMAN_SECRET}/human.pdf`;

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

function syncLogRows(): Array<{
	status: string;
	direction?: string;
	errorPayload?: { errorMessage?: string; reason?: string } | null;
}> {
	return createPmSyncLog.mock.calls.map((c) => c[0]);
}

const ORIGINAL_FLAG = process.env.FABRIC_FEATURE_PM_ATTACHMENT_SYNC;

/** A GitLab issue whose description links one human-attached file. */
function pullReturns(description: string) {
	callPmToolWithFallback.mockResolvedValue({
		externalId: "42",
		title: STORY_TITLE,
		description,
		externalUrl: "https://gitlab.com/g/p/-/issues/42",
		labels: [],
		state: "opened",
	});
}

/** Stub the bytes GitLab hands back for a download. */
function downloadReturns(bytes: Buffer, contentType = "application/pdf") {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(new Uint8Array(bytes), {
					status: 200,
					headers: { "content-type": contentType },
				}),
		),
	);
}

describe("GitLab attachment PULL wiring (Fizzy #1745)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resolvePmSource.mockResolvedValue(REST_SOURCE);
		getStoryById.mockResolvedValue(makeStory());
		updateStory.mockResolvedValue(undefined);
		findManyStatuses.mockResolvedValue([]);
		getStoryAttachmentsForSync.mockResolvedValue([]);
		importPulledStoryAttachment.mockResolvedValue({ id: "att-new" });
		recordStoryAttachmentSyncIssue.mockResolvedValue(undefined);
		createPmSyncLog.mockResolvedValue({ id: "log-1" });
		createPmAttachmentSyncFailedNotification.mockResolvedValue(undefined);
		findUniqueProject.mockResolvedValue({ syncAttachments: true });
		ingestPulledImages.mockImplementation(
			async ({ description }: { description: string }) => ({
				description,
				ingested: 0,
				reused: 0,
				failed: 0,
				skipped: 0,
			}),
		);
		pullReturns(`Body [human.pdf](${HUMAN_LINK})`);
		downloadReturns(Buffer.from([1, 2, 3]));
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

	// AC-5
	it("imports an attachment a human put on the GitLab issue", async () => {
		await syncGitLabStoryViaRest({
			...baseInput,
			direction: "pull",
		} as never);
		expect(importPulledStoryAttachment).toHaveBeenCalledTimes(1);
		expect(importPulledStoryAttachment).toHaveBeenCalledWith(
			expect.objectContaining({
				storyId: "story-1",
				projectId: "proj-1",
				filename: "human.pdf",
				externalAttachmentId: HUMAN_LINK,
			}),
		);
	});

	// The gate. Everything above must stay unreachable while the flag is off.
	it("imports nothing when the feature flag is off", async () => {
		process.env.FABRIC_FEATURE_PM_ATTACHMENT_SYNC = "false";
		await syncGitLabStoryViaRest({
			...baseInput,
			direction: "pull",
		} as never);
		expect(importPulledStoryAttachment).not.toHaveBeenCalled();
	});

	it("imports nothing when the project has not opted in", async () => {
		findUniqueProject.mockResolvedValue({ syncAttachments: false });
		await syncGitLabStoryViaRest({
			...baseInput,
			direction: "pull",
		} as never);
		expect(importPulledStoryAttachment).not.toHaveBeenCalled();
	});

	// AC-9: the file is skipped, logged, AND the user is notified — the AC
	// names all three, and requires the file and the limit both be identified.
	it("skips an oversized file and tells the user which file and which limit", async () => {
		process.env.FABRIC_ATTACHMENT_MAX_BYTES = "2";
		try {
			downloadReturns(Buffer.from([1, 2, 3, 4, 5]));
			await syncGitLabStoryViaRest({
				...baseInput,
				direction: "pull",
			} as never);

			expect(importPulledStoryAttachment).not.toHaveBeenCalled();
			expect(recordStoryAttachmentSyncIssue).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: "human.pdf",
					reason: "TOO_LARGE",
					sourceTool: "gitlab",
				}),
			);

			const failure = syncLogRows().find((r) => r.status === "FAILURE");
			expect(failure?.errorPayload?.errorMessage).toMatch(/human\.pdf/);
			expect(failure?.errorPayload?.errorMessage).toMatch(/2/);

			const notified = createPmAttachmentSyncFailedNotification.mock
				.calls[0]?.[0] as { failureSummary?: string } | undefined;
			expect(notified?.failureSummary).toMatch(/human\.pdf/);
		} finally {
			delete process.env.FABRIC_ATTACHMENT_MAX_BYTES;
		}
	});

	// AC-7
	it("records a discrepancy when a previously-pulled file has gone from GitLab", async () => {
		getStoryAttachmentsForSync.mockResolvedValue([
			{
				id: "att-old",
				filename: "gone.pdf",
				mimeType: "application/pdf",
				storageKey: "k",
				designation: "UNLOCKED",
				source: "PM_SYNCED",
				contentHash: "h",
				externalAttachmentId: `/uploads/${"f".repeat(32)}/gone.pdf`,
			},
		]);
		await syncGitLabStoryViaRest({
			...baseInput,
			direction: "pull",
		} as never);
		expect(recordStoryAttachmentSyncIssue).toHaveBeenCalledWith(
			expect.objectContaining({
				filename: "gone.pdf",
				reason: "REMOTE_DELETED",
			}),
		);
	});

	// A clean pull must stay clean: no FAILURE row, no notification.
	it("writes no failure row when everything imports cleanly", async () => {
		await syncGitLabStoryViaRest({
			...baseInput,
			direction: "pull",
		} as never);
		expect(syncLogRows().some((r) => r.status === "FAILURE")).toBe(false);
		expect(createPmAttachmentSyncFailedNotification).not.toHaveBeenCalled();
	});
});
