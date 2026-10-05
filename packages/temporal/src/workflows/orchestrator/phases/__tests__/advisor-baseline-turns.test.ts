/**
 * Ordinary Advisor turns, pinned as they behave today: a plain answer, a
 * repository read the user located exactly, a document read, a mixed step
 * across a document, Slack and a repository, and a continued conversation.
 *
 * Same harness as `advisor-tool-progression.test.ts`: the real
 * `executeIterativePhase`, the workflow SDK and activity proxy mocked, every
 * `patched()` marker ON, and the model scripted turn by turn.
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
		/** Markers a test switches off to replay an older history. */
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

import {
	DISCOVER_REPO_TOOLS,
	FILE_TEXT,
	finalResponse,
	installDefaultStubs,
	runTurn,
	SHORT_DOC_BODY,
	toolMessage,
} from "./advisor-scenario-harness";

beforeEach(() => {
	installDefaultStubs(mocks);
});

// ---------------------------------------------------------------------------
// Baselines — ordinary turns, pinned as they behave today.
// ---------------------------------------------------------------------------

describe("baseline turns", () => {
	it("answers without tools in one model call", async () => {
		const { result, seen } = await runTurn(mocks, {
			message: "Say hello.",
			steps: [{ answer: "Hello from the Advisor." }],
		});
		expect(seen).toHaveLength(1);
		expect(mocks.stub("executeMcpTool")).not.toHaveBeenCalled();
		expect(mocks.stub("searchAvailableTools")).not.toHaveBeenCalled();
		expect(finalResponse(result)).toBe("Hello from the Advisor.");
	});

	it("reads the named file through the Fabric catalog, with code_file_get attached before any search_tools call", async () => {
		const { result, seen } = await runTurn(mocks, {
			message: "In example-org/app, what does src/flags.ts export?",
			steps: [
				{
					calls: [
						{
							name: "search_tools",
							args: { query: "read a file from the repository" },
						},
					],
				},
				{
					calls: [
						{
							name: "code_file_get",
							args: {
								repo: "example-org/app",
								path: "src/flags.ts",
							},
						},
					],
				},
				{ answer: "src/flags.ts exports launchFlag." },
			],
		});
		// A project chat attaches the repository reads up front
		// (orch-project-repository-tools-v1); a search_tools call the model
		// makes anyway still answers.
		expect(seen[0].tools).toContain("code_file_get");
		expect(mocks.stub("searchAvailableTools")).toHaveBeenCalledTimes(1);
		expect(seen[1].tools).toContain("code_file_get");
		expect(mocks.stub("executeMcpTool")).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "code_file_get",
				mcpConfigId: "fabric-ai-server",
				projectId: "project-1",
				organizationId: "org-1",
				args: { repo: "example-org/app", path: "src/flags.ts" },
			}),
		);
		expect(toolMessage(seen, 2, "call-2-0")).toBe(FILE_TEXT);
		expect(finalResponse(result)).toBe("src/flags.ts exports launchFlag.");
	});

	it("retrieves a short document with fabric_get_project_document", async () => {
		const { result, seen } = await runTurn(mocks, {
			message: "What does the launch checklist say?",
			steps: [
				{
					calls: [
						{
							name: "fabric_get_project_document",
							args: { document: "doc-short" },
						},
					],
				},
				{ answer: "It has three steps." },
			],
		});
		expect(mocks.stub("executeMcpTool")).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "fabric_get_project_document",
				mcpConfigId: "fabric-ai-server",
				args: expect.objectContaining({ document: "doc-short" }),
			}),
		);
		expect(toolMessage(seen, 1, "call-1-0")).toContain(SHORT_DOC_BODY);
		expect(mocks.stub("summarizeLargeToolResult")).not.toHaveBeenCalled();
		expect(finalResponse(result)).toBe("It has three steps.");
	});

	it("runs a document read, a Slack search and a repository read in one step", async () => {
		const { result, seen } = await runTurn(mocks, {
			message: "Cross-check the launch date across docs, Slack and code.",
			steps: [
				DISCOVER_REPO_TOOLS,
				{
					calls: [
						{
							name: "fabric_get_project_document",
							args: { document: "doc-short" },
						},
						{
							name: "search_slack_messages",
							args: { query: "launch" },
						},
						{
							name: "code_file_get",
							args: {
								repo: "example-org/app",
								path: "src/flags.ts",
							},
						},
					],
				},
				{ answer: "All three sources agree." },
			],
		});
		expect(mocks.stub("searchProjectSlackMessages")).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				organizationId: "org-1",
				query: "launch",
			}),
		);
		expect(
			mocks
				.stub("executeMcpTool")
				.mock.calls.map((c) => [c[0].toolName, c[0].mcpConfigId]),
		).toEqual([
			["fabric_get_project_document", "fabric-ai-server"],
			["code_file_get", "fabric-ai-server"],
		]);
		expect(toolMessage(seen, 2, "call-2-0")).toContain(SHORT_DOC_BODY);
		expect(toolMessage(seen, 2, "call-2-1")).toContain(
			"Launch is on the 12th",
		);
		expect(toolMessage(seen, 2, "call-2-2")).toBe(FILE_TEXT);
		expect(finalResponse(result)).toBe("All three sources agree.");
	});

	it("continues a conversation with the prior turn ahead of the new message", async () => {
		const { result, seen } = await runTurn(mocks, {
			message: "Who owns it?",
			history: [
				{ role: "user", content: "What is the launch date?" },
				{ role: "assistant", content: "The launch is on the 12th." },
			],
			steps: [{ answer: "The release team owns the launch." }],
		});
		expect(seen[0].history.map((m) => [m.role, m.content])).toEqual([
			["user", "What is the launch date?"],
			["assistant", "The launch is on the 12th."],
			["user", "Who owns it?"],
		]);
		expect(finalResponse(result)).toBe("The release team owns the launch.");
	});
});
