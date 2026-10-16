/**
 * The workflow commands are the one implementation behind the oRPC procedures
 * and the MCP gateway tools, so their refusals are the tenancy and permission
 * boundary of both. Every refusal case asserts that nothing was written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	membership: vi.fn(),
	canCreate: vi.fn(),
	canUpdate: vi.fn(),
	canRun: vi.fn(),
	canRead: vi.fn(),
	getWorkflowById: vi.fn(),
	createWorkflow: vi.fn(),
	updateWorkflow: vi.fn(),
	projectPlacement: vi.fn(),
	canEditProject: vi.fn(),
	workflowUpdate: vi.fn(),
	versionCreate: vi.fn(),
	versionFindFirst: vi.fn(),
	listExecutions: vi.fn(),
	reserve: vi.fn(),
	temporalAvailable: vi.fn(),
	start: vi.fn(),
	describe: vi.fn(),
	markRunning: vi.fn(),
	executionUpdate: vi.fn(),
	syncSchedule: vi.fn(),
	findScheduleCron: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		workflow: { update: mocks.workflowUpdate },
		workflowVersion: {
			create: mocks.versionCreate,
			findFirst: mocks.versionFindFirst,
		},
		workflowExecution: { update: mocks.executionUpdate },
	},
	canCreateOrganizationWorkflows: mocks.canCreate,
	canUpdateOrganizationWorkflows: mocks.canUpdate,
	canRunOrganizationWorkflows: mocks.canRun,
	canReadOrganizationWorkflows: mocks.canRead,
	getWorkflowById: mocks.getWorkflowById,
	createWorkflow: mocks.createWorkflow,
	updateWorkflow: mocks.updateWorkflow,
	projectPlacementRefusal: mocks.projectPlacement,
	canEditProject: mocks.canEditProject,
	isWorkflowLive: (status: string) =>
		status === "PUBLISHED" || status === "ACTIVE",
	BUILT_IN_TO_FABRIC_TOOLS: {},
	ownMcpConfigIds: vi.fn(async () => []),
	listWorkflowExecutions: mocks.listExecutions,
	markExecutionRunningIfPending: mocks.markRunning,
	createWorkflowExecutionIdempotent: vi.fn(),
	releasedIdempotencyTriggerInput: () => undefined,
}));

vi.mock("@repo/temporal", () => ({
	findScheduleCron: mocks.findScheduleCron,
	isTemporalAvailable: mocks.temporalAvailable,
	// No client is exactly what "the engine is unavailable" means to the start.
	getTemporalClient: async () => {
		if (!(await mocks.temporalAvailable())) {
			throw new Error("Temporal is unavailable");
		}
		return {
			workflow: {
				start: mocks.start,
				getHandle: () => ({ describe: mocks.describe }),
			},
		};
	},
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => `enc(${value})`,
	decryptApiKeyMaybe: (value: string | null) => value,
}));

vi.mock("../sync-workflow-schedule", () => ({
	syncWorkflowSchedule: mocks.syncSchedule,
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.membership,
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));

vi.mock("../execution-concurrency", async (importOriginal) => ({
	...(await importOriginal<typeof import("../execution-concurrency")>()),
	createExecutionWithinConcurrencyCap: mocks.reserve,
}));

import { PUBLISH_FRAME_NODE_TYPE } from "@repo/temporal/agentic-workflow-preset";
import {
	loadEditableWorkflow,
	WorkflowCommandError,
} from "../workflow-command-context";
import {
	applyWorkflowUpdate,
	createWorkflowCommand,
	pauseWorkflowCommand,
	publishWorkflowCommand,
	resumeWorkflowCommand,
	unpublishWorkflowCommand,
	updateWorkflowCommand,
} from "../workflow-commands";
import {
	listWorkflowRunsCommand,
	startWorkflowExecutionCommand,
} from "../workflow-execution-commands";

const ORG_A = "org-example-a";
const ORG_B = "org-example-b";
const USER = "user-1";
const actor = { userId: USER, organizationId: ORG_A };

const TRIGGER_NODE = {
	id: "trigger",
	type: "trigger",
	data: {
		label: "Schedule",
		config: { triggerType: "schedule", scheduleCron: "0 9 * * 1" },
	},
};
const ACTION_NODE = {
	id: "action",
	type: "http-request",
	data: { label: "Call", config: { url: "https://example.com" } },
};
const EDGES = [{ id: "e1", source: "trigger", target: "action" }];

function workflow(overrides: Record<string, unknown> = {}) {
	return {
		id: "wf-1",
		name: "Weekly report",
		userId: USER,
		organizationId: ORG_A,
		projectId: null,
		status: "DRAFT",
		version: 1,
		publishedAt: null,
		triggerType: "MANUAL",
		nodes: [TRIGGER_NODE, ACTION_NODE],
		edges: EDGES,
		variables: null,
		settings: null,
		triggerConfig: null,
		webhookSecret: null,
		...overrides,
	};
}

async function refusal(
	promise: Promise<unknown>,
): Promise<WorkflowCommandError> {
	const error = await promise.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(WorkflowCommandError);
	return error as WorkflowCommandError;
}

function expectNoWrite() {
	expect(mocks.createWorkflow).not.toHaveBeenCalled();
	expect(mocks.updateWorkflow).not.toHaveBeenCalled();
	expect(mocks.workflowUpdate).not.toHaveBeenCalled();
	expect(mocks.versionCreate).not.toHaveBeenCalled();
	expect(mocks.reserve).not.toHaveBeenCalled();
	expect(mocks.syncSchedule).not.toHaveBeenCalled();
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.membership.mockResolvedValue({ role: "member" });
	mocks.canCreate.mockResolvedValue(true);
	mocks.canUpdate.mockResolvedValue(true);
	mocks.canRun.mockResolvedValue(true);
	mocks.canRead.mockResolvedValue(true);
	mocks.getWorkflowById.mockImplementation(
		async (_id: string, userId: string, organizationId?: string) =>
			userId === USER && organizationId === ORG_A ? workflow() : null,
	);
	mocks.createWorkflow.mockImplementation(async (data: object) => ({
		id: "wf-new",
		...data,
	}));
	mocks.updateWorkflow.mockImplementation(
		async (_id: string, _user: string, patch: object) => ({
			...workflow(),
			...patch,
		}),
	);
	mocks.projectPlacement.mockResolvedValue(null);
	mocks.canEditProject.mockResolvedValue(true);
	mocks.workflowUpdate.mockResolvedValue({});
	mocks.versionCreate.mockResolvedValue({});
	mocks.versionFindFirst.mockResolvedValue({ version: 2 });
	mocks.syncSchedule.mockResolvedValue({ outcome: "none", reason: "test" });
	mocks.findScheduleCron.mockReturnValue("0 9 * * 1");
	mocks.reserve.mockResolvedValue({
		allowed: true,
		execution: {
			id: "exec-1",
			status: "PENDING",
			startedAt: new Date("2026-10-14T09:00:00Z"),
			triggerInput: {},
		},
		inFlight: 1,
		limit: 25,
	});
	mocks.temporalAvailable.mockResolvedValue(true);
	mocks.start.mockResolvedValue({ workflowId: "temporal-1" });
	mocks.markRunning.mockResolvedValue(true);
	mocks.executionUpdate.mockResolvedValue({});
});

describe("create", () => {
	it("creates a draft for the actor in their organization", async () => {
		const created = await createWorkflowCommand(actor, { name: "Weekly" });

		expect(mocks.createWorkflow).toHaveBeenCalledWith({
			name: "Weekly",
			userId: USER,
			organizationId: ORG_A,
		});
		expect(created.id).toBe("wf-new");
	});

	it("refuses a non-member and writes nothing", async () => {
		mocks.membership.mockResolvedValue(null);

		const error = await refusal(
			createWorkflowCommand(actor, { name: "x" }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expectNoWrite();
	});

	it("refuses an actor whose role cannot create workflows now", async () => {
		mocks.canCreate.mockResolvedValue(false);

		const error = await refusal(
			createWorkflowCommand(actor, { name: "x" }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expectNoWrite();
	});

	it("asks the shared placement check about the actor and their organization", async () => {
		await createWorkflowCommand(actor, {
			name: "x",
			projectId: "project-a",
		});

		expect(mocks.projectPlacement).toHaveBeenCalledExactlyOnceWith({
			userId: USER,
			organizationId: ORG_A,
			projectId: "project-a",
		});
	});

	it("refuses a project the placement check reports missing (another organization, hidden, or in the trash) and writes nothing", async () => {
		mocks.projectPlacement.mockResolvedValue("not_found");

		const error = await refusal(
			createWorkflowCommand(actor, { name: "x", projectId: "project-b" }),
		);

		expect(error.code).toBe("NOT_FOUND");
		expectNoWrite();
	});

	it("refuses a project the actor cannot edit and writes nothing", async () => {
		mocks.projectPlacement.mockResolvedValue("not_editable");

		const error = await refusal(
			createWorkflowCommand(actor, { name: "x", projectId: "project-a" }),
		);

		expect(error.code).toBe("NOT_FOUND");
		expectNoWrite();
	});
});

describe("update", () => {
	it("does not reach a workflow of another organization the owner also belongs to", async () => {
		mocks.getWorkflowById.mockResolvedValue(null);

		const error = await refusal(
			updateWorkflowCommand(
				{ userId: USER, organizationId: ORG_B },
				{ id: "wf-1", name: "renamed" },
			),
		);

		expect(error.code).toBe("NOT_FOUND");
		expect(mocks.getWorkflowById).toHaveBeenCalledWith("wf-1", USER, ORG_B);
		expectNoWrite();
	});

	it("refuses a colleague who does not own the workflow", async () => {
		mocks.getWorkflowById.mockResolvedValue(null);

		const error = await refusal(
			updateWorkflowCommand(actor, { id: "wf-1", name: "renamed" }),
		);

		expect(error.code).toBe("NOT_FOUND");
		expectNoWrite();
	});

	it("refuses an actor who lost the permission to edit", async () => {
		mocks.canUpdate.mockResolvedValue(false);

		const error = await refusal(
			updateWorkflowCommand(actor, { id: "wf-1", name: "renamed" }),
		);

		expect(error.code).toBe("FORBIDDEN");
		expectNoWrite();
	});

	it("refuses to take an invalid agent step live, and writes nothing", async () => {
		mocks.getWorkflowById.mockResolvedValue(
			workflow({ status: "PUBLISHED" }),
		);

		const error = await refusal(
			updateWorkflowCommand(actor, {
				id: "wf-1",
				nodes: [
					TRIGGER_NODE,
					{
						id: "agent",
						type: "agent-task",
						data: { label: "Agent Task", config: { prompt: "" } },
					},
				],
			}),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toContain("Agent Task");
		expectNoWrite();
	});

	it("lets a draft carry an unfinished agent step", async () => {
		await updateWorkflowCommand(actor, {
			id: "wf-1",
			nodes: [
				{
					id: "agent",
					type: "agent-task",
					data: { label: "Agent Task", config: { prompt: "" } },
				},
			],
		});

		expect(mocks.updateWorkflow).toHaveBeenCalled();
		expect(mocks.syncSchedule).not.toHaveBeenCalled();
	});
});

describe("publish", () => {
	it("refuses a graph with an invalid agent step, and writes nothing", async () => {
		mocks.getWorkflowById.mockResolvedValue(
			workflow({
				nodes: [
					TRIGGER_NODE,
					{
						id: "agent",
						type: "agent-task",
						data: { label: "Agent Task", config: { prompt: "" } },
					},
					{
						id: "frame",
						type: PUBLISH_FRAME_NODE_TYPE,
						data: { label: "Publish Frame", config: {} },
					},
				],
				edges: [
					{ id: "e1", source: "trigger", target: "agent" },
					{ id: "e2", source: "agent", target: "frame" },
				],
			}),
		);

		const outcome = await publishWorkflowCommand(actor, {
			workflowId: "wf-1",
			skipValidation: true,
		});

		expect(outcome.success).toBe(false);
		expect(outcome.validation.errors.join(" ")).toContain("Agent Task");
		expectNoWrite();
	});

	it("publishes a valid graph as the next version and syncs the schedule live", async () => {
		const outcome = await publishWorkflowCommand(actor, {
			workflowId: "wf-1",
		});

		expect(outcome.success).toBe(true);
		expect(mocks.versionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					version: 3,
					organizationId: ORG_A,
					createdBy: USER,
				}),
			}),
		);
		expect(mocks.workflowUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "PUBLISHED",
					triggerType: "SCHEDULE",
				}),
			}),
		);
		expect(mocks.syncSchedule).toHaveBeenCalledWith(
			expect.objectContaining({ workflowId: "wf-1", active: true }),
		);
	});

	it("refuses another organization's workflow and writes nothing", async () => {
		const error = await refusal(
			publishWorkflowCommand(
				{ userId: USER, organizationId: ORG_B },
				{ workflowId: "wf-1" },
			),
		);

		expect(error.code).toBe("NOT_FOUND");
		expectNoWrite();
	});
});

describe("unpublish, pause and resume", () => {
	it("unpublish reverts to draft and takes the schedule down", async () => {
		await unpublishWorkflowCommand(actor, "wf-1");

		expect(mocks.workflowUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ data: { status: "DRAFT" } }),
		);
		expect(mocks.syncSchedule).toHaveBeenCalledWith(
			expect.objectContaining({ active: false }),
		);
	});

	it("pause sets PAUSED and removes the schedule", async () => {
		mocks.getWorkflowById.mockResolvedValue(
			workflow({ status: "PUBLISHED", publishedAt: new Date() }),
		);

		await pauseWorkflowCommand(actor, "wf-1");

		expect(mocks.updateWorkflow).toHaveBeenCalledWith(
			"wf-1",
			USER,
			{ status: "PAUSED" },
			ORG_A,
		);
		expect(mocks.syncSchedule).toHaveBeenCalledWith(
			expect.objectContaining({ active: false }),
		);
	});

	it("pause on a paused workflow and resume on a live one change nothing", async () => {
		mocks.getWorkflowById.mockResolvedValue(
			workflow({ status: "PAUSED", publishedAt: new Date() }),
		);
		await pauseWorkflowCommand(actor, "wf-1");

		mocks.getWorkflowById.mockResolvedValue(
			workflow({ status: "PUBLISHED", publishedAt: new Date() }),
		);
		await resumeWorkflowCommand(actor, "wf-1");

		expectNoWrite();
	});

	it("pause refuses a draft", async () => {
		const error = await refusal(pauseWorkflowCommand(actor, "wf-1"));

		expect(error.code).toBe("BAD_REQUEST");
		expectNoWrite();
	});

	it("resume returns a paused workflow to PUBLISHED on its schedule", async () => {
		mocks.getWorkflowById.mockResolvedValue(
			workflow({ status: "PAUSED", publishedAt: new Date() }),
		);
		mocks.updateWorkflow.mockResolvedValue(
			workflow({ status: "PUBLISHED", publishedAt: new Date() }),
		);

		await resumeWorkflowCommand(actor, "wf-1");

		expect(mocks.updateWorkflow).toHaveBeenCalledWith(
			"wf-1",
			USER,
			{ status: "PUBLISHED" },
			ORG_A,
		);
		expect(mocks.syncSchedule).toHaveBeenCalledWith(
			expect.objectContaining({ active: true }),
		);
	});

	it("resume refuses a workflow that is not paused, and one never published", async () => {
		const notPaused = await refusal(resumeWorkflowCommand(actor, "wf-1"));
		expect(notPaused.code).toBe("BAD_REQUEST");

		mocks.getWorkflowById.mockResolvedValue(
			workflow({ status: "PAUSED", publishedAt: null }),
		);
		const neverPublished = await refusal(
			resumeWorkflowCommand(actor, "wf-1"),
		);
		expect(neverPublished.message).toContain("never been published");
		expectNoWrite();
	});
});

describe("loadEditableWorkflow", () => {
	it("starts the membership, the permission and the row together", async () => {
		const resolvers: Array<() => void> = [];
		const held = <T>(value: T) =>
			new Promise<T>((resolve) => {
				resolvers.push(() => resolve(value));
			});
		mocks.membership.mockReturnValue(held({ role: "member" }));
		mocks.canUpdate.mockReturnValue(held(true));
		mocks.getWorkflowById.mockReturnValue(held(workflow()));

		const loading = loadEditableWorkflow(actor, "wf-1", "edit");

		expect(mocks.membership).toHaveBeenCalledOnce();
		expect(mocks.canUpdate).toHaveBeenCalledOnce();
		expect(mocks.getWorkflowById).toHaveBeenCalledOnce();
		for (const resolve of resolvers) {
			resolve();
		}
		expect((await loading).id).toBe("wf-1");
	});

	it("tells a non-member so, before anything else", async () => {
		mocks.membership.mockResolvedValue(null);
		mocks.canUpdate.mockResolvedValue(false);
		mocks.getWorkflowById.mockResolvedValue(null);

		const error = await refusal(
			loadEditableWorkflow(actor, "wf-1", "edit"),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(error.message).toContain("not a member");
	});

	it("names the operation when the permission is missing, before reporting a missing row", async () => {
		mocks.canUpdate.mockResolvedValue(false);
		mocks.getWorkflowById.mockResolvedValue(null);

		const error = await refusal(
			loadEditableWorkflow(actor, "wf-1", "publish"),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(error.message).toBe(
			"You do not have permission to publish workflows in this organization",
		);
	});

	it("reports a row the actor does not own as missing", async () => {
		mocks.getWorkflowById.mockResolvedValue(null);

		const error = await refusal(
			loadEditableWorkflow(actor, "wf-1", "edit"),
		);

		expect(error.code).toBe("NOT_FOUND");
	});

	it("does not ask whether the workflow's organization admits the actor a second way", async () => {
		await loadEditableWorkflow(actor, "wf-1", "edit");

		expect(mocks.getWorkflowById).toHaveBeenCalledExactlyOnceWith(
			"wf-1",
			USER,
			ORG_A,
		);
	});
});

describe("one load per command", () => {
	it("pause reads the workflow once", async () => {
		mocks.getWorkflowById.mockResolvedValue(
			workflow({ status: "PUBLISHED", publishedAt: new Date() }),
		);

		await pauseWorkflowCommand(actor, "wf-1");

		expect(mocks.getWorkflowById).toHaveBeenCalledOnce();
		expect(mocks.membership).toHaveBeenCalledOnce();
		expect(mocks.canUpdate).toHaveBeenCalledOnce();
	});

	it("resume reads the workflow once", async () => {
		mocks.getWorkflowById.mockResolvedValue(
			workflow({ status: "PAUSED", publishedAt: new Date() }),
		);

		await resumeWorkflowCommand(actor, "wf-1");

		expect(mocks.getWorkflowById).toHaveBeenCalledOnce();
		expect(mocks.membership).toHaveBeenCalledOnce();
		expect(mocks.canUpdate).toHaveBeenCalledOnce();
	});

	it("applyWorkflowUpdate changes a workflow it was handed without reading it", async () => {
		const current = await loadEditableWorkflow(actor, "wf-1", "edit");
		mocks.getWorkflowById.mockClear();
		mocks.membership.mockClear();
		mocks.canUpdate.mockClear();

		await applyWorkflowUpdate(actor, current, {
			id: "wf-1",
			name: "renamed",
		});

		expect(mocks.updateWorkflow).toHaveBeenCalledWith(
			"wf-1",
			USER,
			{ name: "renamed" },
			ORG_A,
		);
		expect(mocks.getWorkflowById).not.toHaveBeenCalled();
		expect(mocks.membership).not.toHaveBeenCalled();
		expect(mocks.canUpdate).not.toHaveBeenCalled();
	});

	it("applyWorkflowUpdate still holds a live workflow's agent step to the publish checks", async () => {
		const current = workflow({ status: "PUBLISHED" });

		const error = await refusal(
			applyWorkflowUpdate(actor, current as never, {
				id: "wf-1",
				nodes: [
					{
						id: "agent",
						type: "agent-task",
						data: { label: "Agent Task", config: { prompt: "" } },
					},
				],
			}),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(mocks.updateWorkflow).not.toHaveBeenCalled();
	});
});

describe("start", () => {
	it("starts a published scheduled workflow now, whatever its trigger", async () => {
		mocks.getWorkflowById.mockResolvedValue(
			workflow({
				status: "PUBLISHED",
				triggerType: "SCHEDULE",
				publishedAt: new Date(),
			}),
		);

		const outcome = await startWorkflowExecutionCommand(actor, {
			workflowId: "wf-1",
			requirePublished: true,
			source: "mcp-gateway",
		});

		expect(outcome.status).toBe("started");
		expect(outcome.temporalWorkflowId).toBe("temporal-1");
		expect(mocks.reserve).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: USER,
				organizationId: ORG_A,
				data: expect.objectContaining({
					triggerType: "MANUAL",
					triggerInput: expect.objectContaining({
						source: "mcp-gateway",
					}),
				}),
			}),
		);
	});

	it("refuses a draft when a published workflow is required, and creates no run", async () => {
		const error = await refusal(
			startWorkflowExecutionCommand(actor, {
				workflowId: "wf-1",
				requirePublished: true,
			}),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(mocks.reserve).not.toHaveBeenCalled();
	});

	it("lets the builder run a draft", async () => {
		const outcome = await startWorkflowExecutionCommand(actor, {
			workflowId: "wf-1",
		});

		expect(outcome.status).toBe("started");
	});

	it("refuses an actor without the permission to run, and another organization's workflow", async () => {
		mocks.canRun.mockResolvedValue(false);
		const forbidden = await refusal(
			startWorkflowExecutionCommand(actor, { workflowId: "wf-1" }),
		);
		expect(forbidden.code).toBe("FORBIDDEN");

		mocks.canRun.mockResolvedValue(true);
		const notFound = await refusal(
			startWorkflowExecutionCommand(
				{ userId: USER, organizationId: ORG_B },
				{ workflowId: "wf-1" },
			),
		);
		expect(notFound.code).toBe("NOT_FOUND");
		expect(mocks.reserve).not.toHaveBeenCalled();
	});

	it("records FAILED and says so when the engine is unavailable", async () => {
		mocks.temporalAvailable.mockResolvedValue(false);

		const outcome = await startWorkflowExecutionCommand(actor, {
			workflowId: "wf-1",
		});

		expect(outcome).toMatchObject({
			status: "failed",
			failure: "engine-unavailable",
		});
		expect(mocks.executionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
	});

	it("tells an engine that refused the start from one that was never reached", async () => {
		mocks.start.mockRejectedValue(new Error("task queue closed"));
		const notFound = new Error("WorkflowNotFoundError");
		notFound.name = "WorkflowNotFoundError";
		mocks.describe.mockRejectedValue(notFound);

		const outcome = await startWorkflowExecutionCommand(actor, {
			workflowId: "wf-1",
		});

		expect(outcome).toMatchObject({
			status: "failed",
			failure: "start-rejected",
		});
	});

	it("refuses a graph the validator rejects, before reserving anything", async () => {
		mocks.getWorkflowById.mockResolvedValue(
			workflow({ nodes: [], edges: [] }),
		);

		const error = await refusal(
			startWorkflowExecutionCommand(actor, { workflowId: "wf-1" }),
		);

		expect(error.code).toBe("BAD_REQUEST");
		expect(error.message).toContain("Workflow validation failed");
		expect(mocks.reserve).not.toHaveBeenCalled();
	});

	it("reads the workflow once to decide who may start it", async () => {
		await startWorkflowExecutionCommand(actor, { workflowId: "wf-1" });

		expect(mocks.getWorkflowById).toHaveBeenCalledOnce();
		expect(mocks.membership).toHaveBeenCalledOnce();
		expect(mocks.canRun).toHaveBeenCalledOnce();
	});
});

describe("start in a confirmed project", () => {
	const published = (projectId: string | null) =>
		workflow({ status: "PUBLISHED", projectId, publishedAt: new Date() });

	it("starts a workflow that belongs to the project, when the actor can still edit it", async () => {
		mocks.getWorkflowById.mockResolvedValue(published("project-a"));

		const outcome = await startWorkflowExecutionCommand(actor, {
			workflowId: "wf-1",
			requirePublished: true,
			confirmedProjectId: "project-a",
		});

		expect(outcome.status).toBe("started");
		expect(mocks.canEditProject).toHaveBeenCalledWith("project-a", USER);
	});

	it("refuses a workflow that belongs to another project, and reserves nothing", async () => {
		mocks.getWorkflowById.mockResolvedValue(published("project-b"));

		const error = await refusal(
			startWorkflowExecutionCommand(actor, {
				workflowId: "wf-1",
				requirePublished: true,
				confirmedProjectId: "project-a",
			}),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(error.message).toContain("confirmed project");
		expect(mocks.reserve).not.toHaveBeenCalled();
	});

	it("refuses a workflow with no project at all", async () => {
		mocks.getWorkflowById.mockResolvedValue(published(null));

		const error = await refusal(
			startWorkflowExecutionCommand(actor, {
				workflowId: "wf-1",
				requirePublished: true,
				confirmedProjectId: "project-a",
			}),
		);

		expect(error.code).toBe("FORBIDDEN");
	});

	it("refuses when the actor's right to edit the project was revoked since", async () => {
		mocks.getWorkflowById.mockResolvedValue(published("project-a"));
		mocks.canEditProject.mockResolvedValue(false);

		const error = await refusal(
			startWorkflowExecutionCommand(actor, {
				workflowId: "wf-1",
				requirePublished: true,
				confirmedProjectId: "project-a",
			}),
		);

		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.reserve).not.toHaveBeenCalled();
	});

	it("asks nothing about a project when none was confirmed", async () => {
		await startWorkflowExecutionCommand(actor, { workflowId: "wf-1" });

		expect(mocks.canEditProject).not.toHaveBeenCalled();
	});
});

describe("run history", () => {
	it("returns bounded run summaries with the frame a run published", async () => {
		mocks.listExecutions.mockResolvedValue({
			executions: [
				{
					id: "exec-1",
					status: "COMPLETED",
					startedAt: new Date("2026-10-14T09:00:00Z"),
					completedAt: new Date("2026-10-14T09:01:00Z"),
					duration: 60_000,
					error: null,
					output: {
						"agent-task": { text: "done" },
						"publish-frame": { frameId: "frame-1", url: "/x" },
					},
				},
				{
					id: "exec-2",
					status: "FAILED",
					startedAt: new Date("2026-10-07T09:00:00Z"),
					completedAt: null,
					duration: null,
					error: "tool unavailable",
					output: null,
				},
			],
		});

		const runs = await listWorkflowRunsCommand(actor, {
			workflowId: "wf-1",
			limit: 500,
		});

		expect(mocks.listExecutions).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowId: "wf-1",
				userId: USER,
				organizationId: ORG_A,
				limit: 20,
			}),
		);
		expect(runs.map((run) => run.frameId)).toEqual(["frame-1", null]);
		expect(runs[1]).toMatchObject({
			status: "FAILED",
			error: "tool unavailable",
			output: null,
		});
	});

	it("truncates a large output instead of carrying it whole", async () => {
		mocks.listExecutions.mockResolvedValue({
			executions: [
				{
					id: "exec-1",
					status: "COMPLETED",
					startedAt: new Date(),
					completedAt: new Date(),
					duration: 1,
					error: null,
					output: { "agent-task": { text: "x".repeat(10_000) } },
				},
			],
		});

		const [run] = await listWorkflowRunsCommand(actor, {
			workflowId: "wf-1",
		});

		expect(typeof run?.output).toBe("string");
		expect((run?.output as string).length).toBeLessThan(2_100);
	});

	it("refuses another organization's workflow", async () => {
		const error = await refusal(
			listWorkflowRunsCommand(
				{ userId: USER, organizationId: ORG_B },
				{ workflowId: "wf-1" },
			),
		);

		expect(error.code).toBe("NOT_FOUND");
		expect(mocks.listExecutions).not.toHaveBeenCalled();
	});
});
