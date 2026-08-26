/**
 * The generator was a hand-written switch covering 12 of ~68 node types, and
 * for most of those it emitted a comment rather than the operation
 * (`results["x"] = { title: "..." }`). Anything unrecognised fell through to a
 * bare "Unknown node type" line — so a workflow built from the integrations
 * that make up most of the palette generated essentially nothing.
 *
 * It now walks the saved graph, so coverage is automatic. These pin the
 * properties that make the output trustworthy: every node appears, in
 * dependency order, with its real config and its data flow resolved.
 */

import { describe, expect, it } from "vitest";
import {
	type CodegenNode,
	generateWorkflowCode,
	sanitizeFilename,
	topologicalOrder,
} from "../workflow-codegen";

function node(
	id: string,
	type: string,
	label?: string,
	config: Record<string, unknown> = {},
	enabled?: boolean,
): CodegenNode {
	return { id, type, data: { label, config, enabled } };
}
function edge(source: string, target: string) {
	return { id: `${source}->${target}`, source, target };
}

describe("generateWorkflowCode", () => {
	it("covers node types the old switch never knew about", () => {
		const code = generateWorkflowCode(
			"Ops",
			[
				node("a", "jira-create-issue", "File Bug", { summary: "x" }),
				node("b", "zendesk-search-tickets", "Find Tickets"),
				node("c", "asana-create-task", "Make Task"),
			],
			[edge("a", "b"), edge("b", "c")],
		);

		expect(code).toContain("jira-create-issue");
		expect(code).toContain("zendesk-search-tickets");
		expect(code).toContain("asana-create-task");
		expect(code).not.toContain("Unknown node type");
	});

	it("emits every node exactly once, in dependency order", () => {
		const code = generateWorkflowCode(
			"Chain",
			[
				node("a", "trigger", "Start"),
				node("b", "http-request", "Fetch"),
				node("c", "slack-send", "Notify"),
			],
			[edge("a", "b"), edge("b", "c")],
		);

		expect(code.indexOf("const start")).toBeLessThan(
			code.indexOf("const fetch"),
		);
		expect(code.indexOf("const fetch")).toBeLessThan(
			code.indexOf("const notify"),
		);
		expect(code.match(/const fetch =/g)).toHaveLength(1);
	});

	it("carries each node's real configuration", () => {
		const code = generateWorkflowCode(
			"Cfg",
			[node("a", "slack-send", "Notify", { slackChannel: "#ops" })],
			[],
		);

		expect(code).toContain('"slackChannel": "#ops"');
	});

	it("resolves {{Node.field}} references to the producing step", () => {
		const code = generateWorkflowCode(
			"Flow",
			[
				node("a", "firecrawl-scrape", "Scrape", { url: "https://x" }),
				node("b", "slack-send", "Notify", {
					slackMessage: "Got {{Scrape.markdown}}",
				}),
			],
			[edge("a", "b")],
		);

		expect(code).toContain("uses: Scrape.markdown  ->  scrape.markdown");
	});

	it("flags a reference to a node that does not exist", () => {
		const code = generateWorkflowCode(
			"Broken",
			[node("a", "slack-send", "Notify", { msg: "{{Ghost.value}}" })],
			[],
		);

		expect(code).toContain("unresolved");
	});

	it("records a disabled node without calling it", () => {
		const code = generateWorkflowCode(
			"Partly",
			[
				node("a", "trigger", "Start"),
				node("b", "slack-send", "Notify", {}, false),
			],
			[edge("a", "b")],
		);

		expect(code).toContain("DISABLED");
		expect(code).toContain("// const notify =");
		expect(code).not.toMatch(/^ {2}const notify =/m);
	});

	it("notes what each step depends on", () => {
		const code = generateWorkflowCode(
			"Deps",
			[node("a", "trigger", "Start"), node("b", "http-request", "Fetch")],
			[edge("a", "b")],
		);

		expect(code).toContain("depends on: start");
	});

	it("gives colliding labels distinct identifiers", () => {
		const code = generateWorkflowCode(
			"Dupes",
			[
				node("a", "slack-send", "Notify"),
				node("b", "slack-send", "Notify"),
			],
			[],
		);

		expect(code).toContain("const notify =");
		expect(code).toContain("const notify_2 =");
	});

	it("ignores canvas placeholder nodes", () => {
		const code = generateWorkflowCode(
			"Placeholders",
			[
				node("a", "trigger", "Start"),
				node("p", "add"),
				node("e", "empty-action"),
			],
			[],
		);

		expect(code).not.toContain('"add"');
		expect(code).not.toContain("empty-action");
	});

	it("handles an empty workflow without producing broken code", () => {
		const code = generateWorkflowCode("Empty", [], []);

		expect(code).toContain("no steps yet");
	});

	it("says plainly that it is a scaffold", () => {
		// The old output looked like a program and did nothing. Whatever else
		// changes, the header must not let a reader assume it runs.
		const code = generateWorkflowCode(
			"Any",
			[node("a", "trigger", "Start")],
			[],
		);

		expect(code).toContain("SCAFFOLD");
	});
});

describe("topologicalOrder", () => {
	it("orders a diamond so the join comes last", () => {
		const nodes = [
			node("a", "trigger"),
			node("b", "http-request"),
			node("c", "http-request"),
			node("d", "slack-send"),
		];
		const order = topologicalOrder(nodes, [
			edge("a", "b"),
			edge("a", "c"),
			edge("b", "d"),
			edge("c", "d"),
		]).map((n) => n.id);

		expect(order[0]).toBe("a");
		expect(order.at(-1)).toBe("d");
	});

	it("drops no node when the graph has a cycle", () => {
		const nodes = [node("a", "x"), node("b", "y"), node("c", "z")];
		const order = topologicalOrder(nodes, [
			edge("a", "b"),
			edge("b", "c"),
			edge("c", "b"),
		]);

		expect(order.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
	});
});

describe("sanitizeFilename", () => {
	it("makes a safe slug", () => {
		expect(sanitizeFilename("My Workflow!")).toBe("my-workflow");
	});

	it("falls back rather than returning an empty name", () => {
		expect(sanitizeFilename("!!!")).toBe("workflow");
	});
});
