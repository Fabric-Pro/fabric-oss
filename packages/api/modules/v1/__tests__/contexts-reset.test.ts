/**
 * `POST /api/v1/projects/:projectId/contexts/reset`, the key-backed twin of
 * `projects.contexts.resetLivingMemory` that `fabric context reset` calls.
 *
 * What this suite owns is the ROUTE, with the two gates every key-backed
 * surface owes (AGENTS.md):
 *  - the key's declared scope, `projects:write`, refused with the flat
 *    `{ error: "Missing required scope: …" }` before any lookup;
 *  - the creator's LIVE `CONTEXT_DELETE`, checked on every call including
 *    for a wildcard `*` key, refused with the nested `{ error: { message } }`;
 *  - visibility and the hosting organization, as the other context routes;
 *  - the shared function's answers: 200 `{ data: { deleted } }`, and 409
 *    `REPOSITORY_SYNC_ACTIVE` with its own body.
 *
 * The shared `resetSyncedContexts` is mocked; its refusal body helper is the
 * real one.
 */
import { ORPCError } from "@orpc/client";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		resolveEffectiveProjectPermissions: vi.fn(),
		hasProjectAccess: vi.fn(),
		resetSyncedContexts: vi.fn(),
		findOrganization: vi.fn(),
		findUser: vi.fn(),
		scopes: ["projects:write"] as string[],
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		organization: { findFirst: mocks.findOrganization },
		user: { findUnique: mocks.findUser },
	},
	hasProjectAccess: mocks.hasProjectAccess,
	resetSyncedContextRows: vi.fn(),
}));

vi.mock("../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions:
		mocks.resolveEffectiveProjectPermissions,
}));

// The reset module's own imports, so its real refusal body helper loads.
vi.mock("../../../lib/realtime", () => ({
	emitContextChange: vi.fn(),
	emitActivity: vi.fn(),
}));
vi.mock("../../../lib/audit", () => ({ auditRequestFields: vi.fn() }));
vi.mock("../../../orpc/middleware/audit-timing-middleware", () => ({
	markCuratedAuditWritten: vi.fn(),
}));
vi.mock("../../projects/lib/delete-synced-context", () => ({
	deleteSyncedContext: vi.fn(),
	drainSyncedContextCleanupOnce: vi.fn(),
}));
vi.mock("../../projects/lib/upsert-synced-context", () => ({
	upsertSyncedContext: vi.fn(),
}));

vi.mock("../../projects/lib/reset-synced-contexts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../projects/lib/reset-synced-contexts")
	>()),
	resetSyncedContexts: mocks.resetSyncedContexts,
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
const { repositorySyncActiveError } = await import(
	"../../projects/lib/reset-synced-contexts"
);

const PROJECT = "project-1";
const ORG = "org-1";
const PATH = `/projects/${PROJECT}/contexts/reset`;

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

function post(query = "") {
	return new Request(`http://localhost${PATH}${query}`, { method: "POST" });
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
		permissions: ["context:create", "context:delete"],
		source: "project-member",
		organizationId: ORG,
	});
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.findUser.mockResolvedValue({
		email: "dev@example.com",
		name: "Example Developer",
	});
	mocks.resetSyncedContexts.mockResolvedValue({ deleted: 4 });
});

describe("POST /projects/:projectId/contexts/reset — the two gates", () => {
	it("refuses a key without projects:write with the flat scope refusal, before any lookup", async () => {
		mocks.scopes = ["projects:read"];

		const res = await buildApp().fetch(post());

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "Missing required scope: projects:write",
		});
		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
		expect(mocks.resetSyncedContexts).not.toHaveBeenCalled();
	});

	it("still requires the creator's live CONTEXT_DELETE for a wildcard key", async () => {
		mocks.scopes = ["*"];
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["context:read", "context:create"],
			source: "project-member",
			organizationId: ORG,
		});

		const res = await buildApp().fetch(post());

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { message: string } };
		expect(typeof body.error).toBe("object");
		expect(body.error.message).toMatch(/delete/i);
		expect(mocks.resetSyncedContexts).not.toHaveBeenCalled();
	});

	it("answers 404 for a project the caller cannot see, even with the permission", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		const res = await buildApp().fetch(post());

		expect(res.status).toBe(404);
		expect(mocks.resetSyncedContexts).not.toHaveBeenCalled();
	});

	it("answers 404 when an organization key names another organization's project", async () => {
		apiContext = { ...apiContext, organizationId: "org-other" };

		const res = await buildApp().fetch(post());

		expect(res.status).toBe(404);
		expect(mocks.resetSyncedContexts).not.toHaveBeenCalled();
	});

	it("refuses ?personal=1 before resolving anything", async () => {
		const res = await buildApp().fetch(post("?personal=1"));

		expect(res.status).toBe(403);
		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
	});
});

describe("POST /projects/:projectId/contexts/reset — outcomes", () => {
	it("resets under the hosting organization as the key's creator and answers the count", async () => {
		const res = await buildApp().fetch(post());

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ data: { deleted: 4 } });
		expect(mocks.resetSyncedContexts).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT,
				userId: "user-1",
				organizationId: ORG,
				via: "v1-api",
			}),
		);
	});

	it("answers 409 REPOSITORY_SYNC_ACTIVE with its own body while a sync is connected", async () => {
		mocks.resetSyncedContexts.mockRejectedValue(
			repositorySyncActiveError({
				repository: "example-org/notes",
				ref: "main",
			}),
		);

		const res = await buildApp().fetch(post());

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			error: {
				message: expect.stringContaining(
					"Disconnect the repository sync",
				),
				code: "REPOSITORY_SYNC_ACTIVE",
				repository: "example-org/notes",
				ref: "main",
			},
		});
	});

	it("maps the shared function's FORBIDDEN to 403", async () => {
		mocks.resetSyncedContexts.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Synced context files require an organization project",
			}),
		);

		const res = await buildApp().fetch(post());

		expect(res.status).toBe(403);
	});
});
