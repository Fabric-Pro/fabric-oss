/**
 * `POST /api/v1/projects/:projectId/contexts/synced-files/missing`, which
 * `fabric context push` asks about the files its lock records as pushed.
 *
 * What this suite owns is the ROUTE: the key's declared scope, the creator's
 * live `CONTEXT_READ`, visibility and the hosting organization, the body's
 * shape, and an answer read only from the hosting organization's rows of this
 * project.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		resolveEffectiveProjectPermissions: vi.fn(),
		hasProjectAccess: vi.fn(),
		findContexts: vi.fn(),
		findOrganization: vi.fn(),
		scopes: ["projects:write"] as string[],
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		organization: { findFirst: mocks.findOrganization },
		projectContext: { findMany: mocks.findContexts },
	},
	hasProjectAccess: mocks.hasProjectAccess,
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
		) => {
			if (!mocks.scopes.includes(scope) && !mocks.scopes.includes("*")) {
				return c.json(
					{ error: `Missing required scope: ${scope}` },
					403,
				);
			}
			return next();
		},
}));

vi.mock("../helpers", () => ({
	badRequest: (message: string) => ({ error: { message } }),
	forbidden: (message: string) => ({ error: { message } }),
	notFound: (resource: string) => ({
		error: { message: `${resource} not found` },
	}),
	ok: (data: unknown) => ({ data }),
}));

const { registerContextRoutes } = await import("../contexts");

const PROJECT = "project-1";
const ORG = "org-1";
const PATH = `/projects/${PROJECT}/contexts/synced-files/missing`;

let apiContext: {
	keyType: "personal" | "organization" | "oauth";
	userId: string;
	organizationId?: string;
	scopes: string[];
};

function buildApp() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", apiContext);
		await next();
	});
	registerContextRoutes(
		app as unknown as Parameters<typeof registerContextRoutes>[0],
	);
	return app;
}

function post(body: unknown, query = "") {
	return new Request(`http://localhost${PATH}${query}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

beforeEach(() => {
	for (const value of Object.values(mocks)) {
		if (typeof value === "function" && "mockReset" in value) {
			(value as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	mocks.scopes = ["projects:write"];
	apiContext = {
		keyType: "organization",
		userId: "user-1",
		organizationId: ORG,
		scopes: mocks.scopes,
	};
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: ["context:read", "context:create"],
		source: "project-member",
		organizationId: ORG,
	});
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.findContexts.mockResolvedValue([]);
});

describe("POST /projects/:projectId/contexts/synced-files/missing — the gates", () => {
	it("refuses a key without projects:write with the flat scope refusal, before any lookup", async () => {
		mocks.scopes = ["projects:read"];

		const res = await buildApp().fetch(post({ sourcePaths: ["a.md"] }));

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "Missing required scope: projects:write",
		});
		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
		expect(mocks.findContexts).not.toHaveBeenCalled();
	});

	it("still requires the creator's live CONTEXT_READ for a wildcard key", async () => {
		mocks.scopes = ["*"];
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "project-member",
			organizationId: ORG,
		});

		const res = await buildApp().fetch(post({ sourcePaths: ["a.md"] }));

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toMatch(/read/i);
		expect(mocks.findContexts).not.toHaveBeenCalled();
	});

	it("answers 404 for a project the caller cannot see, even with the permission", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		const res = await buildApp().fetch(post({ sourcePaths: ["a.md"] }));

		expect(res.status).toBe(404);
		expect(mocks.findContexts).not.toHaveBeenCalled();
	});

	it("answers 404 when an organization key names another organization's project", async () => {
		apiContext = { ...apiContext, organizationId: "org-other" };

		const res = await buildApp().fetch(post({ sourcePaths: ["a.md"] }));

		expect(res.status).toBe(404);
		expect(mocks.findContexts).not.toHaveBeenCalled();
	});

	it("refuses ?personal=1 before resolving anything", async () => {
		const res = await buildApp().fetch(
			post({ sourcePaths: ["a.md"] }, "?personal=1"),
		);

		expect(res.status).toBe(403);
		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
	});
});

describe("POST /projects/:projectId/contexts/synced-files/missing — the body", () => {
	it.each([
		["invalid JSON", "{not json"],
		["an array", ["a.md"]],
		["no paths", {}],
		["an empty list", { sourcePaths: [] }],
		["a list that is not one", { sourcePaths: "a.md" }],
		["a path that is not a string", { sourcePaths: [1] }],
		["an empty path", { sourcePaths: [""] }],
		["a path no server stores", { sourcePaths: ["a".repeat(513)] }],
		[
			"more paths than one request answers for",
			{ sourcePaths: Array.from({ length: 501 }, (_, i) => `${i}.md`) },
		],
	])("refuses %s with 400 and reads nothing", async (_name, body) => {
		const res = await buildApp().fetch(post(body));

		expect(res.status).toBe(400);
		expect(mocks.findContexts).not.toHaveBeenCalled();
	});

	it("accepts the largest request, every path at its longest", async () => {
		const sourcePaths = Array.from(
			{ length: 500 },
			(_, i) => `${i}`.padStart(3, "0") + "é".repeat(509),
		);

		const res = await buildApp().fetch(post({ sourcePaths }));

		expect(res.status).toBe(200);
	});
});

describe("POST /projects/:projectId/contexts/synced-files/missing — the answer", () => {
	it("lists the paths with no row, in the order sent", async () => {
		mocks.findContexts.mockResolvedValue([{ sourcePath: "b.md" }]);

		const res = await buildApp().fetch(
			post({ sourcePaths: ["c.md", "b.md", "a.md"] }),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			data: { missing: ["c.md", "a.md"] },
		});
	});

	it("reads only this project's rows in its hosting organization", async () => {
		await buildApp().fetch(post({ sourcePaths: ["a.md"] }));

		expect(mocks.findContexts).toHaveBeenCalledWith({
			where: {
				projectId: PROJECT,
				organizationId: ORG,
				sourcePath: { in: ["a.md"] },
			},
			select: { sourcePath: true },
		});
	});

	it("answers an empty list when every path is stored", async () => {
		mocks.findContexts.mockResolvedValue([{ sourcePath: "a.md" }]);

		const res = await buildApp().fetch(post({ sourcePaths: ["a.md"] }));

		expect(await res.json()).toEqual({ data: { missing: [] } });
	});
});
