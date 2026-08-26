/**
 * Tests for `fetchPMItemsByIds` bounded-concurrency option.
 *
 * Three behaviors are asserted:
 *   1. Default (no `concurrency` arg): max-in-flight === 1 (serial).
 *   2. `concurrency: 3`: max-in-flight ≤ 3 and > 1.
 *   3. `concurrency: 5` with reversed per-call latency: returned items are
 *      in input order (slot-based result reassembly preserves order even
 *      when calls finish out of order).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/agent-core/backend — same pattern as story-sync.test.ts to
// avoid loading real @repo/database (vitest #4373).
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

// Mock the orchestrator's executeMcpTool so we can instrument concurrency.
vi.mock("../src/activities/orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

// Mock @repo/database — see comment on @repo/agent-core/backend mock.
vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		userStory: { findMany: vi.fn() },
		storyTask: { findUnique: vi.fn() },
	},
	Prisma: {},
	getStoryById: vi.fn(),
	getMcpConfigById: vi.fn(),
	updateStory: vi.fn(),
	updateTask: vi.fn(),
}));

import { getMcpClient, getMcpClientResult } from "@repo/agent-core/backend";
import { executeMcpTool } from "../src/activities/orchestrator/execution/execute-mcp-tool";
import {
	fetchPMItemsByIds,
	isPmNotFoundError,
} from "../src/activities/pm-integration/story-sync";

// GitLab-shaped tool: get_issue with required project_id + issue_id.
// The real analyzer detects this as a taskGet capability with
// idParam=issue_id and additionalRequiredParams=["project_id"].
const GITLAB_TOOLS = {
	get_issue: {
		description: "Get a GitLab issue",
		inputSchema: {
			type: "object",
			properties: {
				project_id: { type: "string" },
				issue_id: { type: "number" },
			},
			required: ["project_id", "issue_id"],
		},
	},
};

function setupMcpClientMock() {
	const mockClient = {
		tools: vi.fn().mockResolvedValue(GITLAB_TOOLS),
	};
	vi.mocked(getMcpClient).mockResolvedValue({
		// biome-ignore lint/suspicious/noExplicitAny: test fake
		client: mockClient as any,
		serverName: "gitlab",
	});
	vi.mocked(getMcpClientResult).mockResolvedValue({
		ok: true,
		// biome-ignore lint/suspicious/noExplicitAny: test fake
		client: mockClient as any,
		serverName: "gitlab",
	});
	return mockClient;
}

/**
 * Build an executeMcpTool mock that tracks max-in-flight and supports
 * per-id latency. Returns the tracker so tests can read `maxInFlight`.
 */
function buildExecuteMock(latencyById: Record<string, number>) {
	const tracker = { inFlight: 0, maxInFlight: 0 };

	vi.mocked(executeMcpTool).mockImplementation(async (args) => {
		const id = String(
			(args.args as Record<string, unknown>).issue_id ?? "",
		);
		tracker.inFlight++;
		if (tracker.inFlight > tracker.maxInFlight) {
			tracker.maxInFlight = tracker.inFlight;
		}
		await new Promise((r) => setTimeout(r, latencyById[id] ?? 5));
		tracker.inFlight--;

		return {
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id: Number(id),
							title: `Issue ${id}`,
						}),
					},
				],
			},
			// biome-ignore lint/suspicious/noExplicitAny: test fake
		} as any;
	});

	return tracker;
}

describe("fetchPMItemsByIds — bounded concurrency", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("runs serially by default (max-in-flight === 1)", async () => {
		setupMcpClientMock();
		const tracker = buildExecuteMock({ "1": 10, "2": 10, "3": 10 });

		const result = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "project-1",
			externalIds: ["1", "2", "3"],
			additionalContext: { project_id: "project-1" },
			userId: "user-1",
		});

		expect(result.items).toHaveLength(3);
		expect(tracker.maxInFlight).toBe(1);
	});

	it("respects concurrency: 3 (max-in-flight > 1 and ≤ 3)", async () => {
		setupMcpClientMock();
		const tracker = buildExecuteMock({
			"1": 20,
			"2": 20,
			"3": 20,
			"4": 20,
			"5": 20,
			"6": 20,
		});

		const result = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "project-1",
			externalIds: ["1", "2", "3", "4", "5", "6"],
			additionalContext: { project_id: "project-1" },
			userId: "user-1",
			concurrency: 3,
		});

		expect(result.items).toHaveLength(6);
		expect(tracker.maxInFlight).toBeGreaterThan(1);
		expect(tracker.maxInFlight).toBeLessThanOrEqual(3);
	});

	it("returns empty result without invoking executeMcpTool when externalIds is empty", async () => {
		setupMcpClientMock();
		buildExecuteMock({});

		const result = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "project-1",
			externalIds: [],
			additionalContext: { project_id: "project-1" },
			userId: "user-1",
		});

		expect(result.items).toEqual([]);
		expect(result.total).toBe(0);
		expect(result.failedIds).toEqual([]);
		expect(result.hasNextPage).toBe(false);
		// executeMcpTool should not have been called at all.
		expect(executeMcpTool).not.toHaveBeenCalled();
	});

	it("preserves input order when calls finish out of order", async () => {
		setupMcpClientMock();
		// Reverse latency: id "1" finishes last, id "3" finishes first.
		buildExecuteMock({ "1": 60, "2": 30, "3": 5 });

		const result = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "project-1",
			externalIds: ["1", "2", "3"],
			additionalContext: { project_id: "project-1" },
			userId: "user-1",
			concurrency: 5,
		});

		expect(result.items).toHaveLength(3);
		expect(result.items.map((i) => i.id)).toEqual(["1", "2", "3"]);
	});
});

// =============================================================================
// Jira (Rovo) nests summary/description under `fields` and returns the
// description as ADF. The poll must read those nested fields and flatten the
// ADF — otherwise title falls back to "Work Item N" and description is null, so
// the content-drift hash never matches and every poll flags a phantom conflict.
// =============================================================================

describe("fetchPMItemsByIds — Jira nested fields + ADF description", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("reads fields.summary and flattens the ADF fields.description", async () => {
		setupMcpClientMock();
		vi.mocked(executeMcpTool).mockImplementation(
			async (args) =>
				({
					success: true,
					output: {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									id: Number(
										(args.args as Record<string, unknown>)
											.issue_id ?? 0,
									),
									fields: {
										summary: "Initial Git Setup",
										description: {
											type: "doc",
											version: 1,
											content: [
												{
													type: "heading",
													content: [
														{
															type: "text",
															text: "Big Picture",
														},
													],
												},
												{
													type: "paragraph",
													content: [
														{
															type: "text",
															text: "Set up the repo.",
														},
													],
												},
											],
										},
									},
								}),
							},
						],
					},
					// biome-ignore lint/suspicious/noExplicitAny: test fake
				}) as any,
		);

		const result = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "project-1",
			externalIds: ["1"],
			additionalContext: { project_id: "project-1" },
			userId: "user-1",
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.title).toBe("Initial Git Setup");
		expect(result.items[0]?.description).toBe(
			"Big Picture\n\nSet up the repo.",
		);
	});
});

// =============================================================================
// Fix A (#1360 review): failure classification — only DEFINITE not-found feeds
// missing-detection. Ambiguous/transient/auth/config errors are failedIds only.
// =============================================================================

describe("isPmNotFoundError", () => {
	it("returns true on positive not-found evidence", () => {
		expect(isPmNotFoundError("Work item not found")).toBe(true);
		expect(isPmNotFoundError("The item does not exist")).toBe(true);
		expect(isPmNotFoundError("could not be found")).toBe(true);
		expect(isPmNotFoundError("HTTP 404")).toBe(true);
		// Generic, unambiguous not-found phrases (no permission text).
		expect(isPmNotFoundError("Issue does not exist")).toBe(true);
		expect(isPmNotFoundError("HTTP 404 Not Found")).toBe(true);
		// VS402371 with explicit "does not exist" (no permission text) → true.
		expect(isPmNotFoundError("VS402371: does not exist")).toBe(true);
	});

	it("returns false on ambiguous/transient/auth/empty/null", () => {
		expect(isPmNotFoundError("401 Unauthorized")).toBe(false);
		expect(isPmNotFoundError("rate limit exceeded")).toBe(false);
		expect(isPmNotFoundError("request timeout")).toBe(false);
		expect(isPmNotFoundError("")).toBe(false);
		expect(isPmNotFoundError(null)).toBe(false);
		expect(isPmNotFoundError(undefined)).toBe(false);
	});

	// Permission-ambiguity veto (#1360 review HIGH finding): a message that
	// conflates deletion with no-access is NOT positive deletion evidence, even
	// when it also contains not-found-looking text. The veto must win so a
	// still-valid ticket the caller can't read is never classified as deleted.
	it("vetoes permission/auth ambiguity even with not-found text", () => {
		// ADO's real TF401232 message: "does not exist" AND "do not have
		// permissions" in one string → veto wins → false.
		expect(
			isPmNotFoundError(
				"TF401232: Work item 42 does not exist, or you do not have permissions to read it",
			),
		).toBe(false);
		expect(isPmNotFoundError("No access token found")).toBe(false);
		expect(isPmNotFoundError("No permission found to read work item")).toBe(
			false,
		);
		expect(isPmNotFoundError("403 Forbidden")).toBe(false);
		expect(isPmNotFoundError("401 Unauthorized")).toBe(false);
		// Bare not-found text plus an explicit permission clause → veto wins.
		expect(isPmNotFoundError("Work item not found: access denied")).toBe(
			false,
		);
	});
});

/** executeMcpTool mock that fails the given ids with a specific error message. */
function buildFailingExecuteMock(errorById: Record<string, string>) {
	vi.mocked(executeMcpTool).mockImplementation(async (args) => {
		const id = String(
			(args.args as Record<string, unknown>).issue_id ?? "",
		);
		const err = errorById[id];
		if (err !== undefined) {
			return {
				success: false,
				output: { content: [{ type: "text", text: err }] },
				// biome-ignore lint/suspicious/noExplicitAny: test fake
			} as any;
		}
		return {
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id: Number(id),
							title: `Issue ${id}`,
						}),
					},
				],
			},
			// biome-ignore lint/suspicious/noExplicitAny: test fake
		} as any;
	});
}

describe("fetchPMItemsByIds — failure classification (MCP branch)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("puts a 404-ish MCP failure in BOTH failedIds and notFoundIds", async () => {
		setupMcpClientMock();
		buildFailingExecuteMock({ "2": "Issue not found" });

		const result = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "project-1",
			externalIds: ["1", "2"],
			additionalContext: { project_id: "project-1" },
			userId: "user-1",
		});

		expect(result.items.map((i) => i.id)).toEqual(["1"]);
		expect(result.failedIds).toContain("2");
		expect(result.notFoundIds).toEqual(["2"]);
	});

	it("puts an auth MCP failure in failedIds but NOT notFoundIds", async () => {
		setupMcpClientMock();
		buildFailingExecuteMock({ "2": "401 Unauthorized" });

		const result = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "project-1",
			externalIds: ["1", "2"],
			additionalContext: { project_id: "project-1" },
			userId: "user-1",
		});

		expect(result.failedIds).toContain("2");
		expect(result.notFoundIds).toEqual([]);
	});

	it("returns an empty notFoundIds when all fetches succeed", async () => {
		setupMcpClientMock();
		buildFailingExecuteMock({});

		const result = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "project-1",
			externalIds: ["1", "2"],
			additionalContext: { project_id: "project-1" },
			userId: "user-1",
		});

		expect(result.failedIds).toEqual([]);
		expect(result.notFoundIds).toEqual([]);
	});
});
