import { describe, expect, it, vi } from "vitest";

// Mock @repo/agent-core/backend + @repo/database so importing fetch-pm-hierarchy
// does not load the real packages (vitest #4373) — same pattern as
// fetch-pm-items-structural-not-found.test.ts.
vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	getMcpClientResult: vi.fn(),
	closeMcpClientSafe: vi.fn().mockResolvedValue(undefined),
	getDetailedMcpToolInfo: vi.fn().mockResolvedValue([]),
}));
vi.mock("../src/activities/orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {},
	Prisma: {},
}));

import { parseListResponse } from "../src/activities/pm-integration/fetch-pm-hierarchy";

describe("parseListResponse externalId mapping", () => {
	it("captures the addressable card number for Fizzy, not the internal base36 id", () => {
		// Fizzy returns BOTH an internal base36 `id` and the addressable `number`.
		// The update/get tools resolve by number; capturing the internal id poisons
		// externalId and makes every later push 404 (regression: PM-sync Fizzy pull).
		const output = {
			items: [
				{
					id: "03g8xd7wkev0wsbo39oa0om88",
					number: 1101,
					title: "Pulled Fizzy card",
					url: "https://app.fizzy.do/000000/cards/1101",
				},
			],
		};

		const [item] = parseListResponse(output);

		expect(item.id).toBe("1101");
		expect(item.title).toBe("Pulled Fizzy card");
	});

	it("falls through to id for ADO work items (no number field)", () => {
		const output = {
			workItems: [
				{
					id: 156,
					fields: { "System.Title": "ADO story" },
					url: "https://dev.azure.com/org/_apis/wit/workItems/156",
				},
			],
		};

		const [item] = parseListResponse(output);

		expect(item.id).toBe("156");
		expect(item.title).toBe("ADO story");
	});

	it("unwraps ADO `target` refs and still resolves the id", () => {
		const output = {
			workItems: [{ target: { id: 200, url: "https://example/200" } }],
		};

		const [item] = parseListResponse(output);

		expect(item.id).toBe("200");
	});

	it("prefers issue_number over a non-addressable id (GitHub/GitLab shape)", () => {
		const output = {
			value: [{ id: 99887766, issue_number: 42, title: "Issue" }],
		};

		const [item] = parseListResponse(output);

		expect(item.id).toBe("42");
	});

	it("unwraps a fizzy-mcp 1.1.0 page envelope (`cards`)", () => {
		const output = {
			cards: [
				{
					id: "03g8xd7wkev0wsbo39oa0om88",
					number: 1101,
					title: "Enveloped Fizzy card",
				},
			],
			page: 1,
			total_count: 611,
			has_more: true,
			next_page: 2,
		};

		const items = parseListResponse(output);

		expect(items).toHaveLength(1);
		expect(items[0].id).toBe("1101");
		expect(items[0].title).toBe("Enveloped Fizzy card");
	});

	it("still unwraps the legacy `items` shape", () => {
		const output = { items: [{ number: 7, title: "Legacy shape" }] };

		const items = parseListResponse(output);

		expect(items).toHaveLength(1);
		expect(items[0].id).toBe("7");
		expect(items[0].title).toBe("Legacy shape");
	});
});
