/**
 * Public v1 synced-context route (Fizzy #2618).
 *
 * `projects.contexts.upsertSyncedFile` is a `tenantProtectedProcedure`, and
 * that chain authenticates with a Better Auth session cookie only, so no API
 * key — and therefore no `fabric context push` — could ever reach it. This
 * route is the key-backed twin, and what is pinned here is the authorization
 * shape every key-backed surface owes (AGENTS.md, "API keys never grant more
 * than the UI"):
 *
 *  - the key's declared scope, `projects:write` — the scope the MCP twin
 *    `fabric_upsert_project_context` already demands — refused with the
 *    middleware's flat `{ error: "Missing required scope: …" }`;
 *  - the creator's LIVE `CONTEXT_CREATE` on the project, checked on every
 *    call including for a wildcard `*` key, refused with the nested
 *    `{ error: { message } }` so the two stay distinguishable;
 *  - the project supplies the tenant: an organization key never reaches
 *    another organization's project, and a project the caller cannot see is
 *    NOT FOUND rather than forbidden.
 *
 * The shared `upsertSyncedContext` is mocked: its validation, write, embed
 * and audit are covered by `upsert-synced-file.test.ts` and reached the same
 * way from three surfaces. What this suite owns is the ROUTE.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		resolveEffectiveProjectPermissions: vi.fn(),
		hasProjectAccess: vi.fn(),
		upsertSyncedContext: vi.fn(),
		/** `db.organization.findFirst`, for the explicit `?org=` binding. */
		findOrganization: vi.fn(),
		/** `db.user.findUnique`, for the audit actor snapshot. */
		findUser: vi.fn(),
		/** The scopes the caller's key carries, read by the `requireScope` stub. */
		scopes: ["projects:write"] as string[],
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		organization: { findFirst: mocks.findOrganization },
		user: { findUnique: mocks.findUser },
	},
	hasProjectAccess: mocks.hasProjectAccess,
}));

vi.mock("../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions:
		mocks.resolveEffectiveProjectPermissions,
}));

vi.mock("../../projects/lib/upsert-synced-context", () => ({
	upsertSyncedContext: mocks.upsertSyncedContext,
}));

/**
 * A faithful stand-in for the real middleware, not a no-op: the scope refusal
 * is one of the behaviours under test, and its flat body shape is what keeps
 * it distinguishable from the object-level refusal.
 */
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
	ok: (data: unknown, meta?: unknown) => ({
		data,
		...(meta ? { meta } : {}),
	}),
}));

const { registerContextRoutes } = await import("../contexts");

const PROJECT = "project-1";
const ORG = "org-1";
const PATH = `/projects/${PROJECT}/contexts/synced-files`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let apiContext: {
	keyType: "personal" | "organization";
	userId: string;
	organizationId?: string;
	scopes: string[];
};

function organizationKey(organizationId: string, userId = "user-1") {
	return {
		keyType: "organization" as const,
		userId,
		organizationId,
		scopes: mocks.scopes,
	};
}

function personalKey(userId = "user-1") {
	return {
		keyType: "personal" as const,
		userId,
		organizationId: undefined,
		scopes: mocks.scopes,
	};
}

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

function put(body: unknown, query = "") {
	return new Request(`http://localhost${PATH}${query}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

function fileBody(overrides: Record<string, unknown> = {}) {
	return {
		sourcePath: "docs/architecture.md",
		content: "# Architecture\n",
		...overrides,
	};
}

/** An `ORPCError`-shaped rejection, as the shared function throws. */
function orpcRefusal(code: string, message: string) {
	return Object.assign(new Error(message), { code, message });
}

beforeEach(() => {
	for (const value of Object.values(mocks)) {
		if (typeof value === "function" && "mockReset" in value) {
			(value as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	mocks.scopes = ["projects:write"];
	apiContext = organizationKey(ORG);
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: ["context:create"],
		source: "org",
		organizationId: ORG,
	});
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.findOrganization.mockResolvedValue({ id: ORG });
	mocks.findUser.mockResolvedValue({
		email: "dev@example.com",
		name: "Example Developer",
	});
	mocks.upsertSyncedContext.mockResolvedValue({
		status: "created",
		contextId: "ctx-1",
		sourcePath: "docs/architecture.md",
		contentHash: HASH_A,
	});
});

describe("PUT /projects/:projectId/contexts/synced-files — the key's scope", () => {
	it("refuses a key without projects:write with the flat scope refusal, before any lookup", async () => {
		// The coarse MCP umbrella is not this surface's scope: `mcp:write`
		// satisfies the gateway's dispatcher, and nothing on the REST side.
		mocks.scopes = ["projects:read", "mcp:write", "instructions:write"];
		apiContext = organizationKey(ORG);

		const res = await buildApp().fetch(put(fileBody()));

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "Missing required scope: projects:write",
		});
		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
		expect(mocks.upsertSyncedContext).not.toHaveBeenCalled();
	});

	it("still requires the creator's live CONTEXT_CREATE for a wildcard key", async () => {
		mocks.scopes = ["*"];
		apiContext = organizationKey(ORG);
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["context:read"],
			source: "org",
			organizationId: ORG,
		});

		const res = await buildApp().fetch(put(fileBody()));

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { message: string } };
		// The nested shape: a permission refusal, never a scope refusal.
		expect(typeof body.error).toBe("object");
		expect(body.error.message).toMatch(/permission/i);
		expect(body.error.message).not.toMatch(/scope/i);
		expect(mocks.upsertSyncedContext).not.toHaveBeenCalled();
	});

	it("refuses a projects:write key whose creator lacks CONTEXT_CREATE (a viewer on the project)", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["context:read", "project:read"],
			source: "project-member",
			organizationId: ORG,
		});

		const res = await buildApp().fetch(put(fileBody()));

		expect(res.status).toBe(403);
		expect(mocks.upsertSyncedContext).not.toHaveBeenCalled();
	});
});

describe("PUT /projects/:projectId/contexts/synced-files — the tenant", () => {
	it("writes under the project's hosting organization as the key's creator", async () => {
		const res = await buildApp().fetch(
			// A body naming an organization is ignored, never trusted.
			put(fileBody({ organizationId: "org-evil", userId: "user-evil" })),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			data: {
				status: "created",
				contextId: "ctx-1",
				sourcePath: "docs/architecture.md",
				contentHash: HASH_A,
			},
		});
		expect(mocks.resolveEffectiveProjectPermissions).toHaveBeenCalledWith(
			PROJECT,
			"user-1",
		);
		expect(mocks.upsertSyncedContext).toHaveBeenCalledTimes(1);
		expect(mocks.upsertSyncedContext).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT,
				sourcePath: "docs/architecture.md",
				content: "# Architecture\n",
				userId: "user-1",
				organizationId: ORG,
				via: "v1-api",
				request: expect.objectContaining({
					user: {
						id: "user-1",
						email: "dev@example.com",
						name: "Example Developer",
					},
				}),
			}),
		);
	});

	it("passes title and expectedContentHash through when they are sent", async () => {
		await buildApp().fetch(
			put(
				fileBody({
					title: "Architecture",
					expectedContentHash: HASH_B,
				}),
			),
		);

		expect(mocks.upsertSyncedContext).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Architecture",
				expectedContentHash: HASH_B,
			}),
		);
	});

	it("answers 404 when an organization key names another organization's project", async () => {
		apiContext = organizationKey("org-other");

		const res = await buildApp().fetch(put(fileBody()));

		expect(res.status).toBe(404);
		expect(mocks.upsertSyncedContext).not.toHaveBeenCalled();
	});

	it("answers 404 for a project the caller cannot see, even with the org role's permission", async () => {
		// The resolver's org-role fallback grants CONTEXT_CREATE on every
		// project in the organization; visibility is a separate question.
		mocks.hasProjectAccess.mockResolvedValue(false);

		const res = await buildApp().fetch(put(fileBody()));

		expect(res.status).toBe(404);
		expect(mocks.upsertSyncedContext).not.toHaveBeenCalled();
	});

	it("answers 404 for a project that does not exist", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(null);

		const res = await buildApp().fetch(put(fileBody()));

		expect(res.status).toBe(404);
		expect(mocks.upsertSyncedContext).not.toHaveBeenCalled();
	});

	it("keeps an invited guest's personal key working on the host's project", async () => {
		apiContext = personalKey("guest-1");
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["context:create"],
			source: "project-member",
			organizationId: ORG,
		});

		const res = await buildApp().fetch(put(fileBody()));

		expect(res.status).toBe(200);
		expect(mocks.upsertSyncedContext).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "guest-1", organizationId: ORG }),
		);
	});

	it("refuses a personal project: there is no organization to write under", async () => {
		apiContext = personalKey();
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["context:create"],
			source: "owner",
			organizationId: null,
		});

		const res = await buildApp().fetch(put(fileBody()));

		expect(res.status).toBe(403);
		expect(mocks.upsertSyncedContext).not.toHaveBeenCalled();
	});

	it("refuses ?personal=1 before resolving anything", async () => {
		const res = await buildApp().fetch(put(fileBody(), "?personal=1"));

		expect(res.status).toBe(403);
		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
		expect(mocks.upsertSyncedContext).not.toHaveBeenCalled();
	});

	it("honours an explicit ?org= that names the project's own organization", async () => {
		const res = await buildApp().fetch(put(fileBody(), "?org=example-org"));

		expect(res.status).toBe(200);
		expect(mocks.findOrganization).toHaveBeenCalledWith({
			where: { slug: "example-org" },
			select: { id: true },
		});
	});

	it("answers 404 for an explicit ?org= that is not the project's", async () => {
		mocks.findOrganization.mockResolvedValue({ id: "org-other" });

		const res = await buildApp().fetch(put(fileBody(), "?org=other-org"));

		expect(res.status).toBe(404);
		expect(mocks.upsertSyncedContext).not.toHaveBeenCalled();
	});

	it("never resolves ?org= for a caller without the permission (no slug oracle)", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "org",
			organizationId: ORG,
		});

		const res = await buildApp().fetch(put(fileBody(), "?org=anything"));

		expect(res.status).toBe(403);
		expect(mocks.findOrganization).not.toHaveBeenCalled();
	});
});

describe("PUT /projects/:projectId/contexts/synced-files — outcomes", () => {
	it("answers a conflict with 409 and keeps the stored version's stamp", async () => {
		mocks.upsertSyncedContext.mockResolvedValue({
			status: "conflict",
			contextId: "ctx-1",
			sourcePath: "docs/architecture.md",
			contentHash: HASH_A,
			current: {
				contextId: "ctx-1",
				contentHash: HASH_B,
				contentUpdatedAt: new Date("2026-09-22T10:00:00.000Z"),
				contentUpdatedBy: { id: "user-2", name: "Example Editor" },
			},
		});

		const res = await buildApp().fetch(
			put(fileBody({ expectedContentHash: "c".repeat(64) })),
		);

		expect(res.status).toBe(409);
		const body = (await res.json()) as {
			error: { message: string; code: string; data: unknown };
		};
		expect(body.error.code).toBe("CONFLICT");
		expect(body.error.message).toMatch(/nothing was written/i);
		expect(body.error.data).toEqual({
			status: "conflict",
			contextId: "ctx-1",
			sourcePath: "docs/architecture.md",
			contentHash: HASH_A,
			current: {
				contextId: "ctx-1",
				contentHash: HASH_B,
				contentUpdatedAt: "2026-09-22T10:00:00.000Z",
				contentUpdatedBy: { id: "user-2", name: "Example Editor" },
			},
		});
	});

	it("answers a named hash on a deleted path with 409, no current version, and what a retry without it does", async () => {
		mocks.upsertSyncedContext.mockResolvedValue({
			status: "conflict",
			contextId: null,
			sourcePath: "docs/architecture.md",
			contentHash: HASH_A,
			current: null,
		});

		const res = await buildApp().fetch(
			put(fileBody({ expectedContentHash: HASH_B })),
		);

		expect(res.status).toBe(409);
		const body = (await res.json()) as {
			error: { message: string; code: string; data: unknown };
		};
		expect(body.error.code).toBe("CONFLICT");
		expect(body.error.message).toMatch(/deleted on the server/i);
		expect(body.error.message).toMatch(/without expectedContentHash/);
		expect(body.error.message).toMatch(
			/answers duplicate instead if that content already exists elsewhere in the project/,
		);
		expect(body.error.data).toEqual({
			status: "conflict",
			contextId: null,
			sourcePath: "docs/architecture.md",
			contentHash: HASH_A,
			current: null,
		});
	});

	it.each([["unchanged"], ["updated"]])(
		"answers %s with 200 and the result",
		async (status) => {
			mocks.upsertSyncedContext.mockResolvedValue({
				status,
				contextId: "ctx-1",
				sourcePath: "docs/architecture.md",
				contentHash: HASH_A,
			});

			const res = await buildApp().fetch(put(fileBody()));

			expect(res.status).toBe(200);
			expect(
				((await res.json()) as { data: { status: string } }).data
					.status,
			).toBe(status);
		},
	);

	it("answers a duplicate with 200 and names the other source", async () => {
		mocks.upsertSyncedContext.mockResolvedValue({
			status: "duplicate",
			contextId: "ctx-9",
			sourcePath: "copy.md",
			contentHash: HASH_A,
			duplicateOfContextId: "ctx-9",
			duplicateOfSourcePath: "docs/architecture.md",
		});

		const res = await buildApp().fetch(
			put(fileBody({ sourcePath: "copy.md" })),
		);

		expect(res.status).toBe(200);
		expect(
			((await res.json()) as { data: { duplicateOfSourcePath: string } })
				.data.duplicateOfSourcePath,
		).toBe("docs/architecture.md");
	});

	it("maps the shared function's BAD_REQUEST to a 400 carrying its sentence", async () => {
		mocks.upsertSyncedContext.mockRejectedValue(
			orpcRefusal(
				"BAD_REQUEST",
				"sourcePath may not contain '.' or '..' segments; pass the file's relative path inside the project's working tree",
			),
		);

		const res = await buildApp().fetch(
			put(fileBody({ sourcePath: "../x.md" })),
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: {
				message:
					"sourcePath may not contain '.' or '..' segments; pass the file's relative path inside the project's working tree",
			},
		});
	});

	it("lets an unexpected failure propagate rather than inventing a status", async () => {
		mocks.upsertSyncedContext.mockRejectedValue(new Error("db down"));
		const app = buildApp();
		app.onError((_error, c) => c.json({ error: "boom" }, 500));

		const res = await app.fetch(put(fileBody()));

		expect(res.status).toBe(500);
	});
});

describe("PUT /projects/:projectId/contexts/synced-files — the body", () => {
	it.each([
		["not JSON", "{ nope"],
		["an array", []],
		["no sourcePath", { content: "x" }],
		["an empty sourcePath", { sourcePath: "", content: "x" }],
		[
			"a sourcePath over 2048 characters",
			{ sourcePath: "a".repeat(2049), content: "x" },
		],
		["no content", { sourcePath: "a.md" }],
		["a non-string title", { sourcePath: "a.md", content: "x", title: 7 }],
		[
			"a non-string expectedContentHash",
			{ sourcePath: "a.md", content: "x", expectedContentHash: 7 },
		],
	])(
		"refuses %s with 400 before resolving the project",
		async (_label, body) => {
			const res = await buildApp().fetch(put(body));

			expect(res.status).toBe(400);
			expect(
				mocks.resolveEffectiveProjectPermissions,
			).not.toHaveBeenCalled();
			expect(mocks.upsertSyncedContext).not.toHaveBeenCalled();
		},
	);
});

describe("PUT /projects/:projectId/contexts/synced-files — the body's size", () => {
	const MIB = 1024 * 1024;
	/**
	 * 2 MiB of content at JSON's worst-case escape factor — a control
	 * character is six bytes on the wire (`\u0001`) — plus 64 KiB for the
	 * path, title and hash.
	 */
	const ENVELOPE = 6 * 2 * MIB + 64 * 1024;

	function oversized(withLength: boolean) {
		const body = JSON.stringify(
			fileBody({ content: "x".repeat(ENVELOPE + 1) }),
		);
		return new Request(`http://localhost${PATH}`, {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				...(withLength
					? { "content-length": String(Buffer.byteLength(body)) }
					: {}),
			},
			body,
		});
	}

	it.each([
		["a declared Content-Length", true],
		["a body that only turns out to be too large while it is read", false],
	])(
		"refuses %s over the envelope with 413 before the handler runs",
		async (_label, withLength) => {
			const res = await buildApp().fetch(oversized(withLength));

			expect(res.status).toBe(413);
			const body = (await res.json()) as { error: unknown };
			expect(typeof body.error).toBe("string");
			expect(body.error).toMatch(/too large/i);
			expect(
				mocks.resolveEffectiveProjectPermissions,
			).not.toHaveBeenCalled();
			expect(mocks.upsertSyncedContext).not.toHaveBeenCalled();
		},
	);

	it("still refuses a key without the scope as a scope refusal, whatever the body's size", async () => {
		mocks.scopes = ["projects:read"];

		const res = await buildApp().fetch(oversized(true));

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "Missing required scope: projects:write",
		});
	});

	it("accepts a full 2 MiB file", async () => {
		const res = await buildApp().fetch(
			put(fileBody({ content: "x".repeat(2 * 1024 * 1024) })),
		);

		expect(res.status).toBe(200);
		expect(mocks.upsertSyncedContext).toHaveBeenCalledTimes(1);
	});

	it("accepts 2 MiB of quotation marks, which JSON doubles on the wire, and hands it to the handler", async () => {
		const content = '"'.repeat(2 * MIB);
		const request = put(fileBody({ content }));
		// Over the old 4 MiB envelope: two bytes per character, plus the rest.
		expect(
			Buffer.byteLength(JSON.stringify(fileBody({ content }))),
		).toBeGreaterThan(4 * MIB);

		const res = await buildApp().fetch(request);

		expect(res.status).toBe(200);
		expect(mocks.upsertSyncedContext).toHaveBeenCalledTimes(1);
		expect(mocks.upsertSyncedContext.mock.calls[0]?.[0]).toMatchObject({
			content,
		});
	});

	it("lets 2 MiB of U+0001, six bytes each on the wire, through the envelope to the handler", async () => {
		// The shared function refuses only NUL among control characters
		// (`upsertSyncedContext`'s content checks), so this content is valid
		// and must not be lost to the envelope.
		const content = "\u0001".repeat(2 * MIB);
		const bytes = Buffer.byteLength(JSON.stringify(fileBody({ content })));
		expect(bytes).toBeGreaterThan(12 * MIB);
		expect(bytes).toBeLessThanOrEqual(ENVELOPE);

		const res = await buildApp().fetch(put(fileBody({ content })));

		expect(res.status).toBe(200);
		expect(mocks.upsertSyncedContext).toHaveBeenCalledTimes(1);
		expect(mocks.upsertSyncedContext.mock.calls[0]?.[0]).toMatchObject({
			content,
		});
	});
});
