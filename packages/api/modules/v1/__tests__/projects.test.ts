/** Public v1 project-detail compatibility coverage for Fizzy #2267. */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getProjectByIdForExternalApi: vi.fn(),
		resolveV1Context: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	resolveUserOrganization: vi.fn(async () => ({
		kind: "resolved" as const,
		organizationId: "org-test",
	})),
	createProject: vi.fn(),
	getProjectAccessById: vi.fn(),
	getProjectByIdForExternalApi: mocks.getProjectByIdForExternalApi,
	listProjects: vi.fn(),
	updateProject: vi.fn(),
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		() => async (_context: unknown, next: () => Promise<unknown>) =>
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

const { registerProjectRoutes } = await import("../projects");

function buildApp() {
	const app = new Hono();
	registerProjectRoutes(
		app as unknown as Parameters<typeof registerProjectRoutes>[0],
	);
	return app;
}

beforeEach(() => {
	mocks.getProjectByIdForExternalApi.mockReset();
	mocks.resolveV1Context.mockReset();
	mocks.resolveV1Context.mockResolvedValue({
		userId: "api-user-1",
		organizationId: null,
	});
});

describe("GET /projects/:id", () => {
	it("preserves the embedded full document and context response shape", async () => {
		const project = {
			id: "project-1",
			name: "Project",
			documents: [
				{
					id: "document-1",
					content: "Full document body",
					version: 3,
					createdAt: "2026-08-22T00:00:00.000Z",
				},
			],
			contexts: [
				{
					id: "context-1",
					type: "FILE",
					content: "Full context body",
				},
			],
		};
		mocks.getProjectByIdForExternalApi.mockResolvedValue(project);

		const response = await buildApp().request(
			"/projects/project-1?personal=1",
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ data: project });
		expect(
			mocks.getProjectByIdForExternalApi,
		).toHaveBeenCalledExactlyOnceWith("project-1", "api-user-1", undefined);
	});
});
