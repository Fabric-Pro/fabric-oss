/**
 * Title-pinning unit test for outbound PM sync.
 *
 * Pins the contract from spec 2026-05-21-roadmap-unique-sequential-ticket-ids
 * §7.5: the outbound title sent to the PM tool is `story.title` verbatim —
 * never `"<identifier>: <title>"`, never `"F-<identifier> <title>"`, never any
 * other prefix concatenation.
 *
 * Covers both the MCP path (`syncStoryToPM` calling `executeMcpTool`) and the
 * GitLab REST fallback (`syncGitLabStoryViaRest` calling
 * `callPmToolWithFallback`). The Fabric identifier remains discoverable via
 * the "View in Fabric" back-link URL stored in the description — not via the
 * title.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { getStoryById, updateStory, getMcpConfigById, findManyStatuses } =
	vi.hoisted(() => ({
		getStoryById: vi.fn(),
		updateStory: vi.fn(),
		getMcpConfigById: vi.fn(),
		findManyStatuses: vi.fn(),
	}));

// Mock @repo/database with a synchronous factory (no importOriginal) so we
// never evaluate the Prisma client. Mirror only what story-sync.ts and
// gitlab-rest-story-sync.ts actually import.
vi.mock("@repo/database", () => ({
	createStory: vi.fn(),
	deleteStory: vi.fn(),
	getStoryById,
	updateStory,
	updateTask: vi.fn(),
	getMcpConfigById,
	// Read-only mode gate — default: project is writable
	isProjectReadOnly: vi.fn(async () => false),
	listStoryStatuses: vi.fn().mockResolvedValue([]),
	// Identity back-link formatter so the description we observe in the PM-tool
	// call equals what `buildStoryDescription` produced.
	formatBackLinkForProvider: (desc: string) => desc,
	normalizeBackLinkFromProvider: (desc: string) => desc,
	HTML_BACK_LINK_RE:
		/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i,
	db: {
		projectStoryStatus: { findMany: findManyStatuses },
	},
}));

vi.mock("@repo/integrations/pm", () => ({
	applyLabelStatusMapOnPull: (_state: unknown, _labels: string[]) => ({
		statusId: null,
		labels: [],
	}),
	computeLabelDeltaOnPush: () => ({ addLabels: [], removeLabels: [] }),
	readLabelStatusMap: () => ({}),
}));

// `syncGitLabStoryViaRest` now stamps a baseline hash via
// `stampPmSyncSuccess` on every successful push/pull (and uses the matching
// guard helpers on update). The real helpers call `db.userStory.update` →
// Prisma client, which isn't available under this test's synchronous
// `@repo/database` mock. Stubbing the hierarchy-sync helpers here mirrors the
// approach in `gitlab-rest-story-sync.test.ts`.
vi.mock("../hierarchy-sync", () => ({
	getPmSyncBaseline: vi.fn().mockResolvedValue(null),
	stampPmSyncConflict: vi.fn().mockResolvedValue(undefined),
	stampPmSyncSuccess: vi.fn().mockResolvedValue(undefined),
}));

import { executeMcpTool } from "../../orchestrator/execution/execute-mcp-tool";
import { syncGitLabStoryViaRest } from "../gitlab-rest-story-sync";
import { parsePMItemFromGetOutput, syncStoryToPM } from "../story-sync";

const STORY_IDENTIFIER = "12";
const STORY_TITLE = "Add login";

function makeStory(overrides: Record<string, unknown> = {}) {
	return {
		id: "story-1",
		projectId: "proj-1",
		identifier: STORY_IDENTIFIER,
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
		...overrides,
	};
}

function makeCapabilities() {
	return {
		hasPMCapabilities: true,
		containerHierarchy: [],
		availableTools: ["create_card", "update_card"],
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

const baseMcpInput = {
	storyId: "story-1",
	projectId: "proj-1",
	mcpConfigId: "mcp-1",
	mcpServerId: "server-1",
	containerId: "board-1",
	direction: "push" as const,
	userId: "user-1",
	organizationId: "org-1",
	additionalContext: {},
	capabilities: makeCapabilities() as never,
};

const REST_SOURCE = {
	kind: "rest-gitlab" as const,
	token: "TOK",
	baseUrl: "https://gitlab.com/api/v4",
	projectId: "100",
};

describe("PM-sync outbound title is `story.title` verbatim (no identifier prefix)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		updateStory.mockResolvedValue(undefined);
		findManyStatuses.mockResolvedValue([]);
		getMcpConfigById.mockResolvedValue({
			baseUrl: null,
			mcpServerId: "server-1",
			mcpServer: { defaultUrl: null },
		});
		resolvePmSource.mockResolvedValue(REST_SOURCE);
	});

	describe("MCP path: syncStoryToPM", () => {
		it("create_card receives title='Add login' (NOT '12: Add login' or 'F-12 Add login')", async () => {
			getStoryById.mockResolvedValue(makeStory());
			vi.mocked(executeMcpTool).mockResolvedValue({
				success: true,
				output: { id: "ext-1", url: "https://pm.example/ext-1" },
			} as never);

			await syncStoryToPM(baseMcpInput);

			const createCall = vi
				.mocked(executeMcpTool)
				.mock.calls.find(
					([arg]) =>
						(arg as { toolName: string }).toolName ===
						"create_card",
				);
			expect(createCall).toBeDefined();
			const args = (createCall![0] as { args: Record<string, unknown> })
				.args;
			expect(args.title).toBe(STORY_TITLE);
			expect(args.title).not.toMatch(/^F?-?\d+[:\s]/);
			expect(args.title).not.toContain(STORY_IDENTIFIER);
		});

		it("update_card receives title='Add login' (NOT '12: Add login' or 'F-12 Add login')", async () => {
			getStoryById.mockResolvedValue(
				makeStory({
					externalId: "ext-1",
					externalUrl: "https://pm.example/ext-1",
					externalMcpServerId: "server-1",
				}),
			);
			vi.mocked(executeMcpTool).mockResolvedValue({
				success: true,
				output: {},
			} as never);

			await syncStoryToPM(baseMcpInput);

			const updateCall = vi
				.mocked(executeMcpTool)
				.mock.calls.find(
					([arg]) =>
						(arg as { toolName: string }).toolName ===
						"update_card",
				);
			expect(updateCall).toBeDefined();
			const args = (updateCall![0] as { args: Record<string, unknown> })
				.args;
			expect(args.title).toBe(STORY_TITLE);
			expect(args.title).not.toMatch(/^F?-?\d+[:\s]/);
			expect(args.title).not.toContain(STORY_IDENTIFIER);
		});
	});

	describe("GitLab REST path: syncGitLabStoryViaRest", () => {
		it("createItem payload.title='Add login' (NOT '12: Add login' or 'F-12 Add login')", async () => {
			getStoryById.mockResolvedValue(makeStory());
			callPmToolWithFallback.mockResolvedValue({
				externalId: "42",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				title: STORY_TITLE,
			});

			await syncGitLabStoryViaRest({
				...baseMcpInput,
				mcpConfigId: null,
				containerId: "100",
			});

			const call = callPmToolWithFallback.mock.calls[0]![0];
			expect(call.call.tool).toBe("createItem");
			expect(call.call.payload.title).toBe(STORY_TITLE);
			expect(call.call.payload.title).not.toMatch(/^F?-?\d+[:\s]/);
			expect(call.call.payload.title).not.toContain(STORY_IDENTIFIER);
		});

		it("updateItem payload.title='Add login' (NOT '12: Add login' or 'F-12 Add login')", async () => {
			getStoryById.mockResolvedValue(
				makeStory({
					externalId: "42",
					externalUrl: "https://gitlab.com/group/proj/-/issues/42",
					externalMcpServerId: "server-1",
				}),
			);
			callPmToolWithFallback.mockResolvedValue({
				externalId: "42",
				externalUrl: "https://gitlab.com/group/proj/-/issues/42",
				title: STORY_TITLE,
			});

			await syncGitLabStoryViaRest({
				...baseMcpInput,
				mcpConfigId: null,
				containerId: "100",
			});

			const call = callPmToolWithFallback.mock.calls[0]![0];
			expect(call.call.tool).toBe("updateItem");
			expect(call.call.payload.title).toBe(STORY_TITLE);
			expect(call.call.payload.title).not.toMatch(/^F?-?\d+[:\s]/);
			expect(call.call.payload.title).not.toContain(STORY_IDENTIFIER);
		});
	});
});

describe("parsePMItemFromGetOutput — workItemType extraction", () => {
	it("extracts workItemType from ADO fields[System.WorkItemType]", () => {
		const output = {
			fields: { "System.WorkItemType": "Bug", "System.Title": "Fix it" },
		};
		const result = parsePMItemFromGetOutput(output);
		expect(result.workItemType).toBe("Bug");
	});

	it("returns undefined workItemType when field is absent", () => {
		const output = { title: "No type here" };
		const result = parsePMItemFromGetOutput(output);
		expect(result.workItemType).toBeUndefined();
	});
});
