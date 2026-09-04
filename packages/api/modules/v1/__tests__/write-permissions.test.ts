/**
 * The public v1 REST API cannot exceed what the caller could do in the app
 * (Fizzy #2380).
 *
 * Three routes confirmed the caller could *see* a project and then wrote to it.
 * `getProjectAccessById` is the visibility query — it is what produces a 404
 * rather than leaking existence — and it is true for a Viewer and a Commenter,
 * neither of whom may change anything through the interface. The documents
 * routes on this same surface already called `canEditProject`, so this was an
 * inconsistency within v1 rather than a missing capability.
 *
 * A scope is not a substitute for a role, which is what made this reachable:
 * `projects:write` on the key gets you past `requireScope`, and until now
 * nothing after it asked whether *this person* may write to *this project*.
 *
 * Each case asserts on the write, not just the status code — a route that
 * returns 403 after calling `updateStory` has not refused.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getProjectAccessById: vi.fn(),
		canEditProject: vi.fn(),
		canCreateProjectStory: vi.fn(),
		canUpdateProjectStory: vi.fn(),
		getStoryById: vi.fn(),
		getUserById: vi.fn(),
		createStory: vi.fn(),
		updateStory: vi.fn(),
		updateProject: vi.fn(),
		resolveV1Context: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	resolveUserOrganization: vi.fn(async () => ({
		kind: "resolved" as const,
		organizationId: "org-test",
	})),
	getProjectAccessById: mocks.getProjectAccessById,
	canEditProject: mocks.canEditProject,
	canCreateProjectStory: mocks.canCreateProjectStory,
	canUpdateProjectStory: mocks.canUpdateProjectStory,
	getStoryById: mocks.getStoryById,
	getUserById: mocks.getUserById,
	createStory: mocks.createStory,
	updateStory: mocks.updateStory,
	updateProject: mocks.updateProject,
	createProject: vi.fn(),
	getProjectByIdForExternalApi: vi.fn(),
	listProjects: vi.fn(),
	listStories: vi.fn(),
	listTasks: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../projects/lib/enqueue-pm-sync", () => ({
	enqueuePmSync: vi.fn().mockResolvedValue({ enqueued: false }),
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	// The key's scope check is deliberately a no-op here. A scope says what a
	// key may attempt; these cases are about what its owner may do.
	requireScope: () => async (_c: unknown, next: () => Promise<unknown>) =>
		next(),
}));

vi.mock("../helpers", () => ({
	resolveV1Context: mocks.resolveV1Context,
	badRequest: (message: string) => ({ error: { message } }),
	forbidden: (message: string) => ({ error: { message } }),
	notFound: (resource: string) => ({
		error: { message: `${resource} not found` },
	}),
	ok: (data: unknown, meta?: unknown) => ({
		data,
		...(meta ? { meta } : {}),
	}),
}));

const { registerFeatureRoutes } = await import("../features");
const { registerProjectRoutes } = await import("../projects");

function buildApp() {
	const app = new Hono();
	registerFeatureRoutes(
		app as unknown as Parameters<typeof registerFeatureRoutes>[0],
	);
	registerProjectRoutes(
		app as unknown as Parameters<typeof registerProjectRoutes>[0],
	);
	return app;
}

function patch(path: string, body: unknown) {
	return new Request(`http://localhost${path}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function post(path: string, body: unknown) {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.resolveV1Context.mockResolvedValue({
		userId: "api-user-1",
		organizationId: "org-1",
	});
	// The caller can see the project in every case below. That is the whole
	// point: visibility was the only thing these routes checked.
	mocks.getProjectAccessById.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	mocks.getStoryById.mockResolvedValue({
		id: "story-1",
		projectId: "project-1",
		title: "Old title",
	});
	mocks.getUserById.mockResolvedValue({ id: "api-user-1", name: "Bot" });
	// Rows carry the timestamps the v1 serializers format; without them the
	// success paths fail on serialization rather than on authorization, which
	// would make these cases prove nothing.
	const now = new Date("2026-01-01T00:00:00Z");
	mocks.updateStory.mockResolvedValue({
		id: "story-1",
		identifier: "F-001",
		title: "New",
		description: null,
		acceptanceCriteria: null,
		status: "DRAFT",
		priority: "MEDIUM",
		projectId: "project-1",
		createdAt: now,
		updatedAt: now,
	});
	mocks.createStory.mockResolvedValue({
		id: "story-2",
		identifier: "F-002",
		title: "New",
		description: null,
		acceptanceCriteria: null,
		status: "DRAFT",
		priority: "MEDIUM",
		projectId: "project-1",
		createdAt: now,
		updatedAt: now,
	});
	mocks.updateProject.mockResolvedValue({
		id: "project-1",
		name: "New",
		description: null,
		status: "ACTIVE",
		createdAt: now,
		updatedAt: now,
	});
});

describe("PATCH /projects/:id", () => {
	it("refuses a caller who can see the project but not edit it", async () => {
		mocks.canEditProject.mockResolvedValue(false);

		const res = await buildApp().fetch(
			patch("/projects/project-1", { name: "Renamed" }),
		);

		expect(res.status).toBe(403);
		expect(mocks.updateProject).not.toHaveBeenCalled();
	});

	it("allows a caller who holds PROJECT_UPDATE", async () => {
		mocks.canEditProject.mockResolvedValue(true);

		const res = await buildApp().fetch(
			patch("/projects/project-1", { name: "Renamed" }),
		);

		expect(res.status).toBe(200);
		expect(mocks.updateProject).toHaveBeenCalled();
	});
});

describe("POST /projects/:projectId/features", () => {
	it("refuses a caller who cannot create stories in the project", async () => {
		mocks.canCreateProjectStory.mockResolvedValue(false);

		const res = await buildApp().fetch(
			post("/projects/project-1/features", { title: "New feature" }),
		);

		expect(res.status).toBe(403);
		expect(mocks.createStory).not.toHaveBeenCalled();
	});

	it("allows a caller who holds STORY_CREATE", async () => {
		mocks.canCreateProjectStory.mockResolvedValue(true);

		const res = await buildApp().fetch(
			post("/projects/project-1/features", { title: "New feature" }),
		);

		expect(res.status).toBe(201);
		expect(mocks.createStory).toHaveBeenCalled();
	});
});

describe("PATCH /projects/:projectId/features/:id", () => {
	it("refuses a caller who cannot update stories in the project", async () => {
		mocks.canUpdateProjectStory.mockResolvedValue(false);

		const res = await buildApp().fetch(
			patch("/projects/project-1/features/story-1", { title: "New" }),
		);

		expect(res.status).toBe(403);
		expect(mocks.updateStory).not.toHaveBeenCalled();
		// The refusal lands before the story is even looked up: nothing about
		// which stories exist leaks to someone who may not write here.
		expect(mocks.getStoryById).not.toHaveBeenCalled();
	});

	it("allows a caller who holds STORY_UPDATE", async () => {
		mocks.canUpdateProjectStory.mockResolvedValue(true);

		const res = await buildApp().fetch(
			patch("/projects/project-1/features/story-1", { title: "New" }),
		);

		expect(res.status).toBe(200);
		expect(mocks.updateStory).toHaveBeenCalled();
	});
});
