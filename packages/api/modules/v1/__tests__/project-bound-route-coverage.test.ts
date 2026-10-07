/**
 * Every route of the public v1 API, asked for by an agent that signed in for ONE
 * project.
 *
 * Such a credential reaches `/auth/whoami`, `/instructions/checkouts/resolve`
 * and the routes under its own project, and the central check in
 * `requireApiKey` refuses everything else before any route runs. The routes
 * come from the real `createPublicV1Routes()`, not from a list kept here, so a
 * route that is added later is refused until someone decides otherwise, and a
 * route that would become reachable fails this test until it is reviewed and
 * added to `REACHABLE`.
 *
 * Nothing under a route runs: the rate limiter, which sits right behind
 * `requireApiKey`, answers 204 for any request that gets past it, so a status
 * of 204 means "reached its route" and 403 means "refused at the door".
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findProject: vi.fn(),
	verifyOAuthAccessToken: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	db: { project: { findUnique: mocks.findProject } },
	verifyOAuthAccessToken: mocks.verifyOAuthAccessToken,
}));

vi.mock("../../external-api/middleware/api-rate-limit", () => ({
	externalApiRateLimit:
		() => async (c: { body: (body: null, status: number) => Response }) =>
			c.body(null, 204),
}));

const { createPublicV1Routes } = await import("../routes");

const BOUND = "project-example-one";
const OTHER = "project-example-two";
const TOKEN = "fat_example-access-token";

/**
 * Every route a project-bound credential gets past the door to. Each was
 * reviewed to pin the project it names to the credential's own, or to refuse
 * the credential outright, before it reads or writes anything:
 *
 *   - whoami names only the organization hosting the project;
 *   - the checkout resolver answers for the bound project only;
 *   - the instruction routes go through `resolveInstructionProject`, the
 *     context routes through `credentialMayReachProject`, and the feature
 *     routes through `resolveV1Context` with the path's project;
 *   - the project's document routes call `resolveV1Context` without a project
 *     and so refuse a bound credential.
 */
const REACHABLE = [
	"DELETE /projects/:projectId/contexts/synced-files",
	"GET /auth/whoami",
	"GET /projects/:projectId/documents",
	"GET /projects/:projectId/features",
	"GET /projects/:projectId/features/:id",
	"GET /projects/:projectId/features/:id/tasks",
	"GET /projects/:projectId/instructions/proposals/:snapshotId/pull-request",
	"GET /projects/:projectId/instructions/proposals/open",
	"GET /projects/:projectId/instructions/published",
	"GET /projects/:projectId/instructions/repository",
	"GET /projects/:projectId/instructions/repository/file",
	"GET /projects/:projectId/instructions/repository/files",
	"GET /projects/:projectId/instructions/repository/git/:generation/info/refs",
	"PATCH /projects/:projectId/features/:id",
	"POST /instructions/checkouts/resolve",
	"POST /projects/:projectId/documents",
	"POST /projects/:projectId/features",
	"POST /projects/:projectId/instructions/changes",
	"POST /projects/:projectId/instructions/published/download",
	"POST /projects/:projectId/instructions/published/files",
	"POST /projects/:projectId/instructions/repository/git/:generation/git-upload-pack",
	"POST /projects/:projectId/instructions/versions",
	"PUT /projects/:projectId/contexts/synced-files",
];

const REFUSAL = {
	error: { message: "This sign-in is limited to project Example Project" },
};

const app = new Hono().route("/api/v1", createPublicV1Routes());

const registered = [
	...new Set(
		createPublicV1Routes()
			.routes.filter((route) => route.method !== "ALL")
			.map((route) => `${route.method} ${route.path}`),
	),
].sort();

/** The route's path with every parameter filled in, `projectId` and a project's `:id` with `projectId`. */
function concretePath(pattern: string, projectId: string): string {
	const segments = pattern.split("/");
	return segments
		.map((segment, index) =>
			segment.startsWith(":")
				? segments[index - 1] === "projects" || segment === ":projectId"
					? projectId
					: "sample-value"
				: segment,
		)
		.join("/");
}

function ask(route: string, projectId: string) {
	const [method, pattern] = route.split(" ");
	return app.request(`/api/v1${concretePath(pattern, projectId)}`, {
		method,
		headers: { Authorization: `Bearer ${TOKEN}` },
	});
}

beforeEach(() => {
	mocks.findProject
		.mockReset()
		.mockResolvedValue({ name: "Example Project" });
	mocks.verifyOAuthAccessToken.mockReset().mockResolvedValue({
		valid: true,
		tokenId: "token-row-1",
		clientRowId: "client-row-1",
		clientName: "Example Agent",
		userId: "user-signed-in",
		userName: "Dev",
		email: "dev@example.com",
		role: "user",
		organizationId: "org-example-alpha",
		projectId: BOUND,
		audience: "api",
		scopes: [
			"mcp:read",
			"instructions:read",
			"instructions:write",
			"offline_access",
		],
	});
});

describe("the public v1 API, for an agent that signed in for one project", () => {
	it("registers routes, and every one is known to this test", () => {
		expect(registered.length).toBeGreaterThan(60);
		expect(registered).toEqual(expect.arrayContaining(REACHABLE));
	});

	it("reaches exactly the routes that were reviewed, and no others", async () => {
		const reached: string[] = [];
		for (const route of registered) {
			const response = await ask(route, BOUND);
			if (response.status === 204) {
				reached.push(route);
			}
		}

		expect(reached).toEqual(REACHABLE);
	});

	it("refuses every other route with one answer, before the route runs", async () => {
		const refused = registered.filter(
			(route) => !REACHABLE.includes(route),
		);
		expect(refused.length).toBeGreaterThan(40);

		for (const route of refused) {
			const response = await ask(route, BOUND);

			expect(response.status, route).toBe(403);
			expect(await response.json(), route).toEqual(REFUSAL);
		}
	});

	it("refuses every route under another project", async () => {
		for (const route of registered.filter((entry) =>
			entry.includes("/projects/:projectId/"),
		)) {
			const response = await ask(route, OTHER);

			expect(response.status, route).toBe(403);
			expect(await response.json(), route).toEqual(REFUSAL);
		}
	});

	it("refuses a path no route is registered for, the same way", async () => {
		const response = await app.request("/api/v1/not-a-route", {
			headers: { Authorization: `Bearer ${TOKEN}` },
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual(REFUSAL);
	});
});
