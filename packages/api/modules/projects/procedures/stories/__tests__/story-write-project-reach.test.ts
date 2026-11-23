/**
 * A caller who cannot open a project cannot change its features either.
 *
 * `projects.stories.get` refuses an organization member with no ProjectMember
 * row on a project they did not create, because the project list and page do
 * not admit them. `projects.stories.update` used to accept the same caller: the
 * permission gate's org-role fallback granted `STORY_UPDATE` from their
 * organization role alone. The gate now admits only callers who can open the
 * project, so reads and writes agree.
 *
 * Driven through the REAL `requireProjectPermission` and the REAL
 * `resolveEffectiveProjectPermissions`, with only the rows underneath mocked,
 * so each case exercises the precedence the API applies.
 */

import { call, os } from "@orpc/server";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	memberFindFirst: vi.fn(),
	projectMemberFindUnique: vi.fn(),
	storyFindFirst: vi.fn(),
	updateStory: vi.fn(),
	updateTaskInStory: vi.fn(),
	toggleTaskComplete: vi.fn(),
	deleteTask: vi.fn(),
	taskWritten: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	const { z } = await import("zod");
	return {
		db: {
			project: { findUnique: mocks.projectFindUnique },
			member: { findFirst: mocks.memberFindFirst },
			projectMember: { findUnique: mocks.projectMemberFindUnique },
			userStory: { findFirst: mocks.storyFindFirst, findUnique: vi.fn() },
		},
		getOrganizationMembership: vi.fn(),
		getTenantContext: vi.fn(() => ({})),
		grantProjectAccess: vi.fn(),
		updateStory: mocks.updateStory,
		updateTaskInStory: mocks.updateTaskInStory,
		toggleTaskComplete: mocks.toggleTaskComplete,
		deleteTask: mocks.deleteTask,
		setLastContextUpdateAt: vi.fn(),
		FeatureDraftingStageSchema: z.string(),
		MaturationStatusSchema: z.string(),
	};
});

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: {
		subscriptionUpdate: vi.fn().mockResolvedValue(undefined),
		assigned: vi.fn().mockResolvedValue(undefined),
	},
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("../../../lib/auto-draft-test-cases", () => ({
	maybeAutoDraftOnStageChange: vi.fn(),
}));

vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/strip-internal-story-fields", () => ({
	stripInternalStoryFields: (story: unknown) => story,
}));

vi.mock("../../../lib/validate-stage-for-kind", () => ({
	validateStageForKind: vi.fn(),
}));

vi.mock("../../scan/lib/start-scan", () => ({
	maybeTriggerMaturationScan: vi.fn(),
}));

vi.mock("../../../../agent-deployments/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../../../orpc/procedures", async () => {
	const { requireProjectPermission } = await import(
		"../../../../../orpc/middleware/require-permission"
	);
	return {
		tenantProtectedProcedure: os.$context<{
			user: { id: string; name?: string };
			session: { activeOrganizationId?: string | null };
			tenantContext: {
				userId: string;
				type: "organization";
				organizationId: string;
			};
			activeOrganizationRole: string | null;
			allowedProjectIds: string[];
		}>(),
		requireProjectPermission,
		Permissions,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? "org-example",
	};
});

import { deleteTaskProcedure } from "../tasks/delete-task";
import { toggleTaskProcedure } from "../tasks/toggle-task";
import { updateTaskProcedure } from "../tasks/update-task";
import { updateStoryProcedure } from "../update-story";

const ORG_ID = "org-example";
const PROJECT_ID = "project-example";
const CREATOR_ID = "user-creator";
const CALLER_ID = "user-caller";

function context(userId: string, role: string | null) {
	return {
		user: { id: userId, name: "Example" },
		session: { activeOrganizationId: ORG_ID },
		tenantContext: {
			userId,
			type: "organization" as const,
			organizationId: ORG_ID,
		},
		activeOrganizationRole: role,
		allowedProjectIds: [],
	};
}

function projectCreatedBy(userId: string) {
	mocks.projectFindUnique.mockResolvedValue({
		id: PROJECT_ID,
		organizationId: ORG_ID,
		userId,
		organization: { deletedAt: null },
	});
}

function orgRole(role: string | null) {
	mocks.memberFindFirst.mockResolvedValue(role ? { role } : null);
}

function projectMember(role: string | null) {
	mocks.projectMemberFindUnique.mockResolvedValue(
		role ? { role, acceptedAt: new Date(), expiresAt: null } : null,
	);
}

function updateStoryAs(userId: string, role: string | null) {
	return call(
		updateStoryProcedure,
		{ projectId: PROJECT_ID, storyId: "story-example", title: "Renamed" },
		{ context: context(userId, role) },
	);
}

function updateTaskAs(
	userId: string,
	role: string | null,
	taskId = "task-example",
) {
	return call(
		updateTaskProcedure,
		{
			projectId: PROJECT_ID,
			storyId: "story-example",
			taskId,
			title: "Renamed",
		},
		{ context: context(userId, role) },
	);
}

/** Task rows by where they live; only the first is in the caller's project. */
const TASKS = [
	{ id: "task-example", storyId: "story-example", projectId: PROJECT_ID },
	// Same organization, another project.
	{
		id: "task-other-project",
		storyId: "story-other",
		projectId: "project-other",
	},
	// Another organization's project.
	{
		id: "task-other-org",
		storyId: "story-foreign",
		projectId: "project-foreign",
	},
];

interface TaskScope {
	taskId: string;
	storyId: string;
	projectId: string;
}

function taskInScope(scope: TaskScope) {
	return TASKS.some(
		(task) =>
			task.id === scope.taskId &&
			task.storyId === scope.storyId &&
			task.projectId === scope.projectId,
	);
}

const TASK_WRITES = {
	update: (userId: string, taskId: string) =>
		updateTaskAs(userId, "member", taskId),
	toggle: (userId: string, taskId: string) =>
		call(
			toggleTaskProcedure,
			{ projectId: PROJECT_ID, storyId: "story-example", taskId },
			{ context: context(userId, "member") },
		),
	delete: (userId: string, taskId: string) =>
		call(
			deleteTaskProcedure,
			{ projectId: PROJECT_ID, storyId: "story-example", taskId },
			{ context: context(userId, "member") },
		),
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.storyFindFirst.mockResolvedValue({
		assigneeId: null,
		externalId: null,
		title: "Original",
		version: 1,
		maturationStatus: null,
	});
	mocks.updateStory.mockResolvedValue({
		id: "story-example",
		title: "Renamed",
		version: 1,
		pmAutoSyncEnabled: false,
		externalId: null,
	});
	mocks.updateTaskInStory.mockImplementation(async (scope: TaskScope) => {
		if (!taskInScope(scope)) return null;
		mocks.taskWritten(scope.taskId);
		return { id: scope.taskId, subtasks: [] };
	});
	mocks.toggleTaskComplete.mockImplementation(async (scope: TaskScope) => {
		if (!taskInScope(scope)) return null;
		mocks.taskWritten(scope.taskId);
		return { id: scope.taskId, title: "Example", isCompleted: true };
	});
	mocks.deleteTask.mockImplementation(async (scope: TaskScope) => {
		if (!taskInScope(scope)) return false;
		mocks.taskWritten(scope.taskId);
		return true;
	});
});

describe("projects.stories.update — project reach", () => {
	it("relies on an org member's role granting STORY_UPDATE", () => {
		// So the refusals below are about reach, not about the role.
		const granted = resolveOrgPermissions("member");
		expect(hasPermission(granted, Permissions.STORY_UPDATE)).toBe(true);
	});

	for (const role of ["member", "admin"]) {
		it(`refuses an org ${role} with no project row on a project they did not create, before any write`, async () => {
			projectCreatedBy(CREATOR_ID);
			orgRole(role);
			projectMember(null);

			await expect(updateStoryAs(CALLER_ID, role)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			expect(mocks.storyFindFirst).not.toHaveBeenCalled();
			expect(mocks.updateStory).not.toHaveBeenCalled();
		});
	}

	it("allows an active project Editor", async () => {
		projectCreatedBy(CREATOR_ID);
		orgRole("member");
		projectMember("EDITOR");

		const result = await updateStoryAs(CALLER_ID, "member");

		expect(result).toMatchObject({ story: { id: "story-example" } });
		expect(mocks.updateStory).toHaveBeenCalledTimes(1);
	});

	it("allows the project's creator through their org role, with no project row", async () => {
		projectCreatedBy(CREATOR_ID);
		orgRole("admin");
		projectMember(null);

		const result = await updateStoryAs(CREATOR_ID, "admin");

		expect(result).toMatchObject({ story: { id: "story-example" } });
		expect(mocks.updateStory).toHaveBeenCalledTimes(1);
	});

	it("refuses a project Viewer with FORBIDDEN, since they can open the project", async () => {
		projectCreatedBy(CREATOR_ID);
		orgRole("admin");
		projectMember("VIEWER");

		await expect(updateStoryAs(CALLER_ID, "admin")).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.updateStory).not.toHaveBeenCalled();
	});
});

describe("projects.stories.tasks.update — project reach", () => {
	it("refuses an org member with no project row on a project they did not create, before any write", async () => {
		projectCreatedBy(CREATOR_ID);
		orgRole("member");
		projectMember(null);

		await expect(updateTaskAs(CALLER_ID, "member")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.updateTaskInStory).not.toHaveBeenCalled();
	});

	it("allows an active project Editor", async () => {
		projectCreatedBy(CREATOR_ID);
		orgRole(null);
		projectMember("EDITOR");

		const result = await updateTaskAs(CALLER_ID, null);

		expect(result).toMatchObject({ task: { id: "task-example" } });
		expect(mocks.updateTaskInStory).toHaveBeenCalledWith(
			{
				taskId: "task-example",
				storyId: "story-example",
				projectId: PROJECT_ID,
			},
			expect.objectContaining({ title: "Renamed" }),
		);
		expect(mocks.taskWritten).toHaveBeenCalledWith("task-example");
	});
});

describe("projects.stories.tasks — a task id from outside the authorized project", () => {
	beforeEach(() => {
		// A project admin holds every task permission, so each refusal below
		// is about where the task lives.
		projectCreatedBy(CREATOR_ID);
		orgRole("member");
		projectMember("PROJECT_ADMIN");
	});

	for (const [action, write] of Object.entries(TASK_WRITES)) {
		it(`${action} reaches a task in the authorized story`, async () => {
			await write(CALLER_ID, "task-example");

			expect(mocks.taskWritten).toHaveBeenCalledWith("task-example");
		});

		for (const taskId of ["task-other-project", "task-other-org"]) {
			it(`${action} answers NOT_FOUND for ${taskId}, with nothing written`, async () => {
				await expect(write(CALLER_ID, taskId)).rejects.toMatchObject({
					code: "NOT_FOUND",
				});
				expect(mocks.taskWritten).not.toHaveBeenCalled();
			});
		}
	}
});
