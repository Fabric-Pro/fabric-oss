import { describe, expect, it } from "vitest";
import { resolveMappedStatus } from "../resolve-pm-status";

const projectStatuses = [
	{ id: "s-todo", name: "Backlog" },
	{ id: "s-prog", name: "In Progress" },
	{ id: "s-done", name: "Done" },
];

describe("resolveMappedStatus", () => {
	it("resolves via a mapped label (GitLab)", () => {
		expect(
			resolveMappedStatus({
				labels: ["type::bug", "workflow::in-progress"],
				statusString: null,
				labelStatusMap: { "workflow::in-progress": "s-prog" },
				statusColumnMap: {},
				projectStatuses,
			}),
		).toEqual({ kind: "matched", statusId: "s-prog", via: "label" });
	});

	it("resolves via the inverted statusColumnMap (Fizzy)", () => {
		expect(
			resolveMappedStatus({
				labels: [],
				statusString: "col-42",
				labelStatusMap: {},
				statusColumnMap: { "s-done": "col-42" },
				projectStatuses,
			}),
		).toEqual({ kind: "matched", statusId: "s-done", via: "column-map" });
	});

	it("resolves via a case-insensitive name match (ADO/Jira)", () => {
		expect(
			resolveMappedStatus({
				labels: [],
				statusString: "  in progress  ",
				labelStatusMap: {},
				statusColumnMap: {},
				projectStatuses,
			}),
		).toEqual({ kind: "matched", statusId: "s-prog", via: "name" });
	});

	it("prefers a label match over a name match", () => {
		expect(
			resolveMappedStatus({
				labels: ["workflow::done"],
				statusString: "In Progress",
				labelStatusMap: { "workflow::done": "s-done" },
				statusColumnMap: {},
				projectStatuses,
			}),
		).toEqual({ kind: "matched", statusId: "s-done", via: "label" });
	});

	it("returns conflict when two labels map to two statuses", () => {
		const result = resolveMappedStatus({
			labels: ["workflow::todo", "workflow::done"],
			statusString: null,
			labelStatusMap: {
				"workflow::todo": "s-todo",
				"workflow::done": "s-done",
			},
			statusColumnMap: {},
			projectStatuses,
		});
		expect(result.kind).toBe("conflict");
		if (result.kind === "conflict") {
			expect(result.statusIds.sort()).toEqual(["s-done", "s-todo"]);
			expect(result.labels.sort()).toEqual([
				"workflow::done",
				"workflow::todo",
			]);
		}
	});

	it("returns none when a label maps to a deleted status", () => {
		expect(
			resolveMappedStatus({
				labels: ["workflow::gone"],
				statusString: null,
				labelStatusMap: { "workflow::gone": "s-deleted" },
				statusColumnMap: {},
				projectStatuses,
			}),
		).toEqual({ kind: "none" });
	});

	it("returns none when nothing matches", () => {
		expect(
			resolveMappedStatus({
				labels: ["type::bug"],
				statusString: "Something Else",
				labelStatusMap: {},
				statusColumnMap: {},
				projectStatuses,
			}),
		).toEqual({ kind: "none" });
	});

	it("returns none for an empty status string", () => {
		expect(
			resolveMappedStatus({
				labels: [],
				statusString: "",
				labelStatusMap: {},
				statusColumnMap: {},
				projectStatuses,
			}),
		).toEqual({ kind: "none" });
	});
});
