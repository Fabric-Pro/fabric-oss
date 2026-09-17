/**
 * fireColumnAutomations — the workflow it starts must actually be runnable
 * and answerable.
 *
 * For its whole life this starter named `taskQueue: "orchestrator"`, which no
 * worker polls (the worker is on `fabric-orchestrator`), so every automation
 * was accepted by Temporal and never executed. It also passed no
 * `executionId` (which `createInitialState` reads as-is) and no memo, so even
 * a running workflow could not be approved: the approve/status/stream routes
 * validate an `orch-<uuid>` id and authorize via `memo.userId` /
 * `memo.organizationId`.
 *
 * `@repo/temporal` is mocked here (the real barrel drags in the Temporal SDK
 * and Prisma); the constant's real value is pinned by
 * `packages/temporal/__tests__/task-queues.test.ts`.
 *
 * Run with: pnpm --filter @repo/api test -- story-automations
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
	skillFindMany: vi.fn(),
	skillUpdate: vi.fn(),
}));

const temporalMocks = vi.hoisted(() => ({
	start: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		skill: {
			findMany: dbMocks.skillFindMany,
			update: dbMocks.skillUpdate,
		},
	},
}));

vi.mock("@repo/temporal", () => ({
	ORCHESTRATOR_TASK_QUEUE: "fabric-orchestrator",
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: temporalMocks.start },
	})),
}));

import {
	automationWorkflowId,
	fireColumnAutomations,
} from "../story-automations";

const transition = {
	storyId: "story-1",
	storyTitle: "Add login",
	storyIdentifier: "F-001",
	projectId: "project-1",
	projectName: "Portal",
	targetColumnName: "Triage",
	fromStatusId: "status-backlog",
	toStatusId: "status-triage",
	transitionAt: "2026-09-16T12:00:00.000Z",
	userId: "user-1",
	organizationId: "org-a",
};

const ORCH_ID = /^orch-[a-f0-9-]{36}$/;

beforeEach(() => {
	vi.clearAllMocks();
	dbMocks.skillFindMany.mockResolvedValue([
		{
			id: "skill-1",
			name: "Triage",
			slug: "triage",
			content: "Label the issue.",
		},
	]);
	dbMocks.skillUpdate.mockResolvedValue({});
	temporalMocks.start.mockResolvedValue({ workflowId: "ignored" });
});

describe("fireColumnAutomations", () => {
	it("starts the orchestrator on the queue the worker polls", async () => {
		await fireColumnAutomations(transition);

		expect(temporalMocks.start).toHaveBeenCalledTimes(1);
		const [workflowType, options] = temporalMocks.start.mock.calls[0];
		expect(workflowType).toBe("orchestratorExecutionWorkflow");
		expect(options.taskQueue).toBe("fabric-orchestrator");
	});

	it("passes an orch-<uuid> executionId in args and uses it as the workflowId", async () => {
		await fireColumnAutomations(transition);

		const [, options] = temporalMocks.start.mock.calls[0];
		const input = options.args[0];
		expect(input.executionId).toMatch(ORCH_ID);
		// The approve/status routes do `getHandle(executionId)`.
		expect(options.workflowId).toBe(input.executionId);
		expect(input).toMatchObject({
			executionMode: "balanced",
			userId: "user-1",
			organizationId: "org-a",
			projectId: "project-1",
			userStoryId: "story-1",
		});
		expect(input.message).toContain("Label the issue.");
	});

	it("sets the ownership memo the approve/stream routes check", async () => {
		await fireColumnAutomations(transition);

		const [, options] = temporalMocks.start.mock.calls[0];
		expect(options.memo).toMatchObject({
			userId: "user-1",
			organizationId: "org-a",
		});
	});

	it("refuses a transition without an organization before any lookup or start (ADR-018)", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await fireColumnAutomations({ ...transition, organizationId: null });

		expect(dbMocks.skillFindMany).not.toHaveBeenCalled();
		expect(temporalMocks.start).not.toHaveBeenCalled();
		expect(dbMocks.skillUpdate).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith(
			expect.stringMatching(/without an organization/),
			expect.objectContaining({ storyId: "story-1" }),
		);
		error.mockRestore();
	});

	it("threads the organization into the run's args and memo", async () => {
		await fireColumnAutomations(transition);

		const [, options] = temporalMocks.start.mock.calls[0];
		expect(options.args[0].organizationId).toBe("org-a");
		expect(options.memo.organizationId).toBe("org-a");
		expect(options.memo.userId).toBe("user-1");
	});

	it("does not start anything when no skill matches the column", async () => {
		dbMocks.skillFindMany.mockResolvedValue([]);

		await fireColumnAutomations(transition);

		expect(temporalMocks.start).not.toHaveBeenCalled();
	});
});

describe("fireColumnAutomations — one run per transition", () => {
	it("derives the workflowId from the transition so a duplicate delivery reuses it", async () => {
		await fireColumnAutomations(transition);
		await fireColumnAutomations({ ...transition });

		const ids = temporalMocks.start.mock.calls.map(
			([, options]) => options.workflowId,
		);
		expect(ids).toHaveLength(2);
		expect(ids[0]).toMatch(ORCH_ID);
		expect(ids[0]).toBe(ids[1]);
		expect(ids[0]).toBe(automationWorkflowId(transition, "triage"));
		// Temporal is told to refuse the second start of that id outright.
		expect(temporalMocks.start.mock.calls[0][1].workflowIdReusePolicy).toBe(
			"REJECT_DUPLICATE",
		);
	});

	it("gives a later transition into the same column its own id", () => {
		const back = automationWorkflowId(transition, "triage");
		const again = automationWorkflowId(
			{ ...transition, transitionAt: "2026-09-16T12:05:00.000Z" },
			"triage",
		);
		const otherSkill = automationWorkflowId(transition, "notify");
		const otherStory = automationWorkflowId(
			{ ...transition, storyId: "story-2" },
			"triage",
		);
		expect(new Set([back, again, otherSkill, otherStory]).size).toBe(4);
		for (const id of [back, again, otherSkill, otherStory]) {
			expect(id).toMatch(ORCH_ID);
		}
	});

	it("treats Temporal's already-started rejection as the duplicate it is", async () => {
		const alreadyStarted = new Error("Workflow execution already started");
		alreadyStarted.name = "WorkflowExecutionAlreadyStartedError";
		temporalMocks.start.mockRejectedValueOnce(alreadyStarted);

		await expect(
			fireColumnAutomations(transition),
		).resolves.toBeUndefined();

		// Not a run, so not a use.
		expect(dbMocks.skillUpdate).not.toHaveBeenCalled();
	});

	it("counts a use only when the run actually started", async () => {
		await fireColumnAutomations(transition);
		expect(dbMocks.skillUpdate).toHaveBeenCalledTimes(1);
	});
});
