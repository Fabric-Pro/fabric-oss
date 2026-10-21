import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	workflow: vi.fn(),
	definition: vi.fn(),
	origin: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {},
	getWorkflowById: mocks.workflow,
	createExecutionLog: vi.fn(),
	updateExecutionLog: vi.fn(),
	updateWorkflowExecution: vi.fn(),
	recordWorkflowRunStarted: vi.fn(),
	isProjectReadOnly: vi.fn(),
}));
vi.mock("../lib/workflow-execution-definition", () => ({
	resolveExecutionGraph: mocks.definition,
}));
vi.mock("../lib/workspace-workflow-usage-origin", () => ({
	resolveWorkspaceWorkflowUsageOrigin: mocks.origin,
}));

import { getWorkflowDefinition } from "../workflow-builder-execution";

const workflow = {
	id: "workflow",
	projectId: "project",
	nodes: [{ id: "draft", type: "trigger" }],
	edges: [],
	variables: null,
};
const execution = {
	id: "execution",
	workflowId: "workflow",
	version: 3,
	triggerType: "SCHEDULE",
	triggerInput: { source: "schedule" },
};
const graph = {
	nodes: [{ id: "published", type: "trigger" }],
	edges: [],
	variables: { mode: "published" },
};
const input = {
	workflowId: "workflow",
	userId: "owner",
	organizationId: "example-org",
	executionId: "execution",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.workflow.mockResolvedValue(workflow);
	mocks.definition.mockResolvedValue({ graph, execution, published: true });
	mocks.origin.mockResolvedValue("workspace");
});

describe("workflow definition usage attribution", () => {
	it("resolves the origin once from the same owned execution and published graph", async () => {
		expect(await getWorkflowDefinition(input)).toEqual({
			...workflow,
			...graph,
			usageFrameId: "workspace",
		});
		expect(mocks.definition).toHaveBeenCalledExactlyOnceWith({
			...input,
			nodes: workflow.nodes,
			edges: workflow.edges,
			variables: workflow.variables,
			projectId: "project",
		});
		expect(mocks.origin).toHaveBeenCalledExactlyOnceWith({
			userId: "owner",
			organizationId: "example-org",
			workflow,
			execution,
			publishedNodes: graph.nodes,
		});
	});

	it("does not infer an origin from a draft graph", async () => {
		mocks.definition.mockResolvedValue({
			graph,
			execution,
			published: false,
		});
		await getWorkflowDefinition(input);
		expect(mocks.origin.mock.calls[0][0].publishedNodes).toBeUndefined();
	});

	it("preserves definition reads outside an execution without attributing a Workspace", async () => {
		expect(
			await getWorkflowDefinition({
				workflowId: "workflow",
				userId: "owner",
				organizationId: "example-org",
			}),
		).toEqual({
			...workflow,
			usageFrameId: undefined,
		});
		expect(mocks.definition).not.toHaveBeenCalled();
		expect(mocks.origin).not.toHaveBeenCalled();
	});
});
