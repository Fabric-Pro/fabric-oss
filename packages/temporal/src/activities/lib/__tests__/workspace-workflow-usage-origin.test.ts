import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	canRun: vi.fn(),
	projectAccess: vi.fn(),
	grant: vi.fn(),
}));
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		workspaceWorkflowRunProvenanceSchema:
			actual.workspaceWorkflowRunProvenanceSchema,
		canRunOrganizationWorkflows: mocks.canRun,
		hasProjectAccess: mocks.projectAccess,
		getWorkspaceWorkflowGrant: mocks.grant,
	};
});

import { resolveWorkspaceWorkflowUsageOrigin } from "../workspace-workflow-usage-origin";

type Input = Parameters<typeof resolveWorkspaceWorkflowUsageOrigin>[0];
const stamp = new Date("2026-10-20T09:00:00.000Z");
const workflow: Input["workflow"] = {
	id: "workflow",
	userId: "owner",
	organizationId: "example-org",
	projectId: "project",
	status: "PUBLISHED",
	version: 3,
	publishedVersion: 3,
	updatedAt: stamp,
};
const provenance = {
	kind: "workspace-workflow",
	version: 1,
	workflowId: "workflow",
	workspaceFrameId: "workspace",
	projectId: "project",
	workflowVersion: 3,
	workflowUpdatedAt: stamp.toISOString(),
	frameUpdatedAt: stamp.toISOString(),
	inputsFingerprint: "a".repeat(64),
};
function dataNode(frameId = "workspace") {
	return {
		id: `read-${frameId}`,
		type: "workspace-data-read",
		data: {
			config: {
				frameId,
				collection: "state",
				key: "baseline",
				scope: "shared",
			},
		},
	};
}
function input(overrides: Partial<Input> = {}): Input {
	return {
		userId: "owner",
		organizationId: "example-org",
		workflow,
		execution: {
			id: "execution",
			workflowId: "workflow",
			version: 3,
			triggerType: "SCHEDULE",
			triggerInput: { source: "schedule" },
		},
		publishedNodes: [dataNode()],
		...overrides,
	};
}
function grant() {
	return {
		frame: {
			id: "workspace",
			userId: "owner",
			organizationId: "example-org",
			projectId: "project",
			updatedAt: stamp,
		},
		grant: {
			workflowId: "workflow",
			authorizedWorkflowVersion: 3,
			authorizedWorkflowUpdatedAt: stamp.toISOString(),
		},
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.canRun.mockResolvedValue(true);
	mocks.projectAccess.mockResolvedValue(true);
	mocks.grant.mockResolvedValue(grant());
});

describe("Workspace workflow usage origin", () => {
	it.each(["SCHEDULE", "MANUAL"] as const)(
		"uses one published Workspace for a %s run with a current grant",
		async (triggerType) => {
			const run = input();
			run.execution.triggerType = triggerType;
			expect(await resolveWorkspaceWorkflowUsageOrigin(run)).toBe(
				"workspace",
			);
			expect(mocks.grant).toHaveBeenCalledExactlyOnceWith({
				frameId: "workspace",
				workflowId: "workflow",
				userId: "owner",
				organizationId: "example-org",
			});
		},
	);

	it("uses the server-owned manual launch without requiring a data node", async () => {
		const run = input({ publishedNodes: undefined });
		run.execution.triggerType = "MANUAL";
		run.execution.triggerInput = {
			source: "workspace-workflow",
			workspaceWorkflowBinding: provenance,
		};
		expect(await resolveWorkspaceWorkflowUsageOrigin(run)).toBe(
			"workspace",
		);
	});

	it("attributes a manual launch to its Workspace when the graph uses another bound data store", async () => {
		const run = input({ publishedNodes: [dataNode("other-workspace")] });
		run.execution.triggerType = "MANUAL";
		run.execution.triggerInput = {
			source: "workspace-workflow",
			workspaceWorkflowBinding: provenance,
		};
		expect(await resolveWorkspaceWorkflowUsageOrigin(run)).toBe(
			"workspace",
		);
		expect(mocks.grant.mock.calls[0][0].frameId).toBe("workspace");
	});

	it("never reads Workspace-like values from user trigger data", async () => {
		const run = input({ publishedNodes: undefined });
		run.execution.triggerType = "MANUAL";
		run.execution.triggerInput = {
			triggerData: {
				source: "workspace-workflow",
				workspaceWorkflowBinding: provenance,
				frameId: "workspace",
			},
		};
		expect(await resolveWorkspaceWorkflowUsageOrigin(run)).toBeUndefined();
		expect(mocks.grant).not.toHaveBeenCalled();
		expect(mocks.canRun).not.toHaveBeenCalled();
	});

	it.each([
		{ source: "workspace-workflow" },
		{ source: "other", workspaceWorkflowBinding: provenance },
		{
			source: "workspace-workflow",
			workspaceWorkflowBinding: { ...provenance, workflowId: "foreign" },
		},
		{
			source: "workspace-workflow",
			workspaceWorkflowBinding: { ...provenance, projectId: "foreign" },
		},
		{
			source: "workspace-workflow",
			workspaceWorkflowBinding: { ...provenance, workflowVersion: 2 },
		},
		{
			source: "workspace-workflow",
			workspaceWorkflowBinding: {
				...provenance,
				workflowUpdatedAt: "2026-10-19T09:00:00.000Z",
			},
		},
	])(
		"does not infer another origin after malformed launch metadata: %j",
		async (triggerInput) => {
			const run = input();
			run.execution.triggerType = "MANUAL";
			run.execution.triggerInput = triggerInput;
			expect(
				await resolveWorkspaceWorkflowUsageOrigin(run),
			).toBeUndefined();
			expect(mocks.grant).not.toHaveBeenCalled();
		},
	);

	it("does not treat scheduled trigger metadata as a manual launch", async () => {
		const run = input();
		run.execution.triggerInput = {
			source: "workspace-workflow",
			workspaceWorkflowBinding: provenance,
		};
		expect(await resolveWorkspaceWorkflowUsageOrigin(run)).toBeUndefined();
	});

	it.each([
		{ publishedNodes: [dataNode("first"), dataNode("second")] },
		{
			publishedNodes: [
				dataNode(),
				{
					id: "broken",
					type: "workspace-data-read",
					data: { config: {} },
				},
			],
		},
		{ publishedNodes: [dataNode(), dataNode("{{dynamicFrame}}")] },
		{ publishedNodes: [] },
	])(
		"leaves ambiguous or malformed published graphs unattributed: %j",
		async ({ publishedNodes }) => {
			expect(
				await resolveWorkspaceWorkflowUsageOrigin(
					input({ publishedNodes }),
				),
			).toBeUndefined();
			expect(mocks.grant).not.toHaveBeenCalled();
		},
	);

	it("allows read and write nodes that name the same Workspace", async () => {
		expect(
			await resolveWorkspaceWorkflowUsageOrigin(
				input({
					publishedNodes: [
						dataNode(),
						{
							id: "write",
							type: "workspace-data-write",
							data: {
								config: {
									...dataNode().data.config,
									value: "{}",
									expectedVersion: 0,
								},
							},
						},
					],
				}),
			),
		).toBe("workspace");
	});

	it.each([
		{ userId: "foreign" },
		{ organizationId: "foreign" },
		{ projectId: null },
		{ status: "PAUSED" as const },
		{ version: 4 },
		{ publishedVersion: 2 },
	])("does not attribute a foreign or stale workflow: %j", async (change) => {
		expect(
			await resolveWorkspaceWorkflowUsageOrigin(
				input({ workflow: { ...workflow, ...change } }),
			),
		).toBeUndefined();
		expect(mocks.grant).not.toHaveBeenCalled();
	});

	it("requires the canonical execution to belong to this workflow", async () => {
		const run = input();
		run.execution.workflowId = "foreign";
		expect(await resolveWorkspaceWorkflowUsageOrigin(run)).toBeUndefined();
	});

	it.each(["canRun", "projectAccess"] as const)(
		"requires current %s permission",
		async (permission) => {
			mocks[permission].mockResolvedValue(false);
			expect(
				await resolveWorkspaceWorkflowUsageOrigin(input()),
			).toBeUndefined();
			expect(mocks.grant).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ frame: { ...grant().frame, id: "foreign" } },
		{ frame: { ...grant().frame, userId: "foreign" } },
		{ frame: { ...grant().frame, organizationId: "foreign" } },
		{ frame: { ...grant().frame, projectId: "foreign" } },
		{ grant: { ...grant().grant, authorizedWorkflowVersion: 2 } },
		{
			grant: {
				...grant().grant,
				authorizedWorkflowUpdatedAt: "2026-10-19T09:00:00.000Z",
			},
		},
	])("rejects foreign frames and changed grants: %j", async (change) => {
		mocks.grant.mockResolvedValue({ ...grant(), ...change });
		expect(
			await resolveWorkspaceWorkflowUsageOrigin(input()),
		).toBeUndefined();
	});

	it("keeps the workflow origin when the Workspace grant was revoked", async () => {
		mocks.grant.mockResolvedValue(null);
		expect(
			await resolveWorkspaceWorkflowUsageOrigin(input()),
		).toBeUndefined();
	});
});
