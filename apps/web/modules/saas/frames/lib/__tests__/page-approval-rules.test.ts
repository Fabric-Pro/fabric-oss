import { describe, expect, it } from "vitest";
import {
	askModeFor,
	createPageTaint,
	declaresStoreTools,
	taintsPage,
} from "../page-approval-rules";

function decide(
	name: string,
	overrides: Partial<Parameters<typeof askModeFor>[0]> = {},
) {
	return askModeFor({
		name,
		args: {},
		readOnly: false,
		tainted: false,
		declaresStoreTools: false,
		confirmEveryCall: false,
		...overrides,
	});
}

function ask(
	name: string,
	overrides: Partial<Parameters<typeof askModeFor>[0]> = {},
) {
	return decide(name, overrides).mode;
}

describe("askModeFor", () => {
	it("never asks about a tool that only reads", () => {
		expect(ask("fabric_list_workflows", { readOnly: true })).toBe("never");
	});

	it("asks once about any other tool", () => {
		expect(ask("fabric_execute_workflow")).toBe("once");
	});

	it.each(["fabric_page_ask", "fabric_page_read_connected"])(
		"asks once about %s even when the tool list calls it a read",
		(name) => {
			expect(ask(name, { readOnly: true })).toBe("once");
		},
	);

	it("asks once about a write to the page's data, and never about reading it", () => {
		expect(ask("fabric_page_data_set", { declaresStoreTools: true })).toBe(
			"once",
		);
		expect(
			ask("fabric_page_data_list", {
				readOnly: true,
				declaresStoreTools: true,
			}),
		).toBe("never");
	});

	it("asks on every other write from a page that keeps data", () => {
		expect(
			ask("fabric_execute_workflow", { declaresStoreTools: true }),
		).toBe("every");
	});

	it.each([
		["fabric_page_data_set", { records: [{ key: "a", value: 1 }] }],
		["fabric_page_data_delete", { keys: ["a"] }],
		["fabric_page_file_upload", {}],
		["fabric_page_file_delete", {}],
	])(
		"asks on every call to %s once the page has read outside its store",
		(name, args) => {
			expect(
				ask(name, { args, tainted: true, declaresStoreTools: true }),
			).toBe("every");
		},
	);

	it.each([
		["a story", "fabric_create_story"],
		["a workflow run", "fabric_execute_workflow"],
		["a comment", "fabric_page_comment_add"],
		["an unknown tool", "fabric_something_new"],
	])(
		"asks on every call to change %s once the page has read outside its store, whatever it declares",
		(_label, name) => {
			for (const declares of [true, false]) {
				expect(
					ask(name, { tainted: true, declaresStoreTools: declares }),
				).toBe("every");
			}
			expect(ask(name, { tainted: false })).not.toBe("every");
		},
	);

	it.each(["fabric_page_ask", "fabric_page_read_connected"])(
		"asks on every call to %s once the page is tainted, though it asks once before",
		(name) => {
			expect(ask(name)).toBe("once");
			expect(ask(name, { tainted: true })).toBe("every");
			expect(ask(name, { tainted: true, readOnly: true })).toBe("every");
		},
	);

	it("still never asks about a plain read once tainted, in its own store or beyond", () => {
		expect(
			ask("fabric_list_workflows", { readOnly: true, tainted: true }),
		).toBe("never");
		expect(
			ask("fabric_get_page_viewer", { readOnly: true, tainted: true }),
		).toBe("never");
	});

	it("does not ask more than usual about reading the page's own store once tainted", () => {
		expect(
			ask("fabric_page_data_list", {
				readOnly: true,
				tainted: true,
				declaresStoreTools: true,
			}),
		).toBe("never");
	});

	it("keeps asking once about a record the viewer keeps for themselves, tainted or not", () => {
		const mine = { records: [{ key: "@me", value: 1, scope: "mine" }] };

		expect(
			ask("fabric_page_data_set", {
				args: mine,
				tainted: true,
				declaresStoreTools: true,
			}),
		).toBe("once");
	});

	it("asks on every call when any record in the batch is shared", () => {
		const mixed = {
			records: [
				{ key: "@me", value: 1, scope: "mine" },
				{ key: "all", value: 2 },
			],
		};

		expect(
			ask("fabric_page_data_set", {
				args: mixed,
				tainted: true,
				declaresStoreTools: true,
			}),
		).toBe("every");
	});

	it("treats a batch that is not a list of records as shared, so nothing slips past as the viewer's own", () => {
		for (const records of ["mine", null, [null], [["mine"]], undefined]) {
			expect(
				ask("fabric_page_data_set", {
					args: { records },
					tainted: true,
					declaresStoreTools: true,
				}),
			).toBe("every");
		}
	});

	it("says why it asks on every call: the page read outside itself, it keeps data, or the tool asks", () => {
		expect(decide("fabric_execute_workflow", { tainted: true })).toEqual({
			mode: "every",
			because: "tainted",
		});
		expect(
			decide("fabric_execute_workflow", { declaresStoreTools: true }),
		).toEqual({ mode: "every", because: "keeps-data" });
		expect(
			decide("fabric_execute_workflow", { confirmEveryCall: true }),
		).toEqual({ mode: "every", because: "confirm" });
		expect(decide("fabric_execute_workflow")).toEqual({ mode: "once" });
	});

	it("asks on every call when the tool's definition says to, even for a read and for a viewer's own record", () => {
		expect(
			ask("fabric_list_workflows", {
				readOnly: true,
				confirmEveryCall: true,
			}),
		).toBe("every");
		expect(
			ask("fabric_page_data_set", {
				args: { records: [{ key: "@me", value: 1, scope: "mine" }] },
				tainted: true,
				declaresStoreTools: true,
				confirmEveryCall: true,
			}),
		).toBe("every");
	});

	it("names the page's reading, not the tool, when both hold", () => {
		expect(
			decide("fabric_execute_workflow", {
				tainted: true,
				confirmEveryCall: true,
			}).because,
		).toBe("tainted");
	});
});

describe("taintsPage", () => {
	it.each([
		"fabric_get_page_viewer",
		"fabric_page_read_connected",
		"fabric_page_ask",
	])(
		"takes the page to have seen more than its own once it has called %s",
		(name) => {
			expect(taintsPage(name, true)).toBe(true);
			expect(taintsPage(name, false)).toBe(true);
		},
	);

	it("takes a page to have seen more than its own once it reads any other Fabric data", () => {
		expect(taintsPage("fabric_list_workflows", true)).toBe(true);
	});

	it("does not when it writes, or reads only what it keeps itself", () => {
		expect(taintsPage("fabric_execute_workflow", false)).toBe(false);
		expect(taintsPage("fabric_page_data_list", true)).toBe(false);
		expect(taintsPage("fabric_page_file_read", true)).toBe(false);
		expect(taintsPage("fabric_page_comment_list", true)).toBe(false);
		expect(taintsPage("fabric_page_data_set", false)).toBe(false);
	});
});

describe("declaresStoreTools", () => {
	it("is true when any tool that keeps the page's data is declared", () => {
		expect(
			declaresStoreTools(
				new Set(["fabric_list_workflows", "fabric_page_comment_list"]),
			),
		).toBe(true);
	});

	it("is false for a page that declares none, a connected read and the viewer included", () => {
		expect(
			declaresStoreTools(
				new Set([
					"fabric_list_workflows",
					"fabric_get_page_viewer",
					"fabric_page_ask",
					"connected:linear/list_issues",
				]),
			),
		).toBe(false);
	});
});

describe("createPageTaint", () => {
	it("starts clean, and stays marked once marked", () => {
		const taint = createPageTaint();

		expect(taint.isTainted()).toBe(false);
		taint.mark();
		taint.mark();

		expect(taint.isTainted()).toBe(true);
	});

	it("is the page's own: marking one leaves another clean", () => {
		const first = createPageTaint();
		const second = createPageTaint();

		first.mark();

		expect(second.isTainted()).toBe(false);
	});

	it("outlives a reload of the same page for the browser session, as its allows do", () => {
		window.sessionStorage.clear();
		createPageTaint("page-a").mark();

		expect(createPageTaint("page-a").isTainted()).toBe(true);
		expect(createPageTaint("page-b").isTainted()).toBe(false);
		window.sessionStorage.clear();
	});
});
