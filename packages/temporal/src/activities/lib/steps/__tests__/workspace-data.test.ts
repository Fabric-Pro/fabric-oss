import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execution: vi.fn(),
	snapshot: vi.fn(),
	workflow: vi.fn(),
	grant: vi.fn(),
	frame: vi.fn(),
	permission: vi.fn(),
	access: vi.fn(),
	edit: vi.fn(),
	framePermission: vi.fn(),
	read: vi.fn(),
	write: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		workflowExecution: { findFirst: mocks.execution },
		workflowVersion: { findFirst: mocks.snapshot },
	},
	getWorkflowById: mocks.workflow,
	getWorkspaceWorkflowGrant: mocks.grant,
	getAccessibleFrameById: mocks.frame,
	canRunOrganizationWorkflows: mocks.permission,
	hasProjectAccess: mocks.access,
	canEditProject: mocks.edit,
	canUpdateOrganizationFrames: mocks.framePermission,
	getWorkspaceWorkflowRecord: mocks.read,
	setWorkspaceWorkflowRecord: mocks.write,
}));

import { executeWorkspaceDataReadStep } from "../workspace-data-read";
import { executeWorkspaceDataWriteStep } from "../workspace-data-write";

const stamp = new Date("2026-01-01T12:00:00Z");
const config = {
	frameId: "workspace",
	collection: "state",
	key: "{{Selection.key}}",
	scope: "mine",
};
const writeConfig = {
	...config,
	value: "{{Transform.result}}",
	expectedVersion: "{{Read.version}}",
};
const params = {
	userId: "owner",
	organizationId: "example-org",
	projectId: "project",
	workflowId: "workflow",
	executionId: "execution",
	nodeId: "read",
	nodeConfig: config,
	inputs: { Selection: { key: "selected" } },
};
const writeParams = {
	...params,
	nodeId: "write",
	nodeConfig: writeConfig,
	inputs: {
		...params.inputs,
		Read: { version: 2 },
		Transform: {
			result: {
				rows: [{ text: 'quoted "value"\nwith newline' }],
				enabled: true,
			},
		},
	},
};
const workflow = {
	projectId: "project",
	status: "PUBLISHED",
	version: 3,
	publishedVersion: 3,
	updatedAt: stamp,
};

beforeEach(() => {
	vi.resetAllMocks();
	for (const check of [
		mocks.permission,
		mocks.access,
		mocks.edit,
		mocks.framePermission,
	]) {
		check.mockResolvedValue(true);
	}
	mocks.execution.mockResolvedValue({ version: 3, triggerType: "MANUAL" });
	mocks.snapshot.mockResolvedValue({
		nodes: [
			{ id: "read", type: "workspace-data-read", data: { config } },
			{
				id: "write",
				type: "workspace-data-write",
				data: { config: writeConfig },
			},
		],
	});
	mocks.workflow.mockResolvedValue(workflow);
	mocks.grant.mockResolvedValue({
		frame: { id: "workspace", projectId: "project", updatedAt: stamp },
		grant: {
			authorizedWorkflowVersion: 3,
			authorizedWorkflowUpdatedAt: stamp.toISOString(),
		},
	});
	mocks.frame.mockResolvedValue({ userId: "owner", projectId: "project" });
	mocks.read.mockResolvedValue({ value: { reused: true }, version: 2 });
	mocks.write.mockResolvedValue({
		records: [{ value: writeParams.inputs.Transform.result, version: 3 }],
	});
});

describe("published Workspace data steps", () => {
	it("reads the execution owner's scoped record, ignoring input authority", async () => {
		expect(
			await executeWorkspaceDataReadStep({
				...params,
				inputs: {
					...params.inputs,
					userId: "foreign",
					frameId: "foreign",
				},
			}),
		).toEqual({
			success: true,
			output: { value: { reused: true }, version: 2, found: true },
		});
		expect(mocks.read).toHaveBeenCalledWith(
			expect.objectContaining({
				collection: "state",
				key: "selected",
				scope: "mine",
				binding: expect.objectContaining({
					userId: "owner",
					workspaceFrameId: "workspace",
					projectId: "project",
					requirement: { kind: "bound-run", workflowVersion: 3 },
				}),
			}),
		);
		expect(mocks.snapshot.mock.calls[0][0].where).toMatchObject({
			version: 3,
			isPublished: true,
			userId: "owner",
			organizationId: "example-org",
		});
	});

	it("returns version zero for absence and preserves stored JSON null", async () => {
		mocks.read.mockResolvedValueOnce(null);
		expect(await executeWorkspaceDataReadStep(params)).toEqual({
			success: true,
			output: { value: null, version: 0, found: false },
		});
		mocks.read.mockResolvedValueOnce({ value: null, version: 4 });
		expect(await executeWorkspaceDataReadStep(params)).toEqual({
			success: true,
			output: { value: null, version: 4, found: true },
		});
	});

	it("writes nested quoted JSON and returns only the new version", async () => {
		expect(await executeWorkspaceDataWriteStep(writeParams)).toEqual({
			success: true,
			output: { version: 3 },
		});
		expect(mocks.write).toHaveBeenCalledWith(
			expect.objectContaining({
				key: "selected",
				scope: "mine",
				expectedVersion: 2,
				value: writeParams.inputs.Transform.result,
			}),
		);
	});

	it.each(["permission", "access", "edit", "framePermission"] as const)(
		"rechecks current %s before writing",
		async (check) => {
			mocks[check].mockResolvedValue(false);
			expect(
				(await executeWorkspaceDataWriteStep(writeParams)).success,
			).toBe(false);
			expect(mocks.write).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ frameId: "foreign" },
		{ collection: "other" },
		{ scope: "shared" },
		{ key: "foreign" },
		{ userId: "forged" },
	])("refuses forged or modified config %j", async (change) => {
		expect(
			(
				await executeWorkspaceDataReadStep({
					...params,
					nodeConfig: { ...config, ...change },
				})
			).success,
		).toBe(false);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it.each([
		"organizationId",
		"projectId",
		"workflowId",
		"executionId",
		"nodeId",
	] as const)("refuses missing %s", async (field) => {
		expect(
			(
				await executeWorkspaceDataReadStep({
					...params,
					[field]: undefined,
				})
			).success,
		).toBe(false);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("refuses a foreign execution, absent snapshot, or different node type", async () => {
		mocks.execution.mockResolvedValueOnce(null);
		expect((await executeWorkspaceDataReadStep(params)).success).toBe(
			false,
		);
		mocks.snapshot.mockResolvedValueOnce(null);
		expect((await executeWorkspaceDataReadStep(params)).success).toBe(
			false,
		);
		expect((await executeWorkspaceDataReadStep(writeParams)).success).toBe(
			false,
		);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it.each([
		{ projectId: "other" },
		{ version: 4 },
		{ publishedVersion: 2 },
		{ updatedAt: new Date("2026-01-02T12:00:00Z") },
		{ status: "DRAFT" },
	])("refuses edited or moved workflow %j", async (change) => {
		mocks.workflow.mockResolvedValue({ ...workflow, ...change });
		expect((await executeWorkspaceDataReadStep(params)).success).toBe(
			false,
		);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("refuses revoked grants and foreign frames", async () => {
		mocks.grant.mockResolvedValueOnce(null);
		expect((await executeWorkspaceDataReadStep(params)).success).toBe(
			false,
		);
		mocks.frame.mockResolvedValueOnce({
			userId: "owner",
			projectId: "other",
		});
		expect((await executeWorkspaceDataReadStep(params)).success).toBe(
			false,
		);
		mocks.frame.mockResolvedValueOnce({
			userId: "other",
			projectId: "project",
		});
		expect((await executeWorkspaceDataReadStep(params)).success).toBe(
			false,
		);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("refuses grant versions and stamps that differ from its execution", async () => {
		for (const grant of [
			{
				authorizedWorkflowVersion: 2,
				authorizedWorkflowUpdatedAt: stamp.toISOString(),
			},
			{
				authorizedWorkflowVersion: 3,
				authorizedWorkflowUpdatedAt: "2026-01-02T12:00:00.000Z",
			},
		]) {
			mocks.grant.mockResolvedValueOnce({
				frame: {
					id: "workspace",
					projectId: "project",
					updatedAt: stamp,
				},
				grant,
			});
			expect((await executeWorkspaceDataReadStep(params)).success).toBe(
				false,
			);
		}
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("fails malformed JSON and invalid or unresolved versions before mutation", async () => {
		for (const result of ["unquoted text", undefined]) {
			const response = await executeWorkspaceDataWriteStep({
				...writeParams,
				inputs: { ...writeParams.inputs, Transform: { result } },
			});
			expect(response.success).toBe(false);
		}
		for (const version of [-1, 1.5, "", "two", null]) {
			const response = await executeWorkspaceDataWriteStep({
				...writeParams,
				inputs: { ...writeParams.inputs, Read: { version } },
			});
			expect(response.success).toBe(false);
		}
		expect(mocks.write).not.toHaveBeenCalled();
	});

	it("does not turn a conflict into success or a second write", async () => {
		mocks.write.mockRejectedValueOnce(
			new Error("Record is at version 3, not 2"),
		);
		expect(await executeWorkspaceDataWriteStep(writeParams)).toEqual({
			success: false,
			error: "Record is at version 3, not 2",
		});
		expect(mocks.write).toHaveBeenCalledTimes(1);
	});
});
