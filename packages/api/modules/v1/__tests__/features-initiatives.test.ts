import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

class MockInitiativesDisabledError extends Error {
	constructor(message = "Initiatives are turned off for this project.") {
		super(message);
		this.name = "InitiativesDisabledError";
	}
}

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getProjectAccessById: vi.fn(),
		canCreateProjectStory: vi.fn(),
		createStory: vi.fn(),
		listStories: vi.fn(),
		resolveV1Context: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	resolveUserOrganization: vi.fn(async () => ({
		kind: "resolved" as const,
		organizationId: "org-test",
	})),
	getProjectAccessById: mocks.getProjectAccessById,
	canCreateProjectStory: mocks.canCreateProjectStory,
	createStory: mocks.createStory,
	listStories: mocks.listStories,
	canUpdateProjectStory: vi.fn(),
	getUserById: vi.fn(),
	getVisibleStoryById: vi.fn(),
	listTasks: vi.fn(),
	updateStory: vi.fn(),
	InitiativesDisabledError: MockInitiativesDisabledError,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("../../projects/lib/enqueue-pm-sync", () => ({
	enqueuePmSync: vi.fn(),
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
	forbidden: (message: string) => ({ error: { message } }),
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
		userId: "user-1",
		organizationId: "org-test",
	});
	mocks.getProjectAccessById.mockResolvedValue({
		id: "proj-1",
		organizationId: "org-test",
	});
	mocks.canCreateProjectStory.mockResolvedValue(true);
});

describe("v1 Features — Initiatives", () => {
	it("POST with kind: 'INITIATIVE' passes kind to createStory and returns kind in response", async () => {
		mocks.createStory.mockResolvedValue({
			id: "story-1",
			identifier: "I-001",
			kind: "INITIATIVE",
			title: "Strategic expansion",
			description: null,
			acceptanceCriteria: null,
			priority: "P1_HIGH",
			projectId: "proj-1",
			assigneeId: null,
			version: 1,
			order: 1,
			createdAt: new Date("2026-11-16T00:00:00.000Z"),
			updatedAt: new Date("2026-11-16T00:00:00.000Z"),
		});

		const res = await buildApp().request("/projects/proj-1/features", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Strategic expansion",
				kind: "INITIATIVE",
				priority: "P1_HIGH",
			}),
		});

		expect(res.status).toBe(201);
		const json = (await res.json()) as {
			data: { kind: string; identifier: string };
		};
		expect(json.data.kind).toBe("INITIATIVE");
		expect(json.data.identifier).toBe("I-001");
		expect(mocks.createStory).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				title: "Strategic expansion",
				kind: "INITIATIVE",
				priority: "P1_HIGH",
			}),
		);
	});

	it("POST when createStory throws InitiativesDisabledError returns 400 with error message", async () => {
		mocks.createStory.mockRejectedValue(new MockInitiativesDisabledError());

		const res = await buildApp().request("/projects/proj-1/features", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Strategic expansion",
				kind: "INITIATIVE",
			}),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: { message: "Initiatives are turned off for this project." },
		});
	});

	it("POST with kind: 'EPIC' returns 400 and doesn't call createStory", async () => {
		const res = await buildApp().request("/projects/proj-1/features", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Strategic expansion",
				kind: "EPIC",
			}),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: {
				message: "kind must be one of: FEATURE, INITIATIVE",
			},
		});
		expect(mocks.createStory).not.toHaveBeenCalled();
	});

	it("GET ?kind=INITIATIVE passes kind to listStories; ?kind=EPIC returns 400", async () => {
		mocks.listStories.mockResolvedValue({
			stories: [],
			total: 0,
		});

		const resValid = await buildApp().request(
			"/projects/proj-1/features?kind=INITIATIVE",
		);
		expect(resValid.status).toBe(200);
		expect(mocks.listStories).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				kind: "INITIATIVE",
			}),
		);

		const resInvalid = await buildApp().request(
			"/projects/proj-1/features?kind=EPIC",
		);
		expect(resInvalid.status).toBe(400);
		expect(await resInvalid.json()).toEqual({
			error: {
				message: "kind must be one of: FEATURE, BUG, INITIATIVE",
			},
		});
	});
});
