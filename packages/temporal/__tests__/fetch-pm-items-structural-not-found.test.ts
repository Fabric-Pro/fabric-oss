import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/agent-core/backend + @repo/database so importing story-sync does
// not load the real packages (vitest #4373) — same pattern as
// fetch-pm-items-by-ids-concurrency.test.ts.
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
vi.mock("../src/activities/orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));
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
	extractMcpErrorText,
	fetchPMItemsByIds,
	hasUsablePmContent,
	isStructurallyAbsentPmResponse,
} from "../src/activities/pm-integration/story-sync";

describe("hasUsablePmContent", () => {
	it("is true for any real title/description/url source", () => {
		expect(hasUsablePmContent({ fields: { "System.Title": "X" } })).toBe(
			true,
		);
		expect(hasUsablePmContent({ fields: { summary: "X" } })).toBe(true);
		expect(hasUsablePmContent({ title: "X" })).toBe(true);
		expect(hasUsablePmContent({ name: "X" })).toBe(true);
		expect(hasUsablePmContent({ description: "d" })).toBe(true);
		// a non-empty ADF doc flattens to real text → content.
		expect(
			hasUsablePmContent({
				fields: {
					description: {
						type: "doc",
						content: [
							{
								type: "paragraph",
								content: [{ type: "text", text: "Hi" }],
							},
						],
					},
				},
			}),
		).toBe(true);
		expect(hasUsablePmContent({ url: "u" })).toBe(true);
		expect(hasUsablePmContent({ _links: { html: { href: "u" } } })).toBe(
			true,
		);
		// content-wins: a sentinel does not demote a live item.
		expect(hasUsablePmContent({ id: "1", title: "X", found: false })).toBe(
			true,
		);
	});

	it("is false for bare identity/state, empties, and unknown shapes", () => {
		expect(hasUsablePmContent({ id: "1" })).toBe(false);
		expect(hasUsablePmContent({ key: "PROJ-1" })).toBe(false);
		expect(hasUsablePmContent({ id: "1", state: "Closed" })).toBe(false);
		expect(hasUsablePmContent({})).toBe(false);
		expect(hasUsablePmContent({ randomFlag: true })).toBe(false);
		expect(hasUsablePmContent({ found: false })).toBe(false);
		expect(hasUsablePmContent({ title: "" })).toBe(false); // empty string not content
		// empty ADF doc / non-ADF object → descriptionToText yields no text (Codex plan-R1).
		expect(hasUsablePmContent({ fields: { description: {} } })).toBe(false);
		expect(
			hasUsablePmContent({ fields: { description: { type: "doc" } } }),
		).toBe(false);
		expect(hasUsablePmContent(null)).toBe(false);
		expect(hasUsablePmContent([])).toBe(false);
		expect(hasUsablePmContent("string")).toBe(false);
	});
});

describe("isStructurallyAbsentPmResponse", () => {
	it("is true for contract-safe absent signals", () => {
		expect(isStructurallyAbsentPmResponse({ found: false })).toBe(true);
		expect(isStructurallyAbsentPmResponse({ exists: false })).toBe(true);
		expect(
			isStructurallyAbsentPmResponse({ error: "Issue does not exist" }),
		).toBe(true);
		expect(
			isStructurallyAbsentPmResponse({
				errorMessages: ["Issue does not exist"],
			}),
		).toBe(true);
		expect(
			isStructurallyAbsentPmResponse({
				errorMessages: "Issue does not exist",
			}),
		).toBe(true);
		expect(isStructurallyAbsentPmResponse({ error: "HTTP 404" })).toBe(
			true,
		);
		// id-echoed absence (bare id is not content) still resolves to absent.
		expect(
			isStructurallyAbsentPmResponse({ id: "123", found: false }),
		).toBe(true);
	});

	it("is false for bare empty / generic / raw-text shapes (ambiguous)", () => {
		expect(isStructurallyAbsentPmResponse(null)).toBe(false);
		expect(isStructurallyAbsentPmResponse([])).toBe(false);
		expect(isStructurallyAbsentPmResponse({})).toBe(false);
		expect(isStructurallyAbsentPmResponse("unparseable string")).toBe(
			false,
		);
		expect(
			isStructurallyAbsentPmResponse({ message: "404 not found" }),
		).toBe(false); // message is not a dedicated error field
		expect(
			isStructurallyAbsentPmResponse({ message: "not found page bug" }),
		).toBe(false);
		expect(
			isStructurallyAbsentPmResponse({ detail: "issue does not exist" }),
		).toBe(false);
		// raw unparsed envelope text is never an absent signal (Codex R3).
		expect(
			isStructurallyAbsentPmResponse({
				content: [{ type: "text", text: "Issue 123 not found" }],
			}),
		).toBe(false);
		// real ticket whose title contains "not found" → content field, not error.
		expect(isStructurallyAbsentPmResponse({ title: "not found" })).toBe(
			false,
		);
		expect(
			isStructurallyAbsentPmResponse({ id: "123", title: "Real ticket" }),
		).toBe(false);
	});

	it("globally vetoes permission/auth ambiguity before any absent classification", () => {
		// dedicated error field with both not-found and permission text → veto wins.
		expect(
			isStructurallyAbsentPmResponse({
				error: "not found — or you do not have permissions",
			}),
		).toBe(false);
		expect(
			isStructurallyAbsentPmResponse({
				errorMessages: ["403 forbidden"],
			}),
		).toBe(false);
		// sentinel + permission text → veto governs the sentinel (Codex R6).
		expect(
			isStructurallyAbsentPmResponse({
				found: false,
				error: "403 forbidden",
			}),
		).toBe(false);
		expect(
			isStructurallyAbsentPmResponse({
				exists: false,
				message: "not authorized",
			}),
		).toBe(false);
		// permission text in a NESTED carrier → recursive veto (Codex R7).
		expect(
			isStructurallyAbsentPmResponse({
				found: false,
				errors: [{ message: "403 forbidden" }],
			}),
		).toBe(false);
		expect(
			isStructurallyAbsentPmResponse({
				exists: false,
				errors: ["access denied"],
			}),
		).toBe(false);
		expect(
			isStructurallyAbsentPmResponse({
				found: false,
				meta: { note: "401 unauthorized" },
			}),
		).toBe(false);
		// truncation fail-closed (Codex plan-R2): a permission string nested
		// deeper than PM_VETO_MAX_DEPTH (6) is not scanned, so the sentinel must
		// NOT classify the item as absent.
		expect(
			isStructurallyAbsentPmResponse({
				found: false,
				l1: {
					l2: { l3: { l4: { l5: { l6: { l7: "403 forbidden" } } } } },
				},
			}),
		).toBe(false);
		// node-budget truncation fail-closed + BOUNDED traversal (Codex plan-R3/R4):
		// a payload wider than PM_VETO_MAX_NODES (200) truncates the scan AND the
		// loops break early — a tripwire getter placed past the cap is never read.
		let tripped = 0;
		const wide: unknown[] = Array.from({ length: 300 }, () => ({}));
		Object.defineProperty(wide, 250, {
			enumerable: true,
			get() {
				tripped++;
				return {};
			},
		});
		expect(
			isStructurallyAbsentPmResponse({ found: false, pad: wide }),
		).toBe(false);
		expect(tripped).toBe(0); // loop stopped before index 250 → genuinely bounded
	});
});

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
	const mockClient = { tools: vi.fn().mockResolvedValue(GITLAB_TOOLS) };
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
}

/**
 * executeMcpTool mock that returns a SUCCESS whose body for each id is the
 * given value, wrapped in the MCP `content[].text` envelope. Objects are
 * JSON-stringified (so the real code parses them back); raw strings are passed
 * through verbatim (so JSON.parse fails and the envelope is kept — the raw-text
 * case).
 */
function buildSuccessExecuteMock(bodyById: Record<string, unknown>) {
	vi.mocked(executeMcpTool).mockImplementation(async (args) => {
		const id = String(
			(args.args as Record<string, unknown>).issue_id ?? "",
		);
		const body = bodyById[id];
		const text = typeof body === "string" ? body : JSON.stringify(body);
		return {
			success: true,
			output: { content: [{ type: "text", text }] },
			// biome-ignore lint/suspicious/noExplicitAny: test fake
		} as any;
	});
}

describe("fetchPMItemsByIds — structural not-found (success branch)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("routes a dedicated-error absence to BOTH notFoundIds and failedIds, no phantom", async () => {
		setupMcpClientMock();
		buildSuccessExecuteMock({
			"1": { id: 1, title: "Issue 1" },
			"2": { error: "Issue does not exist" },
		});
		const r = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "p1",
			externalIds: ["1", "2"],
			additionalContext: { project_id: "p1" },
			userId: "u1",
		});
		expect(r.items.map((i) => i.id)).toEqual(["1"]);
		expect(r.notFoundIds).toEqual(["2"]);
		expect(r.failedIds).toContain("2"); // invariant: notFoundIds ⊆ failedIds
	});

	it("routes explicit found:false / id-echo / exists:false sentinels to notFoundIds", async () => {
		setupMcpClientMock();
		buildSuccessExecuteMock({
			"1": { found: false },
			"2": { id: 2, found: false },
			"3": { key: "K-3", exists: false },
		});
		const r = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "p1",
			externalIds: ["1", "2", "3"],
			additionalContext: { project_id: "p1" },
			userId: "u1",
		});
		expect(r.items).toHaveLength(0);
		expect(r.notFoundIds?.sort()).toEqual(["1", "2", "3"]);
		for (const id of ["1", "2", "3"]) {
			expect(r.failedIds).toContain(id);
		}
	});

	it("content wins: a live item with a found:false flag is built, not flagged", async () => {
		setupMcpClientMock();
		buildSuccessExecuteMock({
			"1": { id: 1, title: "Live", found: false },
		});
		const r = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "p1",
			externalIds: ["1"],
			additionalContext: { project_id: "p1" },
			userId: "u1",
		});
		expect(r.items.map((i) => i.id)).toEqual(["1"]);
		expect(r.notFoundIds).toEqual([]);
	});

	it("routes bare-empty and message/detail-only successes to failedIds only (ambiguous)", async () => {
		setupMcpClientMock();
		buildSuccessExecuteMock({
			"1": {},
			"2": { message: "not found page bug" },
			"3": { detail: "x not found" },
		});
		const r = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "p1",
			externalIds: ["1", "2", "3"],
			additionalContext: { project_id: "p1" },
			userId: "u1",
		});
		expect(r.items).toHaveLength(0);
		expect(r.notFoundIds).toEqual([]);
		for (const id of ["1", "2", "3"]) {
			expect(r.failedIds).toContain(id);
		}
	});

	it("sentinel + permission text → failedIds only, never notFoundIds (global veto + truncation)", async () => {
		setupMcpClientMock();
		buildSuccessExecuteMock({
			"1": { found: false, error: "403 forbidden" },
			"2": { found: false, errors: [{ message: "403 forbidden" }] },
			// permission text nested beyond the veto depth cap → truncation
			// fail-closed must keep it out of notFoundIds (Codex plan-R2).
			"3": {
				found: false,
				l1: {
					l2: { l3: { l4: { l5: { l6: { l7: "403 forbidden" } } } } },
				},
			},
			// wide payload (no permission text) that exceeds the node cap →
			// truncation fail-closed keeps the sentinel out of notFoundIds (plan-R3).
			"4": { found: false, pad: Array.from({ length: 250 }, () => ({})) },
		});
		const r = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "p1",
			externalIds: ["1", "2", "3", "4"],
			additionalContext: { project_id: "p1" },
			userId: "u1",
		});
		expect(r.notFoundIds).toEqual([]);
		for (const id of ["1", "2", "3", "4"]) {
			expect(r.failedIds).toContain(id);
		}
	});

	it("raw text containing 'not found' is ambiguous → failedIds, never notFoundIds", async () => {
		setupMcpClientMock();
		// Raw non-JSON string: JSON.parse fails, the envelope is kept.
		buildSuccessExecuteMock({ "1": "Issue 1 not found page bug" });
		const r = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "p1",
			externalIds: ["1"],
			additionalContext: { project_id: "p1" },
			userId: "u1",
		});
		expect(r.notFoundIds).toEqual([]);
		expect(r.failedIds).toContain("1");
	});

	it("carries workItemType so selective pull can reverse-map kind (#1305)", async () => {
		setupMcpClientMock();
		buildSuccessExecuteMock({
			"1": {
				id: 1,
				fields: {
					"System.Title": "A bug",
					"System.WorkItemType": "Bug",
				},
			},
		});
		const r = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "p1",
			externalIds: ["1"],
			additionalContext: { project_id: "p1" },
			userId: "u1",
		});
		expect(r.items).toHaveLength(1);
		expect(r.items[0].workItemType).toBe("Bug");
	});
});

describe("extractMcpErrorText", () => {
	it("reads MCP isError content text", () => {
		expect(
			extractMcpErrorText({
				content: [{ type: "text", text: "boom" }],
				isError: true,
			}),
		).toBe("boom");
	});
	it("reads the executeMcpTool {error} catch shape", () => {
		expect(extractMcpErrorText({ error: "Resource not found: x" })).toBe(
			"Resource not found: x",
		);
	});
	it("falls back to String for other shapes", () => {
		expect(extractMcpErrorText("plain")).toBe("plain");
		expect(extractMcpErrorText(null)).toBe("");
		expect(extractMcpErrorText(undefined)).toBe("");
	});
});

function buildFailureExecuteMock(errorById: Record<string, string>) {
	vi.mocked(executeMcpTool).mockImplementation(async (args) => {
		const id = String(
			(args.args as Record<string, unknown>).issue_id ?? "",
		);
		return {
			success: false,
			output: { error: errorById[id] },
			// biome-ignore lint/suspicious/noExplicitAny: test fake
		} as any;
	});
}

describe("fetchPMItemsByIds — failure branch {error} unwrap (#1360 Fizzy delete)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("classifies a JSON-RPC not-found error (output.error) as notFound", async () => {
		setupMcpClientMock();
		buildFailureExecuteMock({
			"1": "MCP error -32603: Resource not found: https://app.fizzy.do/000000/cards/1",
		});
		const r = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "p1",
			externalIds: ["1"],
			additionalContext: { project_id: "p1" },
			userId: "u1",
		});
		expect(r.notFoundIds).toEqual(["1"]);
		expect(r.failedIds).toContain("1");
		// regression: the message reaches failedIdErrors, NOT "[object Object]"
		expect(r.failedIdErrors?.["1"]).toContain("Resource not found");
	});

	it("does NOT classify an auth error as notFound (permission veto holds)", async () => {
		setupMcpClientMock();
		buildFailureExecuteMock({
			"1": "MCP error -32603: 403 Forbidden",
		});
		const r = await fetchPMItemsByIds({
			mcpConfigId: "mcp-1",
			containerId: "p1",
			externalIds: ["1"],
			additionalContext: { project_id: "p1" },
			userId: "u1",
		});
		expect(r.notFoundIds).toEqual([]);
		expect(r.failedIds).toContain("1");
	});
});
