/**
 * buildPreloadedToolCatalog — stub-catalog rendering for focused agents
 * with > TOOLS.eagerLoadThreshold tools.
 *
 * Replaces the eager schema-attach path that burned ~440 input tokens per
 * tool per iteration. A production incident (2026-04-29) preloaded 110 tools
 * across 3 MCP configs and consumed ~48K input tokens *per iteration* before
 * the model emitted a single token of work.
 *
 * The catalog is rendered into the system prompt; the model uses
 * search_tools to load schemas on demand. The output is therefore
 * load-bearing — its format must stay compact, deterministic, and complete.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: vi.fn(() => true),
	proxyActivities: vi.fn(() => ({})),
	workflowInfo: vi.fn(() => ({ unsafe: { isReplaying: false } })),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import { buildPreloadedToolCatalog } from "../src/workflows/orchestrator/phases/iterative-execution";

interface T {
	toolName: string;
	description: string;
	serverName: string;
}

function tool(toolName: string, serverName: string, description: string): T {
	return { toolName, serverName, description };
}

describe("buildPreloadedToolCatalog", () => {
	it("returns the empty string when given no tools", () => {
		expect(buildPreloadedToolCatalog([])).toBe("");
	});

	it("groups tools by server with a header per server", () => {
		const out = buildPreloadedToolCatalog([
			tool("repo_get_file", "azure-devops", "Get a file"),
			tool("repo_list_directory", "azure-devops", "List a directory"),
			tool("send_message", "teams", "Send a Teams message"),
		]);
		expect(out).toContain("Server: azure-devops");
		expect(out).toContain("Server: teams");
		expect(out).toContain("- repo_get_file — Get a file");
		expect(out).toContain("- repo_list_directory — List a directory");
		expect(out).toContain("- send_message — Send a Teams message");
	});

	it("preserves first-seen server order", () => {
		const out = buildPreloadedToolCatalog([
			tool("c1", "z-server", "x"),
			tool("a1", "a-server", "x"),
			tool("c2", "z-server", "x"),
			tool("a2", "a-server", "x"),
		]);
		const zIdx = out.indexOf("Server: z-server");
		const aIdx = out.indexOf("Server: a-server");
		expect(zIdx).toBeGreaterThan(-1);
		expect(aIdx).toBeGreaterThan(zIdx);
	});

	it("preserves within-server registration order", () => {
		const out = buildPreloadedToolCatalog([
			tool("first", "s", "x"),
			tool("second", "s", "x"),
			tool("third", "s", "x"),
		]);
		const firstIdx = out.indexOf("first");
		const secondIdx = out.indexOf("second");
		const thirdIdx = out.indexOf("third");
		expect(secondIdx).toBeGreaterThan(firstIdx);
		expect(thirdIdx).toBeGreaterThan(secondIdx);
	});

	it("collapses descriptions to a single line (no newlines leaking)", () => {
		const out = buildPreloadedToolCatalog([
			tool(
				"foo",
				"s",
				"First line\n\nDeep paragraph that should not be in the catalog",
			),
		]);
		expect(out).toContain("- foo — First line");
		expect(out).not.toContain("Deep paragraph");
	});

	it("truncates long descriptions with an ellipsis", () => {
		const long = "a".repeat(200);
		const out = buildPreloadedToolCatalog([tool("foo", "s", long)]);
		expect(out).toContain("…");
		expect(out.includes(long)).toBe(false);
	});

	it("handles tools with empty descriptions", () => {
		const out = buildPreloadedToolCatalog([tool("foo", "s", "")]);
		expect(out).toContain("- foo — ");
	});

	it("is deterministic — same input yields the same output", () => {
		const input = [
			tool("a", "s1", "alpha"),
			tool("b", "s2", "beta"),
			tool("c", "s1", "gamma"),
		];
		expect(buildPreloadedToolCatalog(input)).toBe(
			buildPreloadedToolCatalog(input),
		);
	});

	it("is dramatically more compact than a schema dump", () => {
		// Sanity check: 100 tools at ~50 chars/line ≈ 5–6 KB total. The schema
		// dump it replaces was ~440 tokens per tool ≈ ~150 KB for 100 tools.
		// We don't measure the schema dump here — just confirm the catalog
		// is in the small-kilobyte range that motivated the swap.
		const tools = Array.from({ length: 100 }, (_, i) =>
			tool(`tool_${String(i).padStart(3, "0")}`, "ado", "Does a thing"),
		);
		const out = buildPreloadedToolCatalog(tools);
		// ~50 chars/line * 100 lines + 1 header ≈ ~5500 chars.
		expect(out.length).toBeLessThan(8_000);
		expect(out.length).toBeGreaterThan(2_000);
	});

	it("reproduces the production scenario shape (110 tools, 3 servers)", () => {
		const ado = Array.from({ length: 95 }, (_, i) =>
			tool(`ado_tool_${i}`, "azure-devops", "ADO operation"),
		);
		const teams = Array.from({ length: 8 }, (_, i) =>
			tool(`teams_tool_${i}`, "microsoft-teams", "Teams operation"),
		);
		const github = Array.from({ length: 7 }, (_, i) =>
			tool(`github_tool_${i}`, "github", "GitHub operation"),
		);
		const out = buildPreloadedToolCatalog([...ado, ...teams, ...github]);

		// Every tool name appears in the catalog — model loses no information.
		for (const t of [...ado, ...teams, ...github]) {
			expect(out).toContain(t.toolName);
		}
		// All three server headers present.
		expect(out).toContain("Server: azure-devops");
		expect(out).toContain("Server: microsoft-teams");
		expect(out).toContain("Server: github");
	});
});
