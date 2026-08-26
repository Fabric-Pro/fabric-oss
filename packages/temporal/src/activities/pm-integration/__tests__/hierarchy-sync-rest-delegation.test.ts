/**
 * Tests for the GitLab REST delegation branch in `syncWorkItemToPM`.
 *
 * When `mcpConfigId === null` the activity is on the REST fallback path —
 * it must (a) reject epic/feature with PmCapabilitiesError (no REST routine
 * exists for non-stories), (b) delegate stories/bugs to `syncStoryToPM`,
 * and (c) translate the StorySyncResult into the SyncWorkItemResult shape
 * the workflow expects. Mocks `./story-sync` so we can assert on the
 * forwarded input without exercising the real REST routine.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", async () => {
	const actual = await vi.importActual<object>("@temporalio/activity");
	return {
		...actual,
		Context: { current: () => ({ heartbeat: vi.fn() }) },
	};
});

vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	closeMcpClientSafe: vi.fn().mockResolvedValue(undefined),
	getDetailedMcpToolInfo: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: vi.fn(() => ({
		getSignedUrl: vi.fn(async (key: string) => `https://signed/${key}`),
	})),
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "test-project-contexts" } },
	},
}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	// Read-only mode gate — default: project is writable
	isProjectReadOnly: vi.fn(async () => false),
	db: {
		userStory: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
		feature: { update: vi.fn(), updateMany: vi.fn() },
		epic: { update: vi.fn(), updateMany: vi.fn() },
		mCPConfig: { findUnique: vi.fn().mockResolvedValue(null) },
	},
	PmSyncStatus: {
		PENDING: "PENDING",
		SUCCESS: "SUCCESS",
		CONFLICT: "CONFLICT",
		FAILED: "FAILED",
	},
	getEpicById: vi.fn(),
	getFeatureById: vi.fn(),
	getStoryById: vi.fn(),
	getMcpConfigById: vi.fn(),
	updateEpic: vi.fn().mockResolvedValue(undefined),
	updateFeature: vi.fn().mockResolvedValue(undefined),
	updateStory: vi.fn().mockResolvedValue(undefined),
	updateTask: vi.fn().mockResolvedValue(undefined),
	createStory: vi.fn(),
	deleteStory: vi.fn(),
	listStoryStatuses: vi.fn().mockResolvedValue([]),
	formatBackLinkForProvider: (d: string | null | undefined) => d ?? "",
	normalizeBackLinkFromProvider: (d: string | null | undefined) => d ?? "",
	HTML_BACK_LINK_RE:
		/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i,
}));

// The dynamic import inside `syncWorkItemToPM`'s REST branch resolves to this
// mocked module — we can assert on the forwarded input and stub the return.
const { syncStoryToPMMock } = vi.hoisted(() => ({
	syncStoryToPMMock: vi.fn(),
}));
vi.mock("../story-sync", async () => {
	const actual = await vi.importActual<object>("../story-sync");
	return {
		...actual,
		syncStoryToPM: syncStoryToPMMock,
		discoverPMToolCapabilities: vi.fn(),
		HTML_DESCRIPTION_TOOLS: new Set<string>(),
		markdownToSimpleHtml: (s: string) => s,
	};
});

import { syncWorkItemToPM } from "../hierarchy-sync";

const baseRestInput = (overrides: Record<string, unknown> = {}) => ({
	itemType: "story" as const,
	itemId: "story-1",
	projectId: "proj-1",
	mcpConfigId: null,
	mcpServerId: "key:gitlab-official",
	containerId: "group/project",
	additionalContext: {},
	userId: "user-1",
	organizationId: "org-1",
	triggerSource: "manual-edit" as const,
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("syncWorkItemToPM — GitLab REST delegation", () => {
	it("delegates story push to syncStoryToPM and maps SUCCESS", async () => {
		const syncedAt = new Date("2026-05-28T12:00:00Z");
		syncStoryToPMMock.mockResolvedValue({
			success: true,
			externalId: "42",
			externalUrl: "https://gitlab.com/group/project/-/issues/42",
			syncedAt,
			direction: "push",
		});

		const result = await syncWorkItemToPM(baseRestInput());

		expect(syncStoryToPMMock).toHaveBeenCalledTimes(1);
		const forwarded = syncStoryToPMMock.mock.calls[0]?.[0];
		expect(forwarded).toMatchObject({
			storyId: "story-1",
			projectId: "proj-1",
			mcpConfigId: null,
			mcpServerId: "key:gitlab-official",
			containerId: "group/project",
			direction: "push",
		});

		expect(result).toEqual({
			status: "SUCCESS",
			externalId: "42",
			externalUrl: "https://gitlab.com/group/project/-/issues/42",
			pushedAt: syncedAt.toISOString(),
		});
	});

	it("maps PM_SYNC_CONFLICT to status: CONFLICT", async () => {
		syncStoryToPMMock.mockResolvedValue({
			success: false,
			externalId: "42",
			error: "Remote GitLab issue was modified since the last sync. Resolve the conflict to continue.",
			errorCode: "PM_SYNC_CONFLICT",
			syncedAt: new Date(),
			direction: "push",
		});

		const result = await syncWorkItemToPM(baseRestInput());

		expect(result.status).toBe("CONFLICT");
		if (result.status === "CONFLICT") {
			expect(result.externalId).toBe("42");
		}
	});

	it("throws PmCapabilitiesError for PM_TOOL_MISMATCH (workflow stamps FAILED)", async () => {
		syncStoryToPMMock.mockResolvedValue({
			success: false,
			error: "This feature is linked to a different PM tool. Re-link it to push to GitLab.",
			errorCode: "PM_TOOL_MISMATCH",
			syncedAt: new Date(),
			direction: "push",
		});

		await expect(syncWorkItemToPM(baseRestInput())).rejects.toMatchObject({
			type: "PmCapabilitiesError",
		});
	});

	it("throws PmNotFoundError when the REST routine self-heals a missing remote", async () => {
		syncStoryToPMMock.mockResolvedValue({
			success: false,
			error: "The external item was not found in the current PM tool. The sync link has been removed.",
			errorCode: "EXTERNAL_ID_NOT_FOUND",
			syncedAt: new Date(),
			direction: "push",
		});

		await expect(syncWorkItemToPM(baseRestInput())).rejects.toMatchObject({
			type: "PmNotFoundError",
		});
	});

	it("rejects epic itemType on REST path with PmCapabilitiesError (no REST routine)", async () => {
		await expect(
			syncWorkItemToPM(baseRestInput({ itemType: "epic" })),
		).rejects.toMatchObject({
			type: "PmCapabilitiesError",
		});
		expect(syncStoryToPMMock).not.toHaveBeenCalled();
	});

	it("rejects feature itemType on REST path with PmCapabilitiesError", async () => {
		await expect(
			syncWorkItemToPM(baseRestInput({ itemType: "feature" })),
		).rejects.toMatchObject({
			type: "PmCapabilitiesError",
		});
		expect(syncStoryToPMMock).not.toHaveBeenCalled();
	});

	it("forwards forceHashOverride from pushAnyway", async () => {
		syncStoryToPMMock.mockResolvedValue({
			success: true,
			externalId: "42",
			syncedAt: new Date(),
			direction: "push",
		});

		await syncWorkItemToPM(baseRestInput({ pushAnyway: true }));

		expect(syncStoryToPMMock).toHaveBeenCalledWith(
			expect.objectContaining({ forceHashOverride: true }),
		);
	});

	it("throws PmCapabilitiesError when REST path lacks mcpServerId", async () => {
		await expect(
			syncWorkItemToPM(baseRestInput({ mcpServerId: undefined })),
		).rejects.toMatchObject({
			type: "PmCapabilitiesError",
		});
	});
});
