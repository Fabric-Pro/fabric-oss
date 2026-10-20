/**
 * A database error during a pull is not a deleted PM ticket.
 *
 * Prisma's P2025 text ("...required but not found") matches the stale-link
 * pattern the pull paths use to decide that a legacy (unstamped) link points
 * at a ticket that no longer exists. Each of those paths must keep the link
 * when the error is a database error, whether thrown or flattened by the MCP
 * executor into an indeterminate failure result after dispatch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The create claim (`pm-create-claim.ts`) has its own tests
// (pm-create-claim.test.ts); here every create takes it.
vi.mock("../pm-create-claim", async (importOriginal) => ({
	...(await importOriginal<object>()),
	acquirePmCreateClaim: vi.fn(async () => ({ claimId: "claim-test" })),
	releasePmCreateClaim: vi.fn(async () => true),
}));

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
vi.mock("../../pm-source", () => ({
	resolvePmSource,
	PMSourceNotFound,
	assertPmMcpTargetOrigin: async () => undefined,
}));

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
	// The organization gate on the config owner (Fizzy #2903): a member whose
	// role allows MCP read and connect.
	canConnectOrganizationMcpConfigs: vi.fn(async () => true),
	canReadOrganizationMcpConfigs: vi.fn(async () => true),
	isOrganizationMember: vi.fn(async () => true),
	createStory: vi.fn(),
	deleteStory: vi.fn(),
	getStoryById,
	updateStory,
	updateTask: vi.fn(),
	getMcpConfigById,
	// Read-only mode gate — default: project is writable
	isProjectReadOnly: vi.fn(async () => false),
	listStoryStatuses: vi.fn().mockResolvedValue([]),
	formatBackLinkForProvider: (desc: string) => desc,
	normalizeBackLinkFromProvider: (desc: string) => desc,
	HTML_BACK_LINK_RE:
		/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i,
	db: {
		projectStoryStatus: { findMany: findManyStatuses },
		project: { findUnique: vi.fn().mockResolvedValue(null) },
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
import { syncStoryToPM } from "../story-sync";

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

function p2025() {
	return Object.assign(
		new Error(
			"An operation failed because it depends on one or more records that were required but not found. Record to update not found.",
		),
		{ name: "PrismaClientKnownRequestError", code: "P2025" },
	);
}

const legacyLink = {
	externalId: "ext-1",
	externalUrl: "https://pm.example/ext-1",
	externalMcpServerId: null,
};

function expectLinkKept() {
	for (const [, , data] of updateStory.mock.calls) {
		expect(data).not.toMatchObject({ externalId: null });
		expect(data).not.toMatchObject({ externalUrl: null });
	}
}

describe("a database not-found during a pull keeps a legacy PM link", () => {
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

	it.each([false, true])(
		"MCP path: a database error escaping to the outer catch (wrapped=%s)",
		async (wrapped) => {
			const error = wrapped
				? new Error(p2025().message, { cause: p2025() })
				: p2025();
			getStoryById
				.mockRejectedValueOnce(error)
				.mockResolvedValue(makeStory(legacyLink));

			const result = await syncStoryToPM({
				...baseMcpInput,
				direction: "pull",
			});

			expectLinkKept();
			expect(result.success).toBe(false);
			expect(result.errorCode).not.toBe("EXTERNAL_ID_NOT_FOUND");
			expect(result.error).toBe("database error P2025");
		},
	);

	it.each([false, true])(
		"MCP path: a database error thrown by the ticket fetch (wrapped=%s)",
		async (wrapped) => {
			const error = wrapped
				? new Error(p2025().message, { cause: p2025() })
				: p2025();
			getStoryById.mockResolvedValue(makeStory(legacyLink));
			vi.mocked(executeMcpTool).mockRejectedValue(error);

			const result = await syncStoryToPM({
				...baseMcpInput,
				direction: "pull",
			});

			expect(executeMcpTool).toHaveBeenCalled();
			expectLinkKept();
			expect(result.success).toBe(false);
			expect(result.errorCode).not.toBe("EXTERNAL_ID_NOT_FOUND");
			expect(result.error).toBe("database error P2025");
		},
	);

	it("MCP path: a failure result refused before it reached the PM tool", async () => {
		getStoryById.mockResolvedValue(makeStory(legacyLink));
		for (const error of [p2025().message, "Tool not found: get_card"]) {
			vi.mocked(executeMcpTool).mockResolvedValue({
				success: false,
				output: { error },
				durationMs: 1,
				failureKind: "rejected",
			} as never);

			const result = await syncStoryToPM({
				...baseMcpInput,
				direction: "pull",
			});

			expectLinkKept();
			expect(result.success).toBe(false);
			expect(result.errorCode).not.toBe("EXTERNAL_ID_NOT_FOUND");
		}
	});

	it("MCP path: an indeterminate local database failure keeps the link", async () => {
		getStoryById.mockResolvedValue(makeStory(legacyLink));
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: false,
			output: { error: p2025().message },
			durationMs: 1,
			failureKind: "indeterminate",
			localDatabaseError: true,
		} as never);
		const result = await syncStoryToPM({
			...baseMcpInput,
			direction: "pull",
		});
		expectLinkKept();
		expect(result.success).toBe(false);
		expect(result.errorCode).not.toBe("EXTERNAL_ID_NOT_FOUND");
	});

	it("MCP path: the PM tool's own not-found still unlinks a legacy link", async () => {
		getStoryById.mockResolvedValue(makeStory(legacyLink));
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: false,
			output: { error: "Resource not found: card ext-1" },
			durationMs: 1,
			failureKind: "indeterminate",
		} as never);

		const result = await syncStoryToPM({
			...baseMcpInput,
			direction: "pull",
		});

		expect(updateStory).toHaveBeenCalledWith(
			"story-1",
			"proj-1",
			expect.objectContaining({ externalId: null }),
			expect.anything(),
		);
		expect(result.errorCode).toBe("EXTERNAL_ID_NOT_FOUND");
	});

	it.each([false, true])(
		"GitLab REST path: a database error thrown by the ticket fetch (wrapped=%s)",
		async (wrapped) => {
			const error = wrapped
				? new Error(p2025().message, { cause: p2025() })
				: p2025();
			getStoryById.mockResolvedValue(
				makeStory({
					externalId: "42",
					externalUrl: "https://gitlab.com/group/proj/-/issues/42",
					externalMcpServerId: null,
				}),
			);
			callPmToolWithFallback.mockRejectedValue(error);

			const result = await syncGitLabStoryViaRest({
				...baseMcpInput,
				mcpConfigId: null,
				containerId: "100",
				direction: "pull",
			});

			expect(callPmToolWithFallback).toHaveBeenCalled();
			expectLinkKept();
			expect(result.success).toBe(false);
			expect(result.errorCode).not.toBe("EXTERNAL_ID_NOT_FOUND");
		},
	);
});
