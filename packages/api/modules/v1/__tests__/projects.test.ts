/** Public v1 project-detail compatibility coverage for Fizzy #2267. */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getProjectByIdForExternalApi: vi.fn(),
		resolveV1Context: vi.fn(),
		createProject: vi.fn(),
		ownerPermissionAllowed: true,
	},
}));

vi.mock("@repo/database", () => ({
	resolveUserOrganization: vi.fn(async () => ({
		kind: "resolved" as const,
		organizationId: "org-test",
	})),
	createProject: mocks.createProject,
	getProjectAccessById: vi.fn(),
	getProjectByIdForExternalApi: mocks.getProjectByIdForExternalApi,
	listProjects: vi.fn(),
	updateProject: vi.fn(),
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		() => async (_context: unknown, next: () => Promise<unknown>) =>
			next(),
	requireV1OwnerPermission: async (
		c: { json: (body: unknown, status: number) => unknown },
		_context: unknown,
		action: string,
	) => {
		if (action !== "projects:create") {
			throw new Error(`Unexpected project permission action: ${action}`);
		}
		return mocks.ownerPermissionAllowed
			? null
			: c.json(
					{
						error: "The key's owner no longer holds the access required for projects:write in this organization",
					},
					403,
				);
	},
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
	mocks.createProject.mockReset().mockResolvedValue({
		id: "project-1",
		name: "Example project",
		description: null,
		status: "DRAFT",
		color: null,
		icon: null,
		userId: "api-user-1",
		organizationId: "org-test",
		repositoryUrl: null,
		createdAt: new Date("2026-10-31T00:00:00.000Z"),
		updatedAt: new Date("2026-10-31T00:00:00.000Z"),
	});
	mocks.ownerPermissionAllowed = true;
	mocks.resolveV1Context.mockResolvedValue({
		userId: "api-user-1",
		organizationId: null,
	});
});

describe("POST /projects", () => {
	it("refuses a viewer's personal key before creating a project", async () => {
		mocks.ownerPermissionAllowed = false;
		mocks.resolveV1Context.mockResolvedValue({
			userId: "api-user-1",
			organizationId: "org-test",
		});

		const response = await buildApp().request("/projects", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Example project" }),
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "The key's owner no longer holds the access required for projects:write in this organization",
		});
		expect(mocks.createProject).not.toHaveBeenCalled();
	});

	it("allows a member's personal key to create a project", async () => {
		mocks.resolveV1Context.mockResolvedValue({
			userId: "api-user-1",
			organizationId: "org-test",
		});
		const response = await buildApp().request("/projects", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Example project" }),
		});

		expect(response.status).toBe(201);
		expect(mocks.createProject).toHaveBeenCalledOnce();
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
