/**
 * Wiring tests for `recordPmSyncLog` at the hierarchy-sync push boundaries
 * (T4.1) plus the bulk-push SKIP guarantee.
 *
 * Mirrors the mock harness in `hierarchy-sync.test.ts` (MCP/storage/db all
 * stubbed) and adds a mock for `./record-pm-sync-log` so we can assert the
 * push SUCCESS / CONFLICT rows are emitted with the right `status` +
 * `entityType` (story/bug→STORY — the only work-item rows since the
 * Epic/Feature folder tables were dropped; legacy epic/feature item types
 * fail fast without logging), and that a nothing-to-do bulk push writes ZERO
 * rows (D4).
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/hierarchy-sync-log-wiring.test.ts
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

const dbMocks = vi.hoisted(() => ({
	userStoryUpdate: vi.fn(),
	userStoryUpdateMany: vi.fn(),
	userStoryFindMany: vi.fn(),
	recordPmSyncLog: vi.fn(),
}));

vi.mock("../record-pm-sync-log", () => ({
	recordPmSyncLog: dbMocks.recordPmSyncLog,
}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	// Read-only mode gate — default: project is writable
	isProjectReadOnly: vi.fn(async () => false),
	db: {
		userStory: {
			update: dbMocks.userStoryUpdate,
			updateMany: dbMocks.userStoryUpdateMany,
			findMany: dbMocks.userStoryFindMany,
		},
		mCPConfig: { findUnique: vi.fn().mockResolvedValue(null) },
	},
	PmSyncStatus: {
		PENDING: "PENDING",
		SUCCESS: "SUCCESS",
		CONFLICT: "CONFLICT",
		FAILED: "FAILED",
	},
	getStoryById: vi.fn(),
	getMcpConfigById: vi.fn(),
	updateStory: vi.fn().mockResolvedValue(undefined),
	updateTask: vi.fn().mockResolvedValue(undefined),
	createStory: vi.fn(),
	deleteStory: vi.fn(),
	listStoryStatuses: vi.fn(),
	formatBackLinkForProvider: (d: string | null | undefined) => d ?? "",
	normalizeBackLinkFromProvider: (d: string | null | undefined) => d ?? "",
	HTML_BACK_LINK_RE:
		/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i,
}));

vi.mock("../story-sync", async () => {
	const actual = await vi.importActual<{
		markdownToSimpleHtml: (s: string) => string;
		syncBulkStoriesToPM: unknown;
	}>("../story-sync");
	return {
		...actual,
		discoverPMToolCapabilities: vi.fn(),
		HTML_DESCRIPTION_TOOLS: new Set<string>(),
		markdownToSimpleHtml: vi.fn((s: string) => s),
	};
});

import { getMcpConfigById, getStoryById } from "@repo/database";
import { executeMcpTool } from "../../orchestrator/execution/execute-mcp-tool";
import { syncWorkItemToPM } from "../hierarchy-sync";
import { computePmHash } from "../pm-sync-hash";
import {
	discoverPMToolCapabilities,
	syncBulkStoriesToPM,
	syncStoryToPM,
} from "../story-sync";

const PROJECT_ID = "project-1";
const TITLE = "Story title";
const DESCRIPTION = "Story description";

function makeCapabilities() {
	return {
		hasPMCapabilities: true,
		containerHierarchy: [],
		availableTools: ["update_card", "get_card", "create_card"],
		detectedType: "fizzy",
		taskUpdate: {
			toolName: "update_card",
			idParam: "card_id",
			titleParam: "title",
			descriptionParam: "description",
			updatesBased: undefined,
			allParams: [],
		},
		taskCreation: {
			toolName: "create_card",
			containerParam: "board_id",
			titleParam: "title",
			descriptionParam: "description",
			fieldsBased: undefined,
			allParams: [],
		},
		taskGet: {
			toolName: "get_card",
			idParam: "card_id",
			additionalRequiredParams: [],
			allParams: [],
		},
	};
}

function makeEntity(overrides: Record<string, unknown> = {}) {
	return {
		id: "ent-1",
		title: TITLE,
		description: DESCRIPTION,
		acceptanceCriteria: null,
		identifier: "US-001",
		externalId: "PM-42",
		lastSyncedPmHash: null,
		...overrides,
	};
}

const baseInput = {
	itemId: "ent-1",
	projectId: PROJECT_ID,
	mcpConfigId: "mcp-1",
	containerId: "board-1",
	userId: "user-9",
	organizationId: "org-1",
	triggerSource: "ai-update" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	dbMocks.userStoryUpdate.mockResolvedValue({});
	dbMocks.recordPmSyncLog.mockResolvedValue(undefined);
	vi.mocked(discoverPMToolCapabilities).mockResolvedValue(
		makeCapabilities() as never,
	);
	vi.mocked(executeMcpTool).mockResolvedValue({
		success: true,
		output: {},
	} as never);
});

describe("syncWorkItemToPM → push SUCCESS log row + entityType mapping", () => {
	it("story SUCCESS → one row, direction push, status SUCCESS, entityType STORY", async () => {
		vi.mocked(getStoryById).mockResolvedValue(
			makeEntity({ lastSyncedPmHash: null }) as never,
		);

		const result = await syncWorkItemToPM({
			...baseInput,
			itemType: "story",
		});

		expect(result.status).toBe("SUCCESS");
		expect(dbMocks.recordPmSyncLog).toHaveBeenCalledTimes(1);
		expect(dbMocks.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				direction: "push",
				status: "SUCCESS",
				entityType: "STORY",
				entityId: "ent-1",
				title: TITLE,
				pmTool: "fizzy",
				projectId: PROJECT_ID,
				organizationId: "org-1",
				userId: null,
				actorUserId: null,
			}),
		);
	});

	it.each(["epic", "feature"] as const)(
		"legacy %s itemType fails fast with NO log row (folder tables removed)",
		async (itemType) => {
			await expect(
				syncWorkItemToPM({
					...baseInput,
					itemType,
				}),
			).rejects.toMatchObject({ type: "PmCapabilitiesError" });

			expect(dbMocks.recordPmSyncLog).not.toHaveBeenCalled();
			expect(executeMcpTool).not.toHaveBeenCalled();
		},
	);

	it("bug SUCCESS → entityType STORY (bugs are UserStory rows; never TASK)", async () => {
		vi.mocked(getStoryById).mockResolvedValue(
			makeEntity({ lastSyncedPmHash: null }) as never,
		);

		const result = await syncWorkItemToPM({
			...baseInput,
			itemType: "bug",
		});

		expect(result.status).toBe("SUCCESS");
		expect(dbMocks.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({ entityType: "STORY", status: "SUCCESS" }),
		);
	});
});

describe("syncWorkItemToPM → push CONFLICT log row", () => {
	it("hash drift → one row, direction push, status CONFLICT", async () => {
		const baseline = computePmHash(TITLE, DESCRIPTION);
		vi.mocked(getStoryById).mockResolvedValue(
			makeEntity({ lastSyncedPmHash: baseline }) as never,
		);
		vi.mocked(executeMcpTool).mockImplementation(async (args: unknown) => {
			const { toolName } = args as { toolName: string };
			if (toolName === "get_card") {
				return {
					success: true,
					output: {
						title: "PM edited title",
						description: "PM edited body",
					},
				} as never;
			}
			return { success: true, output: {} } as never;
		});

		const result = await syncWorkItemToPM({
			...baseInput,
			itemType: "story",
		});

		expect(result.status).toBe("CONFLICT");
		expect(dbMocks.recordPmSyncLog).toHaveBeenCalledTimes(1);
		expect(dbMocks.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				direction: "push",
				status: "CONFLICT",
				entityType: "STORY",
				entityId: "ent-1",
			}),
		);
	});
});

describe("syncBulkStoriesToPM → no per-story outcome emits zero log rows (D4 SKIP)", () => {
	it("writes no PmSyncLog row when the bulk run pushes nothing", async () => {
		// A bulk run that never reaches a per-story push (empty set / capability
		// short-circuit) resolves zero per-item outcomes — and therefore zero
		// `PmSyncLog` rows. The wrapper itself never logs; only the per-story
		// `syncStoryToPM` path does, so a no-push bulk run is provably silent
		// in the log (D4: nothing-to-do emits no row).
		dbMocks.userStoryFindMany.mockResolvedValue([]);

		await syncBulkStoriesToPM({
			projectId: PROJECT_ID,
			mcpConfigId: "mcp-1",
			containerId: "board-1",
			userId: "user-9",
			organizationId: "org-1",
		});

		expect(dbMocks.recordPmSyncLog).not.toHaveBeenCalled();
	});
});

describe("syncStoryToPM → log row direction is faithful to the attempt", () => {
	it("a pull-direction failure logs direction pull (not push)", async () => {
		// Drive the PM_TOOL_MISMATCH FAILURE return on a pull: the story is
		// pinned to a different MCP server than the active one, and pull cannot
		// override the mismatch — so it returns a clean FAILURE and logs it.
		vi.mocked(getMcpConfigById).mockResolvedValue({
			mcpServerId: "srv-active",
		} as never);
		vi.mocked(getStoryById).mockResolvedValue(
			makeEntity({ externalMcpServerId: "srv-other" }) as never,
		);

		const result = await syncStoryToPM({
			storyId: "ent-1",
			projectId: PROJECT_ID,
			mcpConfigId: "mcp-1",
			containerId: "board-1",
			direction: "pull",
			userId: "user-9",
			organizationId: "org-1",
		});

		expect(result.success).toBe(false);
		expect(dbMocks.recordPmSyncLog).toHaveBeenCalledTimes(1);
		expect(dbMocks.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				direction: "pull",
				status: "FAILURE",
				entityType: "STORY",
				entityId: "ent-1",
				// user-triggered sync → actorUserId is the acting user.
				actorUserId: "user-9",
			}),
		);
	});

	it("a push-direction failure logs direction push", async () => {
		vi.mocked(getMcpConfigById).mockResolvedValue({
			mcpServerId: "srv-active",
		} as never);
		vi.mocked(getStoryById).mockResolvedValue(
			makeEntity({ externalMcpServerId: "srv-other" }) as never,
		);

		const result = await syncStoryToPM({
			storyId: "ent-1",
			projectId: PROJECT_ID,
			mcpConfigId: "mcp-1",
			containerId: "board-1",
			direction: "push",
			userId: "user-9",
			organizationId: "org-1",
			// push without override still hits the hard mismatch block → FAILURE.
		});

		expect(result.success).toBe(false);
		expect(dbMocks.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({ direction: "push", status: "FAILURE" }),
		);
	});
});
