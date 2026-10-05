/**
 * An agent that signed in for ONE project on the public v1 surface.
 *
 * Such a credential reaches its own project's coding-instructions, synced
 * context, features and project routes and nothing organization-wide. Every
 * refusal below is a route handler's own answer to the credential it was given,
 * with the real `resolveV1Context` and `resolveInstructionProject` in play and
 * only the database stood in for.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		findProject: vi.fn(),
		getProjectAccessById: vi.fn(),
		getProjectByIdForExternalApi: vi.fn(),
		listProjects: vi.fn(),
		listStories: vi.fn(),
		resolveUserOrganization: vi.fn(),
		resolveEffectiveProjectPermissions: vi.fn(),
		hasProjectAccess: vi.fn(),
		findOrganization: vi.fn(),
		scopes: ["*"] as string[],
	},
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	db: {
		project: { findUnique: mocks.findProject },
		organization: { findFirst: mocks.findOrganization },
	},
	getProjectAccessById: mocks.getProjectAccessById,
	getProjectByIdForExternalApi: mocks.getProjectByIdForExternalApi,
	hasProjectAccess: mocks.hasProjectAccess,
	listProjects: mocks.listProjects,
	listStories: mocks.listStories,
	resolveUserOrganization: mocks.resolveUserOrganization,
}));

vi.mock("../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions:
		mocks.resolveEffectiveProjectPermissions,
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		(scope: string) =>
		async (
			c: { json: (body: unknown, status: number) => unknown },
			next: () => Promise<unknown>,
		) =>
			mocks.scopes.includes(scope) || mocks.scopes.includes("*")
				? next()
				: c.json({ error: `Missing required scope: ${scope}` }, 403),
}));

const { resolveV1Context } = await import("../helpers");
const { resolveInstructionProject } = await import(
	"../instruction-project-gate"
);
const { registerProjectRoutes } = await import("../projects");
const { registerFeatureRoutes } = await import("../features");
const { registerMcpRoutes } = await import("../mcp");

const ORG = "org-example-alpha";
const BOUND = "project-example-one";
const OTHER = "project-example-two";

interface Credential {
	keyType: "personal" | "organization" | "oauth";
	keyId: string;
	keyPrefix: string;
	userId: string;
	organizationId: string | undefined;
	scopes: string[];
	boundProjectId?: string;
}

const projectBound: Credential = {
	keyType: "oauth",
	keyId: "client-row-1",
	keyPrefix: "fat_client-r",
	userId: "user-1",
	organizationId: ORG,
	scopes: ["*"],
	boundProjectId: BOUND,
};

const organizationWide: Credential = {
	keyType: "oauth",
	keyId: "client-row-2",
	keyPrefix: "fat_client-r",
	userId: "user-1",
	organizationId: ORG,
	scopes: ["*"],
};

function appFor(credential: Credential) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", credential);
		await next();
	});
	registerProjectRoutes(
		app as unknown as Parameters<typeof registerProjectRoutes>[0],
	);
	registerFeatureRoutes(
		app as unknown as Parameters<typeof registerFeatureRoutes>[0],
	);
	registerMcpRoutes(
		app as unknown as Parameters<typeof registerMcpRoutes>[0],
	);
	return app;
}

beforeEach(() => {
	for (const value of Object.values(mocks)) {
		if (typeof value === "function" && "mockReset" in value) {
			(value as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	mocks.scopes = ["*"];
	mocks.findProject.mockResolvedValue({ name: "Example Project" });
	mocks.getProjectAccessById.mockResolvedValue({
		id: BOUND,
		organizationId: ORG,
	});
	mocks.getProjectByIdForExternalApi.mockResolvedValue({
		id: BOUND,
		name: "Example Project",
	});
	mocks.listProjects.mockResolvedValue({
		projects: [],
		total: 0,
		hasMore: false,
	});
	mocks.listStories.mockResolvedValue({ stories: [], total: 0 });
	mocks.resolveUserOrganization.mockResolvedValue({
		kind: "resolved",
		organizationId: ORG,
	});
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: ["instruction:read"],
		source: "org",
		organizationId: ORG,
	});
});

describe("resolveV1Context", () => {
	it("resolves, in the organization hosting the project, for a route that names the project", async () => {
		expect(
			await resolveV1Context(projectBound, undefined, false, BOUND),
		).toEqual({ userId: "user-1", organizationId: ORG });
	});

	it("refuses a route that names another project, naming the one the sign-in is limited to", async () => {
		expect(
			await resolveV1Context(projectBound, undefined, false, OTHER),
		).toEqual({
			error: "This sign-in is limited to project Example Project",
			status: 403,
		});
	});

	it("refuses every organization-wide route, which names no project", async () => {
		expect(await resolveV1Context(projectBound)).toEqual({
			error: "This sign-in is limited to project Example Project",
			status: 403,
		});
	});

	it("refuses ?personal=1 as it refuses it for every organization-bound credential", async () => {
		expect(
			await resolveV1Context(projectBound, undefined, true, BOUND),
		).toEqual({
			error: "Cannot use personal context with an organization-bound credential",
			status: 403,
		});
	});

	it("names the project by its id when the row cannot be read", async () => {
		mocks.findProject.mockResolvedValue(null);

		expect(await resolveV1Context(projectBound)).toEqual({
			error: `This sign-in is limited to project ${BOUND}`,
			status: 403,
		});
	});

	it("leaves an organization-wide credential exactly as it was, whether or not a project is named", async () => {
		const expected = { userId: "user-1", organizationId: ORG };

		expect(await resolveV1Context(organizationWide)).toEqual(expected);
		expect(
			await resolveV1Context(organizationWide, undefined, false, OTHER),
		).toEqual(expected);
		expect(mocks.findProject).not.toHaveBeenCalled();
	});
});

describe("the coding-instructions project gate", () => {
	it("lets an agent through to its own project, as it would any other credential", async () => {
		const resolved = await resolveInstructionProject(BOUND, projectBound, {
			personal: false,
		});

		expect(resolved).toMatchObject({ organizationId: ORG });
		expect(resolved).not.toHaveProperty("error");
	});

	it("answers another project as one that does not exist, before anything is read", async () => {
		const resolved = await resolveInstructionProject(OTHER, projectBound, {
			personal: false,
		});

		expect(resolved).toEqual({
			error: { message: "Project not found" },
			status: 404,
		});
		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
		expect(mocks.hasProjectAccess).not.toHaveBeenCalled();
	});
});

describe("GET /projects/:id", () => {
	it("serves the agent's own project", async () => {
		const response = await appFor(projectBound).request(
			`http://localhost/projects/${BOUND}`,
		);

		expect(response.status).toBe(200);
		expect(mocks.getProjectByIdForExternalApi).toHaveBeenCalledWith(
			BOUND,
			"user-1",
			ORG,
		);
	});

	it("refuses another project without reading it", async () => {
		const response = await appFor(projectBound).request(
			`http://localhost/projects/${OTHER}`,
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: {
				message: "This sign-in is limited to project Example Project",
			},
		});
		expect(mocks.getProjectByIdForExternalApi).not.toHaveBeenCalled();
	});
});

describe("GET /projects", () => {
	it("refuses the organization-wide list", async () => {
		const response = await appFor(projectBound).request(
			"http://localhost/projects",
		);

		expect(response.status).toBe(403);
		expect(mocks.listProjects).not.toHaveBeenCalled();
	});
});

describe("GET /projects/:projectId/features", () => {
	it("serves the agent's own project's features", async () => {
		const response = await appFor(projectBound).request(
			`http://localhost/projects/${BOUND}/features`,
		);

		expect(response.status).toBe(200);
		expect(mocks.listStories).toHaveBeenCalledOnce();
	});

	it("refuses another project's features without reading them", async () => {
		const response = await appFor(projectBound).request(
			`http://localhost/projects/${OTHER}/features`,
		);

		expect(response.status).toBe(403);
		expect(mocks.getProjectAccessById).not.toHaveBeenCalled();
		expect(mocks.listStories).not.toHaveBeenCalled();
	});
});

describe("the MCP configuration export", () => {
	it.each(["/user/mcp-config", "/user/mcp-config/validate"])(
		"%s is the organization's connected servers, and is refused",
		async (path) => {
			const response = await appFor(projectBound).request(
				`http://localhost${path}`,
			);

			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({
				error: {
					message:
						"This sign-in is limited to project Example Project",
				},
			});
		},
	);
});
