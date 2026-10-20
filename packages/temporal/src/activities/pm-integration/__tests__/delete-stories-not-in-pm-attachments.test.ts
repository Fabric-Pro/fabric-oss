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
	projectFindUnique: vi.fn(),
	mcpConfigFindFirst: vi.fn(),
	mcpServerFindUnique: vi.fn(),
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
		project: { findUnique: mocks.projectFindUnique },
		mCPConfig: {
			findFirst: (...a: unknown[]) => mocks.mcpConfigFindFirst(...a),
		},
		mCPServer: {
			findUnique: (...a: unknown[]) => mocks.mcpServerFindUnique(...a),
		},
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
import { buildExternalPmTarget } from "@repo/utils/pm-target";
import {
	fixtureTarget,
	mutablePmSettings,
	pmTargetFixtures,
} from "../../../../../utils/test-fixtures/pm-target";
import { resolveExternalPmTarget } from "../external-pm-target";
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
		mcpServerId: "server-active",
		mcpConfigId: "config-active",
		userId: "user-1",
		pmTool: "fizzy",
		additionalContext: undefined,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({
		projectManagementContainerId: "example-project",
	});
	mocks.mcpConfigFindFirst.mockResolvedValue({
		baseUrl: "https://pm.example.com",
		mcpServer: { key: "fizzy", defaultUrl: null },
	});
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
			{
				id: "s1",
				identifier: "F-1",
				externalId: "ext-1",
				externalMcpServerId: "server-active",
			},
			{
				id: "s2",
				identifier: "F-2",
				externalId: "ext-2",
				externalMcpServerId: "server-active",
			},
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
			{
				id: "s1",
				identifier: "F-1",
				externalId: "ext-1",
				externalMcpServerId: "server-active",
			},
		]);
		mocks.storyAttachmentFindMany.mockResolvedValue([]); // no attachments

		const result = await deleteStoriesNotInPMList(makeInput([], ORG_ID));

		expect(result.deletedCount).toBe(1);
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
	});

	it("rejects attachment-read failures before starting any story delete", async () => {
		mocks.userStoryFindMany.mockResolvedValue([
			{
				id: "s1",
				identifier: "F-1",
				externalId: "ext-1",
				externalMcpServerId: "server-active",
			},
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
			{
				id: "s1",
				identifier: "F-1",
				externalId: "ext-1",
				externalMcpServerId: "server-active",
			},
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
			{
				id: "s1",
				identifier: "F-1",
				externalId: "ext-1",
				externalMcpServerId: "server-active",
			},
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
			{
				id: "s1",
				identifier: "F-1",
				externalId: "ext-1",
				externalMcpServerId: "server-active",
			},
			{
				id: "s2",
				identifier: "F-2",
				externalId: "ext-2",
				externalMcpServerId: "server-active",
			},
			{
				id: "s3",
				identifier: "F-3",
				externalId: "ext-3",
				externalMcpServerId: "server-active",
			},
			{
				id: "s4",
				identifier: "F-4",
				externalId: "ext-4",
				externalMcpServerId: "server-active",
			},
			{
				id: "s5",
				identifier: "F-5",
				externalId: "ext-5",
				externalMcpServerId: "server-active",
			},
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

describe("deleteStoriesNotInPMList — link ownership", () => {
	const story = {
		id: "s1",
		identifier: "F-1",
		externalId: "123",
		externalUrl: "https://app.fizzy.do/example/cards/123",
		externalMcpServerId: null,
	};

	it.each([
		[
			"another stamped server",
			{ externalMcpServerId: "server-other" },
			false,
		],
		[
			"the active stamped server",
			{ externalMcpServerId: "server-active" },
			true,
		],
		[
			"an unstamped other tool",
			{
				externalUrl:
					"https://dev.azure.com/example/project/_workitems/edit/123",
			},
			false,
		],
		["the unstamped active tool", {}, true],
	])(
		"handles %s without touching kept attachments",
		async (_label, link, shouldDelete) => {
			mocks.userStoryFindMany.mockResolvedValue([{ ...story, ...link }]);
			const result = await deleteStoriesNotInPMList(
				makeInput([], ORG_ID),
			);
			expect(result.deletedCount).toBe(shouldDelete ? 1 : 0);
			expect(mocks.deleteStory).toHaveBeenCalledTimes(
				shouldDelete ? 1 : 0,
			);
			expect(mocks.storyAttachmentFindMany).toHaveBeenCalledTimes(
				shouldDelete ? 1 : 0,
			);
			if (!shouldDelete) {
				expect(logger.info).toHaveBeenCalledWith(
					"[Delete Orphaned] Skipped stories linked to another PM tool",
					{ projectId: PROJECT_ID, skippedCount: 1 },
				);
				expect(mocks.deleteObjects).not.toHaveBeenCalled();
			}
		},
	);

	it.each([
		["a null URL", null, "fizzy", false],
		["an unparsable URL", "not a URL", "fizzy", false],
		[
			"no known tool or base URL",
			"https://unknown.example.com/items/123",
			"unknown",
			true,
		],
	])(
		"keeps an unstamped story with %s",
		async (_label, externalUrl, pmTool, noBaseUrl) => {
			if (noBaseUrl) {
				mocks.mcpConfigFindFirst.mockResolvedValue({
					baseUrl: null,
					mcpServer: { key: "custom", defaultUrl: null },
				});
			}
			mocks.userStoryFindMany.mockResolvedValue([
				{ ...story, externalUrl },
			]);
			expect(
				await deleteStoriesNotInPMList({
					...makeInput([], ORG_ID),
					pmTool,
				}),
			).toEqual({ deletedCount: 0, deletedIdentifiers: [] });
			expect(mocks.deleteStory).not.toHaveBeenCalled();
			expect(mocks.storyAttachmentFindMany).not.toHaveBeenCalled();
			expect(mocks.deleteObjects).not.toHaveBeenCalled();
			expect(logger.info).toHaveBeenCalledWith(
				"[Delete Orphaned] Skipped stories without PM link ownership evidence",
				{ projectId: PROJECT_ID, skippedCount: 1 },
			);
		},
	);

	it("keeps stories for an old caller without mcpServerId", async () => {
		mocks.userStoryFindMany.mockResolvedValue([story]);
		const { mcpServerId: _server, ...input } = makeInput([], ORG_ID);
		expect(await deleteStoriesNotInPMList(input)).toEqual({
			deletedCount: 0,
			deletedIdentifiers: [],
		});
		expect(mocks.deleteStory).not.toHaveBeenCalled();
		expect(mocks.storyAttachmentFindMany).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			"[Delete Orphaned] Missing active PM server; skipping prune",
			{ projectId: PROJECT_ID },
		);
	});

	it.each(["missing", "lookup failed", "REST GitLab origin invalid"])(
		"keeps unstamped stories but prunes matching stamps when config is %s",
		async (reason) => {
			const input = makeInput([], ORG_ID);
			if (reason === "missing") {
				mocks.mcpConfigFindFirst.mockResolvedValue(null);
			}
			if (reason === "lookup failed") {
				mocks.mcpConfigFindFirst.mockRejectedValue(
					new Error("lookup failed"),
				);
			}
			if (reason === "REST GitLab origin invalid") {
				Object.assign(input, {
					mcpConfigId: null,
					pmTool: "gitlab",
					additionalContext: {
						gitlabOrigin: "http://gitlab.example.com",
					},
				});
				mocks.mcpServerFindUnique.mockResolvedValue({
					key: "gitlab",
					defaultUrl: null,
				});
			}
			mocks.userStoryFindMany.mockResolvedValue([
				story,
				{
					...story,
					id: "s2",
					identifier: "F-2",
					externalMcpServerId: "server-active",
				},
			]);
			expect(await deleteStoriesNotInPMList(input)).toEqual({
				deletedCount: 1,
				deletedIdentifiers: ["F-2"],
			});
			expect(mocks.deleteStory).toHaveBeenCalledExactlyOnceWith(
				"s2",
				PROJECT_ID,
			);
			expect(mocks.storyAttachmentFindMany).toHaveBeenCalledWith({
				where: { storyId: { in: ["s2"] } },
				select: { storyId: true, storageKey: true },
			});
			expect(logger.warn).toHaveBeenCalledWith(
				"[Delete Orphaned] Active PM config unavailable; keeping unstamped stories",
				{
					projectId: PROJECT_ID,
					error:
						reason === "lookup failed"
							? "Error: lookup failed"
							: expect.any(String),
				},
			);
		},
	);

	it.each([
		["https://gitlab.example.com/example/project/-/issues/123", 1],
		["https://other.example.com/example/project/-/issues/123", 0],
		[null, 0],
	])(
		"uses the recorded REST GitLab instance for %s",
		async (externalUrl, deletedCount) => {
			mocks.mcpServerFindUnique.mockResolvedValue({
				key: "gitlab",
				defaultUrl: null,
			});
			mocks.userStoryFindMany.mockResolvedValue([
				{ ...story, externalUrl },
			]);
			const input = {
				...makeInput([], ORG_ID),
				mcpConfigId: null,
				pmTool: "gitlab",
				additionalContext: {
					gitlabOrigin: "https://gitlab.example.com",
				},
			};
			expect((await deleteStoriesNotInPMList(input)).deletedCount).toBe(
				deletedCount,
			);
			expect(mocks.mcpServerFindUnique).toHaveBeenCalledExactlyOnceWith({
				where: { id: "server-active" },
				select: { defaultUrl: true, key: true },
			});
		},
	);

	it("uses gitlab.com for a legacy REST selection without a recorded origin", async () => {
		mocks.mcpServerFindUnique.mockResolvedValue({
			key: "gitlab",
			defaultUrl: null,
		});
		mocks.userStoryFindMany.mockResolvedValue([
			{
				...story,
				externalUrl: "https://gitlab.com/example/project/-/issues/123",
			},
		]);
		expect(
			(
				await deleteStoriesNotInPMList({
					...makeInput([], ORG_ID),
					mcpConfigId: null,
					pmTool: "gitlab",
				})
			).deletedCount,
		).toBe(1);
	});

	it("uses the config base URL when the detected tool is undefined", async () => {
		mocks.userStoryFindMany.mockResolvedValue([
			{ ...story, externalUrl: "https://other.example.com/items/123" },
		]);
		expect(
			(
				await deleteStoriesNotInPMList({
					...makeInput([], ORG_ID),
					pmTool: undefined,
				})
			).deletedCount,
		).toBe(0);
		expect(mocks.storyAttachmentFindMany).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"accepts matching custom hosts using default URL: %s",
		async (useDefaultUrl) => {
			mocks.mcpConfigFindFirst.mockResolvedValue({
				baseUrl: useDefaultUrl ? null : "https://pm.example.com",
				mcpServer: {
					key: "custom",
					defaultUrl: useDefaultUrl ? "https://pm.example.com" : null,
				},
			});
			mocks.userStoryFindMany.mockResolvedValue([
				{
					...story,
					externalUrl: "https://cards.pm.example.com/items/123",
				},
			]);
			expect(
				(
					await deleteStoriesNotInPMList({
						...makeInput([], ORG_ID),
						pmTool: undefined,
					})
				).deletedCount,
			).toBe(1);
		},
	);

	it("keeps normalized IDs returned by the active tool", async () => {
		mocks.userStoryFindMany.mockResolvedValue([
			{ ...story, externalId: "#123" },
		]);
		expect(
			(await deleteStoriesNotInPMList(makeInput(["123"], ORG_ID)))
				.deletedCount,
		).toBe(0);
		expect(mocks.deleteStory).not.toHaveBeenCalled();
	});

	it("resolves config once and preserves the tenant filter", async () => {
		mocks.userStoryFindMany.mockResolvedValue([
			story,
			{ ...story, id: "s2" },
		]);
		await deleteStoriesNotInPMList(makeInput([], ORG_ID));
		expect(mocks.mcpConfigFindFirst).toHaveBeenCalledTimes(1);
		expect(mocks.mcpConfigFindFirst).toHaveBeenCalledWith({
			where: {
				id: "config-active",
				userId: "user-1",
				organizationId: ORG_ID,
				mcpServerId: "server-active",
			},
			select: {
				baseUrl: true,
				commandArgs: true,
				atlassianCloudSiteUrl: true,
				mcpServer: { select: { defaultUrl: true, key: true } },
			},
		});
		expect(mocks.userStoryFindMany).toHaveBeenCalledWith({
			where: {
				projectId: PROJECT_ID,
				externalId: { not: null },
				project: { organizationId: ORG_ID },
			},
			select: {
				id: true,
				identifier: true,
				externalId: true,
				externalUrl: true,
				externalMcpServerId: true,
				externalPmTarget: true,
			},
		});
	});
});

describe("target-scoped prune", () => {
	it.each([
		[
			"azure-devops",
			{ commandArgs: ["example-org-b"] },
			{ team: "example-team", backlogId: "stories" },
		],
		["fizzy", {}, { account_slug: "/example-account" }],
	])(
		"keeps another %s target but prunes the active target and legacy links",
		async (pmTool, config, additionalContext) => {
			mocks.mcpConfigFindFirst.mockResolvedValue({
				...config,
				mcpServer: { key: pmTool },
			});
			const containerId =
				pmTool === "azure-devops"
					? "11111111-1111-4111-8111-111111111111"
					: "example-project";
			const active = await resolveExternalPmTarget({
				...makeInput([]),
				containerId,
				stableContainerId: containerId,
				pmTool,
				additionalContext,
			});
			expect(active).not.toBeNull();
			mocks.userStoryFindMany.mockResolvedValue([
				{
					id: "old",
					identifier: "F-1",
					externalId: "1",
					externalMcpServerId: "server-active",
					externalPmTarget: buildExternalPmTarget({
						mcpServerId: "server-active",
						pmTool,
						config:
							pmTool === "azure-devops"
								? { commandArgs: ["example-org-a"] }
								: {},
						containerId:
							pmTool === "fizzy"
								? "example-other-board"
								: containerId,
						additionalContext,
					}),
				},
				{
					id: "active",
					identifier: "F-2",
					externalId: "2",
					externalMcpServerId: "server-active",
					externalPmTarget: active,
				},
				{
					id: "legacy",
					identifier: "F-3",
					externalId: "3",
					externalMcpServerId: "server-active",
					externalPmTarget: null,
				},
			]);
			const result = await deleteStoriesNotInPMList({
				...makeInput([]),
				containerId,
				pmTool,
				additionalContext,
			});
			expect(result.deletedIdentifiers).toEqual(["F-2", "F-3"]);
		},
	);
});

it("keeps keyed rows when the active target is unresolved and preserves null-key pruning", async () => {
	mocks.userStoryFindMany.mockResolvedValue([
		{
			id: "old",
			identifier: "F-1",
			externalId: "1",
			externalMcpServerId: "server-active",
			externalPmTarget: "known-target",
		},
		{
			id: "legacy",
			identifier: "F-2",
			externalId: "2",
			externalMcpServerId: "server-active",
			externalPmTarget: null,
		},
	]);
	const result = await deleteStoriesNotInPMList(makeInput([]));
	expect(result.deletedIdentifiers).toEqual(["F-2"]);
});

it.each(pmTargetFixtures)(
	"$name: prune compares the resolved target without mutable settings",
	async (fixture) => {
		mocks.mcpConfigFindFirst.mockResolvedValue(fixture.config);
		const input = {
			...makeInput([]),
			pmTool: fixture.pmTool,
			containerId: fixture.containerId,
			additionalContext: fixture.additionalContext,
		};
		const active = await resolveExternalPmTarget({
			...input,
			stableContainerId: input.containerId,
		});
		expect(active).toBe(fixtureTarget(fixture, "server-active"));
		mocks.userStoryFindMany.mockResolvedValue([
			{
				id: "example-story",
				identifier: "F-1",
				externalId: "1",
				externalMcpServerId: "server-active",
				externalPmTarget: active,
			},
		]);
		expect(
			(
				await deleteStoriesNotInPMList({
					...input,
					additionalContext: {
						...fixture.additionalContext,
						...mutablePmSettings,
					},
				})
			).deletedIdentifiers,
		).toEqual(["F-1"]);
	},
);
