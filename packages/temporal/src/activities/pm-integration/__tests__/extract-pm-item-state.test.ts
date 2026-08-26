import { describe, expect, it } from "vitest";
import { normalizePolledState } from "../extract-pm-item-state";
import type { PMWorkItemSummary } from "../story-sync";
import { extractChangedDate } from "../story-sync";

describe("extractChangedDate", () => {
	it("reads ADO System.ChangedDate from fields", () => {
		const d = extractChangedDate(
			{},
			{ "System.ChangedDate": "2026-05-01T00:00:00Z" },
		);
		expect(d?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
	});

	it("reads generic updated_at / updatedAt from the record", () => {
		expect(
			extractChangedDate(
				{ updated_at: "2026-05-02T00:00:00Z" },
				undefined,
			)?.toISOString(),
		).toBe("2026-05-02T00:00:00.000Z");
		expect(
			extractChangedDate(
				{ updatedAt: "2026-05-03T00:00:00Z" },
				undefined,
			)?.toISOString(),
		).toBe("2026-05-03T00:00:00.000Z");
	});

	it("returns null when absent or unparseable", () => {
		expect(extractChangedDate({}, undefined)).toBeNull();
		expect(
			extractChangedDate({ updated_at: "not-a-date" }, undefined),
		).toBeNull();
	});

	it("reads Fizzy last_active_at as a fallback", () => {
		expect(
			extractChangedDate(
				{ last_active_at: "2026-06-01T00:00:00Z" },
				undefined,
			)?.toISOString(),
		).toBe("2026-06-01T00:00:00.000Z");
	});
});

function item(
	raw: Record<string, unknown>,
	over: Partial<PMWorkItemSummary> = {},
): PMWorkItemSummary {
	return { id: "1", title: "T", description: "D", raw, ...over };
}

describe("normalizePolledState", () => {
	it("MCP/ADO: reads System.State + System.ChangedDate", () => {
		const n = normalizePolledState(
			item({
				fields: {
					"System.State": "Closed",
					"System.ChangedDate": "2026-05-01T00:00:00Z",
				},
			}),
			{ kind: "mcp" },
		);
		expect(n.statusString).toBe("Closed");
		expect(n.isClosed).toBeNull();
		expect(n.labels).toEqual([]);
		expect(n.changedDate?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
	});

	it("MCP/generic: reads generic status when no provider-specific branch applies", () => {
		const n = normalizePolledState(
			item({ status: "Done", updated_at: "2026-05-02T00:00:00Z" }),
			{ kind: "mcp" },
		);
		expect(n.statusString).toBe("Done");
		expect(n.changedDate?.toISOString()).toBe("2026-05-02T00:00:00.000Z");
	});

	it("MCP/Jira: reads fields.status.name", () => {
		const n = normalizePolledState(
			item({ fields: { status: { name: "In Review" } } }),
			{ kind: "mcp" },
		);
		expect(n.statusString).toBe("In Review");
	});

	it("rest-gitlab: isClosed from state, labels surfaced, no status string", () => {
		const n = normalizePolledState(
			item({
				state: "closed",
				labels: ["Done", "backend"],
				updatedAt: "2026-05-03T00:00:00Z",
			}),
			{ kind: "rest-gitlab" },
		);
		expect(n.statusString).toBeNull();
		expect(n.isClosed).toBe(true);
		expect(n.labels).toEqual(["Done", "backend"]);
		expect(n.changedDate?.toISOString()).toBe("2026-05-03T00:00:00.000Z");
	});

	it("rest-gitlab: open issue → isClosed false", () => {
		const n = normalizePolledState(item({ state: "opened", labels: [] }), {
			kind: "rest-gitlab",
		});
		expect(n.isClosed).toBe(false);
	});

	it("empty payload → all-null, no terminal signal", () => {
		const n = normalizePolledState(item({}), { kind: "mcp" });
		expect(n.statusString).toBeNull();
		expect(n.isClosed).toBeNull();
		expect(n.labels).toEqual([]);
		expect(n.changedDate).toBeNull();
	});
});

describe("normalizePolledState — Fizzy (#1360)", () => {
	it("closed card → isClosed:true, statusString from column.name", () => {
		const n = normalizePolledState(
			item({
				closed: true,
				status: "published",
				column: { name: "QA/ Review" },
				last_active_at: "2026-06-01T00:00:00Z",
			}),
			{ kind: "mcp", pmTool: "fizzy" },
		);
		expect(n.isClosed).toBe(true);
		expect(n.statusString).toBe("QA/ Review");
		expect(n.changedDate?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
	});

	it("open card → isClosed:false, statusString from column.name", () => {
		const n = normalizePolledState(
			item({
				closed: false,
				status: "published",
				column: { name: "To do" },
			}),
			{ kind: "mcp", pmTool: "fizzy" },
		);
		expect(n.isClosed).toBe(false);
		expect(n.statusString).toBe("To do");
	});

	it("no column → statusString falls back to status enum", () => {
		const n = normalizePolledState(
			item({ closed: true, status: "archived" }),
			{ kind: "mcp", pmTool: "fizzy" },
		);
		expect(n.isClosed).toBe(true);
		expect(n.statusString).toBe("archived");
	});

	it("empty column name → statusString falls back to status enum", () => {
		const n = normalizePolledState(
			item({ closed: true, status: "archived", column: { name: "" } }),
			{ kind: "mcp", pmTool: "fizzy" },
		);
		expect(n.isClosed).toBe(true);
		expect(n.statusString).toBe("archived");
	});

	it("non-boolean closed → isClosed:null", () => {
		const n = normalizePolledState(
			item({ status: "published", column: { name: "To do" } }),
			{ kind: "mcp", pmTool: "fizzy" },
		);
		expect(n.isClosed).toBeNull();
	});

	it("regression: non-Fizzy MCP ignores `closed`, isClosed stays null", () => {
		const n = normalizePolledState(item({ closed: true, status: "Done" }), {
			kind: "mcp",
			pmTool: "azure-devops",
		});
		expect(n.isClosed).toBeNull();
		expect(n.statusString).toBe("Done");
	});
});
