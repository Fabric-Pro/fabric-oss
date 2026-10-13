/**
 * The pure half of discovery mode: parsing `?mode=`, ranking `search_tools`
 * matches, summarizing descriptions, and validating `call_tool` input. The
 * gateway-level behaviour, including equivalence with direct calls, is pinned
 * in `__tests__/api/mcp-gateway-discovery-mode.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
	DISCOVERY_MODE,
	parseCallToolArguments,
	parseToolListMode,
	searchTools,
	summarize,
	TOOL_LIST_MODE_PARAM,
} from "../discovery-tools";
import type { GatewaySession, GatewayToolDefinition } from "../types";

const SESSION: Pick<GatewaySession, "credential" | "scopes"> = {
	credential: "personal-key",
	scopes: ["*"],
};

function tool(name: string, description: string): GatewayToolDefinition {
	return {
		name,
		description,
		inputSchema: { type: "object", properties: {} },
	};
}

function names(result: ReturnType<typeof searchTools>): string[] {
	return (
		JSON.parse(result.content[0].text) as { tools: Array<{ name: string }> }
	).tools.map((entry) => entry.name);
}

describe("parseToolListMode", () => {
	it("is named by its exported constants", () => {
		expect(`${TOOL_LIST_MODE_PARAM}=${DISCOVERY_MODE}`).toBe(
			"mode=discovery",
		);
	});

	it.each([
		["", { kind: "mode", mode: "full" }],
		["?mode=discovery", { kind: "mode", mode: "discovery" }],
		["?mode=%20Discovery%20", { kind: "mode", mode: "discovery" }],
		["?mode=discovery&mode=discovery", { kind: "mode", mode: "discovery" }],
	])("reads %s", (query, expected) => {
		expect(parseToolListMode(new URLSearchParams(query))).toEqual(expected);
	});

	it.each([["?mode=full"], ["?mode="], ["?mode=discovery&mode=full"]])(
		"refuses %s",
		(query) => {
			const parsed = parseToolListMode(new URLSearchParams(query));
			expect(parsed.kind).toBe("invalid");
		},
	);
});

describe("searchTools ranking", () => {
	const tools = [
		tool("tracker__create_issue", "[Tracker] Create an issue."),
		tool("fabric_list_projects", "List the projects you can see."),
		tool("tracker__list_issues", "[Tracker] List issues in a project."),
	];

	it("ranks tools matching more terms first, then name matches, then list order", () => {
		expect(
			names(searchTools(SESSION, tools, { query: "list issues" })),
		).toEqual(["tracker__list_issues", "fabric_list_projects"]);
		expect(
			names(searchTools(SESSION, tools, { query: "project" })),
		).toEqual(["fabric_list_projects", "tracker__list_issues"]);
	});

	it("matches case-insensitively and caps the limit at 25", () => {
		const many = Array.from({ length: 30 }, (_, index) =>
			tool(`fabric_tool_${index}`, "Example."),
		);
		const result = JSON.parse(
			searchTools(SESSION, many, { query: "FABRIC", limit: 100 })
				.content[0].text,
		) as { total: number; tools: unknown[] };
		expect(result.total).toBe(30);
		expect(result.tools).toHaveLength(25);
	});

	it("refuses a limit that is not a number", () => {
		expect(
			searchTools(SESSION, tools, { query: "issue", limit: "many" })
				.isError,
		).toBe(true);
	});
});

describe("summarize", () => {
	it("keeps the first sentence of the first line", () => {
		expect(summarize("List projects. Then more.\nSecond line.")).toBe(
			"List projects.",
		);
		expect(summarize("No full stop\nmore")).toBe("No full stop");
	});

	it("caps a long sentence at 160 characters", () => {
		const summary = summarize(`${"word ".repeat(60)}end.`);
		expect(summary.length).toBeLessThanOrEqual(160);
		expect(summary.endsWith("…")).toBe(true);
	});
});

describe("parseCallToolArguments", () => {
	it("passes the name and inner arguments through, defaulting to an empty object", () => {
		expect(
			parseCallToolArguments({
				name: "fabric_list_projects",
				arguments: { limit: 5 },
			}),
		).toEqual({
			ok: true,
			name: "fabric_list_projects",
			arguments: { limit: 5 },
		});
		expect(parseCallToolArguments({ name: "fabric_get_identity" })).toEqual(
			{ ok: true, name: "fabric_get_identity", arguments: {} },
		);
	});
});
