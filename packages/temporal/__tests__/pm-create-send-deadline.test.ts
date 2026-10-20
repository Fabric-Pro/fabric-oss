/**
 * The PM create's send deadline, end to end through the shared dispatch
 * check (Fizzy #3045). The bulk story create (`createStoryInPmWithClaim`)
 * and the test-case create (`createTestCaseInPmWithClaim`) run for real with
 * the real claim and the real `executeMcpTool`; only the database (a
 * simulated store with Prisma's `where` semantics), the MCP connection and
 * the clocks are simulated.
 *
 * The deadline starts before the claim is asked for. When the claim
 * UPDATE's answer comes back after the send ceiling (the row was claimed,
 * but the reply was that late), nothing is sent to the PM tool, the claim
 * is released and a failure the user can retry is reported: not the
 * unconfirmed create a held claim would mean.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const h = vi.hoisted(() => ({
	stories: new Map<string, Record<string, unknown> & { id: string }>(),
	cases: new Map<string, Record<string, unknown> & { id: string }>(),
	/** How long the claim UPDATE's answer takes, on the monotonic clock. */
	claimAnswerDelayMs: 0,
	/** The monotonic clock. */
	clock: 1_000_000,
	getClient: vi.fn(),
	execute: vi.fn(),
	recordPmSyncLog: vi.fn(),
}));

/** Prisma `where` semantics for the shapes these reads and writes use. */
function matches(row: Record<string, unknown>, where: object): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (key === "OR") {
			return (value as object[]).some((arm) => matches(row, arm));
		}
		const cell = row[key] ?? null;
		if (value && typeof value === "object" && !(value instanceof Date)) {
			if ("not" in value) {
				return (
					cell !== null && cell !== (value as { not: unknown }).not
				);
			}
			return (
				cell !== null &&
				matches(cell as Record<string, unknown>, value as object)
			);
		}
		return cell === value;
	});
}

function table(rows: Map<string, Row>) {
	return {
		findFirst: vi.fn(async ({ where }: { where: object }) => {
			const row = [...rows.values()].find((r) => matches(r, where));
			return row ? { ...row } : null;
		}),
		findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
			const row = rows.get(where.id);
			return row ? { ...row } : null;
		}),
		update: vi.fn(
			async ({
				where,
				data,
			}: {
				where: { id: string };
				data: Record<string, unknown>;
			}) => {
				const row = rows.get(where.id);
				if (!row) {
					throw new Error("Record to update not found.");
				}
				Object.assign(row, data);
				return { ...row };
			},
		),
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where: object;
				data: Record<string, unknown>;
			}) => {
				let count = 0;
				for (const row of rows.values()) {
					if (matches(row, where)) {
						Object.assign(row, data);
						count++;
					}
				}
				return { count };
			},
		),
	};
}

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
	activityInfo: () => ({ workflowExecution: { workflowId: "wf-1" } }),
	Context: { current: () => ({ heartbeat: vi.fn() }) },
}));

vi.mock("@repo/database", () => ({
	db: {
		userStory: table(h.stories),
		testCase: table(h.cases),
		mCPServer: { findUnique: vi.fn(async () => null) },
	},
	PmSyncStatus: {
		PENDING: "PENDING",
		SUCCESS: "SUCCESS",
		CONFLICT: "CONFLICT",
		FAILED: "FAILED",
	},
	// The claim UPDATE reads the database clock and then writes; its answer
	// takes `claimAnswerDelayMs` to come back.
	readDatabaseClock: vi.fn(async () => {
		h.clock += h.claimAnswerDelayMs;
		return new Date();
	}),
	updateStory: vi.fn(),
}));

vi.mock("../src/activities/lib/job-progress", () => ({
	jobHeartbeat: vi.fn(async () => undefined),
}));

vi.mock("../src/activities/pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog: h.recordPmSyncLog,
}));

vi.mock("../src/activities/pm-integration/fetch-pm-ticket", () => ({
	fetchPmTicket: vi.fn(),
}));

// `executeMcpTool`'s own dependencies, as its failure-kind tests mock them;
// the MCP connection is the one under the test's control.
vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: h.getClient,
	invalidateMcpClientCache: vi.fn(async () => undefined),
	isClosedClientRefusedBeforeSend: () => false,
	McpGitLabOriginMismatchError: class extends Error {},
	OAuthAuthorizationRequiredError: class extends Error {},
}));
vi.mock("@repo/integrations/github", () => ({ executeGitHubTool: vi.fn() }));
vi.mock("@repo/integrations/slack", () => ({ executeSlackTool: vi.fn() }));
vi.mock("../src/activities/letta-memory-activities", () => ({
	cacheToolResult: vi.fn(),
	getCachedToolResult: vi.fn(async () => ({ found: false })),
}));
vi.mock("../src/activities/shared/frame-service", () => ({
	createFirstClassFrame: vi.fn(),
	getFirstClassFrame: vi.fn(),
	listFirstClassFrames: vi.fn(),
	shareFirstClassFrame: vi.fn(),
	updateFirstClassFrame: vi.fn(),
}));
vi.mock("../src/activities/shared/oauth-tool-executors", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));
vi.mock("../src/activities/shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: vi.fn(async () => null),
}));

const { createStoryInPmWithClaim } = await import(
	"../src/activities/pm-integration/create-story-in-pm-with-claim"
);
const { createTestCaseInPmWithClaim } = await import(
	"../src/activities/pm-integration/create-test-case-in-pm-with-claim"
);

const SEND_CEILING_MS = 50_000;

function unlinked(id: string, overrides: Record<string, unknown> = {}): Row {
	return {
		id,
		projectId: "project-1",
		project: { organizationId: "org-1", userId: "u-1" },
		title: "Example",
		deletedAt: null,
		externalId: null,
		externalUrl: null,
		externalMcpServerId: null,
		lastPmSyncStatus: null,
		lastPmSyncError: null,
		lastPmSyncAttemptId: null,
		pmCreateClaimId: null,
		pmCreateClaimedAt: null,
		...overrides,
	};
}

const common = {
	projectId: "project-1",
	organizationId: "org-1",
	userId: "u-1",
	mcpConfigId: "config-1",
	pmTarget: { additionalContext: { account_slug: "example-org" } },
	pmTool: "fizzy",
	toolLabel: "fizzy",
	toolName: "create_card",
	createArgs: { board_id: "board-1", title: "Example" },
};

beforeEach(() => {
	h.stories.clear();
	h.cases.clear();
	h.clock = 1_000_000;
	h.claimAnswerDelayMs = 0;
	h.getClient.mockReset();
	h.execute.mockReset();
	h.recordPmSyncLog.mockReset();
	vi.spyOn(performance, "now").mockImplementation(() => h.clock);
	h.getClient.mockImplementation(async () => ({
		client: {
			tools: async () => ({ create_card: { execute: h.execute } }),
		},
		serverName: "Fizzy",
		fromCache: true,
	}));
	h.execute.mockResolvedValue({
		content: [
			{
				type: "text",
				text: JSON.stringify({
					id: "1075",
					url: "https://pm.example.com/cards/1075",
				}),
			},
		],
	});
});

afterEach(() => {
	vi.mocked(performance.now).mockRestore();
});

describe("the bulk story create (createStoryInPmWithClaim)", () => {
	const input = { ...common, storyId: "s1", action: "create" as const };

	it("a claim UPDATE whose answer came after the send ceiling: nothing is sent, the claim is released, and a retry is offered", async () => {
		h.stories.set("s1", unlinked("s1"));
		h.claimAnswerDelayMs = 6 * 60_000;

		const result = await createStoryInPmWithClaim(input);

		expect(h.getClient).not.toHaveBeenCalled();
		expect(h.execute).not.toHaveBeenCalled();
		expect(h.stories.get("s1")).toMatchObject({
			externalId: null,
			pmCreateClaimId: null,
			pmCreateClaimedAt: null,
		});
		expect(result).toMatchObject({
			success: false,
			outcome: "create-rejected",
		});
		expect(result.error).toContain(
			"Fabric did not send the create to fizzy",
		);
		expect(result.error).not.toMatch(
			/may already exist|Unlink & re-create/,
		);
		// Not recorded as an unconfirmed create.
		expect(h.stories.get("s1")?.lastPmSyncError ?? null).toBeNull();
	});

	// The control: the same setup sends when the claim answers in time. (The
	// link write after it is not simulated here; its own suites cover it.)
	it("a claim answered within the ceiling: the create is sent", async () => {
		h.stories.set("s1", unlinked("s1"));
		h.claimAnswerDelayMs = SEND_CEILING_MS - 1_000;

		const result = await createStoryInPmWithClaim(input);

		expect(h.execute).toHaveBeenCalledTimes(1);
		expect(result.error ?? "").not.toContain("did not send the create");
	});
});

describe("the test-case create (createTestCaseInPmWithClaim)", () => {
	const input = {
		...common,
		testCaseId: "tc1",
		pmSyncAttemptId: "attempt-1",
	};

	it("a claim UPDATE whose answer came after the send ceiling: nothing is sent, FAILED with a retry offered, and the claim released", async () => {
		h.cases.set(
			"tc1",
			unlinked("tc1", {
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-1",
			}),
		);
		h.claimAnswerDelayMs = 6 * 60_000;

		const result = await createTestCaseInPmWithClaim(input);

		expect(h.getClient).not.toHaveBeenCalled();
		expect(h.execute).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: false,
			outcome: "create-rejected",
		});
		const row = h.cases.get("tc1");
		expect(row).toMatchObject({
			externalId: null,
			pmCreateClaimId: null,
			pmCreateClaimedAt: null,
			lastPmSyncStatus: "FAILED",
		});
		expect(row?.lastPmSyncError).toContain(
			"Fabric did not send the create to fizzy",
		);
		expect(String(row?.lastPmSyncError)).not.toMatch(
			/may already exist|Unlink & re-create/,
		);
	});

	// The control, as for the story.
	it("a claim answered within the ceiling: the create is sent", async () => {
		h.cases.set(
			"tc1",
			unlinked("tc1", {
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-1",
			}),
		);
		h.claimAnswerDelayMs = SEND_CEILING_MS - 1_000;

		const result = await createTestCaseInPmWithClaim(input);

		expect(h.execute).toHaveBeenCalledTimes(1);
		expect(result.error ?? "").not.toContain("did not send the create");
	});
});
