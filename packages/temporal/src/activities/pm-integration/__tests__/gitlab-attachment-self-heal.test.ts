/**
 * Fix-round-1 regressions for the GitLab attachment block wiring (Fizzy
 * #1745, review R15/R16/R-stamp-1/R-stamp-2/R-guard). Each test fails if its
 * corresponding fix is reverted.
 *
 * R15: the pull-side strip must run BEFORE `ingestPulledImages`, not after.
 * `ingestPulledImages` matches markdown `[label](url)` links filtered on
 * GitLab's `/uploads/{32hex}/…` form — exactly what `renderAttachmentBlock`
 * emits — so stripping too late means every pull downloads and re-hosts
 * Fabric's own attachments into story media before the result is discarded.
 *
 * R16: the push must strip any attachment block already present on the
 * OUTBOUND BASE (`buildStoryDescription(story)`) before appending a fresh
 * one, so a block that reached Fabric's description by an unanticipated
 * route self-heals instead of accumulating forever.
 *
 * R-stamp-1 / R-stamp-2: the post-push baseline (`stampPmSyncSuccess`) must
 * be stamped with the block-FREE `description`, never `descriptionWithAttachments`
 * (the update path at `gitlab-rest-story-sync.ts`'s `stampPmSyncSuccess` call
 * after `updateItem`, and the create path's after `createItem`). Passing the
 * with-block description there is a change that leaves the rest of the
 * temporal suite green while false-conflicting every attachment-bearing
 * story on its very next push, because the conflict guard (R-guard, below)
 * always compares against a block-free live hash.
 *
 * R-guard: the push-time conflict guard must strip the attachment block from
 * the LIVE remote description before hashing it against the stamped
 * baseline, or the block's mere presence (independent of any real remote
 * edit) raises a false PM_SYNC_CONFLICT on every push of a story that has
 * ever pushed attachments.
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
} = vi.hoisted(() => ({
	getStoryById: vi.fn(),
	updateStory: vi.fn(),
	findManyStatuses: vi.fn(),
	getStoryAttachmentsForSync: vi.fn(),
	updateStoryAttachmentSyncState: vi.fn(),
	findUniqueProject: vi.fn(),
}));

// Synchronous factory (no importOriginal) so the Prisma client is never
// evaluated. Mirrors gitlab-rest-story-sync.ts's actual @repo/database
// surface, extended with the attachment-sync helpers this round wires in.
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
	createPmSyncLog: vi.fn(),
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

import {
	appendAttachmentBlock,
	renderAttachmentBlock,
} from "../gitlab-attachment-block";
import { syncGitLabStoryViaRest } from "../gitlab-rest-story-sync";
import {
	getPmSyncBaseline,
	stampPmSyncConflict,
	stampPmSyncSuccess,
} from "../hierarchy-sync";
import { computePmHash } from "../pm-sync-hash";

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
		externalId: null,
		externalUrl: null,
		externalMcpServerId: null,
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

const ORIGINAL_FLAG = process.env.FABRIC_FEATURE_PM_ATTACHMENT_SYNC;

describe("GitLab attachment block self-heal (Fizzy #1745, review round 1)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resolvePmSource.mockResolvedValue(REST_SOURCE);
		updateStory.mockResolvedValue(undefined);
		findManyStatuses.mockResolvedValue([]);
		updateStoryAttachmentSyncState.mockResolvedValue(undefined);
		delete process.env.FABRIC_FEATURE_PM_ATTACHMENT_SYNC;
	});

	afterEach(() => {
		if (ORIGINAL_FLAG === undefined) {
			delete process.env.FABRIC_FEATURE_PM_ATTACHMENT_SYNC;
		} else {
			process.env.FABRIC_FEATURE_PM_ATTACHMENT_SYNC = ORIGINAL_FLAG;
		}
	});

	// R15 -----------------------------------------------------------------

	it("R15: strips the attachment block BEFORE ingestPulledImages runs, so our own attachment link is never re-ingested", async () => {
		const blockPath = `/uploads/${"c".repeat(32)}/spec.pdf`;
		const block = renderAttachmentBlock({
			links: [{ filename: "spec.pdf", path: blockPath }],
			excluded: [],
		});
		const remoteDescription = appendAttachmentBlock(
			"Body from GitLab",
			block,
		);

		getStoryById.mockResolvedValue(
			makeStory({
				externalId: "42",
				externalUrl: "https://gitlab.com/g/p/-/issues/42",
				externalMcpServerId: "server-1",
			}),
		);
		callPmToolWithFallback.mockResolvedValue({
			title: "Some title",
			description: remoteDescription,
			externalUrl: "https://gitlab.com/g/p/-/issues/42",
			labels: [],
			state: "opened",
		});
		ingestPulledImages.mockImplementation(
			async ({ description }: { description: string }) => ({
				description,
				ingested: 0,
				reused: 0,
				failed: 0,
				skipped: 0,
			}),
		);

		await syncGitLabStoryViaRest({
			...baseInput,
			direction: "pull",
		} as never);

		expect(ingestPulledImages).toHaveBeenCalledTimes(1);
		const ingestArg = ingestPulledImages.mock.calls[0]?.[0] as {
			description: string;
		};
		// The block — and specifically our own /uploads/{32hex}/ link — must
		// already be gone by the time ingestPulledImages sees the content.
		expect(ingestArg.description).not.toContain("fabric:attachments");
		expect(ingestArg.description).not.toContain(blockPath);
		expect(ingestArg.description).toContain("Body from GitLab");

		// And it never reaches the editor either.
		expect(updateStory).toHaveBeenCalledTimes(1);
		const updateArgs = updateStory.mock.calls[0] ?? [];
		expect(updateArgs[0]).toBe("story-1");
		expect(updateArgs[1]).toBe("proj-1");
		expect(
			(updateArgs[2] as { description?: string }).description,
		).not.toContain("fabric:attachments");
	});

	// R16 -------------------------------------------------------------------

	it("R16: a Fabric description that ALREADY contains a block produces exactly ONE block after a push, not two", async () => {
		process.env.FABRIC_FEATURE_PM_ATTACHMENT_SYNC = "true";

		const staleBlock = renderAttachmentBlock({
			links: [
				{
					filename: "old.pdf",
					path: `/uploads/${"a".repeat(32)}/old.pdf`,
				},
			],
			excluded: [],
		});
		const staleDescription = appendAttachmentBlock(
			"Feature body",
			staleBlock,
		);

		getStoryById.mockResolvedValue(
			makeStory({ description: staleDescription }),
		);
		findUniqueProject.mockResolvedValue({ syncAttachments: true });
		const newPath = `/uploads/${"b".repeat(32)}/new.pdf`;
		getStoryAttachmentsForSync.mockResolvedValue([
			{
				id: "att-1",
				filename: "new.pdf",
				mimeType: "application/pdf",
				storageKey: "story-attachments/proj-1/story-1/att-1.pdf",
				designation: "UNLOCKED",
				source: "FABRIC",
				contentHash: "hash123",
				externalAttachmentId: newPath,
			},
		]);
		callPmToolWithFallback.mockResolvedValue({
			externalId: "42",
			externalUrl: "https://gitlab.com/g/p/-/issues/42",
			title: STORY_TITLE,
		});

		await syncGitLabStoryViaRest({
			...baseInput,
			direction: "push",
		} as never);

		expect(callPmToolWithFallback).toHaveBeenCalledTimes(1);
		const call = callPmToolWithFallback.mock.calls[0]?.[0] as {
			call: { tool: string; payload: { description: string } };
		};
		expect(call.call.tool).toBe("createItem");
		const pushedDescription = call.call.payload.description;

		// Exactly one block (OPEN + CLOSE = 2 matches of the fence text), not
		// two blocks (4 matches) from the stale block surviving alongside a
		// freshly-appended one.
		expect(pushedDescription.match(/fabric:attachments/g)).toHaveLength(2);
		// The stale link is gone — proof the OLD block was actually removed,
		// not just left in place with a new block appended after it.
		expect(pushedDescription).not.toContain("old.pdf");
		// The fresh block (built from the current attachment rows) is what
		// remains.
		expect(pushedDescription).toContain("new.pdf");
	});

	// R-stamp-1 / R-stamp-2 -------------------------------------------------

	it("R-stamp-1: push (update) stamps stampPmSyncSuccess with the block-free description, not the one pushed to GitLab", async () => {
		process.env.FABRIC_FEATURE_PM_ATTACHMENT_SYNC = "true";

		getStoryById.mockResolvedValue(
			makeStory({
				externalId: "42",
				externalUrl: "https://gitlab.com/g/p/-/issues/42",
				externalMcpServerId: "server-1",
			}),
		);
		findUniqueProject.mockResolvedValue({ syncAttachments: true });
		getStoryAttachmentsForSync.mockResolvedValue([
			{
				id: "att-1",
				filename: "secret.pdf",
				mimeType: "application/pdf",
				storageKey: "story-attachments/proj-1/story-1/att-1.pdf",
				designation: "LOCKED",
				source: "FABRIC",
				contentHash: null,
				externalAttachmentId: null,
			},
		]);
		callPmToolWithFallback.mockResolvedValue({
			externalId: "42",
			externalUrl: "https://gitlab.com/g/p/-/issues/42",
			title: STORY_TITLE,
		});

		await syncGitLabStoryViaRest({
			...baseInput,
			direction: "push",
		} as never);

		expect(callPmToolWithFallback).toHaveBeenCalledTimes(1);
		const pushCall = callPmToolWithFallback.mock.calls[0]?.[0] as {
			call: { tool: string; payload: { description: string } };
		};
		expect(pushCall.call.tool).toBe("updateItem");
		// The setup actually produced a block in the pushed payload — the LOCKED
		// file always renders an "excluded" line even with no unlocked links.
		expect(pushCall.call.payload.description).toContain(
			"fabric:attachments",
		);
		expect(pushCall.call.payload.description).toContain("secret.pdf");

		expect(stampPmSyncSuccess).toHaveBeenCalledTimes(1);
		const stampArg = vi.mocked(stampPmSyncSuccess).mock.calls[0]?.[0] as {
			description?: string | null;
		};
		// The stamped baseline must be block-free: passing the with-block
		// description here (`descriptionWithAttachments` instead of
		// `description`) would make every subsequent push of this story
		// false-conflict, because the conflict guard always hashes a
		// block-stripped live description against this baseline.
		expect(stampArg.description ?? "").not.toContain("fabric:attachments");
		expect(stampArg.description ?? "").not.toContain("secret.pdf");
	});

	it("R-stamp-2: push (create) stamps stampPmSyncSuccess with the block-free description on a freshly-created issue", async () => {
		process.env.FABRIC_FEATURE_PM_ATTACHMENT_SYNC = "true";

		getStoryById.mockResolvedValue(makeStory()); // no externalId -> create path
		findUniqueProject.mockResolvedValue({ syncAttachments: true });
		getStoryAttachmentsForSync.mockResolvedValue([
			{
				id: "att-2",
				filename: "secret2.pdf",
				mimeType: "application/pdf",
				storageKey: "story-attachments/proj-1/story-1/att-2.pdf",
				designation: "LOCKED",
				source: "FABRIC",
				contentHash: null,
				externalAttachmentId: null,
			},
		]);
		callPmToolWithFallback.mockResolvedValue({
			externalId: "99",
			externalUrl: "https://gitlab.com/g/p/-/issues/99",
			title: STORY_TITLE,
		});

		await syncGitLabStoryViaRest({
			...baseInput,
			direction: "push",
		} as never);

		expect(callPmToolWithFallback).toHaveBeenCalledTimes(1);
		const pushCall = callPmToolWithFallback.mock.calls[0]?.[0] as {
			call: { tool: string; payload: { description: string } };
		};
		expect(pushCall.call.tool).toBe("createItem");
		expect(pushCall.call.payload.description).toContain(
			"fabric:attachments",
		);
		expect(pushCall.call.payload.description).toContain("secret2.pdf");

		expect(stampPmSyncSuccess).toHaveBeenCalledTimes(1);
		const stampArg = vi.mocked(stampPmSyncSuccess).mock.calls[0]?.[0] as {
			description?: string | null;
		};
		expect(stampArg.description ?? "").not.toContain("fabric:attachments");
		expect(stampArg.description ?? "").not.toContain("secret2.pdf");
	});

	// R-guard -----------------------------------------------------------------

	it("R-guard: the push-time conflict guard strips the attachment block from the live-fetched description before hashing", async () => {
		// Flag left OFF: this isolates the conflict guard from the attachment
		// reconcile branch, which is covered separately above.
		getStoryById.mockResolvedValue(
			makeStory({
				externalId: "42",
				externalUrl: "https://gitlab.com/g/p/-/issues/42",
				externalMcpServerId: "server-1",
			}),
		);

		const remoteTitle = "Some title";
		const remoteBaseDescription = "Body from GitLab";
		const block = renderAttachmentBlock({
			links: [
				{
					filename: "spec.pdf",
					path: `/uploads/${"c".repeat(32)}/spec.pdf`,
				},
			],
			excluded: [],
		});
		const remoteDescriptionWithBlock = appendAttachmentBlock(
			remoteBaseDescription,
			block,
		);

		// A previously-stamped, block-free baseline that matches the CURRENT
		// remote content once the block is stripped — i.e. GitLab has not
		// actually changed since our last sync; only the block differs.
		vi.mocked(getPmSyncBaseline).mockResolvedValueOnce(
			computePmHash(remoteTitle, remoteBaseDescription),
		);

		callPmToolWithFallback.mockImplementation(async (args: unknown) => {
			const tool = (args as { call: { tool: string } }).call.tool;
			if (tool === "fetchItem") {
				return {
					title: remoteTitle,
					description: remoteDescriptionWithBlock,
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

		const result = await syncGitLabStoryViaRest({
			...baseInput,
			direction: "push",
		} as never);

		// If the strip on the live-fetched description were removed, the
		// unstripped hash would never match the block-free baseline and this
		// push would false-conflict purely from the block's presence.
		expect(stampPmSyncConflict).not.toHaveBeenCalled();
		expect((result as { success: boolean }).success).toBe(true);
	});
});
