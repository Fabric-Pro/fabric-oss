import { beforeEach, describe, expect, it, vi } from "vitest";

// Covers the CREATE-branch externalId extraction + atomicity contract.
// Repro for the "roadmap shows Unsynced after successful Fizzy push" bug:
// 1. The flat-only extractor missed nested PM-MCP create responses (e.g.
//    `{ card: { id: "..." } }`), leaving externalId undefined.
// 2. `stampPmSyncSuccess` then ran unconditionally, persisting
//    `lastPmSyncStatus = SUCCESS` with `externalId = null`. The roadmap
//    classifier (`!externalId || FAILED → unsynced`) rendered "Unsynced"
//    and the next auto-sync re-entered CREATE → duplicate PM card.
// These tests pin both halves of the fix: the nested-probing extractor
// catches common nested shapes, and the atomicity guard never stamps
// SUCCESS when extraction produced no externalId.

vi.mock("@temporalio/activity", async () => {
	const actual = await vi.importActual<object>("@temporalio/activity");
	return {
		...actual,
		Context: {
			current: () => ({ heartbeat: vi.fn() }),
		},
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
		getSignedUrl: vi.fn(
			async (key: string) =>
				`https://signed.example.com/${key}?Sig=test&Expires=999999`,
		),
	})),
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: {
			bucketNames: {
				projectContexts: "test-project-contexts",
			},
		},
	},
}));

// Spy on recordPmSyncFailure so we can assert the atomicity-guard branch
// actually calls it. Replacing the module entirely (rather than partial-mock)
// keeps the DB write side-effect-free in the test.
const { recordPmSyncFailureMock } = vi.hoisted(() => ({
	recordPmSyncFailureMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../record-pm-sync-state", () => ({
	recordPmSyncFailure: recordPmSyncFailureMock,
}));

const {
	userStoryUpdateMock,
	userStoryUpdateManyMock,
	featureUpdateMock,
	featureUpdateManyMock,
	epicUpdateMock,
	epicUpdateManyMock,
} = vi.hoisted(() => ({
	userStoryUpdateMock: vi.fn(),
	userStoryUpdateManyMock: vi.fn(),
	featureUpdateMock: vi.fn(),
	featureUpdateManyMock: vi.fn(),
	epicUpdateMock: vi.fn(),
	epicUpdateManyMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	// Read-only mode gate — default: project is writable
	isProjectReadOnly: vi.fn(async () => false),
	db: {
		userStory: {
			update: userStoryUpdateMock,
			updateMany: userStoryUpdateManyMock,
		},
		feature: {
			update: featureUpdateMock,
			updateMany: featureUpdateManyMock,
		},
		epic: {
			update: epicUpdateMock,
			updateMany: epicUpdateManyMock,
		},
		mCPConfig: {
			findUnique: vi.fn().mockResolvedValue(null),
		},
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
	updateEpic: vi.fn().mockResolvedValue(undefined),
	updateFeature: vi.fn().mockResolvedValue(undefined),
	updateStory: vi.fn().mockResolvedValue(undefined),
	HTML_BACK_LINK_RE:
		/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i,
	formatBackLinkForProvider: (description: string | null | undefined) =>
		description ?? "",
}));

vi.mock("../story-sync", async () => {
	const actual = await vi.importActual<{
		markdownToSimpleHtml: (s: string) => string;
	}>("../story-sync");
	return {
		...actual,
		discoverPMToolCapabilities: vi.fn(),
		HTML_DESCRIPTION_TOOLS: new Set<string>(),
		markdownToSimpleHtml: vi.fn((s: string) => s),
		__realMarkdownToSimpleHtml: actual.markdownToSimpleHtml,
	};
});

import { getStoryById, updateStory } from "@repo/database";
import { executeMcpTool } from "../../orchestrator/execution/execute-mcp-tool";
import { syncWorkItemToPM } from "../hierarchy-sync";
import { discoverPMToolCapabilities } from "../story-sync";

const STORY_ID = "story-orphan-1";
const PROJECT_ID = "project-orphan-1";
const STORY_TITLE = "Reproduce orphan path";
const STORY_DESCRIPTION = "Body for the orphan-path repro story";

// Fizzy-shaped capabilities. Mirrors the realistic shape from
// `hierarchy-sync.test.ts` `makeCapabilities()` — taskUpdate exists (so the
// CREATE branch is only taken when externalId is null), taskCreation is
// present so the CREATE tool actually runs.
function makeFizzyCapabilities() {
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
			allParams: [
				{ name: "card_id", type: "string", required: true },
				{ name: "title", type: "string", required: false },
				{ name: "description", type: "string", required: false },
			],
		},
		taskCreation: {
			toolName: "create_card",
			containerParam: "board_id",
			titleParam: "title",
			descriptionParam: "description",
			fieldsBased: undefined,
			additionalRequiredParams: [],
			allParams: [
				{ name: "board_id", type: "string", required: true },
				{ name: "title", type: "string", required: true },
				{ name: "description", type: "string", required: false },
			],
		},
		taskGet: {
			toolName: "get_card",
			idParam: "card_id",
			additionalRequiredParams: [],
			allParams: [],
		},
	};
}

// Story with NO externalId/externalUrl — forces the CREATE branch.
function makeUnlinkedStory(overrides: Record<string, unknown> = {}) {
	return {
		id: STORY_ID,
		title: STORY_TITLE,
		description: STORY_DESCRIPTION,
		acceptanceCriteria: null,
		identifier: "US-orphan-1",
		externalId: null,
		externalUrl: null,
		externalMcpServerId: null,
		lastSyncedPmHash: null,
		...overrides,
	};
}

const baseInput = {
	itemType: "story" as const,
	itemId: STORY_ID,
	projectId: PROJECT_ID,
	mcpConfigId: "mcp-fizzy",
	containerId: "board-orphan-1",
	userId: "user-orphan-1",
	triggerSource: "manual-edit" as const,
};

describe("syncWorkItemToPM — CREATE branch externalId extraction & atomicity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		userStoryUpdateMock.mockResolvedValue({});
		userStoryUpdateManyMock.mockResolvedValue({});
		featureUpdateMock.mockResolvedValue({});
		featureUpdateManyMock.mockResolvedValue({});
		epicUpdateMock.mockResolvedValue({});
		epicUpdateManyMock.mockResolvedValue({});
		vi.mocked(discoverPMToolCapabilities).mockResolvedValue(
			makeFizzyCapabilities() as never,
		);
		vi.mocked(getStoryById).mockResolvedValue(makeUnlinkedStory() as never);
	});

	it("CREATE response with top-level id ({ id: '1075', url }) → SUCCESS, externalId persisted (regression guard)", async () => {
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				id: "1075",
				url: "https://app.fizzy.do/000000/cards/1075",
			},
		} as never);

		const result = await syncWorkItemToPM(baseInput);

		expect(result.status).toBe("SUCCESS");
		expect(result.externalId).toBe("1075");
		// Atomicity-guard FAILED path must NOT have fired.
		expect(recordPmSyncFailureMock).not.toHaveBeenCalled();
		// External refs persisted via updateStory (`updateWorkItemExternalRefs`).
		expect(vi.mocked(updateStory)).toHaveBeenCalledWith(
			STORY_ID,
			PROJECT_ID,
			expect.objectContaining({ externalId: "1075" }),
			{ lastEditedSource: "PM_PULL" },
		);
		// SUCCESS stamp landed.
		expect(userStoryUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: STORY_ID },
				data: expect.objectContaining({
					lastPmSyncStatus: "SUCCESS",
					lastPmSyncError: null,
				}),
			}),
		);
	});

	it("CREATE response with NESTED id ({ card: { id: '1075', url } }) → nested probing extracts it, SUCCESS", async () => {
		// This is the realistic Fizzy-MCP shape that the OLD flat-only extractor
		// silently missed — the bug under test.
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				card: {
					id: "1075",
					url: "https://app.fizzy.do/000000/cards/1075",
				},
			},
		} as never);

		const result = await syncWorkItemToPM(baseInput);

		expect(result.status).toBe("SUCCESS");
		expect(result.externalId).toBe("1075");
		// Narrow before accessing externalUrl — the SyncWorkItemResult union's
		// CONFLICT/FAILED variants don't carry it.
		if (result.status === "SUCCESS") {
			expect(result.externalUrl).toBe(
				"https://app.fizzy.do/000000/cards/1075",
			);
		}
		expect(recordPmSyncFailureMock).not.toHaveBeenCalled();
		expect(vi.mocked(updateStory)).toHaveBeenCalledWith(
			STORY_ID,
			PROJECT_ID,
			expect.objectContaining({
				externalId: "1075",
				externalUrl: "https://app.fizzy.do/000000/cards/1075",
			}),
			{ lastEditedSource: "PM_PULL" },
		);
	});

	it("CREATE succeeded but response has NO id anywhere ({}) → atomicity guard stamps FAILED 'create_orphan', NOT SUCCESS", async () => {
		// The path the bug previously took: a successful MCP create but an
		// unparseable response. Before the fix this stamped SUCCESS with
		// externalId=null → roadmap "Unsynced" forever + next-sync duplicate.
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {},
		} as never);

		const result = await syncWorkItemToPM(baseInput);

		expect(result.status).toBe("FAILED");
		expect(result.externalId).toBeUndefined();

		// recordPmSyncFailure called with the create_orphan errorClass and a
		// clear, action-oriented message.
		expect(recordPmSyncFailureMock).toHaveBeenCalledTimes(1);
		expect(recordPmSyncFailureMock).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: STORY_ID,
				itemType: "story",
				errorClass: "create_orphan",
				errorMessage: expect.stringContaining(
					"could not extract its id",
				),
				pmTool: "fizzy",
			}),
		);

		// CRITICAL: stampPmSyncSuccess must NOT have run — no SUCCESS row.
		expect(userStoryUpdateMock).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastPmSyncStatus: "SUCCESS",
				}),
			}),
		);

		// And external refs must NOT have been persisted with a phantom id.
		expect(vi.mocked(updateStory)).not.toHaveBeenCalledWith(
			STORY_ID,
			PROJECT_ID,
			expect.objectContaining({ externalId: expect.any(String) }),
		);
	});

	it("CREATE response with id under a different wrapper ({ result: { card_id: '1075' } }) → nested probing finds it via COMMON_ID_FIELDS", async () => {
		// Defensive coverage for other common envelope shapes that show up in
		// the wild — `{ result: ... }`, `{ data: ... }`, `{ task: ... }`.
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {
				result: {
					card_id: "1075",
					webUrl: "https://app.fizzy.do/000000/cards/1075",
				},
			},
		} as never);

		const result = await syncWorkItemToPM(baseInput);

		expect(result.status).toBe("SUCCESS");
		expect(result.externalId).toBe("1075");
		expect(recordPmSyncFailureMock).not.toHaveBeenCalled();
	});
});
