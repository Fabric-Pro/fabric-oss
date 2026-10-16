/**
 * Public v1 Living Memory write routes (ADR-022, phase 3).
 *
 * The key-backed twin of `projects.contexts.memoryWrites.*`. What is pinned
 * here is the authorization shape every key-backed surface owes, and the wire
 * contract; admission, the receipt and the workflow are the shared functions
 * the app's procedures call, covered by their own suites and mocked here:
 *
 *  - the credential's scope, `memory:write`, on every route, refused with the
 *    middleware's flat `{ error: "Missing required scope: memory:write" }`;
 *  - the caller's LIVE permission: CONTEXT_CREATE to stage and submit,
 *    CONTEXT_READ to read, refused with the nested `{ error: { message } }`;
 *  - the project supplies the tenant, and a credential bound to another
 *    project hears of this one as of a project that does not exist;
 *  - a write is recorded `via: CLI`, with the OAuth client when there is one.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		resolveEffectiveProjectPermissions: vi.fn(),
		hasProjectAccess: vi.fn(),
		findOrganization: vi.fn(),
		findUser: vi.fn(),
		getMemoryWriteTargetsView: vi.fn(),
		getMemoryFolderFilesView: vi.fn(),
		getMemoryFolderFileView: vi.fn(),
		getMemoryWriteView: vi.fn(),
		submitMemoryWriteRequest: vi.fn(),
		createMemoryWriteUploadUrls: vi.fn(),
		scopes: ["memory:write"] as string[],
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

vi.mock("../../projects/lib/memory-write/memory-write-views", () => ({
	MEMORY_FOLDER_FILES_DEFAULT_PAGE: 500,
	MEMORY_FOLDER_FILES_MAX_PAGE: 1000,
	getMemoryWriteTargetsView: mocks.getMemoryWriteTargetsView,
	getMemoryFolderFilesView: mocks.getMemoryFolderFilesView,
	getMemoryFolderFileView: mocks.getMemoryFolderFileView,
	getMemoryWriteView: mocks.getMemoryWriteView,
}));

vi.mock("../../projects/lib/memory-write/submit-memory-write-request", () => ({
	submitMemoryWriteRequest: mocks.submitMemoryWriteRequest,
}));

vi.mock(
	"../../projects/lib/memory-write/create-memory-write-upload-urls",
	() => ({ createMemoryWriteUploadUrls: mocks.createMemoryWriteUploadUrls }),
);

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

const { registerMemoryWriteRoutes } = await import("../memory-writes");

const PROJECT = "project-1";
const ORG = "org-1";
const BASE = `/projects/${PROJECT}/memory`;

type Credential = {
	keyType: "personal" | "organization" | "oauth";
	keyId: string;
	userId: string;
	organizationId?: string;
	boundProjectId?: string;
	scopes: string[];
};

let credential: Credential;

function organizationKey(organizationId = ORG): Credential {
	return {
		keyType: "organization",
		keyId: "key-1",
		userId: "user-1",
		organizationId,
		scopes: mocks.scopes,
	};
}

function buildApp() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", credential);
		await next();
	});
	registerMemoryWriteRoutes(
		app as unknown as Parameters<typeof registerMemoryWriteRoutes>[0],
	);
	return app;
}

function post(path: string, body: unknown) {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

const get = (path: string) => new Request(`http://localhost${path}`);

const submitBody = {
	targetId: "target-1",
	message: "Add the checkout notes",
	entries: [
		{ path: "docs/memory/notes.md", op: "PUT", content: "# Notes\n" },
	],
};

beforeEach(() => {
	for (const value of Object.values(mocks)) {
		if (typeof value === "function" && "mockReset" in value) {
			(value as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	mocks.scopes = ["memory:write"];
	credential = organizationKey();
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: ["context:create", "context:read"],
		source: "org",
		organizationId: ORG,
	});
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.findOrganization.mockResolvedValue({ id: ORG });
	mocks.findUser.mockResolvedValue({
		email: "dev@example.com",
		name: "Example Developer",
	});
	mocks.getMemoryWriteTargetsView.mockResolvedValue({
		sync: null,
		targets: [],
	});
	mocks.submitMemoryWriteRequest.mockResolvedValue({
		kind: "accepted",
		writeId: "write-1",
		status: "PENDING",
		digest: "d".repeat(64),
		deduplicated: false,
	});
});

const ROUTES: Array<[string, () => Request]> = [
	["GET targets", () => get(`${BASE}/targets`)],
	["GET files", () => get(`${BASE}/files?targetId=target-1`)],
	["GET file", () => get(`${BASE}/file?targetId=target-1&path=a/b.md`)],
	[
		"POST upload-urls",
		() => post(`${BASE}/upload-urls`, { files: [{ bytes: 10 }] }),
	],
	["POST writes", () => post(`${BASE}/writes`, submitBody)],
	["GET write", () => get(`${BASE}/writes/write-1`)],
];

describe("every memory route — the credential's scope", () => {
	it.each(ROUTES)(
		"%s refuses a credential without memory:write before any lookup",
		async (_name, request) => {
			mocks.scopes = ["mcp:read", "instructions:write", "projects:write"];
			credential = organizationKey();

			const res = await buildApp().fetch(request());

			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({
				error: "Missing required scope: memory:write",
			});
			expect(
				mocks.resolveEffectiveProjectPermissions,
			).not.toHaveBeenCalled();
		},
	);
});

describe("every memory route — the project and the live permission", () => {
	it.each(ROUTES)(
		"%s answers 404 for a project the caller cannot see",
		async (_name, request) => {
			mocks.hasProjectAccess.mockResolvedValue(false);

			expect((await buildApp().fetch(request())).status).toBe(404);
		},
	);

	it.each(ROUTES)(
		"%s answers 404 to an organization key of another organization",
		async (_name, request) => {
			credential = organizationKey("org-other");

			expect((await buildApp().fetch(request())).status).toBe(404);
		},
	);

	it.each(ROUTES)(
		"%s answers 404 to a credential bound to another project",
		async (_name, request) => {
			credential = { ...organizationKey(), boundProjectId: "project-2" };

			expect((await buildApp().fetch(request())).status).toBe(404);
			expect(
				mocks.resolveEffectiveProjectPermissions,
			).not.toHaveBeenCalled();
		},
	);

	it.each([
		["POST upload-urls", ROUTES[3]],
		["POST writes", ROUTES[4]],
	] as const)(
		"%s needs the creator's live CONTEXT_CREATE, a wildcard key included",
		async (_name, [, request]) => {
			mocks.scopes = ["*"];
			credential = organizationKey();
			mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
				permissions: ["context:read"],
				source: "org",
				organizationId: ORG,
			});

			const res = await buildApp().fetch(request());

			expect(res.status).toBe(403);
			const body = (await res.json()) as { error: { message: string } };
			expect(body.error.message).toMatch(/permission/i);
			expect(mocks.submitMemoryWriteRequest).not.toHaveBeenCalled();
			expect(mocks.createMemoryWriteUploadUrls).not.toHaveBeenCalled();
		},
	);

	it("lets a reader with CONTEXT_READ list the folders but not write", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["context:read"],
			source: "org",
			organizationId: ORG,
		});

		expect((await buildApp().fetch(get(`${BASE}/targets`))).status).toBe(
			200,
		);
		expect(
			(await buildApp().fetch(post(`${BASE}/writes`, submitBody))).status,
		).toBe(403);
	});
});

describe("the read routes", () => {
	it("answers the folders under the project's hosting organization", async () => {
		mocks.getMemoryWriteTargetsView.mockResolvedValue({
			sync: { ref: "main" },
			targets: [{ id: "target-1" }],
		});

		const res = await buildApp().fetch(get(`${BASE}/targets`));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			data: { sync: { ref: "main" }, targets: [{ id: "target-1" }] },
		});
		expect(mocks.getMemoryWriteTargetsView).toHaveBeenCalledWith({
			projectId: PROJECT,
			organizationId: ORG,
		});
	});

	it("pages the files of a folder", async () => {
		mocks.getMemoryFolderFilesView.mockResolvedValue({
			files: [],
			nextCursor: null,
		});

		const res = await buildApp().fetch(
			get(`${BASE}/files?targetId=target-1&after=docs/a.md&limit=25`),
		);

		expect(res.status).toBe(200);
		expect(mocks.getMemoryFolderFilesView).toHaveBeenCalledWith({
			projectId: PROJECT,
			organizationId: ORG,
			targetId: "target-1",
			after: "docs/a.md",
			limit: 25,
		});
	});

	it("requires a targetId and a bounded limit for the listing", async () => {
		expect((await buildApp().fetch(get(`${BASE}/files`))).status).toBe(400);
		expect(
			(
				await buildApp().fetch(
					get(`${BASE}/files?targetId=target-1&limit=100000`),
				)
			).status,
		).toBe(400);
		expect(mocks.getMemoryFolderFilesView).not.toHaveBeenCalled();
	});

	it("answers 404 for a folder or file that is not this project's", async () => {
		mocks.getMemoryFolderFilesView.mockResolvedValue(null);
		mocks.getMemoryFolderFileView.mockResolvedValue(null);
		mocks.getMemoryWriteView.mockResolvedValue(null);

		for (const path of [
			`${BASE}/files?targetId=other`,
			`${BASE}/file?targetId=other&path=x.md`,
			`${BASE}/writes/other`,
		]) {
			expect((await buildApp().fetch(get(path))).status, path).toBe(404);
		}
	});

	it("reads one file, and a receipt", async () => {
		mocks.getMemoryFolderFileView.mockResolvedValue({
			path: "docs/memory/notes.md",
			content: "# Notes\n",
		});
		mocks.getMemoryWriteView.mockResolvedValue({
			writeId: "write-1",
			status: "PENDING",
		});

		const file = await buildApp().fetch(
			get(`${BASE}/file?targetId=target-1&path=docs/memory/notes.md`),
		);
		const receipt = await buildApp().fetch(get(`${BASE}/writes/write-1`));

		expect(file.status).toBe(200);
		expect(receipt.status).toBe(200);
		expect(mocks.getMemoryWriteView).toHaveBeenCalledWith({
			writeId: "write-1",
			projectId: PROJECT,
			organizationId: ORG,
		});
	});
});

describe("POST /projects/:projectId/memory/writes", () => {
	it("submits as the key's creator, via the CLI, and answers 202 with the receipt", async () => {
		const res = await buildApp().fetch(post(`${BASE}/writes`, submitBody));

		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({
			data: {
				writeId: "write-1",
				status: "PENDING",
				digest: "d".repeat(64),
				deduplicated: false,
			},
		});
		expect(mocks.submitMemoryWriteRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT,
				organizationId: ORG,
				userId: "user-1",
				via: "CLI",
				oauthClientId: null,
				...submitBody,
				audit: expect.objectContaining({
					user: {
						id: "user-1",
						email: "dev@example.com",
						name: "Example Developer",
					},
				}),
			}),
		);
	});

	it("never takes the organization or the user from the body", async () => {
		await buildApp().fetch(
			post(`${BASE}/writes`, {
				...submitBody,
				organizationId: "org-evil",
				userId: "user-evil",
			}),
		);

		expect(mocks.submitMemoryWriteRequest).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG, userId: "user-1" }),
		);
	});

	it("records the OAuth client of a signed-in agent", async () => {
		credential = {
			keyType: "oauth",
			keyId: "client-row-1",
			userId: "user-1",
			organizationId: ORG,
			boundProjectId: PROJECT,
			scopes: mocks.scopes,
		};

		await buildApp().fetch(post(`${BASE}/writes`, submitBody));

		expect(mocks.submitMemoryWriteRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				via: "CLI",
				oauthClientId: "client-row-1",
			}),
		);
	});

	it("rejects a malformed body without calling admission", async () => {
		for (const body of [
			"not json",
			{},
			{ ...submitBody, entries: [] },
			{ ...submitBody, entries: [{ path: "a.md", op: "COPY" }] },
		]) {
			const res = await buildApp().fetch(post(`${BASE}/writes`, body));
			expect(res.status).toBe(400);
		}
		expect(mocks.submitMemoryWriteRequest).not.toHaveBeenCalled();
	});

	it("refuses a body over the bound with 413", async () => {
		const res = await buildApp().fetch(
			post(`${BASE}/writes`, "x".repeat(4 * 1024 * 1024 + 1)),
		);

		expect(res.status).toBe(413);
		expect(mocks.submitMemoryWriteRequest).not.toHaveBeenCalled();
	});

	it("maps a refusal to 400 with every problem", async () => {
		mocks.submitMemoryWriteRequest.mockResolvedValue({
			kind: "refused",
			problems: [{ code: "PATH_HIDDEN", path: ".github/x.md" }],
		});

		const res = await buildApp().fetch(post(`${BASE}/writes`, submitBody));

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: expect.objectContaining({
				code: "MEMORY_WRITE_REFUSED",
				data: {
					problems: [{ code: "PATH_HIDDEN", path: ".github/x.md" }],
				},
			}),
		});
	});

	it("maps the pending cap to 429 and a failed start to 503", async () => {
		mocks.submitMemoryWriteRequest.mockResolvedValueOnce({
			kind: "too-many-pending",
			limit: 5,
		});
		expect(
			(await buildApp().fetch(post(`${BASE}/writes`, submitBody))).status,
		).toBe(429);

		mocks.submitMemoryWriteRequest.mockResolvedValueOnce({
			kind: "start-failed",
		});
		expect(
			(await buildApp().fetch(post(`${BASE}/writes`, submitBody))).status,
		).toBe(503);
	});
});

describe("POST /projects/:projectId/memory/upload-urls", () => {
	it("signs one URL per declared file for the project", async () => {
		mocks.createMemoryWriteUploadUrls.mockResolvedValue({
			expiresInSeconds: 600,
			uploads: [],
		});

		const res = await buildApp().fetch(
			post(`${BASE}/upload-urls`, { files: [{ bytes: 10 }] }),
		);

		expect(res.status).toBe(200);
		expect(mocks.createMemoryWriteUploadUrls).toHaveBeenCalledWith({
			projectId: PROJECT,
			files: [{ bytes: 10 }],
		});
	});

	it("rejects a file over the staging bound and answers 412 when storage cannot sign", async () => {
		expect(
			(
				await buildApp().fetch(
					post(`${BASE}/upload-urls`, {
						files: [{ bytes: 100 * 1024 * 1024 }],
					}),
				)
			).status,
		).toBe(400);

		mocks.createMemoryWriteUploadUrls.mockResolvedValue(null);
		expect(
			(
				await buildApp().fetch(
					post(`${BASE}/upload-urls`, { files: [{ bytes: 10 }] }),
				)
			).status,
		).toBe(412);
	});
});
