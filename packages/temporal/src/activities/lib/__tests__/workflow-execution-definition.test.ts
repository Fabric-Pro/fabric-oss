import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execution: vi.fn(), version: vi.fn() }));
vi.mock("@repo/database", () => ({
	db: {
		workflowExecution: { findFirst: mocks.execution },
		workflowVersion: { findFirst: mocks.version },
	},
}));
import { resolveExecutionGraph } from "../workflow-execution-definition";

const input = {
	workflowId: "workflow",
	executionId: "execution",
	userId: "owner",
	organizationId: "example-org",
	projectId: "project",
	nodes: [{ id: "draft", type: "trigger" }],
	edges: [],
	variables: { mode: "draft" },
};
const published = {
	nodes: [{ id: "published", type: "trigger" }],
	edges: [],
	variables: { mode: "published" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.execution.mockResolvedValue({ version: 3, triggerType: "SCHEDULE" });
	mocks.version.mockResolvedValue(published);
});

describe("execution graph authority", () => {
	it.each([
		"workspace-data-read",
		"workspace-data-write",
		"native-platform-read",
	])(
		"requires immutable graphs for manual %s execution and rejects modified overrides",
		async (type) => {
			mocks.execution.mockResolvedValue({
				version: 3,
				triggerType: "MANUAL",
			});
			const nodes = [{ id: "data", type }];
			expect(
				(await resolveExecutionGraph({ ...input, nodes })).graph,
			).toEqual(published);
			await expect(
				resolveExecutionGraph({
					...input,
					override: { nodes, edges: [] },
				}),
			).rejects.toThrow("Publish script workflow changes");
		},
	);

	it("uses the execution's immutable version for scheduled runs, including variables", async () => {
		const definition = await resolveExecutionGraph(input);
		expect(definition.graph).toEqual(published);
		expect(definition.published).toBe(true);
		expect(mocks.execution).toHaveBeenCalledOnce();
		expect(mocks.execution.mock.calls[0][0].select).toEqual({
			id: true,
			workflowId: true,
			version: true,
			triggerType: true,
			triggerInput: true,
		});
		expect(mocks.version).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					workflowId: "workflow",
					version: 3,
					isPublished: true,
					userId: "owner",
					organizationId: "example-org",
				},
			}),
		);
	});

	it("preserves explicit non-script UI draft runs", async () => {
		mocks.execution.mockResolvedValue({
			version: 3,
			triggerType: "MANUAL",
		});
		const override = {
			nodes: [{ id: "preview", type: "trigger" }],
			edges: [],
		};
		expect(
			(await resolveExecutionGraph({ ...input, override })).graph,
		).toMatchObject(override);
		expect(mocks.version).not.toHaveBeenCalled();
	});

	it("refuses a missing published version rather than falling back to a draft", async () => {
		mocks.version.mockResolvedValue(null);
		await expect(resolveExecutionGraph(input)).rejects.toThrow(
			"immutable published",
		);
	});

	it("refuses foreign or absent executions", async () => {
		mocks.execution.mockResolvedValue(null);
		await expect(resolveExecutionGraph(input)).rejects.toThrow(
			"execution not found",
		);
		expect(mocks.execution.mock.calls[0][0].where).toMatchObject({
			userId: "owner",
			organizationId: "example-org",
			workflowId: "workflow",
			workflow: {
				userId: "owner",
				organizationId: "example-org",
				projectId: "project",
			},
		});
	});

	it("cannot use supplied script nodes to bypass the published graph", async () => {
		mocks.execution.mockResolvedValue({
			version: 3,
			triggerType: "MANUAL",
		});
		await expect(
			resolveExecutionGraph({
				...input,
				override: {
					nodes: [{ id: "script", type: "script-transform" }],
					edges: [],
				},
			}),
		).rejects.toThrow("Publish script workflow changes");
	});

	it("accepts the same published graph with reordered object keys", async () => {
		const snapshot = {
			nodes: [
				{
					id: "script",
					type: "script-transform",
					data: {
						config: { code: "return null", language: "javascript" },
						label: "Transform",
					},
				},
			],
			edges: [{ id: "edge", source: "source", target: "script" }],
			variables: null,
		};
		mocks.version.mockResolvedValue(snapshot);
		const override = {
			nodes: [
				{
					data: {
						label: "Transform",
						config: { language: "javascript", code: "return null" },
					},
					type: "script-transform",
					id: "script",
				},
			],
			edges: [{ target: "script", id: "edge", source: "source" }],
		};
		expect(
			(await resolveExecutionGraph({ ...input, override })).graph,
		).toEqual(snapshot);
	});

	it("continues refusing changed graph values and array order", async () => {
		mocks.version.mockResolvedValue({
			...published,
			edges: [{ id: "a" }, { id: "b" }],
		});
		await expect(
			resolveExecutionGraph({
				...input,
				override: {
					nodes: published.nodes,
					edges: [{ id: "b" }, { id: "a" }],
				},
			}),
		).rejects.toThrow("Publish script workflow changes");
	});
});
