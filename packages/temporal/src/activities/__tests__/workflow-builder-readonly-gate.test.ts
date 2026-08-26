/**
 * Read-only mode gate for Weave workflow-builder node execution.
 *
 * `executeWorkflowNode` must refuse to dispatch EXTERNAL_WRITE_NODE_TYPES steps
 * (and mcp-tool steps configured with a write tool) while the owning project is
 * read-only — and must leave read/internal steps and non-project-linked
 * workflows untouched.
 */

import { isProjectReadOnly } from "@repo/database";
import { READ_ONLY_MODE_MESSAGE } from "@repo/utils/read-only-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	EXTERNAL_WRITE_NODE_TYPES,
	executeStep,
	stepRegistry,
} from "../lib/step-registry";
import { executeWorkflowNode } from "../workflow-builder-execution";

vi.mock("@repo/database", () => ({
	createExecutionLog: vi.fn(),
	db: {},
	getWorkflowById: vi.fn(),
	isProjectReadOnly: vi.fn().mockResolvedValue(false),
	updateExecutionLog: vi.fn(),
	updateWorkflowExecution: vi.fn(),
}));

// Keep the real registry (EXTERNAL_WRITE_NODE_TYPES, stepRegistry) but stub
// dispatch so no real step module loads.
vi.mock("../lib/step-registry", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../lib/step-registry")>();
	return {
		...actual,
		hasStep: vi.fn(() => true),
		executeStep: vi.fn(async () => ({
			success: true,
			output: { ok: true },
		})),
	};
});

function nodeParams(
	overrides: Partial<Parameters<typeof executeWorkflowNode>[0]> = {},
) {
	return {
		executionId: "exec-1",
		nodeId: "node-1",
		nodeType: "slack-send",
		nodeConfig: { slackChannel: "#general", slackMessage: "hello" },
		inputs: {},
		userId: "user-1",
		...overrides,
	};
}

describe("executeWorkflowNode read-only gate", () => {
	beforeEach(() => {
		vi.mocked(executeStep).mockClear();
		vi.mocked(isProjectReadOnly).mockReset().mockResolvedValue(false);
	});

	it("blocks an external-write step when the project is read-only", async () => {
		vi.mocked(isProjectReadOnly).mockResolvedValue(true);

		const result = await executeWorkflowNode(
			nodeParams({ projectId: "proj-1" }),
		);

		expect(result).toEqual({
			success: false,
			error: READ_ONLY_MODE_MESSAGE,
		});
		expect(executeStep).not.toHaveBeenCalled();
	});

	it("lets an external READ step through in read-only mode", async () => {
		vi.mocked(isProjectReadOnly).mockResolvedValue(true);

		const result = await executeWorkflowNode(
			nodeParams({
				projectId: "proj-1",
				nodeType: "github-search-issues",
				nodeConfig: { query: "is:open" },
			}),
		);

		expect(result.success).toBe(true);
		expect(executeStep).toHaveBeenCalledOnce();
	});

	it("lets an internal step through in read-only mode", async () => {
		vi.mocked(isProjectReadOnly).mockResolvedValue(true);

		const result = await executeWorkflowNode(
			nodeParams({
				projectId: "proj-1",
				nodeType: "condition",
				nodeConfig: { expression: "true" },
			}),
		);

		expect(result.success).toBe(true);
		expect(executeStep).toHaveBeenCalledOnce();
	});

	it("does not gate a workflow that is not project-linked", async () => {
		vi.mocked(isProjectReadOnly).mockResolvedValue(true);

		const result = await executeWorkflowNode(nodeParams());

		expect(result.success).toBe(true);
		expect(executeStep).toHaveBeenCalledOnce();
		expect(isProjectReadOnly).not.toHaveBeenCalled();
	});

	it("runs an external-write step when the project is not read-only", async () => {
		const result = await executeWorkflowNode(
			nodeParams({ projectId: "proj-1" }),
		);

		expect(result.success).toBe(true);
		expect(executeStep).toHaveBeenCalledOnce();
	});

	it("blocks an mcp-tool step configured with a write tool", async () => {
		vi.mocked(isProjectReadOnly).mockResolvedValue(true);

		const result = await executeWorkflowNode(
			nodeParams({
				projectId: "proj-1",
				nodeType: "mcp-tool",
				nodeConfig: {
					toolName: "create_page",
					mcpServers: ["server-1"],
				},
			}),
		);

		expect(result).toEqual({
			success: false,
			error: READ_ONLY_MODE_MESSAGE,
		});
		expect(executeStep).not.toHaveBeenCalled();
	});

	it("lets an mcp-tool step configured with a read tool through", async () => {
		vi.mocked(isProjectReadOnly).mockResolvedValue(true);

		const result = await executeWorkflowNode(
			nodeParams({
				projectId: "proj-1",
				nodeType: "mcp-tool",
				nodeConfig: { toolName: "get_page", mcpServers: ["server-1"] },
			}),
		);

		expect(result.success).toBe(true);
		expect(executeStep).toHaveBeenCalledOnce();
	});
});

describe("EXTERNAL_WRITE_NODE_TYPES", () => {
	it("only names node types that exist in the step registry", () => {
		const registered = new Set(Object.keys(stepRegistry));
		for (const nodeType of EXTERNAL_WRITE_NODE_TYPES) {
			expect(
				registered.has(nodeType),
				`${nodeType} not in registry`,
			).toBe(true);
		}
	});
});
