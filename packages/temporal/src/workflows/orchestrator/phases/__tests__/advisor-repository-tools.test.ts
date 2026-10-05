/**
 * A project chat attaches the repository reads (`code_tree`, `code_file_get`,
 * `code_search`) from its first model call, behind
 * `orch-project-repository-tools-v1` (Fizzy #2924). Before, a chat with MCP
 * servers assigned had to find them through `search_tools`, whose semantic
 * step usually ranked other servers' repository tools above them, so the
 * model read the project's code through another integration instead.
 *
 * Runs the real `executeIterativePhase` with a scripted model.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const activities = new Map<string, ReturnType<typeof vi.fn>>();
	const stub = (name: string) => {
		let fn = activities.get(name);
		if (!fn) {
			fn = vi.fn();
			activities.set(name, fn);
		}
		return fn;
	};
	return {
		stub,
		resetAll: () => {
			for (const fn of activities.values()) {
				fn.mockReset();
			}
		},
		off: new Set<string>(),
	};
});

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: vi.fn((id: string) => !mocks.off.has(id)),
	proxyActivities: vi.fn(
		() =>
			new Proxy({}, { get: (_target, name) => mocks.stub(String(name)) }),
	),
	workflowInfo: vi.fn(() => ({
		runId: "test-run-id",
		unsafe: { isReplaying: false },
	})),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import { getFabricAiTools } from "../../../../activities/orchestrator/tools/fabric-ai-tools";
import { TOOLS } from "../../orchestrator-config";
import {
	FILE_TEXT,
	installDefaultStubs,
	preloaded,
	runTurn,
	toolMessage,
} from "./advisor-scenario-harness";

const MARKER = "orch-project-repository-tools-v1";
const REPOSITORY_TOOLS = ["code_tree", "code_file_get", "code_search"];

// A focused agent: one MCP server assigned, its tools preloaded.
const FOCUSED = {
	enabledMcpConfigIds: ["cfg-drawing"],
	preload: preloaded(["create_drawing"], "cfg-drawing", "Drawing"),
};

const READ_FILE = {
	calls: [{ name: "code_file_get", args: { path: "src/flags.ts" } }],
};

beforeEach(() => {
	installDefaultStubs(mocks);
});

describe("repository reads in a project chat", () => {
	it("are attached on the first model call of a focused agent, no search_tools needed", async () => {
		const { seen } = await runTurn(mocks, {
			message: "Read src/flags.ts from the repository.",
			...FOCUSED,
			steps: [READ_FILE, { answer: "launchFlag is true." }],
		});

		expect(seen[0].tools).toEqual(expect.arrayContaining(REPOSITORY_TOOLS));
		expect(mocks.stub("searchAvailableTools")).not.toHaveBeenCalled();
		expect(toolMessage(seen, 1, "call-1-0")).toContain(FILE_TEXT);
		expect(mocks.stub("executeMcpTool")).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "code_file_get",
				mcpConfigId: "fabric-ai-server",
			}),
		);
	});

	it("are named as already attached when the agent's tools come as a catalog", async () => {
		// More preloaded tools than TOOLS.eagerLoadThreshold: stub catalog.
		const names = Array.from(
			{ length: TOOLS.eagerLoadThreshold + 1 },
			(_, i) => `example_tool_${i}`,
		);
		const { seen } = await runTurn(mocks, {
			message: "List the repository tree.",
			enabledMcpConfigIds: ["cfg-example"],
			preload: preloaded(names, "cfg-example", "Example Server"),
			steps: [{ answer: "Done." }],
		});

		expect(seen[0].systemPrompt).toContain("Tools NOT in the catalog");

		expect(seen[0].systemPrompt).toContain(
			"code_tree, code_file_get, code_search, ",
		);
	});

	it("use the catalog's own schemas", async () => {
		const { seen } = await runTurn(mocks, {
			message: "List the repository tree.",
			steps: [{ answer: "Done." }],
		});
		expect(seen[0].tools).toEqual(expect.arrayContaining(REPOSITORY_TOOLS));
		const catalog = new Map(getFabricAiTools().map((t) => [t.name, t]));
		const { PROJECT_REPOSITORY_TOOLS } = await import(
			"../../project-repository-tool-schemas"
		);
		for (const tool of PROJECT_REPOSITORY_TOOLS) {
			expect(catalog.get(tool.name)?.inputSchema).toBe(tool.inputSchema);
			expect(catalog.get(tool.name)?.description).toContain(
				tool.description,
			);
		}
	});

	it("follow an explicit Fabric tool list", async () => {
		const { seen } = await runTurn(mocks, {
			message: "List the repository tree.",
			...FOCUSED,
			enabledFabricToolIds: ["code_tree"],
			steps: [{ answer: "Done." }],
		});

		expect(seen[0].tools).toContain("code_tree");
		expect(seen[0].tools).not.toContain("code_file_get");
		expect(seen[0].tools).not.toContain("code_search");
	});

	it("are not attached when the Fabric tool list is empty", async () => {
		const { seen } = await runTurn(mocks, {
			message: "List the repository tree.",
			enabledFabricToolIds: [],
			steps: [{ answer: "Done." }],
		});

		for (const name of REPOSITORY_TOOLS) {
			expect(seen[0].tools).not.toContain(name);
		}
	});

	it("are not attached on a history recorded before the marker", async () => {
		mocks.off.add(MARKER);
		const { seen } = await runTurn(mocks, {
			message: "List the repository tree.",
			...FOCUSED,
			steps: [{ answer: "Done." }],
		});

		for (const name of REPOSITORY_TOOLS) {
			expect(seen[0].tools).not.toContain(name);
		}
		expect(seen[0].systemPrompt).not.toContain("code_tree, ");
	});
});
