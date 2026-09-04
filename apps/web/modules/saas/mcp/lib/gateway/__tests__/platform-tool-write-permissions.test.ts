/**
 * Write permissions on the platform tools that had none (Fizzy #2380).
 *
 * Three handlers reached a write having asked only whether the caller could
 * *see* the project — `hasProjectAccess`, which is true for a Viewer and a
 * Commenter — or, in the case of `fabric_create_project`, having asked nothing
 * at all. Their oRPC counterparts require STORY_UPDATE and PROJECT_CREATE
 * respectively, so the gateway let through exactly the callers the UI refuses.
 *
 * The rule these cases pin: an API key is authentication, not authorization.
 * What a caller may change through MCP is whatever they could change through
 * the UI, resolved live from their roles — never more.
 *
 * Each case asserts on the *write*, not just the return value: a handler that
 * refuses but has already called `updateTask` has not refused. `@repo/database`
 * is mocked because the handlers reach it through dynamic `await import(...)`,
 * so the mock intercepts inside the handler body.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/platform-tool-write-permissions
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	hasProjectAccess: vi.fn(),
	canUpdateProjectStory: vi.fn(),
	canCreateProjectInOrganization: vi.fn(),
	updateTask: vi.fn(),
	createProject: vi.fn(),
	storyTaskFindFirst: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		storyTask: { findFirst: mocks.storyTaskFindFirst },
	},
	hasProjectAccess: mocks.hasProjectAccess,
	canUpdateProjectStory: mocks.canUpdateProjectStory,
	canCreateProjectInOrganization: mocks.canCreateProjectInOrganization,
	updateTask: mocks.updateTask,
	createProject: mocks.createProject,
}));

import { executePlatformTool } from "../platform-tools";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "sess-1",
	userId: "user-1",
	organizationId: "org-1",
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	credential: "personal-key",
	scopes: ["*"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

function text(result: { content: Array<{ text: string }> }) {
	return result.content[0].text;
}

beforeEach(() => {
	vi.clearAllMocks();
	// The caller can see the project in every case below. That is the whole
	// point: visibility was the only thing these handlers used to check, and it
	// is not the question a write should be asking.
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.storyTaskFindFirst.mockResolvedValue({
		id: "task-1",
		title: "Wire the export",
		isCompleted: false,
	});
	mocks.updateTask.mockResolvedValue({
		id: "task-1",
		title: "Wire the export",
		isCompleted: true,
	});
	mocks.createProject.mockResolvedValue({
		id: "proj-new",
		name: "Example Project",
	});
});

describe("fabric_update_task honours the caller's project role", () => {
	it("refuses a caller who may see the project but not update its stories", async () => {
		mocks.canUpdateProjectStory.mockResolvedValue(false);

		const result = await executePlatformTool(
			"fabric_update_task",
			{ taskId: "task-1", projectId: "proj-1", title: "Renamed" },
			session,
		);

		expect(mocks.canUpdateProjectStory).toHaveBeenCalledWith(
			"proj-1",
			"user-1",
		);
		expect(text(result)).toContain("No permission to update tasks");
		// The refusal has to happen before the write, not after it.
		expect(mocks.updateTask).not.toHaveBeenCalled();
	});

	it("allows a caller who holds STORY_UPDATE on the project", async () => {
		mocks.canUpdateProjectStory.mockResolvedValue(true);

		await executePlatformTool(
			"fabric_update_task",
			{ taskId: "task-1", projectId: "proj-1", title: "Renamed" },
			session,
		);

		expect(mocks.updateTask).toHaveBeenCalled();
	});
});

describe("fabric_complete_task honours the caller's project role", () => {
	it("refuses a Viewer who can see the project", async () => {
		mocks.canUpdateProjectStory.mockResolvedValue(false);

		const result = await executePlatformTool(
			"fabric_complete_task",
			{ taskId: "task-1", projectId: "proj-1", completed: true },
			session,
		);

		expect(text(result)).toContain("No permission to update tasks");
		expect(mocks.updateTask).not.toHaveBeenCalled();
	});

	it("allows an Editor", async () => {
		mocks.canUpdateProjectStory.mockResolvedValue(true);

		await executePlatformTool(
			"fabric_complete_task",
			{ taskId: "task-1", projectId: "proj-1", completed: true },
			session,
		);

		expect(mocks.updateTask).toHaveBeenCalledWith("task-1", {
			isCompleted: true,
		});
	});
});

describe("fabric_create_project honours PROJECT_CREATE", () => {
	it("refuses a caller whose organization role cannot create projects", async () => {
		mocks.canCreateProjectInOrganization.mockResolvedValue(false);

		const result = await executePlatformTool(
			"fabric_create_project",
			{ name: "Example Project" },
			session,
		);

		expect(mocks.canCreateProjectInOrganization).toHaveBeenCalledWith(
			"user-1",
			"org-1",
		);
		expect(text(result)).toContain("No permission to create projects");
		expect(mocks.createProject).not.toHaveBeenCalled();
	});

	it("allows a caller who holds PROJECT_CREATE", async () => {
		mocks.canCreateProjectInOrganization.mockResolvedValue(true);

		await executePlatformTool(
			"fabric_create_project",
			{ name: "Example Project" },
			session,
		);

		expect(mocks.createProject).toHaveBeenCalled();
	});

	// Reaching this handler without an organization means something upstream
	// failed to resolve one, which is a bug rather than a context to write in —
	// so it refuses instead of creating an untenanted project.
	it("refuses a session that carries no organization", async () => {
		mocks.canCreateProjectInOrganization.mockResolvedValue(true);

		const result = await executePlatformTool(
			"fabric_create_project",
			{ name: "Example Project" },
			{ ...session, organizationId: null },
		);

		expect(text(result)).toContain("No organization in this session");
		expect(mocks.createProject).not.toHaveBeenCalled();
	});
});
