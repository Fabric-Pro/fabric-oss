/**
 * The workflow reads behind the oRPC procedures and the gateway's list, get and
 * get-execution tools. Each asks the actor's live membership and read
 * permission, and reaches only workflows the actor owns in their organization.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	membership: vi.fn(),
	canRead: vi.fn(),
	getWorkflowById: vi.fn(),
	listWorkflows: vi.fn(),
	listExecutions: vi.fn(),
	getExecution: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	canReadOrganizationWorkflows: mocks.canRead,
	getWorkflowById: mocks.getWorkflowById,
	listWorkflows: mocks.listWorkflows,
	listWorkflowExecutions: mocks.listExecutions,
	getWorkflowExecutionById: mocks.getExecution,
}));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.membership,
}));

import { WorkflowCommandError } from "../workflow-command-context";
import {
	getWorkflowCommand,
	getWorkflowExecutionCommand,
	getWorkflowWithLatestRunCommand,
	listWorkflowsCommand,
} from "../workflow-read-commands";

const ORG = "org-example-a";
const USER = "user-1";
const actor = { userId: USER, organizationId: ORG };

async function refusal(promise: Promise<unknown>) {
	const error = await promise.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(WorkflowCommandError);
	return error as WorkflowCommandError;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.membership.mockResolvedValue({ role: "member" });
	mocks.canRead.mockResolvedValue(true);
	mocks.getWorkflowById.mockResolvedValue({ id: "wf-1", name: "Weekly" });
	mocks.listWorkflows.mockResolvedValue({ workflows: [], total: 0 });
	mocks.listExecutions.mockResolvedValue({ executions: [] });
	mocks.getExecution.mockResolvedValue({ id: "exec-1" });
});

describe("listWorkflowsCommand", () => {
	it("applies the actor's project before listing and counting with pagination", async () => {
		await listWorkflowsCommand(
			{ ...actor, projectRestrictionId: "project-1" },
			{ limit: 1, offset: 2 },
		);
		expect(mocks.listWorkflows).toHaveBeenCalledExactlyOnceWith({
			userId: USER,
			organizationId: ORG,
			projectId: "project-1",
			limit: 1,
			offset: 2,
		});
		await expect(
			listWorkflowsCommand(
				{ ...actor, projectRestrictionId: "project-1" },
				{
					projectId: "project-2",
				},
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.listWorkflows).toHaveBeenCalledOnce();
	});
	it("lists the actor's workflows in their organization with the filters given", async () => {
		await listWorkflowsCommand(actor, { limit: 5, status: "PUBLISHED" });

		expect(mocks.listWorkflows).toHaveBeenCalledExactlyOnceWith({
			limit: 5,
			status: "PUBLISHED",
			userId: USER,
			organizationId: ORG,
		});
	});

	it("never lets a filter name another user or organization", async () => {
		await listWorkflowsCommand(actor, {
			userId: "someone-else",
			organizationId: "org-example-b",
		} as never);

		expect(mocks.listWorkflows).toHaveBeenCalledWith(
			expect.objectContaining({ userId: USER, organizationId: ORG }),
		);
	});

	it("refuses a non-member, and an actor who may not read, without listing", async () => {
		mocks.membership.mockResolvedValue(null);
		const nonMember = await refusal(listWorkflowsCommand(actor, {}));
		expect(nonMember.code).toBe("FORBIDDEN");

		mocks.membership.mockResolvedValue({ role: "member" });
		mocks.canRead.mockResolvedValue(false);
		const noPermission = await refusal(listWorkflowsCommand(actor, {}));
		expect(noPermission.code).toBe("FORBIDDEN");

		expect(mocks.listWorkflows).not.toHaveBeenCalled();
	});
});

describe("getWorkflowCommand", () => {
	it.each(["project-2", null])(
		"refuses workflow project %s before reading its latest run",
		async (projectId) => {
			mocks.getWorkflowById.mockResolvedValue({ id: "wf-1", projectId });
			await expect(
				getWorkflowWithLatestRunCommand(
					{ ...actor, projectRestrictionId: "project-1" },
					"wf-1",
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(mocks.listExecutions).not.toHaveBeenCalled();
		},
	);
	it("reads the workflow with the owner and the organization in the filter", async () => {
		const workflow = await getWorkflowCommand(actor, "wf-1");

		expect(workflow.id).toBe("wf-1");
		expect(mocks.getWorkflowById).toHaveBeenCalledExactlyOnceWith(
			"wf-1",
			USER,
			ORG,
		);
	});

	it("reports a workflow the actor does not own as not found", async () => {
		mocks.getWorkflowById.mockResolvedValue(null);

		const error = await refusal(getWorkflowCommand(actor, "wf-1"));

		expect(error.code).toBe("NOT_FOUND");
	});

	it("refuses an actor who may not read workflows", async () => {
		mocks.canRead.mockResolvedValue(false);

		const error = await refusal(getWorkflowCommand(actor, "wf-1"));

		expect(error.code).toBe("FORBIDDEN");
		expect(error.message).toContain("read workflows");
	});
});

describe("getWorkflowWithLatestRunCommand", () => {
	it("returns the workflow with its most recent run, summarised", async () => {
		mocks.listExecutions.mockResolvedValue({
			executions: [
				{
					id: "exec-9",
					status: "COMPLETED",
					startedAt: new Date("2026-10-14T09:00:00Z"),
					completedAt: new Date("2026-10-14T09:01:00Z"),
					duration: 60_000,
					error: null,
					output: { "publish-frame": { frameId: "frame-1" } },
				},
			],
		});

		const detail = await getWorkflowWithLatestRunCommand(actor, "wf-1");

		expect(detail.workflow.id).toBe("wf-1");
		expect(detail.latestRun).toMatchObject({
			id: "exec-9",
			status: "COMPLETED",
			durationMs: 60_000,
			frameId: "frame-1",
		});
		expect(mocks.listExecutions).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowId: "wf-1",
				userId: USER,
				organizationId: ORG,
				limit: 1,
			}),
		);
	});

	it("returns no run for a workflow that has never run", async () => {
		const detail = await getWorkflowWithLatestRunCommand(actor, "wf-1");

		expect(detail.latestRun).toBeNull();
	});

	it("checks access once, not once for the workflow and again for its runs", async () => {
		await getWorkflowWithLatestRunCommand(actor, "wf-1");

		expect(mocks.membership).toHaveBeenCalledOnce();
		expect(mocks.canRead).toHaveBeenCalledOnce();
		expect(mocks.getWorkflowById).toHaveBeenCalledOnce();
	});

	it("reads no runs of a workflow the actor does not own", async () => {
		mocks.getWorkflowById.mockResolvedValue(null);

		await refusal(getWorkflowWithLatestRunCommand(actor, "wf-1"));

		expect(mocks.listExecutions).not.toHaveBeenCalled();
	});
});

describe("getWorkflowExecutionCommand", () => {
	it("refuses an execution with no workflow under a project restriction", async () => {
		mocks.getExecution.mockResolvedValue({
			id: "exec-1",
			workflowId: null,
		});
		await expect(
			getWorkflowExecutionCommand(
				{ ...actor, projectRestrictionId: "project-1" },
				"exec-1",
			),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Execution not found",
		});
		expect(mocks.getWorkflowById).not.toHaveBeenCalled();
	});
	it.each(["project-2", null])(
		"refuses execution output and logs when its workflow project is %s",
		async (projectId) => {
			mocks.getExecution.mockResolvedValue({
				id: "exec-1",
				workflowId: "wf-1",
				output: "private",
				logs: ["private"],
			});
			mocks.getWorkflowById.mockResolvedValue({ id: "wf-1", projectId });
			await expect(
				getWorkflowExecutionCommand(
					{ ...actor, projectRestrictionId: "project-1" },
					"exec-1",
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(mocks.getWorkflowById).toHaveBeenCalledWith(
				"wf-1",
				USER,
				ORG,
			);
		},
	);

	it("returns an execution after resolving its workflow's matching project", async () => {
		mocks.getExecution.mockResolvedValue({
			id: "exec-1",
			workflowId: "wf-1",
		});
		mocks.getWorkflowById.mockResolvedValue({
			id: "wf-1",
			projectId: "project-1",
		});
		await expect(
			getWorkflowExecutionCommand(
				{ ...actor, projectRestrictionId: "project-1" },
				"exec-1",
			),
		).resolves.toMatchObject({ id: "exec-1" });
	});
	it("reads the execution scoped to the actor", async () => {
		const execution = await getWorkflowExecutionCommand(actor, "exec-1");

		expect(execution.id).toBe("exec-1");
		expect(mocks.getExecution).toHaveBeenCalledExactlyOnceWith(
			"exec-1",
			USER,
			ORG,
		);
	});

	it("reports an execution the actor cannot reach as not found", async () => {
		mocks.getExecution.mockResolvedValue(null);

		const error = await refusal(
			getWorkflowExecutionCommand(actor, "exec-1"),
		);

		expect(error.code).toBe("NOT_FOUND");
	});

	it("refuses a non-member before reading anything", async () => {
		mocks.membership.mockResolvedValue(null);

		const error = await refusal(
			getWorkflowExecutionCommand(actor, "exec-1"),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.getExecution).not.toHaveBeenCalled();
	});
});
