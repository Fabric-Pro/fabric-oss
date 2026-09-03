/**
 * Story Sync Tests
 *
 * Tests for the story sync activities with dynamic PM tool discovery.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/agent-core/backend. Explicit mock (no importOriginal) avoids
// loading real @repo/database, which would keep pg.Pool handles alive
// past vitest exit (see vitest #4373).
vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	getMcpClientResult: vi.fn(),
	closeMcpClientSafe: vi.fn().mockResolvedValue(undefined),
	getDetailedMcpToolInfo: vi.fn().mockResolvedValue([]),
	canMcpToolsHandleTask: vi
		.fn()
		.mockReturnValue({ canHandle: false, matchedTools: [] }),
	generateMemoryContext: vi
		.fn()
		.mockResolvedValue({ contextString: "", memoryCount: 0 }),
	getConfiguredAIModel: vi.fn().mockResolvedValue({}),
}));

// Mock the orchestrator's executeMcpTool
vi.mock("../src/activities/orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

// Mock @repo/storage so the story-media signed-URL resolver doesn't reach a
// real S3 client during sync tests. Returns deterministic signed URLs that
// the integration tests assert on.
vi.mock("@repo/storage", () => ({
	getStorageProvider: vi.fn(() => ({
		getSignedUrl: vi.fn(
			async (key: string) =>
				`https://signed.example.com/${key}?Sig=test&Expires=999999`,
		),
	})),
}));

// Mock @repo/config so the resolver picks up a stable bucket name regardless
// of which .env file the test runner happens to load.
vi.mock("@repo/config", () => ({
	config: {
		storage: {
			bucketNames: {
				projectContexts: "test-project-contexts",
			},
		},
	},
}));

// Mock database explicitly — see comment on @repo/agent-core/backend mock.
vi.mock("@repo/database", () => {
	// Replicate the real F-1219 back-link helpers locally so the Fizzy
	// push pipeline tests can exercise the full HTML-conversion path
	// without pulling in @repo/database (which would re-introduce the
	// pg.Pool leak we mock around). The real per-provider regex
	// behaviour is unit-tested in
	// @repo/database/__tests__/fabric-back-link.test.ts — this mock just
	// has to stay byte-equivalent. Non-Fizzy callers see identity, so the
	// description-passes-verbatim assertions further down still hold.
	const HTML_BACK_LINK_RE =
		/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i;
	const MARKDOWN_BACK_LINK_RE = /\[View in Fabric\]\(([^)]+)\)/;
	const isFizzy = (p: string | null | undefined) =>
		(p ?? "").toLowerCase() === "fizzy";
	return {
		db: {
			userStory: {
				findMany: vi.fn(),
				findFirst: vi.fn(),
				findUnique: vi.fn(),
				update: vi.fn(),
			},
			storyTask: { findUnique: vi.fn() },
			organization: { findUnique: vi.fn() },
			project: { findUnique: vi.fn() },
		},
		Prisma: {},
		PmSyncStatus: {
			PENDING: "PENDING",
			SUCCESS: "SUCCESS",
			CONFLICT: "CONFLICT",
			FAILED: "FAILED",
		},
		createStory: vi.fn(),
		deleteStory: vi.fn(),
		listStoryStatuses: vi.fn(),
		getStoryById: vi.fn(),
		getMcpConfigById: vi.fn(),
		updateStory: vi.fn(),
		updateTask: vi.fn(),
		// Read-only mode gate — default: project is writable
		isProjectReadOnly: vi.fn(async () => false),
		buildFabricStoryUrl: vi
			.fn()
			.mockResolvedValue(
				"https://fabric.test/app/projects/proj-1/stories/new-story-1",
			),
		appendFabricBackLink: (
			description: string | null | undefined,
			fabricUrl: string,
		) => {
			const current = description ?? "";
			if (current.includes("View in Fabric")) {
				return current;
			}
			const anchor = `<p><a href="${fabricUrl}">View in Fabric</a></p>`;
			return current.length === 0 ? anchor : `${current}\n${anchor}`;
		},
		HTML_BACK_LINK_RE,
		formatBackLinkForProvider: (
			description: string | null | undefined,
			providerDetectedType: string | null | undefined,
		) => {
			const current = description ?? "";
			if (!isFizzy(providerDetectedType)) {
				return current;
			}
			const m = current.match(HTML_BACK_LINK_RE);
			if (!m) {
				return current;
			}
			return current.replace(
				HTML_BACK_LINK_RE,
				`[View in Fabric](${m[1]})`,
			);
		},
		normalizeBackLinkFromProvider: (
			description: string | null | undefined,
			providerDetectedType: string | null | undefined,
		) => {
			const current = description ?? "";
			if (!isFizzy(providerDetectedType)) {
				return current;
			}
			const m = current.match(MARKDOWN_BACK_LINK_RE);
			if (!m) {
				return current;
			}
			const safeUrl = m[1].replace(/"/g, "&quot;");
			return current.replace(
				MARKDOWN_BACK_LINK_RE,
				`<p><a href="${safeUrl}">View in Fabric</a></p>`,
			);
		},
	};
});

// Mock the audit-log writer so the import-pull logging can be asserted without
// a real DB write (the real `recordPmSyncLog` → `createPmSyncLog`).
const mockRecordPmSyncLog = vi.fn();
vi.mock("../src/activities/pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog: (...args: unknown[]) => mockRecordPmSyncLog(...args),
}));

// Mock the STORY-only terminal-status reconcile leaf so the #1360 pull-wiring
// tests can assert it is invoked with the raw-derived `item` (proving the
// raw-preserving unwrap + normalize) and can drive its return / throw without
// exercising the full applyTerminalClose DB chain (tested in Task 1's suite).
vi.mock(
	"../src/activities/pm-integration/reconcile-story-terminal-status",
	() => ({
		reconcileStoryTerminalStatus: vi.fn(),
	}),
);

import { getMcpClient, getMcpClientResult } from "@repo/agent-core/backend";
import {
	createStory,
	db,
	getStoryById,
	listStoryStatuses,
	updateStory,
} from "@repo/database";
import { executeMcpTool } from "../src/activities/orchestrator/execution/execute-mcp-tool";
import { reconcileStoryTerminalStatus } from "../src/activities/pm-integration/reconcile-story-terminal-status";
import {
	buildStoryDescription,
	cleanAdoCodeBlocks,
	cleanContentForPM,
	createOrUpdateStoryFromPMItem,
	discoverPMToolCapabilities,
	extractFizzyTables,
	extractPreBlocks,
	getWorkItemsByIdsFromPM,
	listAllFizzyCards,
	listWorkItemsFromPM,
	markdownToSimpleHtml,
	type PMWorkItemSummary,
	parsePMItemFromGetOutput,
	restoreFizzyTables,
	type StorySyncInput,
	simpleHtmlToMarkdown,
	syncBulkStoriesToPM,
	syncStoryToPM,
	tiptapTableToLexxy,
} from "../src/activities/pm-integration/story-sync";
import {
	extractFizzyFileAttachments,
	fileNameForImage,
	hasMarkdownMarkers,
	looksLikeHtmlBody,
	resolveFizzyFileEmbeds,
	restoreFizzyFileAttachments,
	stripStoryMediaFileAnchors,
	uploadGitLabFileAttachmentsAndRewrite,
	uploadGitLabImagesAndRewriteDescription,
} from "../src/activities/pm-integration/story-sync-media";
// The workflow bundle carries its own copy of the description-cleanup family.
// Imported here so the parity assertion can prove the two stay identical.
import { cleanContentForPM as workflowCleanContentForPM } from "../src/workflows/story-sync-workflow";

// =============================================================================
// Test Data
// =============================================================================

const MOCK_STORY = {
	id: "story-123",
	identifier: "US-001",
	title: "User login functionality",
	description: "As a user, I want to log in to the application",
	acceptanceCriteria:
		"- Given valid credentials\n- When I click login\n- Then I should be authenticated",
	priority: "P1_HIGH" as const,
	size: "M" as const,
	storyPoints: 5,
	labels: ["auth", "mvp"],
	externalId: null,
	externalUrl: null,
	tasks: [],
};

const MOCK_SYNCED_STORY = {
	...MOCK_STORY,
	externalId: "card-external-123",
	externalUrl: "https://pm-tool.io/cards/card-external-123",
};

// Mock MCP tools with generic names (not hardcoded to Fizzy)
const MOCK_MCP_TOOLS = {
	create_card: {
		description: "Create a new card",
		inputSchema: {
			type: "object",
			properties: {
				board_id: { type: "string" },
				title: { type: "string" },
				description: { type: "string" },
			},
			required: ["board_id", "title"],
		},
	},
	update_card: {
		description: "Update an existing card",
		inputSchema: {
			type: "object",
			properties: {
				card_id: { type: "string" },
				title: { type: "string" },
				description: { type: "string" },
			},
			required: ["card_id"],
		},
	},
	get_card: {
		description: "Get a card by ID",
		inputSchema: {
			type: "object",
			properties: {
				card_id: { type: "string" },
			},
			required: ["card_id"],
		},
	},
};

// =============================================================================
// Helper to setup MCP client mock
// =============================================================================

function setupMcpClientMock() {
	const mockClient = {
		tools: vi.fn().mockResolvedValue(MOCK_MCP_TOOLS),
	};

	vi.mocked(getMcpClient).mockResolvedValue({
		client: mockClient as any,
		serverName: "test-pm-server",
	});
	vi.mocked(getMcpClientResult).mockResolvedValue({
		ok: true,
		client: mockClient as any,
		serverName: "test-pm-server",
	});

	return mockClient;
}

// =============================================================================
// Tests
// =============================================================================

describe("discoverPMToolCapabilities", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should discover create, update, and get capabilities from MCP tools", async () => {
		setupMcpClientMock();

		const capabilities = await discoverPMToolCapabilities({
			mcpConfigId: "mcp-config-123",
			userId: "user-123",
		});

		expect(capabilities).not.toBeNull();
		expect(capabilities?.hasPMCapabilities).toBe(true);
		expect(capabilities?.taskCreation?.toolName).toBe("create_card");
		expect(capabilities?.taskUpdate?.toolName).toBe("update_card");
		expect(capabilities?.taskGet?.toolName).toBe("get_card");
	});

	it("should return null when getMcpClient fails", async () => {
		vi.mocked(getMcpClient).mockResolvedValue(null);
		vi.mocked(getMcpClientResult).mockResolvedValue({
			ok: false,
			error: {
				code: "CONFIG_NOT_FOUND",
				message: "MCP client could not be created",
			},
		});

		const capabilities = await discoverPMToolCapabilities({
			mcpConfigId: "mcp-config-123",
			userId: "user-123",
		});

		expect(capabilities).toBeNull();
	});

	it("synthesizes REST-GitLab pull capabilities when mcpConfigId is null", async () => {
		const capabilities = await discoverPMToolCapabilities({
			mcpConfigId: null,
			mcpServerId: "gitlab-server-1",
			userId: "user-123",
			organizationId: "org-1",
			containerId: "12345",
		});

		expect(capabilities).not.toBeNull();
		// Workflow's primary guard at story-sync-workflow.ts:636
		expect(capabilities?.hasPMCapabilities).toBe(true);
		// Pull guard at story-sync-workflow.ts:656 requires truthy taskList
		expect(capabilities?.taskList).toBeDefined();
		// Selective-pull fast path at story-sync-workflow.ts:718 needs taskGet
		expect(capabilities?.taskGet).toBeDefined();
		// Push not yet wired through REST — keep these off so the workflow's
		// push branch doesn't try executeMcpTool on a synthetic tool name
		expect(capabilities?.taskCreation).toBeUndefined();
		expect(capabilities?.taskUpdate).toBeUndefined();
		expect(capabilities?.detectedType).toBe("gitlab");
		// MCP client must not be consulted on the REST path
		expect(vi.mocked(getMcpClient)).not.toHaveBeenCalled();
	});
});

describe("syncStoryToPM", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should create a new card when story has no externalId", async () => {
		setupMcpClientMock();

		const mockGetStoryById = vi.mocked(getStoryById);
		const mockExecuteMcpTool = vi.mocked(executeMcpTool);
		const mockUpdateStory = vi.mocked(updateStory);

		mockGetStoryById.mockResolvedValue(MOCK_STORY as any);
		mockExecuteMcpTool.mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id: "new-card-123",
							url: "https://pm-tool.io/cards/new-card-123",
						}),
					},
				],
			},
			durationMs: 100,
		});
		mockUpdateStory.mockResolvedValue({} as any);

		const input: StorySyncInput = {
			storyId: "story-123",
			projectId: "project-456",
			mcpConfigId: "mcp-config-789",
			containerId: "board-abc",
			direction: "push",
			userId: "user-123",
		};

		const result = await syncStoryToPM(input);

		expect(result.success).toBe(true);
		expect(result.externalId).toBe("new-card-123");
		expect(result.externalUrl).toBe(
			"https://pm-tool.io/cards/new-card-123",
		);

		// Verify the dynamically discovered tool was used
		expect(mockExecuteMcpTool).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "create_card",
				args: expect.objectContaining({
					board_id: "board-abc",
					title: MOCK_STORY.title,
				}),
			}),
		);

		expect(mockUpdateStory).toHaveBeenCalledWith(
			"story-123",
			"project-456",
			expect.objectContaining({
				externalId: "new-card-123",
			}),
			{ lastEditedSource: "PM_PULL" },
		);
	});

	it("should update existing card when story has externalId", async () => {
		setupMcpClientMock();

		const mockGetStoryById = vi.mocked(getStoryById);
		const mockExecuteMcpTool = vi.mocked(executeMcpTool);

		mockGetStoryById.mockResolvedValue(MOCK_SYNCED_STORY as any);
		mockExecuteMcpTool.mockResolvedValue({
			success: true,
			output: { id: MOCK_SYNCED_STORY.externalId },
			durationMs: 100,
		});

		const input: StorySyncInput = {
			storyId: "story-123",
			projectId: "project-456",
			mcpConfigId: "mcp-config-789",
			containerId: "board-abc",
			direction: "push",
			userId: "user-123",
		};

		const result = await syncStoryToPM(input);

		expect(result.success).toBe(true);
		expect(result.externalId).toBe(MOCK_SYNCED_STORY.externalId);

		// Verify the dynamically discovered update tool was used
		expect(mockExecuteMcpTool).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "update_card",
				args: expect.objectContaining({
					card_id: MOCK_SYNCED_STORY.externalId,
				}),
			}),
		);
	});

	it("clears a stale FAILED badge on a successful push", async () => {
		// A prior push (e.g. against a previously-configured PM tool) left
		// `lastPmSyncStatus = FAILED` + an error on the row. The next push
		// succeeding must reset that state so the card stops showing
		// "PM sync failed".
		setupMcpClientMock();

		const mockGetStoryById = vi.mocked(getStoryById);
		const mockExecuteMcpTool = vi.mocked(executeMcpTool);
		const mockUserStoryUpdate = vi.mocked(db.userStory.update);

		mockGetStoryById.mockResolvedValue(MOCK_STORY as any);
		mockExecuteMcpTool.mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id: "new-card-123",
							url: "https://pm-tool.io/cards/new-card-123",
						}),
					},
				],
			},
			durationMs: 100,
		});
		mockUserStoryUpdate.mockResolvedValue({} as any);

		const input: StorySyncInput = {
			storyId: "story-123",
			projectId: "project-456",
			mcpConfigId: "mcp-config-789",
			containerId: "board-abc",
			direction: "push",
			userId: "user-123",
		};

		const result = await syncStoryToPM(input);

		expect(result.success).toBe(true);
		expect(mockUserStoryUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "story-123" },
				data: expect.objectContaining({
					lastPmSyncStatus: "SUCCESS",
					lastPmSyncError: null,
				}),
			}),
		);
		// Must NOT stamp a drift baseline here: the body is transformed
		// per-PM-tool and a raw-content hash would mismatch the PM read-back
		// and raise a false CONTENT_DRIFT.
		const clearCall = mockUserStoryUpdate.mock.calls.find(
			(c) => (c[0] as any)?.data?.lastPmSyncStatus === "SUCCESS",
		);
		expect((clearCall?.[0] as any)?.data).not.toHaveProperty(
			"lastSyncedPmHash",
		);
	});

	it("does not clear PM sync state on a pull", async () => {
		// A successful pull (remote read) doesn't prove a push would now
		// succeed, so it must not reset a push-failure badge.
		setupMcpClientMock();

		const mockGetStoryById = vi.mocked(getStoryById);
		const mockExecuteMcpTool = vi.mocked(executeMcpTool);
		const mockUserStoryUpdate = vi.mocked(db.userStory.update);

		mockGetStoryById.mockResolvedValue(MOCK_SYNCED_STORY as any);
		mockExecuteMcpTool.mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id: MOCK_SYNCED_STORY.externalId,
							title: MOCK_SYNCED_STORY.title,
						}),
					},
				],
			},
			durationMs: 100,
		});
		mockUserStoryUpdate.mockResolvedValue({} as any);

		const input: StorySyncInput = {
			storyId: "story-123",
			projectId: "project-456",
			mcpConfigId: "mcp-config-789",
			containerId: "board-abc",
			direction: "pull",
			userId: "user-123",
		};

		await syncStoryToPM(input);

		const clearedSyncState = mockUserStoryUpdate.mock.calls.some(
			(c) => (c[0] as any)?.data?.lastPmSyncStatus === "SUCCESS",
		);
		expect(clearedSyncState).toBe(false);
	});

	it("should handle MCP tool failure gracefully", async () => {
		setupMcpClientMock();

		const mockGetStoryById = vi.mocked(getStoryById);
		const mockExecuteMcpTool = vi.mocked(executeMcpTool);

		mockGetStoryById.mockResolvedValue(MOCK_STORY as any);
		mockExecuteMcpTool.mockResolvedValue({
			success: false,
			output: null,
			durationMs: 100,
		});

		const input: StorySyncInput = {
			storyId: "story-123",
			projectId: "project-456",
			mcpConfigId: "mcp-config-789",
			containerId: "board-abc",
			direction: "push",
			userId: "user-123",
		};

		const result = await syncStoryToPM(input);

		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
	});

	it("should fail when PM tool has no capabilities", async () => {
		vi.mocked(getMcpClient).mockResolvedValue(null);
		vi.mocked(getMcpClientResult).mockResolvedValue({
			ok: false,
			error: {
				code: "CONFIG_NOT_FOUND",
				message: "MCP client could not be created",
			},
		});

		const mockGetStoryById = vi.mocked(getStoryById);
		mockGetStoryById.mockResolvedValue(MOCK_STORY as any);

		const input: StorySyncInput = {
			storyId: "story-123",
			projectId: "project-456",
			mcpConfigId: "mcp-config-789",
			containerId: "board-abc",
			direction: "push",
			userId: "user-123",
		};

		const result = await syncStoryToPM(input);

		expect(result.success).toBe(false);
		expect(result.error).toContain("capabilities");
	});
});

// =============================================================================
// #1360 — Pull not-found three-rule contract
//
//   1. Transient / non-not-found throw → PRESERVE link (any provenance),
//      retryable failure WITHOUT errorCode EXTERNAL_ID_NOT_FOUND.
//   2. Classified not-found + STAMPED link (externalMcpServerId set) →
//      PRESERVE link, errorCode EXTERNAL_ID_NOT_FOUND + linkPreserved:true.
//   3. Classified not-found + NULL-PROVENANCE (legacy) link → keep the
//      existing self-heal unlink (externalId/externalUrl/externalMcpServerId
//      cleared), linkPreserved falsy.
//
// All four cases are driven through the MCP-throw branch (executeMcpTool
// rejecting), which classifies the thrown message before deciding.
// =============================================================================

describe("syncStoryToPM pull not-found three-rule contract (#1360)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const STAMPED_STORY = {
		...MOCK_SYNCED_STORY,
		externalMcpServerId: "srv-1",
	};
	const NULL_PROVENANCE_STORY = {
		...MOCK_SYNCED_STORY,
		externalMcpServerId: null,
	};

	const pullInput: StorySyncInput = {
		storyId: "story-123",
		projectId: "project-456",
		mcpConfigId: "mcp-config-789",
		containerId: "board-abc",
		direction: "pull",
		userId: "user-123",
	};

	function wasUnlinked() {
		return vi
			.mocked(updateStory)
			.mock.calls.some(
				(c) =>
					(c[2] as { externalId?: unknown } | undefined)
						?.externalId === null,
			);
	}

	it("not-found on a STAMPED link PRESERVES it (no externalId clear; linkPreserved:true)", async () => {
		setupMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(STAMPED_STORY as any);
		vi.mocked(executeMcpTool).mockRejectedValue(
			new Error("Work item not found"),
		);
		vi.mocked(updateStory).mockResolvedValue({} as any);

		const result = await syncStoryToPM(pullInput);

		expect(wasUnlinked()).toBe(false);
		expect(result.success).toBe(false);
		expect(result.errorCode).toBe("EXTERNAL_ID_NOT_FOUND");
		expect((result as { linkPreserved?: boolean }).linkPreserved).toBe(
			true,
		);
	});

	it("not-found on a NULL-PROVENANCE (legacy) link still self-heals (unlinks; linkPreserved falsy)", async () => {
		setupMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(NULL_PROVENANCE_STORY as any);
		vi.mocked(executeMcpTool).mockRejectedValue(
			new Error("Work item not found"),
		);
		vi.mocked(updateStory).mockResolvedValue({} as any);

		const result = await syncStoryToPM(pullInput);

		expect(wasUnlinked()).toBe(true);
		expect(result.success).toBe(false);
		expect(result.errorCode).toBe("EXTERNAL_ID_NOT_FOUND");
		expect(
			(result as { linkPreserved?: boolean }).linkPreserved,
		).toBeFalsy();
	});

	it("TRANSIENT throw NEVER unlinks (stamped) — retryable, no EXTERNAL_ID_NOT_FOUND", async () => {
		setupMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(STAMPED_STORY as any);
		vi.mocked(executeMcpTool).mockRejectedValue(new Error("ECONNRESET"));
		vi.mocked(updateStory).mockResolvedValue({} as any);

		const result = await syncStoryToPM(pullInput);

		expect(wasUnlinked()).toBe(false);
		expect(result.success).toBe(false);
		expect(result.errorCode).not.toBe("EXTERNAL_ID_NOT_FOUND");
	});

	it("TRANSIENT throw NEVER unlinks (null-provenance) — retryable", async () => {
		setupMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(NULL_PROVENANCE_STORY as any);
		vi.mocked(executeMcpTool).mockRejectedValue(
			new Error("rate limit exceeded"),
		);
		vi.mocked(updateStory).mockResolvedValue({} as any);

		const result = await syncStoryToPM(pullInput);

		expect(wasUnlinked()).toBe(false);
		expect(result.success).toBe(false);
		expect(result.errorCode).not.toBe("EXTERNAL_ID_NOT_FOUND");
	});
});

// =============================================================================
// #1360 — Task 6: MCP pull runs the STORY terminal-status reconcile using the
// raw payload already fetched (zero extra MCP roundtrips). Non-fatal.
//
//   (a) Pull of a CLOSED Fizzy card (raw { closed: true, column: { name:
//       "Done" } }) + project pmAutoCloseEnabled:true + a DRAFT story →
//       reconcile is invoked with the RAW-derived item (isClosed:true,
//       state:"Done"), and its result threads into the sync return
//       (terminalApplied:true, lifecycleAction:"auto-hidden",
//       lifecycleReconciled:true).
//   (b) reconcile THROWS → the content pull still succeeds
//       (success:true, lifecycleReconciled:false).
// =============================================================================

describe("syncStoryToPM pull terminal-status reconcile wiring (#1360)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// Pre-discovered Fizzy capabilities with a single-item get tool, so the pull
	// branch fetches via executeMcpTool and normalize uses the Fizzy raw shape.
	const FIZZY_PULL_CAPABILITIES = {
		hasPMCapabilities: true,
		detectedType: "fizzy",
		containerHierarchy: [],
		availableTools: ["get_card"],
		taskGet: {
			toolName: "get_card",
			idParam: "card_id",
			additionalRequiredParams: [],
			allParams: [{ name: "card_id" }],
		},
	} as any;

	// Stamped DRAFT story (stamped so the success path is exercised, not the
	// legacy self-heal not-found branch).
	const DRAFT_STAMPED_STORY = {
		...MOCK_SYNCED_STORY,
		draftingStage: "DRAFT",
		pmAutoHidden: false,
		externalMcpServerId: "srv-1",
	};

	const pullInput: StorySyncInput = {
		storyId: "story-123",
		projectId: "project-456",
		mcpConfigId: "mcp-config-789",
		containerId: "board-abc",
		direction: "pull",
		userId: "user-123",
		capabilities: FIZZY_PULL_CAPABILITIES,
	};

	/** A Fizzy get-card payload for a CLOSED card, wrapped in MCP text content. */
	function closedFizzyCardOutput() {
		return {
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id: MOCK_SYNCED_STORY.externalId,
							title: "Pulled title",
							description: "Pulled description",
							closed: true,
							column: { name: "Done" },
						}),
					},
				],
			},
			durationMs: 10,
		};
	}

	it("pull of a closed Fizzy card runs the reconcile with the raw-derived item and auto-hides", async () => {
		setupMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(DRAFT_STAMPED_STORY as any);
		vi.mocked(executeMcpTool).mockResolvedValue(closedFizzyCardOutput());
		vi.mocked(updateStory).mockResolvedValue({} as any);
		vi.mocked(listStoryStatuses).mockResolvedValue([] as any);
		vi.mocked(db.project.findUnique).mockResolvedValue({
			pmTerminalStatuses: [],
			pmAutoCloseEnabled: true,
			organizationId: "org-1",
			userId: "user-9",
		} as any);
		vi.mocked(reconcileStoryTerminalStatus).mockResolvedValue({
			terminalApplied: true,
			action: "auto-hidden",
			pendingChangesCreated: 0,
			terminalStatusLabel: "Done",
		});

		const result = await syncStoryToPM(pullInput);

		// The reconcile saw the RAW closure (not parsePMItemFromGetOutput's
		// result, which drops `closed`): isClosed true + the Fizzy column name.
		expect(reconcileStoryTerminalStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-456",
				item: expect.objectContaining({
					externalId: MOCK_SYNCED_STORY.externalId,
					isClosed: true,
					state: "Done",
				}),
				fabricItem: expect.objectContaining({
					entityType: "STORY",
					entityId: "story-123",
					draftingStage: "DRAFT",
					pmAutoHidden: false,
				}),
				autoCloseEnabled: true,
			}),
		);
		// The default ["Closed","Done","Removed"] terminal-set fallback is applied
		// (project.pmTerminalStatuses was empty) and lowercased.
		const callArg = vi.mocked(reconcileStoryTerminalStatus).mock
			.calls[0][0] as { terminalLc: Set<string> };
		expect(callArg.terminalLc.has("done")).toBe(true);

		expect(result.success).toBe(true);
		expect(result.terminalApplied).toBe(true);
		expect(result.lifecycleAction).toBe("auto-hidden");
		expect(result.lifecycleReconciled).toBe(true);
		expect(result.terminalStatusLabel).toBe("Done");
	});

	it("reconcile failure is non-fatal — content pull still succeeds", async () => {
		setupMcpClientMock();
		vi.mocked(getStoryById).mockResolvedValue(DRAFT_STAMPED_STORY as any);
		vi.mocked(executeMcpTool).mockResolvedValue(closedFizzyCardOutput());
		vi.mocked(updateStory).mockResolvedValue({} as any);
		vi.mocked(listStoryStatuses).mockResolvedValue([] as any);
		vi.mocked(db.project.findUnique).mockResolvedValue({
			pmTerminalStatuses: [],
			pmAutoCloseEnabled: true,
			organizationId: "org-1",
			userId: "user-9",
		} as any);
		vi.mocked(reconcileStoryTerminalStatus).mockRejectedValue(
			new Error("reconcile boom"),
		);

		const result = await syncStoryToPM(pullInput);

		expect(result.success).toBe(true);
		expect(result.lifecycleReconciled).toBe(false);
		// No lifecycle outcome was threaded since the reconcile threw.
		expect(result.terminalApplied).toBeUndefined();
		expect(result.lifecycleAction).toBeUndefined();
	});
});

describe("syncBulkStoriesToPM", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should sync multiple stories", async () => {
		setupMcpClientMock();

		const mockDb = vi.mocked(db);
		const mockGetStoryById = vi.mocked(getStoryById);
		const mockExecuteMcpTool = vi.mocked(executeMcpTool);
		const mockUpdateStory = vi.mocked(updateStory);

		// Mock findMany to return 2 stories
		(
			mockDb.userStory.findMany as ReturnType<typeof vi.fn>
		).mockResolvedValue([
			{ id: "story-1", identifier: "US-001" },
			{ id: "story-2", identifier: "US-002" },
		] as any);

		// Mock getStoryById for each story
		mockGetStoryById.mockImplementation(async (storyId: string) => {
			if (storyId === "story-1") {
				return {
					...MOCK_STORY,
					id: "story-1",
					identifier: "US-001",
				} as any;
			}
			return {
				...MOCK_STORY,
				id: "story-2",
				identifier: "US-002",
			} as any;
		});

		mockExecuteMcpTool.mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id: "card-123",
							url: "https://pm-tool.io/card-123",
						}),
					},
				],
			},
			durationMs: 100,
		});
		mockUpdateStory.mockResolvedValue({} as any);

		const result = await syncBulkStoriesToPM({
			projectId: "project-456",
			mcpConfigId: "mcp-config-789",
			containerId: "board-abc",
			userId: "user-123",
		});

		expect(result.success).toBe(true);
		expect(result.totalStories).toBe(2);
		expect(result.syncedCount).toBe(2);
		expect(result.failedCount).toBe(0);

		// Verify dynamic tool discovery was used (2 stories = 2 create calls)
		expect(mockExecuteMcpTool).toHaveBeenCalledTimes(2);
	});
});

// =============================================================================
// Group 3 (F-1035): listWorkItemsFromPM — availableWorkItemTypes / availableStates
// =============================================================================

/**
 * Stand up a mock MCP client whose `tools()` returns `toolDefs`. Used by
 * `discoverPMToolCapabilities` so the listing code path picks the right
 * `taskList` tool + detectedType.
 */
function setupToolsMock(toolDefs: Record<string, unknown>) {
	const client = {
		tools: vi.fn().mockResolvedValue(toolDefs),
	};
	vi.mocked(getMcpClient).mockResolvedValue({
		client: client as any,
		serverName: "test-server",
	});
	vi.mocked(getMcpClientResult).mockResolvedValue({
		ok: true,
		client: client as any,
		serverName: "test-server",
	});
}

/** Shape a text-only MCP content wrapper around a JSON payload. */
function wrapMcpJson(payload: unknown) {
	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
	};
}

describe("listWorkItemsFromPM: availableWorkItemTypes + availableStates", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("extracts distinct work-item types from Jira items (AC-11)", async () => {
		setupToolsMock({
			jira_search_issues: {
				description: "List Jira issues",
				inputSchema: {
					type: "object",
					properties: {
						project_key: { type: "string" },
					},
					required: ["project_key"],
				},
			},
		});

		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: wrapMcpJson({
				items: [
					{
						id: "JIRA-1",
						key: "PROJ-1",
						fields: {
							summary: "Bug in login",
							issuetype: { name: "Bug" },
							status: {
								name: "In Progress",
								statusCategory: { key: "indeterminate" },
							},
						},
					},
					{
						id: "JIRA-2",
						key: "PROJ-2",
						fields: {
							summary: "New feature",
							issuetype: { name: "Story" },
							status: {
								name: "Done",
								statusCategory: { key: "done" },
							},
						},
					},
					{
						id: "JIRA-3",
						key: "PROJ-3",
						fields: {
							summary: "Another bug",
							issuetype: { name: "Bug" },
							status: {
								name: "To Do",
								statusCategory: { key: "new" },
							},
						},
					},
				],
				total: 3,
			}),
			durationMs: 10,
		});

		const result = await listWorkItemsFromPM({
			mcpConfigId: "cfg-jira",
			containerId: "PROJ",
			userId: "user-1",
		});

		// AC-11: only types actually present
		expect(result.availableWorkItemTypes?.sort()).toEqual(["Bug", "Story"]);
		// Adapter-derived terminal from statusCategory, never from name
		const byName = Object.fromEntries(
			(result.availableStates ?? []).map((s) => [s.name, s.isTerminal]),
		);
		expect(byName.Done).toBe(true);
		expect(byName["In Progress"]).toBe(false);
		expect(byName["To Do"]).toBe(false);
	});

	it("marks GitHub `closed` state as terminal by adapter category, not name", async () => {
		setupToolsMock({
			github_list_issues: {
				description: "List GitHub issues",
				inputSchema: {
					type: "object",
					properties: { repo: { type: "string" } },
					required: ["repo"],
				},
			},
		});

		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: wrapMcpJson({
				items: [
					{ id: "gh-1", number: 1, title: "a", state: "open" },
					{ id: "gh-2", number: 2, title: "b", state: "closed" },
					{ id: "gh-3", number: 3, title: "c", state: "open" },
				],
			}),
			durationMs: 10,
		});

		const result = await listWorkItemsFromPM({
			mcpConfigId: "cfg-gh",
			containerId: "owner/repo",
			userId: "user-1",
		});

		const byName = Object.fromEntries(
			(result.availableStates ?? []).map((s) => [s.name, s.isTerminal]),
		);
		expect(byName.open).toBe(false);
		expect(byName.closed).toBe(true);
	});

	it("derives ADO terminal flag from wit_get_work_item_type StateCategory", async () => {
		setupToolsMock({
			wit_list_work_items: {
				description: "List ADO work items",
				inputSchema: {
					type: "object",
					properties: { project: { type: "string" } },
					required: ["project"],
				},
			},
			wit_get_work_item_type: {
				description: "Get ADO work item type",
				inputSchema: {
					type: "object",
					properties: {
						project: { type: "string" },
						type: { type: "string" },
					},
					required: ["project", "type"],
				},
			},
		});

		const exec = vi.mocked(executeMcpTool);
		// First call: the list tool; second call: wit_get_work_item_type.
		exec.mockImplementation(async ({ toolName }) => {
			if (toolName === "wit_list_work_items") {
				return {
					success: true,
					output: wrapMcpJson({
						workItems: [
							{
								id: 1,
								fields: {
									"System.Title": "t1",
									"System.WorkItemType": "User Story",
									"System.State": "Active",
								},
							},
							{
								id: 2,
								fields: {
									"System.Title": "t2",
									"System.WorkItemType": "User Story",
									"System.State": "Closed",
								},
							},
						],
						total: 2,
					}),
					durationMs: 10,
				};
			}
			if (toolName === "wit_get_work_item_type") {
				return {
					success: true,
					output: wrapMcpJson({
						name: "User Story",
						states: [
							{ name: "New", category: "Proposed" },
							{ name: "Active", category: "InProgress" },
							{ name: "Resolved", category: "Resolved" },
							{ name: "Closed", category: "Completed" },
							{ name: "Removed", category: "Removed" },
						],
					}),
					durationMs: 10,
				};
			}
			return { success: false, output: null, durationMs: 0 };
		});

		const result = await listWorkItemsFromPM({
			mcpConfigId: "cfg-ado",
			containerId: "MyProject",
			userId: "user-1",
		});

		expect(result.availableWorkItemTypes).toEqual(["User Story"]);
		const byName = Object.fromEntries(
			(result.availableStates ?? []).map((s) => [s.name, s.isTerminal]),
		);
		// Only states actually present on the board surface
		expect(byName.Active).toBe(false);
		expect(byName.Closed).toBe(true);
		expect(byName.New).toBeUndefined();
		expect(byName.Removed).toBeUndefined();
		// wit_get_work_item_type should have been called exactly once per distinct type
		const typeCalls = exec.mock.calls.filter(
			([c]) =>
				(c as { toolName?: string }).toolName ===
				"wit_get_work_item_type",
		);
		expect(typeCalls).toHaveLength(1);
	});

	it("falls back to isTerminal: false when ADO wit_get_work_item_type is unavailable", async () => {
		// No wit_get_work_item_type tool in the registry
		setupToolsMock({
			wit_list_work_items: {
				description: "List ADO work items",
				inputSchema: {
					type: "object",
					properties: { project: { type: "string" } },
					required: ["project"],
				},
			},
		});

		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: wrapMcpJson({
				workItems: [
					{
						id: 1,
						fields: {
							"System.Title": "t1",
							"System.WorkItemType": "Bug",
							"System.State": "Closed",
						},
					},
				],
			}),
			durationMs: 10,
		});

		const result = await listWorkItemsFromPM({
			mcpConfigId: "cfg-ado",
			containerId: "MyProject",
			userId: "user-1",
		});

		// Spec §11 forbids name-based terminal detection — without the type
		// lookup we cannot know, so every state is isTerminal: false.
		for (const s of result.availableStates ?? []) {
			expect(s.isTerminal).toBe(false);
		}
	});
});

// =============================================================================
// Group 4 (F-1035): ADO batch-get fast path — getWorkItemsByIdsFromPM
// =============================================================================

/** Stand up ADO capabilities with batch-by-ids + work-item-type discovery. */
function setupAdoBatchTools() {
	setupToolsMock({
		wit_list_backlog_work_items: {
			description: "List ADO backlog work items",
			inputSchema: {
				type: "object",
				properties: {
					project: { type: "string" },
					team: { type: "string" },
					backlogId: { type: "string" },
				},
				required: ["project", "team", "backlogId"],
			},
		},
		wit_get_work_items_batch_by_ids: {
			description: "Batch get ADO work items by ID",
			inputSchema: {
				type: "object",
				properties: {
					project: { type: "string" },
					ids: { type: "array", items: { type: "number" } },
					fields: { type: "array", items: { type: "string" } },
				},
				required: ["project", "ids"],
			},
		},
		wit_get_work_item_type: {
			description: "Get ADO work item type",
			inputSchema: {
				type: "object",
				properties: {
					project: { type: "string" },
					type: { type: "string" },
				},
				required: ["project", "type"],
			},
		},
	});
}

describe("getWorkItemsByIdsFromPM: ADO batch fast path (AC-12)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("invokes ONLY wit_get_work_items_batch_by_ids and never the backlog list tool (AC-12)", async () => {
		setupAdoBatchTools();

		const exec = vi.mocked(executeMcpTool);
		exec.mockImplementation(async ({ toolName }) => {
			if (toolName === "wit_get_work_items_batch_by_ids") {
				return {
					success: true,
					output: wrapMcpJson({
						value: [
							{
								id: 417,
								fields: {
									"System.Title": "Item 417",
									"System.WorkItemType": "User Story",
									"System.State": "Active",
									"System.TeamProject": "MyProject",
								},
							},
						],
					}),
					durationMs: 10,
				};
			}
			if (toolName === "wit_get_work_item_type") {
				return {
					success: true,
					output: wrapMcpJson({
						name: "User Story",
						states: [
							{ name: "Active", category: "InProgress" },
							{ name: "Closed", category: "Completed" },
						],
					}),
					durationMs: 10,
				};
			}
			return { success: false, output: null, durationMs: 0 };
		});

		const result = await getWorkItemsByIdsFromPM({
			mcpConfigId: "cfg-ado",
			containerId: "MyProject",
			containerName: "MyProject",
			userId: "user-1",
			ids: [417],
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0].id).toBe("417");
		expect(result.items[0].title).toBe("Item 417");
		expect(result.items[0].workItemType).toBe("User Story");
		expect(result.items[0].state).toBe("Active");

		// AC-12: the full-board list tool MUST NOT have been called.
		const listCalls = exec.mock.calls.filter(
			([c]) =>
				(c as { toolName?: string }).toolName ===
				"wit_list_backlog_work_items",
		);
		expect(listCalls).toHaveLength(0);

		// The batch tool WAS called with the right args shape.
		const batchCalls = exec.mock.calls.filter(
			([c]) =>
				(c as { toolName?: string }).toolName ===
				"wit_get_work_items_batch_by_ids",
		);
		expect(batchCalls).toHaveLength(1);
		const batchArgs = (
			batchCalls[0][0] as { args: Record<string, unknown> }
		).args;
		expect(batchArgs.project).toBe("MyProject");
		expect(batchArgs.ids).toEqual([417]);
		expect(Array.isArray(batchArgs.fields)).toBe(true);
		expect(batchArgs.fields).toEqual(
			expect.arrayContaining([
				"System.Title",
				"System.WorkItemType",
				"System.State",
				"System.TeamProject",
			]),
		);

		// Terminal flag derived from StateCategory, not name.
		const byName = Object.fromEntries(
			result.availableStates.map((s) => [s.name, s.isTerminal]),
		);
		expect(byName.Active).toBe(false);
	});

	it("silent-drop → notFoundIds (spec §11 row 1)", async () => {
		setupAdoBatchTools();

		vi.mocked(executeMcpTool).mockImplementation(async ({ toolName }) => {
			if (toolName === "wit_get_work_items_batch_by_ids") {
				// Requested 3 IDs; ADO silently returns only 1.
				return {
					success: true,
					output: wrapMcpJson({
						value: [
							{
								id: 417,
								fields: {
									"System.Title": "Found",
									"System.WorkItemType": "User Story",
									"System.State": "Active",
									"System.TeamProject": "MyProject",
								},
							},
						],
					}),
					durationMs: 10,
				};
			}
			if (toolName === "wit_get_work_item_type") {
				return {
					success: true,
					output: wrapMcpJson({
						name: "User Story",
						states: [{ name: "Active", category: "InProgress" }],
					}),
					durationMs: 10,
				};
			}
			return { success: false, output: null, durationMs: 0 };
		});

		const result = await getWorkItemsByIdsFromPM({
			mcpConfigId: "cfg-ado",
			containerId: "MyProject",
			containerName: "MyProject",
			userId: "user-1",
			ids: [417, 9001, 9002],
		});

		expect(result.items.map((i) => i.id)).toEqual(["417"]);
		expect(result.notFoundIds.sort((a, b) => a - b)).toEqual([9001, 9002]);
		expect(result.wrongBoardIds).toEqual([]);
	});

	it("container-mismatch → wrongBoardIds and excluded from items", async () => {
		setupAdoBatchTools();

		vi.mocked(executeMcpTool).mockImplementation(async ({ toolName }) => {
			if (toolName === "wit_get_work_items_batch_by_ids") {
				return {
					success: true,
					output: wrapMcpJson({
						value: [
							{
								id: 417,
								fields: {
									"System.Title": "On this board",
									"System.WorkItemType": "User Story",
									"System.State": "Active",
									"System.TeamProject": "MyProject",
								},
							},
							{
								id: 500,
								fields: {
									"System.Title": "Elsewhere",
									"System.WorkItemType": "User Story",
									"System.State": "Active",
									"System.TeamProject": "OtherProject",
								},
							},
						],
					}),
					durationMs: 10,
				};
			}
			if (toolName === "wit_get_work_item_type") {
				return {
					success: true,
					output: wrapMcpJson({
						name: "User Story",
						states: [{ name: "Active", category: "InProgress" }],
					}),
					durationMs: 10,
				};
			}
			return { success: false, output: null, durationMs: 0 };
		});

		const result = await getWorkItemsByIdsFromPM({
			mcpConfigId: "cfg-ado",
			containerId: "MyProject",
			containerName: "MyProject",
			userId: "user-1",
			ids: [417, 500],
		});

		expect(result.items.map((i) => i.id)).toEqual(["417"]);
		expect(result.wrongBoardIds).toEqual([500]);
		expect(result.notFoundIds).toEqual([]);
	});

	// ---------------------------------------------------------------------------
	// Task 1: strict mode + fields override
	// ---------------------------------------------------------------------------

	it("strict: throws on unparseable JSON content (does not silent-drop all)", async () => {
		setupAdoBatchTools();
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: { content: [{ type: "text", text: "<<not json>>" }] },
			durationMs: 10,
		});
		await expect(
			getWorkItemsByIdsFromPM({
				mcpConfigId: "cfg-ado",
				containerId: "MyProject",
				containerName: "MyProject",
				userId: "user-1",
				ids: [1, 2, 3],
				strict: true,
			}),
		).rejects.toThrow(/malformed|unparseable|unrecognized/i);
	});

	it("strict: throws on unrecognized envelope (no array)", async () => {
		setupAdoBatchTools();
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({ unexpected: "shape" }),
					},
				],
			},
			durationMs: 10,
		});
		await expect(
			getWorkItemsByIdsFromPM({
				mcpConfigId: "cfg-ado",
				containerId: "MyProject",
				containerName: "MyProject",
				userId: "user-1",
				ids: [1, 2, 3],
				strict: true,
			}),
		).rejects.toThrow(/malformed|unrecognized/i);
	});

	it("strict: a recognized empty array returns all as notFound (no throw)", async () => {
		setupAdoBatchTools();
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: { content: [{ type: "text", text: JSON.stringify([]) }] },
			durationMs: 10,
		});
		const r = await getWorkItemsByIdsFromPM({
			mcpConfigId: "cfg-ado",
			containerId: "MyProject",
			containerName: "MyProject",
			userId: "user-1",
			ids: [1, 2],
			strict: true,
		});
		expect(r.notFoundIds.sort((a, b) => a - b)).toEqual([1, 2]);
	});

	it("non-strict (default): malformed content still silent-drops all (unchanged behavior)", async () => {
		setupAdoBatchTools();
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: { content: [{ type: "text", text: "<<not json>>" }] },
			durationMs: 10,
		});
		const r = await getWorkItemsByIdsFromPM({
			mcpConfigId: "cfg-ado",
			containerId: "MyProject",
			containerName: "MyProject",
			userId: "user-1",
			ids: [1, 2],
		});
		expect(r.notFoundIds.sort((a, b) => a - b)).toEqual([1, 2]);
	});

	it("fields override is passed to the batch tool", async () => {
		setupAdoBatchTools();
		vi.mocked(executeMcpTool).mockResolvedValueOnce({
			success: true,
			output: { content: [{ type: "text", text: JSON.stringify([]) }] },
			durationMs: 10,
		});
		await getWorkItemsByIdsFromPM({
			mcpConfigId: "cfg-ado",
			containerId: "MyProject",
			containerName: "MyProject",
			userId: "user-1",
			ids: [1],
			fields: ["System.Id", "System.ChangedDate"],
		});
		expect(vi.mocked(executeMcpTool)).toHaveBeenCalledWith(
			expect.objectContaining({
				args: expect.objectContaining({
					fields: ["System.Id", "System.ChangedDate"],
				}),
			}),
		);
	});
});

// =============================================================================
// Group 4 Task 4.4: Adapter-parity — same input matrix → equivalent output
// =============================================================================

/**
 * Normalize observable output for cross-adapter parity comparison. Excludes
 * raw/url/description and terminal state differences so that type- and state-
 * category-based parity can be verified without leaking adapter-specific
 * metadata into the assertion.
 */
function normalizeForParity(result: {
	items: PMWorkItemSummary[];
	availableStates?: { name: string; isTerminal: boolean }[];
}) {
	return {
		items: result.items
			.map((i) => ({
				id: i.id,
				title: i.title,
				workItemType: i.workItemType,
				state: i.state,
			}))
			.sort((a, b) => a.id.localeCompare(b.id)),
		terminalStates: (result.availableStates ?? [])
			.filter((s) => s.isTerminal)
			.map((s) => s.name)
			.sort(),
		nonTerminalStates: (result.availableStates ?? [])
			.filter((s) => !s.isTerminal)
			.map((s) => s.name)
			.sort(),
	};
}

describe("adapter parity: ADO / Jira / GitHub / Fizzy (AC-5)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("ADO no-IDs path marks Closed as terminal via StateCategory", async () => {
		setupToolsMock({
			wit_list_work_items: {
				description: "List ADO work items",
				inputSchema: {
					type: "object",
					properties: { project: { type: "string" } },
					required: ["project"],
				},
			},
			wit_get_work_item_type: {
				description: "Get ADO work item type",
				inputSchema: {
					type: "object",
					properties: {
						project: { type: "string" },
						type: { type: "string" },
					},
					required: ["project", "type"],
				},
			},
		});
		vi.mocked(executeMcpTool).mockImplementation(async ({ toolName }) => {
			if (toolName === "wit_list_work_items") {
				return {
					success: true,
					output: wrapMcpJson({
						workItems: [
							{
								id: 1,
								fields: {
									"System.Title": "A",
									"System.WorkItemType": "Story",
									"System.State": "Active",
								},
							},
							{
								id: 2,
								fields: {
									"System.Title": "B",
									"System.WorkItemType": "Story",
									"System.State": "Closed",
								},
							},
						],
					}),
					durationMs: 10,
				};
			}
			if (toolName === "wit_get_work_item_type") {
				return {
					success: true,
					output: wrapMcpJson({
						name: "Story",
						states: [
							{ name: "Active", category: "InProgress" },
							{ name: "Closed", category: "Completed" },
						],
					}),
					durationMs: 10,
				};
			}
			return { success: false, output: null, durationMs: 0 };
		});

		const ado = await listWorkItemsFromPM({
			mcpConfigId: "cfg-ado",
			containerId: "MyProject",
			userId: "user-1",
		});
		const parity = normalizeForParity(ado);
		expect(parity.items.map((i) => i.id).sort()).toEqual(["1", "2"]);
		expect(parity.terminalStates).toEqual(["Closed"]);
		expect(parity.nonTerminalStates).toEqual(["Active"]);
	});

	it("Jira marks done statusCategory as terminal (not by name)", async () => {
		setupToolsMock({
			jira_search_issues: {
				description: "List Jira issues",
				inputSchema: {
					type: "object",
					properties: { project_key: { type: "string" } },
					required: ["project_key"],
				},
			},
		});
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: wrapMcpJson({
				items: [
					{
						id: "1",
						key: "PROJ-1",
						fields: {
							summary: "A",
							issuetype: { name: "Story" },
							status: {
								name: "Active",
								statusCategory: { key: "indeterminate" },
							},
						},
					},
					{
						id: "2",
						key: "PROJ-2",
						fields: {
							summary: "B",
							issuetype: { name: "Story" },
							status: {
								name: "Closed",
								statusCategory: { key: "done" },
							},
						},
					},
				],
			}),
			durationMs: 10,
		});

		const jira = await listWorkItemsFromPM({
			mcpConfigId: "cfg-jira",
			containerId: "PROJ",
			userId: "user-1",
		});
		const parity = normalizeForParity(jira);
		expect(parity.terminalStates).toEqual(["Closed"]);
		expect(parity.nonTerminalStates).toEqual(["Active"]);
	});

	it("GitHub marks closed state as terminal via adapter category", async () => {
		setupToolsMock({
			github_list_issues: {
				description: "List GitHub issues",
				inputSchema: {
					type: "object",
					properties: { repo: { type: "string" } },
					required: ["repo"],
				},
			},
		});
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: wrapMcpJson({
				items: [
					{ id: "1", number: 1, title: "A", state: "open" },
					{ id: "2", number: 2, title: "B", state: "closed" },
				],
			}),
			durationMs: 10,
		});

		const gh = await listWorkItemsFromPM({
			mcpConfigId: "cfg-gh",
			containerId: "owner/repo",
			userId: "user-1",
		});
		const parity = normalizeForParity(gh);
		expect(parity.terminalStates).toEqual(["closed"]);
		expect(parity.nonTerminalStates).toEqual(["open"]);
	});

	it("Fizzy (unknown detectedType): no adapter category → nothing flagged terminal", async () => {
		setupToolsMock({
			fizzy_get_cards: {
				description: "List Fizzy cards",
				inputSchema: {
					type: "object",
					properties: {
						account_slug: { type: "string" },
						board_id: { type: "string" },
					},
					required: ["account_slug", "board_id"],
				},
			},
		});
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: wrapMcpJson({
				cards: [
					{
						card_id: "c1",
						card_number: "914",
						title: "A",
						status: "In Progress",
						type: "Feature",
					},
					{
						card_id: "c2",
						card_number: "915",
						title: "B",
						status: "Done",
						type: "Feature",
					},
				],
			}),
			durationMs: 10,
		});

		const fizzy = await listWorkItemsFromPM({
			mcpConfigId: "cfg-fizzy",
			containerId: "board-1",
			additionalContext: { account_slug: "acct" },
			userId: "user-1",
		});
		const parity = normalizeForParity(fizzy);
		// All four adapters expose items with id/title/type/state under the
		// same shape. For Fizzy (no StateCategory available), terminal
		// detection is conservatively off per spec §11 row 3.
		expect(parity.items.length).toBe(2);
		expect(parity.terminalStates).toEqual([]);
		expect(parity.nonTerminalStates.sort()).toEqual([
			"Done",
			"In Progress",
		]);
	});
});

describe("listAllFizzyCards: account_slug auto-resolve", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const baseCapabilities = {
		hasPMCapabilities: true,
		containerHierarchy: [],
		availableTools: [
			"fizzy_get_accounts",
			"fizzy_get_identity",
			"fizzy_get_columns",
			"fizzy_get_cards",
		],
		detectedType: "fizzy",
		// No `as const`: PMToolCapabilities expects mutable ContainerLevel[] /
		// string[]; a readonly fixture is not assignable when spread into a
		// `capabilities: PMToolCapabilities` field (TS2322).
	};

	it("uses account_slug from additionalContext and skips auto-resolve", async () => {
		vi.mocked(executeMcpTool).mockImplementation(async ({ toolName }) => {
			if (toolName === "fizzy_get_columns") {
				return {
					success: true,
					output: wrapMcpJson([{ id: "col-1", name: "Todo" }]),
					durationMs: 1,
				};
			}
			if (toolName === "fizzy_get_cards") {
				return {
					success: true,
					output: wrapMcpJson({ cards: [] }),
					durationMs: 1,
				};
			}
			throw new Error(`Unexpected tool call: ${toolName}`);
		});

		const result = await listAllFizzyCards({
			mcpConfigId: "cfg-1",
			containerId: "board-1",
			additionalContext: { account_slug: "acct-from-context" },
			userId: "user-1",
			capabilities: { ...baseCapabilities },
		});

		expect(result).not.toBeNull();
		const calls = vi.mocked(executeMcpTool).mock.calls.map((c) => c[0]);
		expect(
			calls.find((c) => c.toolName === "fizzy_get_accounts"),
		).toBeUndefined();
		expect(
			calls.find((c) => c.toolName === "fizzy_get_identity"),
		).toBeUndefined();
		const columnsCall = calls.find(
			(c) => c.toolName === "fizzy_get_columns",
		);
		expect(columnsCall?.args).toMatchObject({
			account_slug: "acct-from-context",
			board_id: "board-1",
		});
	});

	it("auto-resolves account_slug via fizzy_get_accounts when missing from context", async () => {
		vi.mocked(executeMcpTool).mockImplementation(async ({ toolName }) => {
			if (toolName === "fizzy_get_accounts") {
				return {
					success: true,
					output: wrapMcpJson([
						{ slug: "resolved-acct", name: "My Team" },
					]),
					durationMs: 1,
				};
			}
			if (toolName === "fizzy_get_columns") {
				return {
					success: true,
					output: wrapMcpJson([{ id: "col-1", name: "Todo" }]),
					durationMs: 1,
				};
			}
			if (toolName === "fizzy_get_cards") {
				return {
					success: true,
					output: wrapMcpJson({ cards: [] }),
					durationMs: 1,
				};
			}
			throw new Error(`Unexpected tool call: ${toolName}`);
		});

		const result = await listAllFizzyCards({
			mcpConfigId: "cfg-1",
			containerId: "board-1",
			additionalContext: {},
			userId: "user-1",
			capabilities: { ...baseCapabilities },
		});

		expect(result).not.toBeNull();
		const columnsCall = vi
			.mocked(executeMcpTool)
			.mock.calls.map((c) => c[0])
			.find((c) => c.toolName === "fizzy_get_columns");
		expect(columnsCall?.args).toMatchObject({
			account_slug: "resolved-acct",
			board_id: "board-1",
		});
	});

	it("falls back to fizzy_get_identity when get_accounts yields no slug", async () => {
		vi.mocked(executeMcpTool).mockImplementation(async ({ toolName }) => {
			if (toolName === "fizzy_get_accounts") {
				return {
					success: true,
					output: wrapMcpJson([]),
					durationMs: 1,
				};
			}
			if (toolName === "fizzy_get_identity") {
				return {
					success: true,
					output: wrapMcpJson([{ account_slug: "identity-acct" }]),
					durationMs: 1,
				};
			}
			if (toolName === "fizzy_get_columns") {
				return {
					success: true,
					output: wrapMcpJson([{ id: "col-1", name: "Todo" }]),
					durationMs: 1,
				};
			}
			if (toolName === "fizzy_get_cards") {
				return {
					success: true,
					output: wrapMcpJson({ cards: [] }),
					durationMs: 1,
				};
			}
			throw new Error(`Unexpected tool call: ${toolName}`);
		});

		const result = await listAllFizzyCards({
			mcpConfigId: "cfg-1",
			containerId: "board-1",
			userId: "user-1",
			capabilities: { ...baseCapabilities },
		});

		expect(result).not.toBeNull();
		const columnsCall = vi
			.mocked(executeMcpTool)
			.mock.calls.map((c) => c[0])
			.find((c) => c.toolName === "fizzy_get_columns");
		expect(columnsCall?.args).toMatchObject({
			account_slug: "identity-acct",
			board_id: "board-1",
		});
	});

	it("returns null when account_slug cannot be resolved (no resolver tools)", async () => {
		vi.mocked(executeMcpTool).mockImplementation(async () => {
			throw new Error("executeMcpTool should not be called");
		});

		const result = await listAllFizzyCards({
			mcpConfigId: "cfg-1",
			containerId: "board-1",
			userId: "user-1",
			capabilities: {
				...baseCapabilities,
				availableTools: ["fizzy_get_columns", "fizzy_get_cards"],
			},
		});

		expect(result).toBeNull();
	});
});

// =============================================================================
// listAllFizzyCards: `fields` projection opt-in (fizzy-mcp #37 / #39)
// =============================================================================
//
// fizzy-mcp's `fields: "summary"` drops `description`/`description_html` — the
// bulk of a card page — in exchange for a 200-char `description_preview`. It is
// safe for the two pickers, which never read a description, and NOT safe for
// the pull-sync / hierarchy paths, which persist one. These tests pin both
// halves: the default must stay a byte-identical request, and the opt-in must
// actually reach the wire.

describe("listAllFizzyCards: fields projection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const baseCapabilities = {
		hasPMCapabilities: true,
		containerHierarchy: [],
		availableTools: ["fizzy_get_columns", "fizzy_get_cards"],
		detectedType: "fizzy",
	};

	/** Mock a one-column board returning `cards` from `fizzy_get_cards`. */
	const mockBoard = (cards: unknown[]) => {
		vi.mocked(executeMcpTool).mockImplementation(async ({ toolName }) => {
			if (toolName === "fizzy_get_columns") {
				return {
					success: true,
					output: wrapMcpJson([{ id: "col-1", name: "Todo" }]),
					durationMs: 1,
				};
			}
			if (toolName === "fizzy_get_cards") {
				return {
					success: true,
					output: wrapMcpJson({ cards }),
					durationMs: 1,
				};
			}
			throw new Error(`Unexpected tool call: ${toolName}`);
		});
	};

	const cardsCallArgs = () =>
		vi
			.mocked(executeMcpTool)
			.mock.calls.map((c) => c[0])
			.find((c) => c.toolName === "fizzy_get_cards")?.args as
			| Record<string, unknown>
			| undefined;

	it("omits `fields` entirely when the caller does not opt in", async () => {
		mockBoard([]);

		await listAllFizzyCards({
			mcpConfigId: "cfg-1",
			containerId: "board-1",
			additionalContext: { account_slug: "acct" },
			userId: "user-1",
			capabilities: { ...baseCapabilities },
		});

		const args = cardsCallArgs();
		expect(args).toMatchObject({
			account_slug: "acct",
			column_id: "col-1",
		});
		// Not `fields: "full"` — absent. A fizzy-mcp deployment predating the
		// projection must see the request it has always seen.
		expect(args).not.toHaveProperty("fields");
	});

	it("omits `fields` when the caller explicitly asks for full", async () => {
		mockBoard([]);

		await listAllFizzyCards({
			mcpConfigId: "cfg-1",
			containerId: "board-1",
			additionalContext: { account_slug: "acct" },
			userId: "user-1",
			capabilities: { ...baseCapabilities },
			fields: "full",
		});

		const args = cardsCallArgs();
		// Assert the call happened first: `not.toHaveProperty` alone would also
		// pass on `undefined`, i.e. if fizzy_get_cards were never called at all.
		expect(args).toBeDefined();
		expect(args).not.toHaveProperty("fields");
	});

	it("forwards `fields: summary` when the caller opts in", async () => {
		mockBoard([]);

		await listAllFizzyCards({
			mcpConfigId: "cfg-1",
			containerId: "board-1",
			additionalContext: { account_slug: "acct" },
			userId: "user-1",
			capabilities: { ...baseCapabilities },
			fields: "summary",
		});

		expect(cardsCallArgs()).toMatchObject({
			account_slug: "acct",
			column_id: "col-1",
			fields: "summary",
		});
	});

	it("maps a summary-shaped card without back-filling description from the preview", async () => {
		// Exactly the shape fizzy-mcp's `summarizeCard` emits: no `description`,
		// a truncated `description_preview`, and no `type`.
		mockBoard([
			{
				id: "card-1",
				number: 42,
				title: "Summary card",
				url: "https://fizzy.example/c/42",
				status: "active",
				column: { id: "col-1", name: "Todo" },
				description_preview: "First 200 chars of the body…",
			},
		]);

		const result = await listAllFizzyCards({
			mcpConfigId: "cfg-1",
			containerId: "board-1",
			additionalContext: { account_slug: "acct" },
			userId: "user-1",
			capabilities: { ...baseCapabilities },
			fields: "summary",
		});

		expect(result?.items).toHaveLength(1);
		const [item] = result?.items ?? [];
		// Identity/triage fields the pickers actually render survive.
		expect(item).toMatchObject({
			id: "card-1",
			displayId: "42",
			title: "Summary card",
			url: "https://fizzy.example/c/42",
			state: "Todo",
		});
		// Deliberately NOT "First 200 chars of the body…": a truncated preview
		// must never masquerade as the description, so misuse on a persisting
		// path fails loudly instead of writing silently-clipped content.
		expect(item.description).toBeNull();
		expect(item.workItemType).toBeUndefined();
	});
});

// =============================================================================
// Markdown → simple HTML link conversion (kept from feature #1219)
// =============================================================================
//
// The convertInlineMarkdown extension that converts `[text](url)` markdown
// links to <a> anchors is a general correctness improvement (any user-authored
// markdown link in a description that gets pushed to an HTML PM tool benefits).
// It survives the move away from comment-posting and is exercised here.

describe("markdownToSimpleHtml — link conversion", () => {
	it("converts inline markdown links to HTML anchors", () => {
		const html = markdownToSimpleHtml(
			"see [docs](https://example.com) for more",
		);
		expect(html).toContain('<a href="https://example.com">docs</a>');
	});

	it("does not emit anchors for non-http(s) schemes (XSS guard)", () => {
		const html = markdownToSimpleHtml("[bad](javascript:alert(1))");
		expect(html).not.toContain("<a");
		// The literal markdown survives as escaped text.
		expect(html).toContain("[bad]");
	});

	it("renders a description ending with a Fabric back-link as an anchor", () => {
		const md =
			"Story body\n\n[View in Fabric](https://app.example/app/acme/projects/p/stories/s)";
		const html = markdownToSimpleHtml(md);
		expect(html).toContain(
			'<a href="https://app.example/app/acme/projects/p/stories/s">View in Fabric</a>',
		);
	});

	it("preserves bold/italic conversion alongside link conversion", () => {
		const html = markdownToSimpleHtml(
			"**bold** and [link](https://example.com)",
		);
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain('<a href="https://example.com">link</a>');
	});
});

// =============================================================================
// Push carries the back-link forward when the story description already has it
// =============================================================================
//
// In the description-based model (feature #1219, post-PR-#762/#763/#764), the
// "[View in Fabric](url)" footer is persisted in the Fabric story's
// description at creation time by createStory in @repo/database. By the time
// syncStoryToPM(push) runs, getStoryById returns a description that already
// ends with the back-link; the push branch must propagate it through unchanged
// — buildStoryDescription doesn't add anything itself.

describe("syncStoryToPM — push propagates back-link from DB-stored description", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("forwards a description that already contains [View in Fabric](url) verbatim", async () => {
		setupMcpClientMock();

		const storyWithLink = {
			...MOCK_STORY,
			description:
				"As a user, I want to log in to the application\n\n[View in Fabric](https://app.fabric.example/app/acme/projects/p123/stories/story-123)",
		};
		vi.mocked(getStoryById).mockResolvedValue(storyWithLink as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id: "new-card-1",
							url: "https://pm-tool.io/cards/new-card-1",
						}),
					},
				],
			},
			durationMs: 10,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		const result = await syncStoryToPM({
			storyId: "story-123",
			projectId: "project-456",
			mcpConfigId: "mcp-config-789",
			containerId: "board-abc",
			direction: "push",
			userId: "user-123",
			organizationId: "org-1",
		});
		expect(result.success).toBe(true);

		const createCall = vi
			.mocked(executeMcpTool)
			.mock.calls.find(
				(c) =>
					(c[0] as { toolName: string }).toolName === "create_card",
			);
		const createArgs = createCall?.[0].args as Record<string, unknown>;
		// Description sent to the PM tool ends with the back-link that
		// the Fabric DB already carried.
		expect(createArgs.description).toContain(
			"[View in Fabric](https://app.fabric.example/app/acme/projects/p123/stories/story-123)",
		);
	});

	it("does NOT inject a back-link when the Fabric description has none (legacy stories)", async () => {
		setupMcpClientMock();

		// Pre-#1219 story without the persisted footer.
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			description: "Plain description without any back-link.",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id: "new-card-2",
							url: "https://pm-tool.io/cards/new-card-2",
						}),
					},
				],
			},
			durationMs: 10,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-123",
			projectId: "project-456",
			mcpConfigId: "mcp-config-789",
			containerId: "board-abc",
			direction: "push",
			userId: "user-123",
			organizationId: "org-1",
		});

		const createCall = vi
			.mocked(executeMcpTool)
			.mock.calls.find(
				(c) =>
					(c[0] as { toolName: string }).toolName === "create_card",
			);
		const createArgs = createCall?.[0].args as Record<string, unknown>;
		expect(createArgs.description).not.toContain("View in Fabric");
	});
});

// =============================================================================
// ADO update path: System.Description forwards verbatim — no transformation
// =============================================================================
//
// Earlier iterations ran markdownToSimpleHtml on the description before
// pushing to ADO's wit_update_work_item JSON-Patch endpoint. That broke the
// round-trip case where the description was already HTML (pulled from ADO
// originally) — the converter escaped existing tags and ADO un-escaped them
// back to literal text, so users saw a wall of <div> markup.
//
// Per product requirement, the back-link is the only thing we add to the
// description. We never transform user content. createStory appends the
// link in matching format (HTML anchor for HTML descriptions, markdown
// link for markdown), and every push-back forwards whatever's stored in
// Fabric verbatim.

describe("syncStoryToPM — ADO update path forwards System.Description verbatim", () => {
	const ADO_TOOLS = {
		wit_create_work_item: {
			description: "Create a new ADO work item",
			inputSchema: {
				type: "object",
				properties: {
					project: { type: "string" },
					workItemType: { type: "string" },
					fields: { type: "array" },
				},
				required: ["project", "workItemType", "fields"],
			},
		},
		wit_update_work_item: {
			description: "Update an existing ADO work item via JSON Patch",
			inputSchema: {
				type: "object",
				properties: {
					id: { type: "number" },
					updates: { type: "array" },
				},
				required: ["id", "updates"],
			},
		},
		wit_get_work_item: {
			description: "Get an ADO work item by ID",
			inputSchema: {
				type: "object",
				properties: {
					id: { type: "number" },
					project: { type: "string" },
				},
				required: ["id", "project"],
			},
		},
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	function setupAdoClient() {
		const mockClient = { tools: vi.fn().mockResolvedValue(ADO_TOOLS) };
		vi.mocked(getMcpClient).mockResolvedValue({
			client: mockClient as any,
			serverName: "azure-devops",
		});
		vi.mocked(getMcpClientResult).mockResolvedValue({
			ok: true,
			client: mockClient as any,
			serverName: "azure-devops",
		});
	}

	function lastUpdateCall(): {
		updates: Array<{ op: string; path: string; value: string }>;
	} {
		const call = vi
			.mocked(executeMcpTool)
			.mock.calls.find(
				(c) =>
					(c[0] as { toolName: string }).toolName ===
					"wit_update_work_item",
			);
		expect(call).toBeDefined();
		return call?.[0].args as {
			updates: Array<{ op: string; path: string; value: string }>;
		};
	}

	it("forwards an already-HTML description verbatim (round-trip pull→push from ADO)", async () => {
		setupAdoClient();
		// Story originally pulled from ADO — description is HTML (each
		// line in its own <div> as ADO stores multi-line content), plus
		// the <a> back-link createStory appended at import time.
		const htmlDescription =
			"<div>345534 </div><div>23544 </div><div>23543 </div>" +
			'<p><a href="https://app.example/app/acme/projects/p/stories/s">View in Fabric</a></p>';

		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_SYNCED_STORY,
			externalId: "146",
			description: htmlDescription,
			acceptanceCriteria: null,
			releaseNotes: null,
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: { id: 146 },
			durationMs: 5,
		});

		await syncStoryToPM({
			storyId: "story-ado-1",
			projectId: "project-ado",
			mcpConfigId: "mcp-cfg-ado",
			containerId: "MyAdoProject",
			direction: "push",
			userId: "user-123",
			organizationId: "org-1",
			additionalContext: { project: "MyAdoProject" },
		});

		const args = lastUpdateCall();
		const descUpdate = args.updates.find(
			(u) => u.path === "/fields/System.Description",
		);
		expect(descUpdate).toBeDefined();
		// Existing tags survive byte-for-byte — no escaping, no wrapping.
		expect(descUpdate?.value).toBe(htmlDescription);
		expect(descUpdate?.value).not.toContain("&lt;div&gt;");
		expect(descUpdate?.value).not.toMatch(/<p><p>/);
	});

	it("forwards a markdown description verbatim too (no surprise conversion)", async () => {
		setupAdoClient();
		// Edge case: hypothetical markdown-shaped description on an
		// already-linked ADO story. We do NOT silently convert to HTML —
		// the user / upstream is responsible for the format they store.
		const mdDescription =
			"Test body\n\n[View in Fabric](https://app.example/app/acme/projects/p/stories/s)";

		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_SYNCED_STORY,
			externalId: "147",
			description: mdDescription,
			acceptanceCriteria: null,
			releaseNotes: null,
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: { id: 147 },
			durationMs: 5,
		});

		await syncStoryToPM({
			storyId: "story-ado-2",
			projectId: "project-ado",
			mcpConfigId: "mcp-cfg-ado",
			containerId: "MyAdoProject",
			direction: "push",
			userId: "user-123",
			organizationId: "org-1",
			additionalContext: { project: "MyAdoProject" },
		});

		const args = lastUpdateCall();
		const descUpdate = args.updates.find(
			(u) => u.path === "/fields/System.Description",
		);
		expect(descUpdate).toBeDefined();
		expect(descUpdate?.value).toBe(mdDescription);
	});
});

// =============================================================================
// Fizzy push path: markdown body → simple HTML (so headings/lists/bold render)
// =============================================================================
//
// Symmetric to PR #985 (which split the back-link format per provider): Fizzy
// stores `description` as plain text and would otherwise render raw `#`, `**`,
// `-` markers to the user. Convert the entire description to simple HTML at the
// push site only — Fabric's DB row stays in canonical markdown-body + HTML-
// anchor form for every tenant. The original PR #781 conversion was reverted
// by commit a566e50e5 because escapeHtml() inside convertInlineMarkdown
// double-encoded the always-HTML back-link anchor (introduced by PR #910); the
// per-provider back-link rewrite in PR #985 strips the HTML anchor before
// markdownToSimpleHtml runs, so the escape path has no anchor to mangle.

describe("syncStoryToPM — Fizzy push converts markdown body to simple HTML", () => {
	const FIZZY_TOOLS = {
		fizzy_create_card: {
			description: "Create a new Fizzy card",
			inputSchema: {
				type: "object",
				properties: {
					board_id: { type: "string" },
					title: { type: "string" },
					description: { type: "string" },
				},
				required: ["board_id", "title"],
			},
		},
		fizzy_update_card: {
			description: "Update an existing Fizzy card",
			inputSchema: {
				type: "object",
				properties: {
					card_number: { type: "number" },
					title: { type: "string" },
					description: { type: "string" },
				},
				required: ["card_number"],
			},
		},
		fizzy_get_card: {
			description: "Get a Fizzy card by ID",
			inputSchema: {
				type: "object",
				properties: {
					card_number: { type: "number" },
				},
				required: ["card_number"],
			},
		},
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	function setupFizzyClient() {
		const mockClient = { tools: vi.fn().mockResolvedValue(FIZZY_TOOLS) };
		vi.mocked(getMcpClient).mockResolvedValue({
			client: mockClient as any,
			serverName: "fizzy",
		});
		vi.mocked(getMcpClientResult).mockResolvedValue({
			ok: true,
			client: mockClient as any,
			serverName: "fizzy",
		});
	}

	function lastDescription(): string {
		const calls = vi.mocked(executeMcpTool).mock.calls;
		const createOrUpdate = calls.find((c) => {
			const name = (c[0] as { toolName: string }).toolName;
			return name === "fizzy_create_card" || name === "fizzy_update_card";
		});
		const args = createOrUpdate?.[0].args as Record<string, unknown>;
		return (args.description as string) ?? "";
	}

	it("emits <h1>/<h2>/<ul>/<li>/<strong> instead of raw markdown markers", async () => {
		setupFizzyClient();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			description:
				"# Feature Stub:\n\n## Description\n\nAs an engineering team, we want **descriptive headers** so they render formatted.",
			acceptanceCriteria:
				"- **GIVEN** a developer opens the feature\n- **WHEN** they read the title\n- **THEN** they see formatted text",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id: "fc-1",
							url: "https://fizzy.example/c/fc-1",
						}),
					},
				],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-1",
			projectId: "project-1",
			mcpConfigId: "mcp-cfg-fizzy",
			containerId: "board-1",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const desc = lastDescription();
		expect(desc).toContain("<h1>Feature Stub:</h1>");
		expect(desc).toContain("<h2>Description</h2>");
		expect(desc).toContain("<strong>descriptive headers</strong>");
		expect(desc).toContain("<ul>");
		// Acceptance Criteria items render as <li> entries — note that
		// `cleanContentForPM` strips bold off the GIVEN/WHEN/THEN keywords
		// before the converter sees them, so we look for the bare keyword
		// inside the <li>.
		expect(desc).toContain("<li>GIVEN a developer opens the feature</li>");
		expect(desc).toContain("<li>WHEN they read the title</li>");
		expect(desc).toContain("<li>THEN they see formatted text</li>");
		// No raw markdown markers leak through.
		expect(desc).not.toMatch(/(^|\n)# /);
		expect(desc).not.toMatch(/(^|\n)## /);
		expect(desc).not.toMatch(/(^|\n)- /);
	});

	// Regression for the Fizzy card 1594 corruption: a story-media FILE anchor
	// (`<a … data-s3-key="story-media/…" download>name</a>`) used to fall
	// straight through `markdownToSimpleHtml`, which HTML-escaped it into
	// literal text (`&lt;a href=…&gt;Test.xlsx&lt;/a&gt;`) — a wall of garbage
	// that replaced the card's real attachments. The file extractor now lifts
	// it into a sentinel token before conversion and restores it as a clean
	// attachment/link. (No account_slug here → resolveFizzyAttachmentTarget
	// returns null → the deterministic clean-anchor fallback, no network.)
	it("ships a story-media file anchor as a clean link, not escaped literal text (card 1594 fix)", async () => {
		setupFizzyClient();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			description:
				'Body before the file.\n\n<a href="http://localhost:9000/project-contexts/story-media/proj/story/pull-xyz/Test.xlsx?X-Amz-Signature=abc" data-s3-key="story-media/proj/story/pull-xyz/Test.xlsx" download>Test.xlsx</a>',
			acceptanceCriteria: "",
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{ type: "text", text: JSON.stringify({ id: "fc-1" }) },
				],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-1",
			projectId: "project-1",
			mcpConfigId: "mcp-cfg-fizzy",
			containerId: "board-1",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const desc = lastDescription();
		// The file ships as a clean anchor with the filename text preserved…
		expect(desc).toContain(">Test.xlsx</a>");
		// …and CRUCIALLY never as the escaped-HTML garbage that corrupted 1594.
		expect(desc).not.toContain("&lt;a");
		expect(desc).not.toContain("&lt;/a&gt;");
		// The raw localhost src is replaced by the resolved (mocked) signed URL.
		expect(desc).not.toContain("localhost:9000");
	});

	it("emits a clean <a> back-link (not the markdown literal) for Fizzy", async () => {
		setupFizzyClient();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			description:
				'As a user, I want to log in.\n\n<p><a href="https://app.fabric.example/app/acme/projects/p/stories/s">View in Fabric</a></p>',
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id: "fc-2",
							url: "https://fizzy.example/c/fc-2",
						}),
					},
				],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-2",
			projectId: "project-1",
			mcpConfigId: "mcp-cfg-fizzy",
			containerId: "board-1",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const desc = lastDescription();
		// The literal markdown back-link is never seen by Fizzy users.
		expect(desc).not.toContain("[View in Fabric](");
		// The HTML anchor we sent is the one we built from the markdown
		// link (proves the pipeline ran, not a verbatim pass-through of the
		// canonical DB anchor — which would have been escaped by the
		// pre-#985 bug).
		expect(desc).toContain(
			'<a href="https://app.fabric.example/app/acme/projects/p/stories/s">View in Fabric</a>',
		);
		// The anchor lives inside a paragraph (markdownToSimpleHtml's
		// fallback for any single-line block).
		expect(desc).toContain(
			'<p><a href="https://app.fabric.example/app/acme/projects/p/stories/s">View in Fabric</a></p>',
		);
		// No double-escaped literal text.
		expect(desc).not.toContain("&lt;p&gt;");
		expect(desc).not.toContain("&lt;a");
	});

	it("does not transform a description with no back-link (rare, but supported)", async () => {
		setupFizzyClient();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			description: "Plain text body without a back-link.",
			acceptanceCriteria: null,
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{ type: "text", text: JSON.stringify({ id: "fc-3" }) },
				],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-3",
			projectId: "project-1",
			mcpConfigId: "mcp-cfg-fizzy",
			containerId: "board-1",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const desc = lastDescription();
		// Plain text still gets wrapped in <p> by markdownToSimpleHtml's
		// fallback path (so Fizzy at least gets a real HTML block).
		expect(desc).toContain("<p>Plain text body without a back-link.</p>");
		expect(desc).not.toContain("View in Fabric");
	});
});

// =============================================================================
// Highlight (<mark>) stripping on the tracker-sync path
// =============================================================================
//
// The editor writes highlights as `<mark data-color="…">…</mark>`. No tracker
// renders that tag: markdown-native tools (github/gitlab/linear/clickup/trello)
// show the literal tag, and the HTML-description subset (fizzy/asana/monday)
// runs through `escapeHtml` and ships `&lt;mark…&gt;`. The strip therefore
// lives in `cleanContentForPM` — the funnel `buildStoryDescription` runs
// BEFORE the per-tool branch — not in `escapeHtml`, which only three of the
// ten tool paths reach.
//
// The patterns are word-delimited on purpose: `/<\/?mark[^>]*>/gi` would also
// eat `<marker>`, `<markdown>` and `Map<markerId, string>`, silently deleting
// real text. Those must keep escaping normally, exactly like `Array<string>`.

/**
 * Matches a REAL `<mark>`/`</mark>` tag only. Deliberately word-delimited so
 * the assertions themselves don't fire on `<marker>`, `<markdown>` or
 * `Map<markerId, string>` — the very strings the strip must preserve.
 */
const RAW_MARK_TAG_RE = /<\/?mark(?=[\s/>])/i;
/** The same tag in HTML-escaped form (`&lt;mark …&gt;` / `&lt;/mark&gt;`). */
const ESCAPED_MARK_TAG_RE = /&lt;\/?mark(?=[\s/]|&gt;)/i;

const HIGHLIGHTED_SOURCE = [
	'## <mark data-color="#fef08a">Description</mark>',
	"",
	'A <mark data-color="#fef08a">highlighted</mark> phrase and a bare <mark>one</mark>.',
	"",
	"Generic types like Array<string> and Map<markerId, string> stay put.",
].join("\n");

describe("cleanContentForPM — highlight (<mark>) stripping", () => {
	it("drops an attributed highlight tag and keeps the text", () => {
		expect(
			cleanContentForPM(
				'A <mark data-color="#fef08a">highlighted</mark> phrase',
			),
		).toBe("A highlighted phrase");
	});

	it("drops a bare highlight tag", () => {
		expect(cleanContentForPM("<mark>text</mark>")).toBe("text");
	});

	it("drops a self-closing tag and tolerates whitespace in the closer", () => {
		expect(cleanContentForPM("before <mark/>after </mark >tail")).toBe(
			"before after tail",
		);
	});

	it("leaves look-alike tags and generic types untouched (not a general HTML stripper)", () => {
		const source =
			"Array<string>, Map<markerId, string>, <marker>, <markdown> and </marker>";
		expect(cleanContentForPM(source)).toBe(source);
	});

	it("cannot be tricked into reassembling a tag from a nested/malformed fragment", () => {
		const cleaned = cleanContentForPM(
			'<ma<mark>rk data-color="x">Body</mark>',
		);
		expect(cleaned).toBe("Body");
		expect(cleaned).not.toMatch(RAW_MARK_TAG_RE);
		expect(markdownToSimpleHtml(cleaned)).not.toMatch(ESCAPED_MARK_TAG_RE);
	});

	it("stays linear and leaves no tag on deeply nested adversarial input", () => {
		// The reassembly guard needs repeated passes, and each pass rescans the
		// whole string -- so an UNBOUNDED fixed point is quadratic in nesting
		// depth. `description` is @db.Text with no length validation upstream
		// and this runs inside a Temporal workflow, so the loop is capped.
		// Deep nesting is adversarial only; real editor output nests one level.
		const build = (depth: number) =>
			`${"<ma".repeat(depth)}<mark>${"rk>".repeat(depth)}Body`;

		const time = (depth: number) => {
			const input = build(depth);
			const started = performance.now();
			const cleaned = cleanContentForPM(input);
			return { elapsed: performance.now() - started, cleaned };
		};

		const small = time(2000);
		const large = time(8000);

		// 4x the input must not cost anything like 16x the time.
		expect(large.elapsed).toBeLessThan(200);
		expect(small.elapsed).toBeLessThan(200);

		// Bounding the loop must not leave a renderable tag behind.
		expect(large.cleaned).not.toMatch(RAW_MARK_TAG_RE);
		expect(markdownToSimpleHtml(large.cleaned)).not.toMatch(
			ESCAPED_MARK_TAG_RE,
		);
	});

	it("cap-path sweep cannot itself reassemble a tag", () => {
		// The cap-path sweep must ESCAPE, never DELETE. A delete splices the
		// neighbours together, which is the same reassembly the loop exists to
		// defeat: `<ma</markrk>` is inert during the loop (neither pattern
		// matches it) and only becomes a live `<mark>` if the sweep removes the
		// `</mark` in its middle.
		//
		// The pure-nest fixture above cannot catch this -- it converges to plain
		// text -- so this fixture pairs an inert fragment with enough nesting to
		// force the cap.
		const inert = "<ma</markrk>X</ma</markrk>";
		const forcesCap = `${"<ma".repeat(11)}<mark>${"rk>".repeat(11)}`;
		const cleaned = cleanContentForPM(inert + forcesCap);

		expect(cleaned).not.toMatch(RAW_MARK_TAG_RE);
		expect(markdownToSimpleHtml(cleaned)).not.toMatch(ESCAPED_MARK_TAG_RE);
	});

	it("keeps the heading when the heading text itself is highlighted", () => {
		expect(
			cleanContentForPM(
				'## <mark data-color="#fef08a">Description</mark>',
			),
		).toBe("## Description");
		// Highlight is stripped BEFORE the redundant-bold heading rule runs,
		// so `### <mark>**Feature Story**</mark>` still collapses to `### Feature Story`.
		expect(cleanContentForPM("### <mark>**Feature Story**</mark>")).toBe(
			"### Feature Story",
		);
	});

	it("matches the workflow-bundle copy byte for byte (activity/workflow parity)", () => {
		const cases = [
			HIGHLIGHTED_SOURCE,
			'A <mark data-color="#fef08a">highlighted</mark> phrase',
			"<mark>text</mark>",
			"before <mark/>after </mark >tail",
			"Array<string>, Map<markerId, string>, <marker>, <markdown>",
			'<ma<mark>rk data-color="x">Body</mark>',
			"### <mark>**Feature Story**</mark>",
			"- **GIVEN** a <mark>highlighted</mark> precondition",
			"",
			"plain line with no decoration at all",
		];
		for (const input of cases) {
			expect(workflowCleanContentForPM(input)).toBe(
				cleanContentForPM(input),
			);
		}
	});
});

describe("buildStoryDescription — highlight tags never reach a tracker", () => {
	it("strips highlights from description, acceptance criteria and release notes alike", () => {
		const built = buildStoryDescription({
			description: HIGHLIGHTED_SOURCE,
			acceptanceCriteria:
				'- **GIVEN** a <mark data-color="#fef08a">highlighted</mark> precondition',
			releaseNotes: "Ships the <mark>highlight</mark> fix.",
		});
		expect(built).not.toMatch(RAW_MARK_TAG_RE);
		expect(built).toContain("A highlighted phrase and a bare one.");
		expect(built).toContain("GIVEN a highlighted precondition");
		expect(built).toContain("Ships the highlight fix.");
		// The look-alikes survive untouched for the escaper downstream.
		expect(built).toContain("Array<string>");
		expect(built).toContain("Map<markerId, string>");
	});
});

describe("highlight stripping — markdown-native AND HTML-description tools", () => {
	const GITHUB_TOOLS = {
		github_create_issue: {
			description: "Create a GitHub issue",
			inputSchema: {
				type: "object",
				properties: {
					repo: { type: "string" },
					title: { type: "string" },
					body: { type: "string" },
				},
				required: ["repo", "title"],
			},
		},
		github_update_issue: {
			description: "Update a GitHub issue",
			inputSchema: {
				type: "object",
				properties: {
					issue_number: { type: "number" },
					title: { type: "string" },
					body: { type: "string" },
				},
				required: ["issue_number"],
			},
		},
		github_get_issue: {
			description: "Get a GitHub issue",
			inputSchema: {
				type: "object",
				properties: { issue_number: { type: "number" } },
				required: ["issue_number"],
			},
		},
	};

	const FIZZY_TOOLS = {
		fizzy_create_card: {
			description: "Create a new Fizzy card",
			inputSchema: {
				type: "object",
				properties: {
					board_id: { type: "string" },
					title: { type: "string" },
					description: { type: "string" },
				},
				required: ["board_id", "title"],
			},
		},
		fizzy_update_card: {
			description: "Update an existing Fizzy card",
			inputSchema: {
				type: "object",
				properties: {
					card_number: { type: "number" },
					title: { type: "string" },
					description: { type: "string" },
				},
				required: ["card_number"],
			},
		},
		fizzy_get_card: {
			description: "Get a Fizzy card by ID",
			inputSchema: {
				type: "object",
				properties: { card_number: { type: "number" } },
				required: ["card_number"],
			},
		},
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	function setupClient(
		tools: Record<string, unknown>,
		serverName: string,
	): void {
		const mockClient = { tools: vi.fn().mockResolvedValue(tools) };
		vi.mocked(getMcpClient).mockResolvedValue({
			client: mockClient as any,
			serverName,
		});
		vi.mocked(getMcpClientResult).mockResolvedValue({
			ok: true,
			client: mockClient as any,
			serverName,
		});
	}

	/** The description/body actually shipped to the tracker. */
	function pushedBody(createTool: string, field: string): string {
		const call = vi
			.mocked(executeMcpTool)
			.mock.calls.find(
				(c) => (c[0] as { toolName: string }).toolName === createTool,
			);
		const args = call?.[0].args as Record<string, unknown>;
		return (args?.[field] as string) ?? "";
	}

	async function pushHighlightedStory(mcpConfigId: string): Promise<void> {
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			description: HIGHLIGHTED_SOURCE,
			acceptanceCriteria:
				'- **GIVEN** a <mark data-color="#fef08a">highlighted</mark> precondition',
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{ type: "text", text: JSON.stringify({ id: "item-1" }) },
				],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-mark-1",
			projectId: "project-1",
			mcpConfigId,
			containerId: "container-1",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});
	}

	it("github (MARKDOWN_DESCRIPTION_TOOLS): clean text, no literal tag", async () => {
		setupClient(GITHUB_TOOLS, "github");
		await pushHighlightedStory("mcp-cfg-github");

		const body = pushedBody("github_create_issue", "body");
		expect(body).not.toBe("");
		expect(body).not.toMatch(RAW_MARK_TAG_RE);
		expect(body).not.toMatch(ESCAPED_MARK_TAG_RE);
		expect(body).toContain("A highlighted phrase and a bare one.");
		expect(body).toContain("## Description");
		expect(body).toContain("GIVEN a highlighted precondition");
		// Markdown-native tools get the raw body, so the look-alikes stay raw.
		expect(body).toContain("Array<string>");
		expect(body).toContain("Map<markerId, string>");
	});

	it("fizzy (HTML_DESCRIPTION_TOOLS): clean text, no escaped tag, same source", async () => {
		setupClient(FIZZY_TOOLS, "fizzy");
		await pushHighlightedStory("mcp-cfg-fizzy");

		const desc = pushedBody("fizzy_create_card", "description");
		expect(desc).not.toBe("");
		expect(desc).not.toMatch(RAW_MARK_TAG_RE);
		// The escaper never sees a mark tag, so no `&lt;mark…` residue either.
		expect(desc).not.toMatch(ESCAPED_MARK_TAG_RE);
		expect(desc).toContain("A highlighted phrase and a bare one.");
		// A highlighted heading still becomes a real heading with clean text.
		expect(desc).toContain("<h2>Description</h2>");
		expect(desc).toContain("<li>GIVEN a highlighted precondition</li>");
		// `Array<string>` / `Map<markerId, string>` / `<marker>` are ESCAPED,
		// not deleted — the word-delimited pattern's whole point.
		expect(desc).toContain("Array&lt;string&gt;");
		expect(desc).toContain("Map&lt;markerId, string&gt;");
	});
});

// =============================================================================
// Fizzy table conversion (Tiptap → Lexxy)
// =============================================================================
//
// Tiptap descriptions can contain inline `<table>` HTML — Tiptap has no
// markdown serializer for tables. Fizzy's editor (Lexxy) rejects the Tiptap-
// specific class / inline-style / colspan attributes and escapes the entire
// block to literal `&lt;table&gt;` text. We pre-extract every `<table>` block,
// convert it to Lexxy's accepted shape, and stitch it back in after
// markdownToSimpleHtml runs. Non-table text continues through the existing
// pipeline byte-for-byte.
//
// Reference: Fizzy card #1355 (bug), Fizzy card #1398 (verified working
// Lexxy table shape).

describe("tiptapTableToLexxy — direct converter", () => {
	it("emits the Lexxy figure wrapper with <table><tbody>", () => {
		const html = tiptapTableToLexxy(
			'<table class="tiptap-table"><tbody><tr><th><p>A</p></th></tr><tr><td><p>1</p></td></tr></tbody></table>',
		);
		expect(
			html.startsWith('<figure class="lexxy-content__table-wrapper">'),
		).toBe(true);
		expect(html).toContain("<table><tbody>");
		expect(html.endsWith("</tbody></table></figure>")).toBe(true);
	});

	it("marks <th> cells with lexxy-content__table-cell--header and leaves <td> plain", () => {
		const html = tiptapTableToLexxy(
			"<table><tbody><tr><th><p>H</p></th></tr><tr><td><p>D</p></td></tr></tbody></table>",
		);
		expect(html).toContain(
			'<th class="lexxy-content__table-cell--header"><p>H</p></th>',
		);
		expect(html).toContain("<td><p>D</p></td>");
	});

	it("strips class, style, colspan, rowspan attributes from cells", () => {
		const html = tiptapTableToLexxy(
			'<table class="tiptap-table" style="min-width: 75px;"><colgroup><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1" style="background:#eee"><p>H</p></th></tr><tr><td colspan="2" rowspan="1"><p>D</p></td></tr></tbody></table>',
		);
		expect(html).not.toContain("tiptap-table");
		expect(html).not.toContain("min-width");
		expect(html).not.toContain("colspan");
		expect(html).not.toContain("rowspan");
		expect(html).not.toContain("background:");
		expect(html).not.toContain("<colgroup>");
		expect(html).not.toContain("<col ");
	});

	it("collapses nested <p> wrappers inside cells to exactly one", () => {
		const html = tiptapTableToLexxy(
			"<table><tbody><tr><td><p><p>nested</p></p></td></tr></tbody></table>",
		);
		// Exactly one <p>…</p> per cell, no leftover nested wrappers.
		expect(html).toContain("<td><p>nested</p></td>");
		expect((html.match(/<p>/g) ?? []).length).toBe(1);
		expect((html.match(/<\/p>/g) ?? []).length).toBe(1);
	});

	it("emits <p><br></p> for empty cells (Lexxy parity)", () => {
		const html = tiptapTableToLexxy(
			"<table><tbody><tr><td><p></p></td><td></td></tr></tbody></table>",
		);
		expect(html).toContain("<td><p><br></p></td>");
		// Both cells should land as the empty-cell form.
		expect((html.match(/<td><p><br><\/p><\/td>/g) ?? []).length).toBe(2);
	});

	it("preserves inline formatting inside cells (strong, em, a, br)", () => {
		const html = tiptapTableToLexxy(
			'<table><tbody><tr><td><p><strong>bold</strong> <em>italic</em> <a href="https://x.example">link</a><br>line2</p></td></tr></tbody></table>',
		);
		expect(html).toContain(
			'<td><p><strong>bold</strong> <em>italic</em> <a href="https://x.example">link</a><br>line2</p></td>',
		);
	});

	it("strips unknown tags inside cells, keeping text", () => {
		const html = tiptapTableToLexxy(
			'<table><tbody><tr><td><p><span class="x">spanned</span><script>alert(1)</script></p></td></tr></tbody></table>',
		);
		expect(html).toContain("<td><p>spannedalert(1)</p></td>");
		expect(html).not.toContain("<span");
		expect(html).not.toContain("<script");
	});

	it("tolerates tables with no <tbody> wrapper (still produces output)", () => {
		const html = tiptapTableToLexxy(
			"<table><tr><th><p>H</p></th></tr><tr><td><p>D</p></td></tr></table>",
		);
		expect(html).toContain("<tbody>");
		expect(html).toContain(
			'<th class="lexxy-content__table-cell--header"><p>H</p></th>',
		);
		expect(html).toContain("<td><p>D</p></td>");
	});

	it("returns empty string for a zero-row table (caller drops it)", () => {
		expect(tiptapTableToLexxy("<table></table>")).toBe("");
		expect(tiptapTableToLexxy("<table><tbody></tbody></table>")).toBe("");
	});
});

describe("extractFizzyTables / restoreFizzyTables — pipeline integration", () => {
	it("round-trips through markdownToSimpleHtml without escaping table tags", () => {
		const input =
			"# Heading\n\n<table><tbody><tr><th><p>H</p></th></tr><tr><td><p>D</p></td></tr></tbody></table>\n\nFollow-up paragraph.";
		const { withTokens, tables } = extractFizzyTables(input);
		// Pre-pass strips the <table> block — markdownToSimpleHtml never sees it.
		expect(withTokens).not.toContain("<table");
		expect(withTokens).toContain("__FIZZY_TABLE_0__");
		expect(tables).toHaveLength(1);

		const rendered = restoreFizzyTables(
			markdownToSimpleHtml(withTokens),
			tables,
		);
		// Heading and paragraph survived the pipeline.
		expect(rendered).toContain("<h1>Heading</h1>");
		expect(rendered).toContain("<p>Follow-up paragraph.</p>");
		// Table is restored as the Lexxy figure block.
		expect(rendered).toContain(
			'<figure class="lexxy-content__table-wrapper">',
		);
		expect(rendered).toContain(
			'<th class="lexxy-content__table-cell--header"><p>H</p></th>',
		);
		// No leftover sentinel, no escaped <table> markup.
		expect(rendered).not.toContain("__FIZZY_TABLE_");
		expect(rendered).not.toContain("&lt;table");
	});

	it("preserves order across multiple tables in one description", () => {
		const input =
			"<table><tbody><tr><td><p>A</p></td></tr></tbody></table>\n\nMid.\n\n<table><tbody><tr><td><p>B</p></td></tr></tbody></table>";
		const { withTokens, tables } = extractFizzyTables(input);
		expect(tables).toHaveLength(2);
		const rendered = restoreFizzyTables(
			markdownToSimpleHtml(withTokens),
			tables,
		);
		const firstIdx = rendered.indexOf("<td><p>A</p></td>");
		const secondIdx = rendered.indexOf("<td><p>B</p></td>");
		expect(firstIdx).toBeGreaterThan(-1);
		expect(secondIdx).toBeGreaterThan(firstIdx);
		expect(rendered).toContain("<p>Mid.</p>");
		expect(rendered).not.toContain("__FIZZY_TABLE_");
	});

	it("is a no-op on inputs without any <table> block", () => {
		const input = "Just **bold** text with no tables.";
		const { withTokens, tables } = extractFizzyTables(input);
		expect(withTokens).toBe(input);
		expect(tables).toHaveLength(0);
		expect(restoreFizzyTables("<p>X</p>", tables)).toBe("<p>X</p>");
	});

	it("drops empty tables instead of restoring them", () => {
		const input = "Before.\n\n<table><tbody></tbody></table>\n\nAfter.";
		const { withTokens, tables } = extractFizzyTables(input);
		expect(tables).toHaveLength(0);
		const rendered = restoreFizzyTables(
			markdownToSimpleHtml(withTokens),
			tables,
		);
		expect(rendered).toContain("<p>Before.</p>");
		expect(rendered).toContain("<p>After.</p>");
		expect(rendered).not.toContain("<figure");
	});

	it("normalises a GFM markdown table to a Lexxy figure (Fizzy push of a typed table — card #1655)", () => {
		const input =
			"423\n\n| 1 | 1 | 1 |\n| --- | --- | --- |\n| 1 | 1 | 1 |\n| 1 | 1 | 1 |";
		const { withTokens, tables } = extractFizzyTables(input);
		expect(tables).toHaveLength(1);
		// The GFM table is recognised + extracted — no literal pipes left behind.
		expect(withTokens).not.toContain("| 1 |");
		expect(withTokens).not.toContain("| --- |");
		const rendered = restoreFizzyTables(
			markdownToSimpleHtml(withTokens),
			tables,
		);
		expect(rendered).toContain(
			'<figure class="lexxy-content__table-wrapper">',
		);
		expect(rendered).toContain("<p>1</p>");
		expect(rendered).toContain("<p>423</p>");
		// No literal GFM pipes or leftover sentinel survive to the Fizzy card.
		expect(rendered).not.toContain("| 1 |");
		expect(rendered).not.toContain("__FIZZY_TABLE_");
	});
});

describe("syncStoryToPM — Fizzy push converts Tiptap tables to Lexxy", () => {
	const FIZZY_TOOLS = {
		fizzy_create_card: {
			description: "Create a new Fizzy card",
			inputSchema: {
				type: "object",
				properties: {
					board_id: { type: "string" },
					title: { type: "string" },
					description: { type: "string" },
				},
				required: ["board_id", "title"],
			},
		},
		fizzy_update_card: {
			description: "Update an existing Fizzy card",
			inputSchema: {
				type: "object",
				properties: {
					card_number: { type: "number" },
					title: { type: "string" },
					description: { type: "string" },
				},
				required: ["card_number"],
			},
		},
		fizzy_get_card: {
			description: "Get a Fizzy card by ID",
			inputSchema: {
				type: "object",
				properties: { card_number: { type: "number" } },
				required: ["card_number"],
			},
		},
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	function setupFizzyClient() {
		const mockClient = { tools: vi.fn().mockResolvedValue(FIZZY_TOOLS) };
		vi.mocked(getMcpClient).mockResolvedValue({
			client: mockClient as any,
			serverName: "fizzy",
		});
		vi.mocked(getMcpClientResult).mockResolvedValue({
			ok: true,
			client: mockClient as any,
			serverName: "fizzy",
		});
	}

	function lastDescription(): string {
		const calls = vi.mocked(executeMcpTool).mock.calls;
		const createOrUpdate = calls.find((c) => {
			const name = (c[0] as { toolName: string }).toolName;
			return name === "fizzy_create_card" || name === "fizzy_update_card";
		});
		const args = createOrUpdate?.[0].args as Record<string, unknown>;
		return (args.description as string) ?? "";
	}

	// The exact Tiptap shape observed in Fizzy card #1355's payload.
	const TIPTAP_TABLE =
		'<table class="tiptap-table" style="min-width: 75px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>Name</p></th><th colspan="1" rowspan="1"><p>Owner</p></th></tr><tr><td colspan="1" rowspan="1"><p>Auth</p></td><td colspan="1" rowspan="1"><p>Vlad</p></td></tr></tbody></table>';

	it("emits a Lexxy <figure> table and never escapes the table tags", async () => {
		setupFizzyClient();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			description: `# Revision history\n\n${TIPTAP_TABLE}`,
			acceptanceCriteria: null,
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{ type: "text", text: JSON.stringify({ id: "fc-t1" }) },
				],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-t1",
			projectId: "project-1",
			mcpConfigId: "mcp-cfg-fizzy",
			containerId: "board-1",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const desc = lastDescription();
		// Lexxy wrapper present.
		expect(desc).toContain('<figure class="lexxy-content__table-wrapper">');
		expect(desc).toContain("<table><tbody>");
		// Header cells marked, data cells plain — preserves Tiptap's th/td.
		expect(desc).toContain(
			'<th class="lexxy-content__table-cell--header"><p>Name</p></th>',
		);
		expect(desc).toContain(
			'<th class="lexxy-content__table-cell--header"><p>Owner</p></th>',
		);
		expect(desc).toContain("<td><p>Auth</p></td>");
		expect(desc).toContain("<td><p>Vlad</p></td>");
		// Tiptap-specific attributes are gone.
		expect(desc).not.toContain("tiptap-table");
		expect(desc).not.toContain("colspan");
		expect(desc).not.toContain("rowspan");
		expect(desc).not.toContain("<colgroup");
		// Nothing escaped — the original bug signature.
		expect(desc).not.toContain("&lt;table");
		expect(desc).not.toContain("&lt;tr");
		expect(desc).not.toContain("&lt;td");
		// Non-table heading still rendered via the existing pipeline.
		expect(desc).toContain("<h1>Revision history</h1>");
		// No sentinel token leaks.
		expect(desc).not.toContain("__FIZZY_TABLE_");
	});

	it("handles multiple tables and keeps the back-link last", async () => {
		setupFizzyClient();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			description: `Intro.\n\n${TIPTAP_TABLE}\n\nMid copy.\n\n${TIPTAP_TABLE}\n\n<p><a href="https://app.fabric.example/app/acme/projects/p/stories/s">View in Fabric</a></p>`,
			acceptanceCriteria: null,
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{ type: "text", text: JSON.stringify({ id: "fc-t2" }) },
				],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-t2",
			projectId: "project-1",
			mcpConfigId: "mcp-cfg-fizzy",
			containerId: "board-1",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const desc = lastDescription();
		// Two figures restored, both with cell data intact.
		expect(
			(desc.match(/<figure class="lexxy-content__table-wrapper">/g) ?? [])
				.length,
		).toBe(2);
		// Back-link present as a real anchor and lands AFTER the second table.
		const backLinkIdx = desc.indexOf(
			'<a href="https://app.fabric.example/app/acme/projects/p/stories/s">View in Fabric</a>',
		);
		const lastFigureIdx = desc.lastIndexOf(
			'<figure class="lexxy-content__table-wrapper">',
		);
		expect(backLinkIdx).toBeGreaterThan(lastFigureIdx);
		expect(desc).not.toContain("&lt;table");
		expect(desc).not.toContain("__FIZZY_TABLE_");
	});

	it("extracts images out of <td> cells and re-emits them as Lexxy attachment figures after the table", async () => {
		setupFizzyClient();
		// A Tiptap table with an image embedded inside the second column of
		// row 1 — Lexxy's cell sanitizer would silently strip the <img>
		// before the bug fix.
		const TIPTAP_TABLE_WITH_IMG =
			'<table class="tiptap-table"><tbody><tr><th colspan="1" rowspan="1"><p>Step</p></th><th colspan="1" rowspan="1"><p>Diagram</p></th></tr><tr><td colspan="1" rowspan="1"><p>1</p></td><td colspan="1" rowspan="1"><p><img src="story-media/p/s/diagram.png" data-s3-key="story-media/p/s/diagram.png" alt="login flow"></p></td></tr></tbody></table>';
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			description: TIPTAP_TABLE_WITH_IMG,
			acceptanceCriteria: null,
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{ type: "text", text: JSON.stringify({ id: "fc-img" }) },
				],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-img",
			projectId: "project-1",
			mcpConfigId: "mcp-cfg-fizzy",
			containerId: "board-1",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const desc = lastDescription();
		// Table figure still emitted with all four cells.
		expect(desc).toContain('<figure class="lexxy-content__table-wrapper">');
		expect(desc).toContain(
			'<th class="lexxy-content__table-cell--header"><p>Step</p></th>',
		);
		expect(desc).toContain(
			'<th class="lexxy-content__table-cell--header"><p>Diagram</p></th>',
		);
		// Image is now an attachment figure appended after the table — not
		// silently stripped from the cell.
		expect(desc).toContain(
			'<figure class="lexxy-content__attachment-wrapper">',
		);
		expect(desc).toContain('alt="login flow"');
		// And it lands AFTER the table figure in document order.
		const tableIdx = desc.indexOf(
			'<figure class="lexxy-content__table-wrapper">',
		);
		const attachIdx = desc.indexOf(
			'<figure class="lexxy-content__attachment-wrapper">',
		);
		expect(attachIdx).toBeGreaterThan(tableIdx);
		// Cell now has the `<br>` empty-cell fallback (image was the only
		// content) — table layout preserved with one row × two columns.
		expect(desc).toContain("<td><p><br></p></td>");
		// No image tags leaked inside any cell.
		const cellWithImg = /(<td>[\s\S]*?<img[\s\S]*?<\/td>)/.exec(desc);
		expect(cellWithImg).toBeNull();
	});

	it("converts standalone markdown ![alt](story-media/...) attachments to Lexxy figures", async () => {
		setupFizzyClient();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			description:
				"Body copy.\n\n## Attachments\n\n![architecture](story-media/p/s/arch.png)",
			acceptanceCriteria: null,
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{ type: "text", text: JSON.stringify({ id: "fc-md" }) },
				],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-md-img",
			projectId: "project-1",
			mcpConfigId: "mcp-cfg-fizzy",
			containerId: "board-1",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const desc = lastDescription();
		// Markdown image converted to a Lexxy attachment figure (the
		// previous bug shipped it as literal `![…](story-media/...)` text).
		expect(desc).toContain(
			'<figure class="lexxy-content__attachment-wrapper">',
		);
		expect(desc).toContain('alt="architecture"');
		// No literal markdown image syntax left.
		expect(desc).not.toContain("![architecture]");
		// No bare story-media key in the final src — it was resolved to a
		// signed URL by the mocked storage provider.
		expect(desc).toMatch(
			/<img src="https:\/\/signed[^"]*story-media\/p\/s\/arch\.png/,
		);
	});
});

describe("syncStoryToPM — non-Fizzy targets normalise Fabric tables to GFM markdown", () => {
	// Generic create tool used by the discovery code as a "this tool can
	// create work items" signal; the description string is the only piece
	// we care about asserting on here.
	const GENERIC_TOOLS = {
		generic_create_work_item: {
			description: "Create a work item",
			inputSchema: {
				type: "object",
				properties: {
					container_id: { type: "string" },
					title: { type: "string" },
					description: { type: "string" },
				},
				required: ["container_id", "title"],
			},
		},
		generic_update_work_item: {
			description: "Update a work item",
			inputSchema: {
				type: "object",
				properties: {
					id: { type: "string" },
					title: { type: "string" },
					description: { type: "string" },
				},
				required: ["id"],
			},
		},
		generic_get_work_item: {
			description: "Get a work item by id",
			inputSchema: {
				type: "object",
				properties: { id: { type: "string" } },
				required: ["id"],
			},
		},
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	function setupClient(detectedType: string) {
		const mockClient = { tools: vi.fn().mockResolvedValue(GENERIC_TOOLS) };
		vi.mocked(getMcpClient).mockResolvedValue({
			client: mockClient as any,
			serverName: detectedType,
		});
		vi.mocked(getMcpClientResult).mockResolvedValue({
			ok: true,
			client: mockClient as any,
			serverName: detectedType,
		});
	}

	function lastDescription(): string {
		const calls = vi.mocked(executeMcpTool).mock.calls;
		const createOrUpdate = calls.find((c) => {
			const name = (c[0] as { toolName: string }).toolName;
			return (
				name === "generic_create_work_item" ||
				name === "generic_update_work_item"
			);
		});
		const args = createOrUpdate?.[0].args as Record<string, unknown>;
		return (args.description as string) ?? "";
	}

	const TIPTAP_TABLE =
		'<table class="tiptap-table"><tbody><tr><th><p>Col</p></th></tr><tr><td><p>Val</p></td></tr></tbody></table>';

	it("Jira push converts a Tiptap-shaped <table> to a GFM markdown table", async () => {
		setupClient("jira");
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			description: TIPTAP_TABLE,
			acceptanceCriteria: null,
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{ type: "text", text: JSON.stringify({ id: "j-1" }) },
				],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-j1",
			projectId: "project-1",
			mcpConfigId: "mcp-cfg-jira",
			containerId: "board-1",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const desc = lastDescription();
		// Fabric-authored tables (Tiptap `class="tiptap-table"`) are now
		// converted to GFM markdown so Jira's renderer shows a real table
		// instead of escaped HTML markup. See bug spec AC1.
		expect(desc).toContain("| Col |");
		expect(desc).toContain("| --- |");
		expect(desc).toContain("| Val |");
		// Original HTML stripped; no Lexxy artefacts on the non-Fizzy path.
		expect(desc).not.toContain('class="tiptap-table"');
		expect(desc).not.toContain("<th><p>");
		expect(desc).not.toContain("lexxy-content__table-wrapper");
		expect(desc).not.toContain("__FIZZY_TABLE_");
	});

	it("Jira push forwards a pulled-from-PM HTML table verbatim (no Tiptap markers)", async () => {
		// Descriptions that round-tripped from a PM tool have no
		// Tiptap class / colgroup / colspan markers and no story-media
		// references. `looksFabricAuthored` should return false and the
		// HTML must pass through byte-for-byte so the next pull→push
		// stays hash-stable.
		const PULLED_HTML_TABLE =
			"<p>Description from Jira.</p><table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>";
		setupClient("jira");
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			description: PULLED_HTML_TABLE,
			acceptanceCriteria: null,
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{ type: "text", text: JSON.stringify({ id: "j-2" }) },
				],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-j2",
			projectId: "project-1",
			mcpConfigId: "mcp-cfg-jira",
			containerId: "board-1",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const desc = lastDescription();
		// HTML table preserved exactly.
		expect(desc).toContain("<table><tbody>");
		expect(desc).toContain("<td>A</td>");
		expect(desc).toContain("<td>B</td>");
		// No GFM conversion applied.
		expect(desc).not.toContain("| A | B |");
	});
});

// =============================================================================
// ADO push: Fabric-authored tables go out as CLEAN HTML (not GFM markdown).
// The ADO MCP server's `wit_update_work_item` JSON Patch entries do not accept
// a `format` field — sending GFM markdown there would show literal `|` / `---`
// text. Clean HTML works on both create and update paths.
// =============================================================================

describe("syncStoryToPM — ADO push ships clean HTML (not GFM markdown)", () => {
	const ADO_TOOLS = {
		wit_create_work_item: {
			description: "Create an Azure DevOps work item",
			inputSchema: {
				type: "object",
				properties: {
					project: { type: "string" },
					workItemType: { type: "string" },
					fields: { type: "array" },
				},
				required: ["project", "workItemType", "fields"],
			},
		},
		wit_update_work_item: {
			description: "Update an Azure DevOps work item",
			inputSchema: {
				type: "object",
				properties: {
					id: { type: "number" },
					updates: { type: "array" },
				},
				required: ["id", "updates"],
			},
		},
		wit_get_work_item: {
			description: "Get an Azure DevOps work item",
			inputSchema: {
				type: "object",
				properties: { id: { type: "number" } },
				required: ["id"],
			},
		},
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	function setupAdoClient() {
		const mockClient = { tools: vi.fn().mockResolvedValue(ADO_TOOLS) };
		vi.mocked(getMcpClient).mockResolvedValue({
			client: mockClient as any,
			serverName: "azure-devops",
		});
		vi.mocked(getMcpClientResult).mockResolvedValue({
			ok: true,
			client: mockClient as any,
			serverName: "azure-devops",
		});
	}

	function lastUpdateDescription(): string {
		const calls = vi.mocked(executeMcpTool).mock.calls;
		const updateCall = calls.find((c) => {
			const name = (c[0] as { toolName: string }).toolName;
			return name === "wit_update_work_item";
		});
		const args = updateCall?.[0].args as Record<string, unknown>;
		const updates = args?.updates as Array<{ path: string; value: string }>;
		const descEntry = updates?.find(
			(u) => u.path === "/fields/System.Description",
		);
		return descEntry?.value ?? "";
	}

	function lastCreateDescription(): {
		value: string;
		format?: string;
	} {
		const calls = vi.mocked(executeMcpTool).mock.calls;
		const createCall = calls.find((c) => {
			const name = (c[0] as { toolName: string }).toolName;
			return name === "wit_create_work_item";
		});
		const args = createCall?.[0].args as Record<string, unknown>;
		const fields = args?.fields as Array<{
			name: string;
			value: string;
			format?: string;
		}>;
		const descEntry = fields?.find((f) => f.name === "System.Description");
		return {
			value: descEntry?.value ?? "",
			format: descEntry?.format,
		};
	}

	const TIPTAP_TABLE =
		'<table class="tiptap-table" style="min-width:75px"><colgroup><col></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>Field</p></th><th colspan="1" rowspan="1"><p>Value</p></th></tr><tr><td colspan="1" rowspan="1"><p>API</p></td><td colspan="1" rowspan="1"><p>v2</p></td></tr></tbody></table>';

	// Regression for ADO WI #225: a description PULLED from ADO is `<div>`-per-
	// line HTML. Once we ingest its inline images (data-s3-key="story-media/…")
	// it trips looksFabricAuthored → lands in this ADO branch. The body must be
	// preserved as HTML (NOT run through markdownToSimpleHtml, which would
	// escape `<div>` → `&lt;div&gt;`), and the story-media FILE anchor must be
	// stripped (ADO holds the file as a native attachment).
	it("preserves pulled ADO <div> HTML and strips the story-media file anchor on push (WI #225)", async () => {
		setupAdoClient();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			externalId: "225",
			externalUrl: "https://dev.azure.com/tf/proj/_workitems/edit/225",
			description:
				'<div>435 </div><div>54 </div><div><img src="http://localhost:9000/x?s=1" data-s3-key="story-media/p/s/pull-img"></div>\n\n<a href="http://localhost:9000/y?s=2" data-s3-key="story-media/p/s/pull-file/Test.xlsx" download>Test.xlsx</a>\n<p><a href="http://localhost:3001/app/projects/p/stories/s">View in Fabric</a></p>',
			acceptanceCriteria: null,
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [{ type: "text", text: JSON.stringify({ id: 225 }) }],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "proj",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const desc = lastUpdateDescription();
		// (1) ADO's <div> structure is preserved, never escaped to literal text.
		expect(desc).toContain("<div>435");
		expect(desc).not.toContain("&lt;div&gt;");
		// (2) The file attachment is NOT pushed into System.Description (ADO has
		// it as a native attachment) — neither present nor escaped.
		expect(desc).not.toContain("Test.xlsx");
		expect(desc).not.toContain("&lt;a");
	});

	// Regression for WI #228 push: after a Fabric edit, the description is
	// MARKDOWN (Tiptap → Turndown removed ADO's <div>s; media became `![](…)` /
	// `[](…)`). The ADO push must CONVERT it to HTML — preserving it would ship
	// raw markdown into System.Description (renders as literal text). The
	// story-media FILE link (markdown form) is stripped; images convert; the
	// back-link converts to a real anchor.
	it("converts an edited (markdown) body to HTML and strips the markdown file link on push (WI #228)", async () => {
		setupAdoClient();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			externalId: "228",
			externalUrl: "https://dev.azure.com/tf/proj/_workitems/edit/228",
			description:
				"32543\n\n345\n\n![](http://localhost:9000/x/story-media/p/s/pull-img?sig=1)\n\n546\n\n[Test.xlsx](http://localhost:9000/x/story-media/p/s/pull-file/Test.xlsx?sig=2)\n\n456543743\n\n[View in Fabric](http://localhost:3001/app/projects/p/stories/s)",
			acceptanceCriteria: null,
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [{ type: "text", text: JSON.stringify({ id: 228 }) }],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-1",
			projectId: "project-1",
			mcpConfigId: "mcp-ado",
			containerId: "proj",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const desc = lastUpdateDescription();
		// Plain-text lines became real <p> blocks (NOT raw markdown text).
		expect(desc).toContain("<p>32543</p>");
		expect(desc).toContain("<p>456543743</p>");
		// No raw markdown markup leaked into ADO's HTML field.
		expect(desc).not.toContain("![](");
		expect(desc).not.toContain("[View in Fabric](");
		// The story-media FILE link was stripped (ADO native attachment).
		expect(desc).not.toContain("Test.xlsx");
		// The back-link converted to a real anchor.
		expect(desc).toContain(">View in Fabric</a>");
	});

	it("converts surrounding markdown (headings / lists / bold) to HTML — regression for ADO showing raw `##` text", async () => {
		setupAdoClient();
		const TIPTAP_TABLE_INLINE =
			'<table class="tiptap-table"><tbody><tr><th><p>A</p></th></tr><tr><td><p>1</p></td></tr></tbody></table>';
		// Note the backtick-wrapped `<table>` / `<img>` / `![](url)` references
		// — those are inline-code syntax samples the AI bug template emits.
		// The extractors must NOT match them as real tables/images.
		const richBody = `## Heading\n\n**Bold** intro paragraph mentions \`<table>\` and \`![alt](url)\` as inline code.\n\n- bullet one\n- bullet two\n\n${TIPTAP_TABLE_INLINE}\n\n## Attachments\n\n![diagram](https://example.com/diagram.png)`;
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			externalId: "42",
			externalUrl: "https://dev.azure.com/tf/proj/_workitems/edit/42",
			description: richBody,
			acceptanceCriteria: null,
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [{ type: "text", text: JSON.stringify({ id: 42 }) }],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-ado-md",
			projectId: "project-1",
			mcpConfigId: "mcp-cfg-ado",
			containerId: "ProjOne",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const desc = lastUpdateDescription();
		// Markdown headings → real HTML headings (not literal `## Heading` text).
		expect(desc).toMatch(/<h2>\s*Heading\s*<\/h2>/);
		// Bold marker → <strong>.
		expect(desc).toContain("<strong>Bold</strong>");
		// Bullet list → real <ul>/<li>.
		expect(desc).toMatch(
			/<ul><li>bullet one<\/li><li>bullet two<\/li><\/ul>/,
		);
		// Embedded table still ships as clean HTML.
		expect(desc).toContain("<table>");
		expect(desc).toContain("<th>A</th>");
		expect(desc).toContain("<td>1</td>");
		// Standalone markdown image becomes an inline <img> tag.
		expect(desc).toMatch(/<img src="https:\/\/example\.com\/diagram\.png"/);
		// Regression guards: NONE of the markdown shapes leak through as
		// literal text the way ADO showed them before PR #1159.
		expect(desc).not.toContain("## Heading");
		expect(desc).not.toContain("**Bold**");
		expect(desc).not.toContain("\n- bullet");
		expect(desc).not.toContain("![diagram](");
		// And — critically — inline-code syntax references like
		// `` `<table>` `` or `` `![alt](url)` `` MUST NOT be extracted as
		// real tables/images. They become real `<code>` elements with the
		// inner content HTML-escaped.
		expect(desc).toMatch(/<code>&lt;table&gt;<\/code>/);
		expect(desc).toMatch(/<code>!\[alt\]\(url\)<\/code>/);
	});

	it("UPDATE path sends clean HTML — no GFM pipes — for Fabric-authored tables", async () => {
		setupAdoClient();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			externalId: "42",
			externalUrl: "https://dev.azure.com/tf/proj/_workitems/edit/42",
			description: TIPTAP_TABLE,
			acceptanceCriteria: null,
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [{ type: "text", text: JSON.stringify({ id: 42 }) }],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-ado-1",
			projectId: "project-1",
			mcpConfigId: "mcp-cfg-ado",
			containerId: "ProjOne",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const desc = lastUpdateDescription();
		// Clean HTML structure preserved.
		expect(desc).toContain("<table>");
		expect(desc).toContain("<th>Field</th>");
		expect(desc).toContain("<th>Value</th>");
		expect(desc).toContain("<td>API</td>");
		expect(desc).toContain("<td>v2</td>");
		// Tiptap noise gone.
		expect(desc).not.toContain("tiptap-table");
		expect(desc).not.toContain("colgroup");
		expect(desc).not.toContain("colspan=");
		expect(desc).not.toContain("rowspan=");
		// And — regression guard — NO GFM markdown.
		expect(desc).not.toContain("| Field |");
		expect(desc).not.toContain("| --- |");
	});

	it('CREATE path sends clean HTML with `format: "Html"`', async () => {
		setupAdoClient();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			externalId: null,
			externalUrl: null,
			description: TIPTAP_TABLE,
			acceptanceCriteria: null,
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id: 100,
							_links: {
								html: {
									href: "https://dev.azure.com/tf/proj/_workitems/edit/100",
								},
							},
						}),
					},
				],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-ado-create",
			projectId: "project-1",
			mcpConfigId: "mcp-cfg-ado",
			containerId: "ProjOne",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const { value: desc, format } = lastCreateDescription();
		expect(format).toBe("Html");
		expect(desc).toContain("<table>");
		expect(desc).toContain("<th>Field</th>");
		expect(desc).toContain("<td>API</td>");
		expect(desc).not.toContain("| Field |");
	});

	it("preserves a pulled-from-ADO description byte-for-byte (no spurious conversion)", async () => {
		setupAdoClient();
		const PULLED_HTML =
			"<p>Description authored in ADO.</p><table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>";
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			externalId: "55",
			externalUrl: "https://dev.azure.com/tf/proj/_workitems/edit/55",
			description: PULLED_HTML,
			acceptanceCriteria: null,
		} as any);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [{ type: "text", text: JSON.stringify({ id: 55 }) }],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);

		await syncStoryToPM({
			storyId: "story-ado-rt",
			projectId: "project-1",
			mcpConfigId: "mcp-cfg-ado",
			containerId: "ProjOne",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
		});

		const desc = lastUpdateDescription();
		// Pulled-from-PM HTML passes through unchanged via the
		// `looksFabricAuthored` gate.
		expect(desc).toContain(
			"<table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>",
		);
		expect(desc).toContain("Description authored in ADO.");
		expect(desc).not.toContain("| A | B |");
	});
});

describe("syncStoryToPM — ADO create workItemType resolution (#1305)", () => {
	const ADO_TOOLS_TYPE = {
		wit_create_work_item: {
			description: "Create an Azure DevOps work item",
			inputSchema: {
				type: "object",
				properties: {
					project: { type: "string" },
					workItemType: { type: "string" },
					fields: { type: "array" },
				},
				required: ["project", "workItemType", "fields"],
			},
		},
		wit_update_work_item: {
			description: "Update an Azure DevOps work item",
			inputSchema: {
				type: "object",
				properties: {
					id: { type: "number" },
					updates: { type: "array" },
				},
				required: ["id", "updates"],
			},
		},
		wit_get_work_item: {
			description: "Get an Azure DevOps work item",
			inputSchema: {
				type: "object",
				properties: { id: { type: "number" } },
				required: ["id"],
			},
		},
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	function setupAdoTypeClient() {
		const mockClient = { tools: vi.fn().mockResolvedValue(ADO_TOOLS_TYPE) };
		vi.mocked(getMcpClient).mockResolvedValue({
			client: mockClient as any,
			serverName: "azure-devops",
		});
		vi.mocked(getMcpClientResult).mockResolvedValue({
			ok: true,
			client: mockClient as any,
			serverName: "azure-devops",
		});
	}

	function lastCreateWorkItemType(): string {
		const calls = vi.mocked(executeMcpTool).mock.calls;
		const createCall = calls.find(
			(c) =>
				(c[0] as { toolName: string }).toolName ===
				"wit_create_work_item",
		);
		const args = createCall?.[0].args as Record<string, unknown>;
		return (args?.workItemType as string) ?? "";
	}

	function mockCreateResult(id: number) {
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id,
							_links: {
								html: {
									href: `https://dev.azure.com/tf/proj/_workitems/edit/${id}`,
								},
							},
						}),
					},
				],
			},
			durationMs: 5,
		});
		vi.mocked(updateStory).mockResolvedValue({} as any);
	}

	it("flag on + mapping { FEATURE: 'Epic' } + kind=FEATURE → creates as 'Epic'", async () => {
		process.env.FEATURE_PM_TYPE_MAPPING = "true";
		try {
			setupAdoTypeClient();
			vi.mocked(getStoryById).mockResolvedValue({
				...MOCK_STORY,
				externalId: null,
				externalUrl: null,
				kind: "FEATURE",
				description: "<p>desc</p>",
				acceptanceCriteria: null,
			} as any);
			mockCreateResult(201);

			await syncStoryToPM({
				storyId: "story-type-1",
				projectId: "project-1",
				mcpConfigId: "mcp-cfg-ado",
				containerId: "ProjOne",
				direction: "push",
				userId: "user-1",
				organizationId: "org-1",
				additionalContext: {
					workItemTypeMapping: { FEATURE: "Epic" },
				} as any,
			});

			expect(lastCreateWorkItemType()).toBe("Epic");
		} finally {
			delete process.env.FEATURE_PM_TYPE_MAPPING;
		}
	});

	it("flag on + no mapping + kind=FEATURE → creates as 'User Story'", async () => {
		process.env.FEATURE_PM_TYPE_MAPPING = "true";
		try {
			setupAdoTypeClient();
			vi.mocked(getStoryById).mockResolvedValue({
				...MOCK_STORY,
				externalId: null,
				externalUrl: null,
				kind: "FEATURE",
				description: "<p>desc</p>",
				acceptanceCriteria: null,
			} as any);
			mockCreateResult(202);

			await syncStoryToPM({
				storyId: "story-type-2",
				projectId: "project-1",
				mcpConfigId: "mcp-cfg-ado",
				containerId: "ProjOne",
				direction: "push",
				userId: "user-1",
				organizationId: "org-1",
			});

			expect(lastCreateWorkItemType()).toBe("User Story");
		} finally {
			delete process.env.FEATURE_PM_TYPE_MAPPING;
		}
	});

	it("flag off + mapping + kind=FEATURE → creates as 'User Story' (legacy)", async () => {
		setupAdoTypeClient();
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_STORY,
			externalId: null,
			externalUrl: null,
			kind: "FEATURE",
			description: "<p>desc</p>",
			acceptanceCriteria: null,
		} as any);
		mockCreateResult(203);

		await syncStoryToPM({
			storyId: "story-type-3",
			projectId: "project-1",
			mcpConfigId: "mcp-cfg-ado",
			containerId: "ProjOne",
			direction: "push",
			userId: "user-1",
			organizationId: "org-1",
			additionalContext: {
				workItemTypeMapping: { FEATURE: "Epic" },
			} as any,
		});

		expect(lastCreateWorkItemType()).toBe("User Story");
	});

	it("kind=BUG → always 'Bug' regardless of flag", async () => {
		for (const flagOn of [true, false]) {
			if (flagOn) {
				process.env.FEATURE_PM_TYPE_MAPPING = "true";
			}
			try {
				vi.clearAllMocks();
				setupAdoTypeClient();
				vi.mocked(getStoryById).mockResolvedValue({
					...MOCK_STORY,
					externalId: null,
					externalUrl: null,
					kind: "BUG",
					description: "<p>bug</p>",
					acceptanceCriteria: null,
				} as any);
				mockCreateResult(204);

				await syncStoryToPM({
					storyId: `story-bug-${flagOn ? "on" : "off"}`,
					projectId: "project-1",
					mcpConfigId: "mcp-cfg-ado",
					containerId: "ProjOne",
					direction: "push",
					userId: "user-1",
					organizationId: "org-1",
					additionalContext: {
						workItemTypeMapping: { FEATURE: "Epic" },
					} as any,
				});

				expect(lastCreateWorkItemType()).toBe("Bug");
			} finally {
				delete process.env.FEATURE_PM_TYPE_MAPPING;
			}
		}
	});
});

// =============================================================================
// markdownToSimpleHtml — heading-level preservation (used by Fizzy push +
// round-trip parity)
// =============================================================================

describe("markdownToSimpleHtml — heading level fidelity", () => {
	it("preserves h1/h2/h3 distinct levels", () => {
		const html = markdownToSimpleHtml("# A\n\n## B\n\n### C");
		expect(html).toContain("<h1>A</h1>");
		expect(html).toContain("<h2>B</h2>");
		expect(html).toContain("<h3>C</h3>");
	});

	it("caps h4-h6 at h3 (PM-tool render guard)", () => {
		const html = markdownToSimpleHtml("#### deep");
		// Markdown levels above 3 collapse to <h3> per the existing
		// `Math.min(level, 3)` cap — keep that contract.
		expect(html).toContain("<h3>deep</h3>");
	});
});

describe("markdownToSimpleHtml — fenced code blocks (ADO/Fizzy push)", () => {
	it("converts a ``` fenced block to <pre><code>, not literal backticks", () => {
		const html = markdownToSimpleHtml(
			"## Feature\n\nIntro.\n\n```js\nlet x = 1;\n```\n\nOutro.",
		);
		expect(html).toContain("<pre><code>let x = 1;</code></pre>");
		expect(html).not.toContain("```");
		// Surrounding blocks still convert normally.
		expect(html).toContain("<h2>Feature</h2>");
		expect(html).toContain("<p>Intro.</p>");
		expect(html).toContain("<p>Outro.</p>");
		// <pre> must NOT be nested inside a <p> (invalid HTML).
		expect(html).not.toMatch(/<p>\s*<pre>/);
	});

	it("HTML-escapes code so tags render as text, not markup", () => {
		const html = markdownToSimpleHtml("```\nif (a < b) { c() }\n```");
		expect(html).toContain("<pre><code>if (a &lt; b) { c() }</code></pre>");
		expect(html).not.toContain("<b>");
	});

	it("preserves blank lines inside the code block", () => {
		const html = markdownToSimpleHtml("```\nline1\n\nline2\n```");
		expect(html).toContain("<pre><code>line1\n\nline2</code></pre>");
	});
});

describe("simpleHtmlToMarkdown — table preservation (ADO/Fizzy pull)", () => {
	it("preserves a <table> block instead of stripping it to mashed cell text", () => {
		const md = simpleHtmlToMarkdown(
			"<p>Intro</p><table><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></table><p>Outro</p>",
		);
		expect(md).toContain("<table>");
		expect(md).toContain("<td>A1</td>");
		expect(md).toContain("</table>");
		// Cells must NOT be mashed into one run (the pre-fix bug).
		expect(md).not.toMatch(/A1B1/);
		// Surrounding text still converts.
		expect(md).toContain("Intro");
		expect(md).toContain("Outro");
	});

	it("keeps the inner <table> of a Fizzy/Lexxy figure wrapper, dropping the figure", () => {
		const md = simpleHtmlToMarkdown(
			'<figure class="lexxy-content__table-wrapper"><table><tbody><tr><td>X</td></tr></tbody></table></figure>',
		);
		expect(md).toContain(
			"<table><tbody><tr><td>X</td></tr></tbody></table>",
		);
		expect(md).not.toContain("<figure");
	});

	it("leaves the embedded <table> in the canonical markdown-with-HTML shape the push path consumes", () => {
		const table = "<table><tr><td>1</td><td>2</td></tr></table>";
		const md = simpleHtmlToMarkdown(`<h2>T</h2>${table}`);
		expect(md).toContain(table);
		expect(md).toContain("## T");
	});
});

describe("simpleHtmlToMarkdown — code block preservation (Fizzy pull — card #1659)", () => {
	it("converts a Fizzy <pre> (no <code>) with <br> lines + entities to a ``` fence", () => {
		const html =
			'<div class="action-text-content"><p>Test</p><pre data-language="javascript">a()<br>b &lt; c<br>}</pre></div>';
		const md = simpleHtmlToMarkdown(html);
		// Line breaks restored to real newlines (not mashed onto one line) and
		// `&lt;` decoded to `<`.
		expect(md).toContain("```\na()\nb < c\n}\n```");
		expect(md).not.toContain("a()b");
		expect(md).not.toContain("&lt;");
		expect(md).not.toContain("<pre");
		expect(md).toContain("Test");
	});

	it("handles two code blocks in one description (the #1659 regression)", () => {
		const html = "<pre>x<br>y</pre><p><br></p><pre>m<br>n</pre>";
		const md = simpleHtmlToMarkdown(html);
		// Two fences = four ``` markers.
		expect((md.match(/```/g) ?? []).length).toBe(4);
		expect(md).toContain("```\nx\ny\n```");
		expect(md).toContain("```\nm\nn\n```");
	});

	it("keeps decoded <...> in code from being eaten by the generic tag-strip", () => {
		const md = simpleHtmlToMarkdown("<pre>OfType&lt;Foo&gt;()</pre>");
		expect(md).toContain("```\nOfType<Foo>()\n```");
		expect(md).toContain("OfType<Foo>");
	});

	it("still handles the classic <pre><code> shape (ADO pull)", () => {
		const md = simpleHtmlToMarkdown("<pre><code>const x = 1;</code></pre>");
		expect(md).toContain("```\nconst x = 1;\n```");
	});

	it("fences a large but realistic code block unchanged (bounded lazy-quantifier guard)", () => {
		const body = "line();<br>".repeat(500);
		const md = simpleHtmlToMarkdown(`<pre>${body}</pre>`);
		expect(md).toContain("```\n");
		expect(md).not.toContain("<pre");
	});

	it("does not hang on an unclosed <pre> in a huge payload (js/polynomial-redos)", () => {
		// No closing </pre> anywhere: the linear scan must fail to find a
		// match (falling through to the generic tag-strip) rather than
		// backtrack quadratically over it.
		const unclosed = `<pre>${"a".repeat(50_000)}`;
		expect(() => simpleHtmlToMarkdown(unclosed)).not.toThrow();
	});

	it("fences a 50,000-char code block in full — no content-length cap (js/polynomial-redos)", () => {
		// The old regex bounded the lazy middle to 20,000 chars, which
		// silently degraded any code block larger than that. The linear scan
		// has no such cap: a legitimately-closed block of any size must be
		// fenced in its entirety.
		const line = "console.log('line');<br>";
		const body = line.repeat(Math.ceil(50_000 / line.length));
		const html = `<pre>${body}</pre>`;
		const md = simpleHtmlToMarkdown(html);
		const expectedCode = body
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/^\n+|\n+$/g, "");
		expect(md).toContain(`\`\`\`\n${expectedCode}\n\`\`\``);
		expect(md).not.toContain("<pre");
		expect(md).not.toContain("<br>");
	});

	it("stays linear with 2,000 unclosed <pre> openers in ~200KB (js/polynomial-redos)", () => {
		// Each earlier fix (the </pre> break and the sticky-regex <code>
		// lookahead) only matters once there are MANY openers with no
		// matching close — a single unclosed opener already passed before
		// those fixes. Regression guard for both: this must complete fast
		// (not the old per-opener O(remaining suffix) rescans) and, because
		// none of the 2,000 openers ever close, extractPreBlocks must give
		// back the exact input untouched (the same "unclosed opener falls
		// through to the generic tag-strip" contract as the single-opener
		// case above, just at a scale that used to be quadratic). Speed is
		// enforced by the runner's normal timeout, not a wall-clock assert.
		const opener = `<pre id="block">${"z".repeat(80)}`;
		const html = opener.repeat(2_000); // ~200KB, 2,000 openers, no closer
		const result = extractPreBlocks(html, (code) => `STASH(${code})`);
		expect(result).toBe(html);
	});
});

describe("cleanAdoCodeBlocks — ADO code-block pull (card #236)", () => {
	it("rewrites a Visual-Studio-pasted span-only <pre> to clean <pre><code>", () => {
		const ado =
			'<div style="margin-top:14px;"><pre style="font-family:monospace;color:#000;">' +
			'<span style="color:#2b91af;">It</span>.<span style="color:#74531f;">IsAny</span>' +
			'<span style="color:#ffd702;">&lt;</span><span style="color:#2b91af;">Foo</span>' +
			'<span style="color:#ffd702;">&gt;()</span></pre><br> </div>';
		const out = cleanAdoCodeBlocks(ado, "azure-devops");
		// ADO emits a <pre> with NO <code> child; the frontend Turndown code
		// rule misses it and splits the block. Adding <code> makes it a fence.
		expect(out).toContain("<pre><code>");
		expect(out).not.toContain("<span");
		expect(out).not.toContain("<pre style");
		// Code text + escaped entities preserved verbatim (no over-escaped >).
		expect(out).toContain("It.IsAny&lt;Foo&gt;()");
		// Only <pre> is rewritten — the wrapping <div> is left intact.
		expect(out).toContain('<div style="margin-top:14px;">');
	});

	it("preserves newlines and leading indentation inside the code", () => {
		const ado = `<pre style="color:#000;"> <span style="color:#ffd702;">[</span>TestMethod<span style="color:#ffd702;">]</span>
 <span style="color:#ffd702;">}</span></pre>`;
		expect(cleanAdoCodeBlocks(ado, "azure-devops")).toBe(
			`<pre><code> [TestMethod]
 }</code></pre>`,
		);
	});

	it("leaves an already-clean <pre><code> block unchanged (idempotent)", () => {
		const clean = "<pre><code>const x = 1;</code></pre>";
		expect(cleanAdoCodeBlocks(clean, "azure-devops")).toBe(clean);
		expect(
			cleanAdoCodeBlocks(cleanAdoCodeBlocks(clean, "ado"), "ado"),
		).toBe(clean);
	});

	it("is a no-op for non-ADO providers (self-gated)", () => {
		const vs = '<pre style="color:#000;"><span>x</span></pre>';
		expect(cleanAdoCodeBlocks(vs, "github")).toBe(vs);
		expect(cleanAdoCodeBlocks(vs, "fizzy")).toBe(vs);
		expect(cleanAdoCodeBlocks(vs, undefined)).toBe(vs);
	});

	it("touches only <pre> blocks — tables, images and text stay byte-identical", () => {
		const table =
			"<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>";
		const img =
			'<img src="https://dev.azure.com/x/_apis/wit/attachments/y" alt="">';
		const ado = `<p>Intro</p>${table}${img}<pre style="x"><span>code</span></pre>`;
		const out = cleanAdoCodeBlocks(ado, "ado");
		expect(out).toContain(table);
		expect(out).toContain(img);
		expect(out).toContain("<p>Intro</p>");
		expect(out).toContain("<pre><code>code</code></pre>");
	});

	it("returns nullish/empty input unchanged", () => {
		expect(cleanAdoCodeBlocks(undefined, "azure-devops")).toBeUndefined();
		expect(cleanAdoCodeBlocks(null, "azure-devops")).toBeNull();
		expect(cleanAdoCodeBlocks("", "azure-devops")).toBe("");
	});
});

// =============================================================================
// simpleHtmlToMarkdown — heading preservation + round-trip stability
// =============================================================================
//
// simpleHtmlToMarkdown is the inverse of markdownToSimpleHtml used on the Fizzy
// pull path (Fizzy stores HTML descriptions; we bring them back to Fabric's
// canonical markdown form). Without heading-level preservation, the second
// push would downgrade <h1> to <p> after a round-trip — visible drift in the
// Fizzy card after a single pull→push cycle.

describe("simpleHtmlToMarkdown — heading level preservation", () => {
	it("emits the right number of # characters per heading level", () => {
		const md = simpleHtmlToMarkdown(
			"<h1>One</h1><h2>Two</h2><h3>Three</h3>",
		);
		expect(md).toContain("# One");
		expect(md).toContain("## Two");
		expect(md).toContain("### Three");
	});

	it("inverts markdownToSimpleHtml for representative AI-scaffolded stories", () => {
		const original =
			"# Feature Stub:\n\n## Description\n\nAs an engineering team, we want **descriptive headers** so they render formatted.\n\n## Acceptance Criteria\n\n- Given valid credentials\n- When I click login\n- Then I should be authenticated";
		const html = markdownToSimpleHtml(original);
		const roundTripped = simpleHtmlToMarkdown(html);
		// Re-emit and compare — second push must produce the same HTML.
		expect(markdownToSimpleHtml(roundTripped)).toBe(html);
	});

	it("survives the full Fabric → Fizzy → Fabric → Fizzy cycle byte-stably", () => {
		// Mirror the DB-canonical form: markdown body + HTML back-link anchor.
		const dbDescription =
			'# Feature Stub:\n\n## Description\n\nBody text with **bold**.\n\n<p><a href="https://app.fabric.example/app/acme/projects/p/stories/s">View in Fabric</a></p>';

		// One iteration of the full pipeline.
		function pushFromDb(d: string): string {
			// Mirror the production push sequence verbatim. The
			// formatBackLinkForProvider call here matches the mock-replicated
			// helper at the top of the file.
			const HTML_BACK_LINK_RE =
				/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i;
			const m = d.match(HTML_BACK_LINK_RE);
			const md = m
				? d.replace(HTML_BACK_LINK_RE, `[View in Fabric](${m[1]})`)
				: d;
			return markdownToSimpleHtml(md);
		}
		function pullToDb(html: string): string {
			const MARKDOWN_BACK_LINK_RE = /\[View in Fabric\]\(([^)]+)\)/;
			const md = simpleHtmlToMarkdown(html);
			const m = md.match(MARKDOWN_BACK_LINK_RE);
			if (!m) {
				return md;
			}
			return md.replace(
				MARKDOWN_BACK_LINK_RE,
				`<p><a href="${m[1]}">View in Fabric</a></p>`,
			);
		}

		const push1 = pushFromDb(dbDescription);
		const db1 = pullToDb(push1);
		const push2 = pushFromDb(db1);
		const db2 = pullToDb(push2);
		const push3 = pushFromDb(db2);

		// Push iterations match byte-for-byte from the second push onward
		// (the first push starts from a markdown-body + HTML-anchor row;
		// subsequent pushes start from the byte-stable round-tripped form).
		expect(push2).toBe(push1);
		expect(push3).toBe(push1);
		expect(db2).toBe(db1);
	});
});

// =============================================================================
// simpleHtmlToMarkdown — images, ActionText attachments, code (#1471 pull)
// =============================================================================
//
// Fizzy stores HTML descriptions. The generic tag-strip dropped <img>,
// <action-text-attachment> and <pre><code>, so pulled Fizzy images/files were
// lost before the pull-image ingester could re-host them, and code blocks were
// flattened. These convert them to markdown first so the ingester catches the
// URL and the formatting survives.
// =============================================================================

describe("simpleHtmlToMarkdown — images, attachments, code", () => {
	it("converts <img> to a markdown image (survives the tag strip)", () => {
		const md = simpleHtmlToMarkdown(
			'<p>before</p><img src="/000000/rails/active_storage/blobs/redirect/SGID/pic.png" alt="shot"><p>after</p>',
		);
		expect(md).toContain(
			"![shot](/000000/rails/active_storage/blobs/redirect/SGID/pic.png)",
		);
	});

	it("converts a Fizzy image action-text-attachment to a markdown image", () => {
		const html =
			'<action-text-attachment content-type="image/png" url="/000000/rails/active_storage/blobs/redirect/SGID/pic.png" filename="pic.png"></action-text-attachment>';
		const md = simpleHtmlToMarkdown(html);
		expect(md).toContain(
			"![pic.png](/000000/rails/active_storage/blobs/redirect/SGID/pic.png)",
		);
	});

	it("converts a non-image action-text-attachment to a markdown link", () => {
		const html =
			'<action-text-attachment content-type="application/pdf" url="/000000/rails/active_storage/blobs/redirect/SGID/report.pdf" filename="report.pdf"></action-text-attachment>';
		const md = simpleHtmlToMarkdown(html);
		expect(md).toContain(
			"[report.pdf](/000000/rails/active_storage/blobs/redirect/SGID/report.pdf)",
		);
		expect(md).not.toContain("![report.pdf]");
	});

	it("strips mention action-text-attachments", () => {
		const html =
			'<action-text-attachment content-type="application/vnd.actiontext.mention" url="/x/avatar" filename="avatar"></action-text-attachment>';
		expect(simpleHtmlToMarkdown(html)).not.toContain("avatar");
	});

	it("converts <pre><code> to a fenced code block", () => {
		const md = simpleHtmlToMarkdown(
			"<pre><code>const x = 1;\nconst y = 2;</code></pre>",
		);
		expect(md).toContain("```");
		expect(md).toContain("const x = 1;");
	});
});

// =============================================================================
// parsePMItemFromGetOutput — Fizzy rich HTML (#1471 pull)
// =============================================================================
//
// Fizzy's fizzy_get_card returns BOTH `description` (Action Text plain_text,
// where attachments collapse to `[filename]` placeholders) and
// `description_html` (the real <action-text-attachment>/<img> markup). The
// parser must prefer the HTML so simpleHtmlToMarkdown + the pull-image ingester
// have real tags/URLs to work with — otherwise images/files render as literal
// `[image.png] [Test.xlsx]` text.
// =============================================================================

describe("parsePMItemFromGetOutput — Fizzy rich HTML", () => {
	it("prefers description_html over the plain-text description", () => {
		const out = parsePMItemFromGetOutput({
			title: "Card",
			description: "Test\n[image.png] [Test.xlsx]",
			description_html:
				'<div class="action-text-content"><p>Test</p><img src="/000000/rails/active_storage/blobs/redirect/SGID/image.png"></div>',
			id: "c1",
		});
		expect(out.description).toContain("<img");
		expect(out.description).not.toContain("[image.png]");
	});

	it("falls back to the plain description when no description_html", () => {
		const out = parsePMItemFromGetOutput({
			title: "X",
			description: "plain body",
			id: "c2",
		});
		expect(out.description).toBe("plain body");
	});
});

// =============================================================================
// createOrUpdateStoryFromPMItem — REST-GitLab pull on existing story
//
// Regression test: before this fix, the existing-story branch unconditionally
// called syncStoryToPM(..., direction: "pull") to refresh the back-link.
// syncStoryToPM throws a non-retryable ApplicationFailure when mcpConfigId is
// null (the REST-GitLab path). That caused every already-imported story on a
// REST tenant to fail with a confusing "REST-GitLab not supported" error
// during a PULL operation, even though the workflow had already supplied the
// title/description from getGitLabIssueForPM upstream.
//
// The fix gates the syncStoryToPM call on `mcpConfigId != null`. When null,
// we fall through to the lightweight updateStory branch that just writes the
// supplied title/description/externalUrl to the DB — no MCP round-trip.
// =============================================================================

describe("createOrUpdateStoryFromPMItem — REST pull on existing story", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("falls through to updateStory when mcpConfigId is null (REST-GitLab pull)", async () => {
		const mockDb = db as unknown as {
			userStory: {
				findFirst: ReturnType<typeof vi.fn>;
				update: ReturnType<typeof vi.fn>;
			};
		};
		mockDb.userStory.findFirst.mockResolvedValue({
			id: "story-existing-1",
			identifier: "F-42",
		});

		vi.mocked(updateStory).mockResolvedValue(undefined as never);

		const result = await createOrUpdateStoryFromPMItem({
			projectId: "proj-1",
			externalId: "gl-issue-99",
			title: "Bug: login broken",
			description: "Repro: ...",
			externalUrl: "https://gitlab.com/group/proj/-/issues/99",
			userId: "user-1",
			mcpConfigId: null, // REST-GitLab path
			mcpServerId: "srv-rest-gitlab",
			containerId: "group/proj",
			organizationId: "org-1",
			// taskGet present — pre-fix this would have routed to syncStoryToPM
			// and thrown the REST-GitLab non-retryable failure.
			// taskGet present — pre-fix this would have routed to
			// syncStoryToPM and thrown the REST-GitLab non-retryable failure.
			capabilities: {
				hasPMCapabilities: true,
				containerHierarchy: [],
				taskGet: {
					toolName: "rest_get_issue",
					idParam: "issue_iid",
					additionalRequiredParams: [],
				},
				availableTools: [],
				detectedType: "gitlab",
			} as any,
		});

		// MCP-only path must not be invoked on the REST branch.
		expect(executeMcpTool).not.toHaveBeenCalled();
		expect(getMcpClient).not.toHaveBeenCalled();

		// Lightweight updateStory path is taken with the title/description
		// already supplied by the workflow (fetched upstream from
		// getGitLabIssueForPM via fetchPMItemsByIds).
		expect(updateStory).toHaveBeenCalledWith(
			"story-existing-1",
			"proj-1",
			expect.objectContaining({
				title: "Bug: login broken",
				externalUrl: "https://gitlab.com/group/proj/-/issues/99",
			}),
			{ lastEditedSource: "PM_PULL" },
		);

		expect(result).toEqual({
			storyId: "story-existing-1",
			identifier: "F-42",
			created: false,
			externalId: "gl-issue-99",
			externalUrl: "https://gitlab.com/group/proj/-/issues/99",
		});

		// The no-taskGet/REST update branch logs the import as a "pull" so it
		// shows in Sync History (it previously wrote nothing).
		expect(mockRecordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				direction: "pull",
				status: "SUCCESS",
				entityType: "STORY",
				entityId: "story-existing-1",
				externalId: "gl-issue-99",
				pmTool: "gitlab",
			}),
		);
	});
});

describe("createOrUpdateStoryFromPMItem — new Fizzy story re-pulls rich content", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// Regression: "Pull from Fizzy" (bulk pull) hands createOrUpdateStoryFromPMItem
	// the lossy Action Text *plain_text* description — file attachments collapse
	// to `[filename]` placeholders and inline images vanish. The pre-fix create
	// branch only re-fetched the rich single-card body when the title was missing,
	// so a bulk-pulled card (title always present) stored the placeholder text AND
	// the back-link push wrote that placeholder back to Fizzy, corrupting it.
	// The fix re-runs the pull through syncStoryToPM for Fizzy so the single-card
	// description replaces the placeholder.
	it("issues the single-card GET and overwrites the lossy bulk-list placeholder", async () => {
		const mockDb = db as unknown as {
			userStory: {
				findFirst: ReturnType<typeof vi.fn>;
				findUnique: ReturnType<typeof vi.fn>;
				update: ReturnType<typeof vi.fn>;
			};
			project: { findUnique: ReturnType<typeof vi.fn> };
		};

		// No existing story → the create branch runs.
		mockDb.userStory.findFirst.mockResolvedValue(null);
		mockDb.userStory.update.mockResolvedValue({} as never);
		// After the pull overwrites the description with the Fizzy body, the
		// back-link re-stamp reads it back via findUnique (first sync → no
		// "View in Fabric" anchor yet).
		mockDb.userStory.findUnique.mockResolvedValue({
			description: "Real body from single-card GET",
		} as never);
		mockDb.project.findUnique.mockResolvedValue({
			pmTerminalStatuses: [],
			pmAutoCloseEnabled: false,
			organizationId: "org-1",
			userId: null,
		} as never);

		vi.mocked(createStory).mockResolvedValue({
			id: "new-story-1",
			identifier: "F-99",
		} as never);

		// The inner syncStoryToPM(pull) reloads the freshly-created story (now
		// carrying externalId) and fetches the single card via the get tool.
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_SYNCED_STORY,
			id: "new-story-1",
			identifier: "F-99",
			externalId: "fizzy-card-1593",
			externalMcpServerId: "srv-1",
		} as never);
		setupMcpClientMock();
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id: "fizzy-card-1593",
							title: "Testr",
							// The single-card GET returns the REAL body — not the
							// "[download.jpg] [Test.xlsx]" list placeholder.
							description: "Real body from single-card GET",
						}),
					},
				],
			},
			durationMs: 5,
		} as never);
		vi.mocked(updateStory).mockResolvedValue({} as never);
		vi.mocked(listStoryStatuses).mockResolvedValue([] as never);
		vi.mocked(reconcileStoryTerminalStatus).mockResolvedValue({
			terminalApplied: false,
			action: "none",
			pendingChangesCreated: 0,
		} as never);

		const result = await createOrUpdateStoryFromPMItem({
			projectId: "proj-1",
			externalId: "fizzy-card-1593",
			title: "Testr",
			// The lossy bulk-list description the pull workflow handed us.
			description: "[download.jpg] [Test.xlsx]",
			externalUrl: "https://app.fizzy.do/000000/cards/1593",
			userId: "user-1",
			mcpConfigId: "mcp-fizzy-1",
			containerId: "board-1",
			organizationId: "org-1",
			capabilities: {
				hasPMCapabilities: true,
				detectedType: "fizzy",
				containerHierarchy: [],
				availableTools: ["get_card"],
				taskGet: {
					toolName: "get_card",
					idParam: "card_id",
					additionalRequiredParams: [],
					allParams: [{ name: "card_id" }],
				},
				// No taskUpdate → the back-link push-back is skipped, isolating
				// this test to the content-pull behavior.
			} as never,
		});

		expect(result.created).toBe(true);

		// The content pull ran: the single-card GET was issued. (Pre-fix, a
		// title-present bulk pull never called the get tool on the create path.)
		expect(executeMcpTool).toHaveBeenCalled();

		// The story description was overwritten from the single-card GET body and
		// never left as the lossy "[download.jpg] [Test.xlsx]" placeholder.
		const descWrites = vi
			.mocked(updateStory)
			.mock.calls.map(
				(c) =>
					(c[2] as { description?: string } | undefined)?.description,
			)
			.filter((d): d is string => typeof d === "string");
		expect(
			descWrites.some((d) =>
				d.includes("Real body from single-card GET"),
			),
		).toBe(true);
		expect(descWrites.some((d) => d.includes("[download.jpg]"))).toBe(
			false,
		);

		// The pull wipes the back-link createStory stamped; it is re-stamped
		// after the pull so the Fizzy card (and Fabric) keep "View in Fabric".
		expect(descWrites.some((d) => d.includes("View in Fabric"))).toBe(true);
	});
});

describe("createOrUpdateStoryFromPMItem — content pull is provider-agnostic (ADO, not just Fizzy)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// Regression for ADO WI #224: a bulk-pulled ADO story kept raw
	// `_apis/wit/attachments/…` image URLs (un-ingested) and dropped its FILE
	// attachments entirely, because the post-create content pull was scoped to
	// Fizzy. The gate is now provider-agnostic (taskGet + mcpConfig), so the ADO
	// create path runs syncStoryToPM(pull) — which ingests inline images and
	// fetches+appends the AttachedFile relations.
	it("runs the post-create content pull for a NEW azure-devops story", async () => {
		const mockDb = db as unknown as {
			userStory: {
				findFirst: ReturnType<typeof vi.fn>;
				findUnique: ReturnType<typeof vi.fn>;
				update: ReturnType<typeof vi.fn>;
			};
			project: { findUnique: ReturnType<typeof vi.fn> };
		};
		mockDb.userStory.findFirst.mockResolvedValue(null);
		mockDb.userStory.update.mockResolvedValue({} as never);
		mockDb.userStory.findUnique.mockResolvedValue({
			description: "<div>ADO body from get</div>",
		} as never);
		mockDb.project.findUnique.mockResolvedValue({
			pmTerminalStatuses: [],
			pmAutoCloseEnabled: false,
			organizationId: "org-1",
			userId: null,
		} as never);

		vi.mocked(createStory).mockResolvedValue({
			id: "ado-story-1",
			identifier: "F-200",
		} as never);
		vi.mocked(getStoryById).mockResolvedValue({
			...MOCK_SYNCED_STORY,
			id: "ado-story-1",
			identifier: "F-200",
			externalId: "224",
			externalMcpServerId: "srv-ado",
		} as never);
		setupMcpClientMock();
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id: 224,
							fields: {
								"System.Title": "WI 224",
								"System.Description":
									"<div>ADO body from get</div>",
							},
						}),
					},
				],
			},
			durationMs: 5,
		} as never);
		vi.mocked(updateStory).mockResolvedValue({} as never);
		vi.mocked(listStoryStatuses).mockResolvedValue([] as never);
		vi.mocked(reconcileStoryTerminalStatus).mockResolvedValue({
			terminalApplied: false,
			action: "none",
			pendingChangesCreated: 0,
		} as never);

		const result = await createOrUpdateStoryFromPMItem({
			projectId: "proj-1",
			externalId: "224",
			title: "WI 224",
			description: "<div>list body</div>",
			externalUrl: "https://dev.azure.com/org/proj/_workitems/edit/224",
			userId: "user-1",
			mcpConfigId: "mcp-ado-1",
			containerId: "proj",
			organizationId: "org-1",
			capabilities: {
				hasPMCapabilities: true,
				detectedType: "azure-devops",
				containerHierarchy: [],
				availableTools: ["wit_get_work_item"],
				taskGet: {
					toolName: "wit_get_work_item",
					idParam: "id",
					additionalRequiredParams: [],
					allParams: [{ name: "id" }],
				},
			} as never,
		});

		expect(result.created).toBe(true);
		// The content pull fired for ADO (pre-fix it was Fizzy-scoped, so a
		// title-present ADO bulk pull never invoked the get tool on create).
		expect(executeMcpTool).toHaveBeenCalled();
	});
});

describe("Fizzy file-attachment push pipeline (card 1594 corruption fix)", () => {
	it("extractFizzyFileAttachments tokenizes story-media file anchors and leaves the back-link", () => {
		const input =
			"<p>body</p>\n" +
			'<a href="http://localhost:9000/x?sig=1" data-s3-key="story-media/p/s/pull-abc/Test.xlsx" download>Test.xlsx</a>\n' +
			'<p><a href="https://app.example/app/x">View in Fabric</a></p>';
		const { withTokens, files } = extractFizzyFileAttachments(input);

		expect(files).toHaveLength(1);
		expect(files[0].filename).toBe("Test.xlsx");
		expect(files[0].s3Key).toBe("story-media/p/s/pull-abc/Test.xlsx");
		expect(files[0].href).toBe("http://localhost:9000/x?sig=1");

		// The file anchor is replaced by a sentinel token (so markdownToSimpleHtml
		// can't escape it)…
		expect(withTokens).toContain("__FIZZY_FILE_0__");
		expect(withTokens).not.toContain(">Test.xlsx</a>");
		// …but the Fabric back-link anchor (no data-s3-key) is untouched.
		expect(withTokens).toContain("View in Fabric");
	});

	it("restoreFizzyFileAttachments swaps the <p>-wrapped token for the embed", () => {
		const html = "<p>body</p><p>__FIZZY_FILE_0__</p>";
		const out = restoreFizzyFileAttachments(html, [
			'<action-text-attachment sgid="SGID"></action-text-attachment>',
		]);
		expect(out).toBe(
			'<p>body</p><action-text-attachment sgid="SGID"></action-text-attachment>',
		);
	});

	it("resolveFizzyFileEmbeds with no target emits a clean <a> link (never escaped text)", async () => {
		const embeds = await resolveFizzyFileEmbeds(
			[
				{
					href: "https://signed.example.com/story-media/p/s/pull-abc/Test.xlsx?Sig=test",
					filename: "Test.xlsx",
					s3Key: "story-media/p/s/pull-abc/Test.xlsx",
				},
			],
			null,
		);
		expect(embeds).toHaveLength(1);
		expect(embeds[0]).toBe(
			'<a href="https://signed.example.com/story-media/p/s/pull-abc/Test.xlsx?Sig=test">Test.xlsx</a>',
		);
		// Crucially NOT the escaped-text garbage that broke card 1594.
		expect(embeds[0]).not.toContain("&lt;a");
	});
});

describe("Fizzy line-break round-trip (card 1595: <br> not collapsed)", () => {
	// Fizzy `<p>3526324<br>345</p>` was pulled to a bare "3526324\n345", which
	// the editor (Turndown / markdown-it breaks:false) flattened onto one line.
	// The canonical hard-break is a literal `<br>` that survives both the pull
	// conversion and the push conversion.
	it("simpleHtmlToMarkdown preserves <br> (does not collapse to a bare \\n)", () => {
		const md = simpleHtmlToMarkdown("<p>3526324<br>345</p>");
		expect(md).toContain("3526324<br>345");
		// The lone-newline form (which collapses to a space on render) is gone.
		expect(md).not.toContain("3526324\n345");
	});

	it("simpleHtmlToMarkdown normalises <br/> and <br /> to <br>", () => {
		expect(simpleHtmlToMarkdown("<p>a<br/>b</p>")).toContain("a<br>b");
		expect(simpleHtmlToMarkdown("<p>a<br />b</p>")).toContain("a<br>b");
	});

	it("markdownToSimpleHtml re-emits a literal <br> as <br> (never escaped to &lt;br&gt;)", () => {
		const html = markdownToSimpleHtml("3526324<br>345");
		expect(html).toBe("<p>3526324<br>345</p>");
		expect(html).not.toContain("&lt;br&gt;");
	});

	it("round-trips a Fizzy line break byte-stably (pull → push → pull → push)", () => {
		const fizzyHtml = "<p>3526324<br>345</p>";
		const pulled = simpleHtmlToMarkdown(fizzyHtml);
		const pushed = markdownToSimpleHtml(pulled);
		expect(pushed).toBe("<p>3526324<br>345</p>");
		// Second cycle is stable — no drift (e.g. <br> degrading to a space).
		expect(markdownToSimpleHtml(simpleHtmlToMarkdown(pushed))).toBe(pushed);
	});
});

describe("ADO push helpers (WI #225: keep native attachments, preserve HTML)", () => {
	it("stripStoryMediaFileAnchors removes story-media file anchors, keeps the back-link and <img>", () => {
		const input =
			'<div>body</div><img src="http://localhost:9000/i" data-s3-key="story-media/p/s/pull-img">\n\n' +
			'<a href="http://localhost:9000/f?a=1&b=2" data-s3-key="story-media/p/s/pull-file/Test.xlsx" download>Test.xlsx</a>\n' +
			'<p><a href="https://app.example/app/x">View in Fabric</a></p>';
		const out = stripStoryMediaFileAnchors(input);

		// File anchor gone…
		expect(out).not.toContain("Test.xlsx");
		expect(out).not.toContain("pull-file");
		// …but the inline image and the (no-data-s3-key) back-link survive.
		expect(out).toContain('data-s3-key="story-media/p/s/pull-img"');
		expect(out).toContain("View in Fabric");
	});

	it("stripStoryMediaFileAnchors also removes the MARKDOWN file-link form, keeping images + back-link", () => {
		const input =
			"text\n\n![](http://localhost:9000/x/story-media/p/s/pull-img?sig=1)\n\n" +
			"[Test.xlsx](http://localhost:9000/x/story-media/p/s/pull-file/Test.xlsx?sig=2)\n\n" +
			"[View in Fabric](http://localhost:3001/app/projects/p/stories/s)";
		const out = stripStoryMediaFileAnchors(input);

		// Markdown file link gone…
		expect(out).not.toContain("Test.xlsx");
		// …but the markdown IMAGE (leading `!`) and the back-link (no story-media)
		// survive.
		expect(out).toContain(
			"![](http://localhost:9000/x/story-media/p/s/pull-img",
		);
		expect(out).toContain("[View in Fabric](");
	});

	it("looksLikeHtmlBody: true for pulled ADO <div> HTML, false for (edited) markdown", () => {
		expect(
			looksLikeHtmlBody("<div>435 </div><div>54 </div><p><a>x</a></p>"),
		).toBe(true);
		expect(looksLikeHtmlBody("a<br>b")).toBe(true);
		// Edited-from-pull markdown: plain text + markdown media, no residual tags.
		expect(
			looksLikeHtmlBody(
				"32543\n\n345\n\n![](url)\n\n[Test.xlsx](url)\n\n[View in Fabric](url)",
			),
		).toBe(false);
		// Inline-code `<table>`/`<img>` samples must NOT count as HTML.
		expect(looksLikeHtmlBody("see `<table>` and `<img>` here")).toBe(false);
	});

	it("fileNameForImage prefers the alt filename over the opaque story-media URL stem (WI #226 round-trip)", () => {
		// Pulled image: story-media URL has no extension, but alt carries the
		// real filename. The upload must use it, else the re-pull can't infer the
		// image content-type from `?fileName=image-0.bin` and drops a placeholder.
		expect(
			fileNameForImage(
				{
					src: "http://localhost:9000/x/pull-6bc2ad1d-88db-4361?X-Amz-Signature=z",
					alt: "download.jpg",
					s3Key: "story-media/p/s/pull-6bc2ad1d-88db-4361",
				},
				0,
			),
		).toBe("download.jpg");
		// No usable alt → falls back to the URL-stem heuristic (image-{i}.bin).
		expect(
			fileNameForImage(
				{
					src: "http://localhost:9000/x/pull-abc?X-Amz-Signature=z",
					alt: "",
					s3Key: "story-media/p/s/pull-abc",
				},
				0,
			),
		).toBe("image-0.bin");
	});

	it("hasMarkdownMarkers: true for Fabric markdown, false for pulled ADO <div> HTML", () => {
		expect(hasMarkdownMarkers("## Heading\n\nbody")).toBe(true);
		expect(hasMarkdownMarkers("- one\n- two")).toBe(true);
		expect(hasMarkdownMarkers("text with **bold** word")).toBe(true);
		// ADO-pulled HTML — `<div>`/`<p>`/`<a>`, no line-leading markdown.
		expect(
			hasMarkdownMarkers(
				'<div>435 </div><div>54 </div><p><a href="x">View in Fabric</a></p>',
			),
		).toBe(false);
	});
});

describe("uploadGitLabImagesAndRewriteDescription (GitLab issue #10 push)", () => {
	it("uploads data: and signed-URL images to /uploads, leaving the back-link", async () => {
		let n = 0;
		const fetchMock = vi.fn(async (url: unknown) => {
			const u = String(url);
			if (u.endsWith("/uploads")) {
				n += 1;
				return {
					ok: true,
					json: async () => ({
						url: `/uploads/${"a".repeat(32)}/img${n}.jpg`,
					}),
				} as unknown as Response;
			}
			// source GET (story-media signed URL) → JPEG bytes
			return {
				ok: true,
				headers: { get: () => "image/jpeg" },
				arrayBuffer: async () =>
					new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer,
			} as unknown as Response;
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const input =
				"intro\n\n![download.jpg](data:image/jpeg;base64,/9j/4AAQSkZJRg==)\n\n" +
				"![](https://signed.example.com/story-media/p/s/pull-x?Sig=1)\n\n" +
				"[View in Fabric](https://app.fabric.example/app/x)";
			const out = await uploadGitLabImagesAndRewriteDescription(input, {
				token: "glpat-TEST",
				projectId: "group/project",
				baseUrl: "https://gitlab.com",
			});

			// Both images replaced with native GitLab /uploads links…
			expect(out).not.toContain("data:image");
			expect(out).not.toContain("signed.example.com");
			expect(
				(
					out.match(/!\[[^\]]*\]\(\/uploads\/a{32}\/img\d\.jpg\)/g) ??
					[]
				).length,
			).toBe(2);
			// …and the Fabric back-link (not an image) is untouched.
			expect(out).toContain(
				"[View in Fabric](https://app.fabric.example/app/x)",
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("leaves an already-GitLab /uploads image untouched (no re-upload)", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		try {
			const input = `![x](/uploads/${"b".repeat(32)}/x.png)`;
			const out = await uploadGitLabImagesAndRewriteDescription(input, {
				token: "t",
				projectId: "g/p",
			});
			expect(out).toBe(input);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("uploadGitLabFileAttachmentsAndRewrite (GitLab file-attachment push)", () => {
	it("uploads story-media file links + <a data-s3-key> to /uploads, leaving back-link & external", async () => {
		let n = 0;
		const fetchMock = vi.fn(async (url: unknown) => {
			const u = String(url);
			if (u.endsWith("/uploads")) {
				n += 1;
				return {
					ok: true,
					json: async () => ({
						url: `/uploads/${"c".repeat(32)}/file${n}.bin`,
					}),
				} as unknown as Response;
			}
			// source GET (story-media signed URL) → opaque bytes
			return {
				ok: true,
				headers: { get: () => "application/octet-stream" },
				arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
			} as unknown as Response;
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const input =
				"[2.xlsx](https://signed.example.com/story-media/p/s/pull-x/2.xlsx?Sig=1)\n\n" +
				'<a href="https://signed.example.com/story-media/p/s/pull-y/notes.txt?Sig=2" data-s3-key="story-media/p/s/pull-y/notes.txt" download>notes.txt</a>\n\n' +
				"[docs](https://external.example.com/page)\n\n" +
				"[View in Fabric](https://app.fabric.example/app/x)";
			const out = await uploadGitLabFileAttachmentsAndRewrite(input, {
				token: "glpat-TEST",
				projectId: "group/project",
				baseUrl: "https://gitlab.com",
			});

			// Both Fabric-hosted attachments uploaded + rewritten to /uploads links.
			expect(out).not.toContain("story-media");
			expect(out).toMatch(/\[2\.xlsx\]\(\/uploads\/c{32}\/file\d\.bin\)/);
			expect(out).toMatch(
				/\[notes\.txt\]\(\/uploads\/c{32}\/file\d\.bin\)/,
			);
			// External link + Fabric back-link left untouched.
			expect(out).toContain("[docs](https://external.example.com/page)");
			expect(out).toContain(
				"[View in Fabric](https://app.fabric.example/app/x)",
			);
			expect(n).toBe(2);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("leaves an already-GitLab /uploads file link untouched (no re-upload)", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		try {
			const input = `[x.pdf](/uploads/${"d".repeat(32)}/x.pdf)`;
			const out = await uploadGitLabFileAttachmentsAndRewrite(input, {
				token: "t",
				projectId: "g/p",
			});
			expect(out).toBe(input);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("createOrUpdateStoryFromPMItem — kind reverse-mapping on new story (#1305)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.FEATURE_PM_TYPE_MAPPING;
	});

	afterEach(() => {
		delete process.env.FEATURE_PM_TYPE_MAPPING;
	});

	it("flag on + workItemType='Bug' → createStory called with kind='BUG'", async () => {
		process.env.FEATURE_PM_TYPE_MAPPING = "true";

		const mockDb = db as unknown as {
			userStory: {
				findFirst: ReturnType<typeof vi.fn>;
				update: ReturnType<typeof vi.fn>;
			};
		};
		mockDb.userStory.findFirst.mockResolvedValue(null);
		mockDb.userStory.update.mockResolvedValue({} as never);

		vi.mocked(createStory).mockResolvedValue({
			id: "new-story-bug-1",
			identifier: "F-BUG-1",
		} as never);

		await createOrUpdateStoryFromPMItem({
			projectId: "proj-1",
			externalId: "pm-bug-1",
			title: "Login crash",
			userId: "user-1",
			mcpConfigId: null,
			containerId: "board-1",
			organizationId: "org-1",
			workItemType: "Bug",
		});

		expect(createStory).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "BUG" }),
		);
	});

	it("enableTypeMapping=true param maps even when worker env is unset → kind='BUG' (#1305)", async () => {
		// process.env.FEATURE_PM_TYPE_MAPPING is intentionally left unset here
		// (beforeEach clears it): the threaded param alone must drive the
		// reverse-map, proving it no longer depends on the Temporal worker env.
		const mockDb = db as unknown as {
			userStory: {
				findFirst: ReturnType<typeof vi.fn>;
				update: ReturnType<typeof vi.fn>;
			};
		};
		mockDb.userStory.findFirst.mockResolvedValue(null);
		mockDb.userStory.update.mockResolvedValue({} as never);

		vi.mocked(createStory).mockResolvedValue({
			id: "new-story-param-on",
			identifier: "F-PON-1",
		} as never);

		await createOrUpdateStoryFromPMItem({
			projectId: "proj-1",
			externalId: "pm-param-on-1",
			title: "Login crash",
			userId: "user-1",
			mcpConfigId: null,
			containerId: "board-1",
			organizationId: "org-1",
			workItemType: "Bug",
			enableTypeMapping: true,
		});

		expect(createStory).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "BUG" }),
		);
	});

	it("enableTypeMapping=false param overrides worker env='true' → createStory NOT called with kind (#1305)", async () => {
		process.env.FEATURE_PM_TYPE_MAPPING = "true";

		const mockDb = db as unknown as {
			userStory: {
				findFirst: ReturnType<typeof vi.fn>;
				update: ReturnType<typeof vi.fn>;
			};
		};
		mockDb.userStory.findFirst.mockResolvedValue(null);
		mockDb.userStory.update.mockResolvedValue({} as never);

		vi.mocked(createStory).mockResolvedValue({
			id: "new-story-param-off",
			identifier: "F-POFF-1",
		} as never);

		await createOrUpdateStoryFromPMItem({
			projectId: "proj-1",
			externalId: "pm-param-off-1",
			title: "Login crash",
			userId: "user-1",
			mcpConfigId: null,
			containerId: "board-1",
			organizationId: "org-1",
			workItemType: "Bug",
			enableTypeMapping: false,
		});

		const callArgs = vi.mocked(createStory).mock.calls[0]?.[0] as
			| Record<string, unknown>
			| undefined;
		expect(callArgs).toBeDefined();
		expect(callArgs).not.toHaveProperty("kind");
	});

	it("flag off → createStory NOT called with kind", async () => {
		const mockDb = db as unknown as {
			userStory: {
				findFirst: ReturnType<typeof vi.fn>;
				update: ReturnType<typeof vi.fn>;
			};
		};
		mockDb.userStory.findFirst.mockResolvedValue(null);
		mockDb.userStory.update.mockResolvedValue({} as never);

		vi.mocked(createStory).mockResolvedValue({
			id: "new-story-no-kind",
			identifier: "F-NK-1",
		} as never);

		await createOrUpdateStoryFromPMItem({
			projectId: "proj-1",
			externalId: "pm-bug-2",
			title: "Login crash",
			userId: "user-1",
			mcpConfigId: null,
			containerId: "board-1",
			organizationId: "org-1",
			workItemType: "Bug",
		});

		const callArgs = vi.mocked(createStory).mock.calls[0]?.[0] as
			| Record<string, unknown>
			| undefined;
		expect(callArgs).toBeDefined();
		expect(callArgs).not.toHaveProperty("kind");
	});

	it("flag on + workItemType null (typeless) → createStory NOT called with kind (preserves FEATURE default)", async () => {
		process.env.FEATURE_PM_TYPE_MAPPING = "true";

		const mockDb = db as unknown as {
			userStory: {
				findFirst: ReturnType<typeof vi.fn>;
				update: ReturnType<typeof vi.fn>;
			};
		};
		mockDb.userStory.findFirst.mockResolvedValue(null);
		mockDb.userStory.update.mockResolvedValue({} as never);

		vi.mocked(createStory).mockResolvedValue({
			id: "new-story-typeless",
			identifier: "F-TL-1",
		} as never);

		await createOrUpdateStoryFromPMItem({
			projectId: "proj-1",
			externalId: "pm-typeless-1",
			title: "Typeless item",
			userId: "user-1",
			mcpConfigId: null,
			containerId: "board-1",
			organizationId: "org-1",
			workItemType: null,
		});

		const callArgs = vi.mocked(createStory).mock.calls[0]?.[0] as
			| Record<string, unknown>
			| undefined;
		expect(callArgs).toBeDefined();
		expect(callArgs).not.toHaveProperty("kind");
	});
});
