/**
 * Tests for the PM auto-sync gate on the v1 public REST API
 * `PATCH /projects/:projectId/features/:id` endpoint.
 *
 * External integrators that rename or rewrite a feature via the public API
 * must see the change propagate to the linked PM ticket when the per-story
 * `pmAutoSyncEnabled` flag is on — same gate as in-app edits.
 *
 * Mocks `@repo/database`, `enqueuePmSync`, the api-key middleware, and the
 * v1 helpers. Runs the patched route through Hono so the request/response
 * lifecycle is exercised end-to-end.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getProjectAccessById: vi.fn(),
		canUpdateProjectStory: vi.fn(),
		getStoryById: vi.fn(),
		getUserById: vi.fn(),
		updateStory: vi.fn(),
		enqueuePmSync: vi.fn(),
		loggerWarn: vi.fn(),
		resolveV1Context: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	resolveUserOrganization: vi.fn(async () => ({
		kind: "resolved" as const,
		organizationId: "org-test",
	})),
	createStory: vi.fn(),
	getProjectAccessById: mocks.getProjectAccessById,
	canUpdateProjectStory: mocks.canUpdateProjectStory,
	getStoryById: mocks.getStoryById,
	// The PATCH route resolves the API key's user so the edit it writes carries a
	// human name rather than landing unattributed.
	getUserById: mocks.getUserById,
	listStories: vi.fn(),
	listTasks: vi.fn(),
	updateStory: mocks.updateStory,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("../../projects/lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mocks.enqueuePmSync,
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<unknown>) =>
		next(),
}));

vi.mock("../helpers", () => ({
	resolveV1Context: mocks.resolveV1Context,
	badRequest: (message: string) => ({ error: { message } }),
	notFound: (resource: string) => ({
		error: { message: `${resource} not found` },
	}),
	ok: (data: unknown, meta?: unknown) => ({
		data,
		...(meta ? { meta } : {}),
	}),
}));

const { registerFeatureRoutes } = await import("../features");

function buildApp() {
	const app = new Hono();
	registerFeatureRoutes(
		app as unknown as Parameters<typeof registerFeatureRoutes>[0],
	);
	return app;
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.resolveV1Context.mockResolvedValue({
		userId: "api-user-1",
		organizationId: null,
	});
	mocks.getProjectAccessById.mockResolvedValue({ id: "project-1" });
	// Seeing the project is not permission to change it — these cases are
	// about the PM-sync gate, so the caller is given the story-write
	// permission the route now requires.
	mocks.canUpdateProjectStory.mockResolvedValue(true);
	mocks.getStoryById.mockResolvedValue({
		id: "story-1",
		projectId: "project-1",
		title: "Old title",
	});
	mocks.getUserById.mockResolvedValue({
		id: "api-user-1",
		name: "Integration User",
	});
	mocks.enqueuePmSync.mockResolvedValue({
		enqueued: true,
		workflowId: "wf_test",
	});
});

describe("v1 PATCH /projects/:projectId/features/:id PM sync gate", () => {
	it("pmAutoSyncEnabled=true + title rename → enqueuePmSync called", async () => {
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			identifier: "F-1",
			title: "New title",
			description: null,
			acceptanceCriteria: null,
			priority: "P2_MEDIUM",
			projectId: "project-1",
			assigneeId: null,
			version: 2,
			order: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
			pmAutoSyncEnabled: true,
		});

		const app = buildApp();
		const res = await app.request("/projects/project-1/features/story-1", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "New title" }),
		});

		expect(res.status).toBe(200);
		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);
		expect(mocks.enqueuePmSync).toHaveBeenCalledWith({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "api-user-1",
			triggerSource: "manual-edit",
		});
	});

	it("pmAutoSyncEnabled=false → enqueuePmSync NOT called even on title rename", async () => {
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			identifier: "F-1",
			title: "New title",
			description: null,
			acceptanceCriteria: null,
			priority: "P2_MEDIUM",
			projectId: "project-1",
			assigneeId: null,
			version: 2,
			order: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
			pmAutoSyncEnabled: false,
		});

		const app = buildApp();
		await app.request("/projects/project-1/features/story-1", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "New title" }),
		});

		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("pmAutoSyncEnabled=true + only priority changed → enqueuePmSync NOT called (kanban-only field)", async () => {
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			identifier: "F-1",
			title: "x",
			description: null,
			acceptanceCriteria: null,
			priority: "P0_CRITICAL",
			projectId: "project-1",
			assigneeId: null,
			version: 1,
			order: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
			pmAutoSyncEnabled: true,
		});

		const app = buildApp();
		await app.request("/projects/project-1/features/story-1", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ priority: "P0_CRITICAL" }),
		});

		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("pmAutoSyncEnabled=true + description rewrite → enqueuePmSync called", async () => {
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			identifier: "F-1",
			title: "x",
			description: "new description",
			acceptanceCriteria: null,
			priority: "P2_MEDIUM",
			projectId: "project-1",
			assigneeId: null,
			version: 2,
			order: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
			pmAutoSyncEnabled: true,
		});

		const app = buildApp();
		await app.request("/projects/project-1/features/story-1", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ description: "new description" }),
		});

		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);
	});

	it("pmAutoSyncEnabled=true + enqueuePmSync rejects → 200 returned (fire-and-forget)", async () => {
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			identifier: "F-1",
			title: "x",
			description: null,
			acceptanceCriteria: null,
			priority: "P2_MEDIUM",
			projectId: "project-1",
			assigneeId: null,
			version: 1,
			order: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
			pmAutoSyncEnabled: true,
		});
		mocks.enqueuePmSync.mockRejectedValueOnce(new Error("temporal down"));

		const app = buildApp();
		const res = await app.request("/projects/project-1/features/story-1", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "anything" }),
		});

		expect(res.status).toBe(200);
		await new Promise((r) => setImmediate(r));
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"enqueuePmSync failed",
			expect.objectContaining({ storyId: "story-1" }),
		);
	});
});
