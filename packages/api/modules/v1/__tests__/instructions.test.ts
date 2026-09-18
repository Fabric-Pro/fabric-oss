/**
 * Public v1 coding-instructions routes (Fizzy #2539).
 *
 * Two things are being pinned here. The first is the AUTHORIZATION shape a
 * key-backed surface owes: the key's declared scope and the creator's live
 * permission are separate gates with separate refusals, and a project outside
 * the resolved organization is NOT FOUND rather than forbidden. The second is
 * that the delta semantics match the MCP bundle tool exactly — an equal
 * digest short-circuits before a single file row is read, and an unknown base
 * answers `changes: null` with the full manifest still attached.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getPublishedInstructionSnapshot: vi.fn(),
		getInstructionManifestDiff: vi.fn(),
		getProjectInstructionSettings: vi.fn(),
		listInstructionFiles: vi.fn(),
		resolveEffectiveProjectPermissions: vi.fn(),
		buildInstructionSnapshotZip: vi.fn(),
		/** `db.organization.findFirst`, for the explicit `?org=` binding. */
		findOrganization: vi.fn(),
		/** The scopes the caller's key carries, read by the `requireScope` stub. */
		scopes: ["instructions:read"] as string[],
	},
}));

vi.mock("@repo/database", () => ({
	db: { organization: { findFirst: mocks.findOrganization } },
	resolveUserOrganization: vi.fn(async () => ({
		kind: "resolved" as const,
		organizationId: "org-1",
	})),
	getPublishedInstructionSnapshot: mocks.getPublishedInstructionSnapshot,
	getInstructionManifestDiff: mocks.getInstructionManifestDiff,
	getProjectInstructionSettings: mocks.getProjectInstructionSettings,
	listInstructionFiles: mocks.listInstructionFiles,
}));

vi.mock("../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions:
		mocks.resolveEffectiveProjectPermissions,
}));

vi.mock("../../projects/procedures/instructions/build-zip", () => ({
	buildInstructionSnapshotZip: mocks.buildInstructionSnapshotZip,
}));

/**
 * A faithful stand-in for the real middleware, not a no-op: the scope refusal
 * is one of the behaviours under test, and its body shape (`{ error: string }`)
 * is what keeps it distinguishable from the object-level refusal below
 * (`{ error: { message } }`).
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

const { registerInstructionRoutes } = await import("../instructions");

const PROJECT = "project-1";
const ORG = "org-1";
const PUBLISHED_PATH = `/projects/${PROJECT}/instructions/published`;

/**
 * The authenticated context `requireApiKey()` would have set. The route now
 * reads it directly instead of going through `resolveV1Context`, because the
 * PROJECT supplies the tenant on this surface — see the gate's own comment.
 */
let apiContext: {
	keyType: "personal" | "organization";
	userId: string;
	organizationId?: string;
	scopes: string[];
};

function personalKey(userId = "user-1") {
	return {
		keyType: "personal" as const,
		userId,
		organizationId: undefined,
		scopes: ["instructions:read"],
	};
}

function organizationKey(organizationId: string, userId = "user-1") {
	return {
		keyType: "organization" as const,
		userId,
		organizationId,
		scopes: ["instructions:read"],
	};
}

function buildApp() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", apiContext);
		await next();
	});
	registerInstructionRoutes(
		app as unknown as Parameters<typeof registerInstructionRoutes>[0],
	);
	return app;
}

function readySnapshot(overrides: Record<string, unknown> = {}) {
	return {
		id: "snap-2",
		projectId: PROJECT,
		organizationId: ORG,
		status: "READY",
		version: 7,
		digest: "d".repeat(64),
		fileCount: 2,
		publishedAt: new Date("2026-09-17T10:00:00.000Z"),
		...overrides,
	};
}

function manifestRows() {
	return [
		{
			path: "AGENTS.md",
			sha256: "a".repeat(64),
			size: 120,
			mode: 33188,
			kind: "INSTRUCTION",
			// A column the route must not echo — the manifest is a fixed shape.
			storageKey: "snapshots/secret-key",
		},
		{
			path: ".claude/skills/review/SKILL.md",
			sha256: "b".repeat(64),
			size: 64,
			mode: 33188,
			kind: "SKILL",
			storageKey: "snapshots/secret-key-2",
		},
	];
}

function post(path: string) {
	return new Request(`http://localhost${path}`, { method: "POST" });
}

beforeEach(() => {
	for (const value of Object.values(mocks)) {
		if (typeof value === "function" && "mockReset" in value) {
			(value as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	mocks.scopes = ["instructions:read"];
	apiContext = organizationKey(ORG);
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: ["instruction:read"],
		source: "org",
		organizationId: ORG,
	});
	mocks.getProjectInstructionSettings.mockResolvedValue({
		ignoreGlobs: null,
		sourceOfTruth: null,
	});
	mocks.getPublishedInstructionSnapshot.mockResolvedValue(readySnapshot());
	mocks.listInstructionFiles.mockResolvedValue(manifestRows());
	mocks.findOrganization.mockResolvedValue({ id: ORG });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------
/**
 * Review round 2, finding 6. Neither route read `org` or `personal`, so a
 * personal key with legitimate access to a project in organization A
 * succeeded even when the request explicitly named organization B. That does
 * not widen who can read what, but it makes the route answer a question
 * nobody asked and it differs from every sibling v1 surface.
 */
describe("an explicit tenant context", () => {
	it("is honoured when it names the project's own organization", async () => {
		apiContext = personalKey();

		const response = await buildApp().request(
			`${PUBLISHED_PATH}?org=example-org`,
		);

		expect(response.status).toBe(200);
		expect(mocks.findOrganization).toHaveBeenCalledWith({
			where: { slug: "example-org" },
			select: { id: true },
		});
	});

	it("is a 404 when it names another organization", async () => {
		apiContext = personalKey();
		mocks.findOrganization.mockResolvedValue({ id: "org-2" });

		const response = await buildApp().request(
			`${PUBLISHED_PATH}?org=other-org`,
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: { message: "Project not found" },
		});
	});

	/**
	 * Review round 3, finding 6. Telling "no such slug" apart from "not this
	 * project's slug" answers whether an organization exists to anyone holding
	 * a key — an oracle the browser twins do not offer. Both are the same
	 * generic 404.
	 */
	it("gives the same generic 404 for an unknown slug as for a mismatched one", async () => {
		apiContext = personalKey();
		mocks.findOrganization.mockResolvedValue(null);

		const unknown = await buildApp().request(
			`${PUBLISHED_PATH}?org=does-not-exist`,
		);

		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toEqual({
			error: { message: "Project not found" },
		});

		mocks.findOrganization.mockResolvedValue({ id: "org-2" });
		const mismatched = await buildApp().request(
			`${PUBLISHED_PATH}?org=someone-elses-org`,
		);

		expect(mismatched.status).toBe(404);
		expect(await mismatched.json()).toEqual({
			error: { message: "Project not found" },
		});
	});

	/**
	 * And nothing resolves an arbitrary slug at all until the caller has
	 * proven they may read this project.
	 */
	it("never looks a slug up for a caller without project permission", async () => {
		apiContext = personalKey();
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "org",
			organizationId: ORG,
		});

		const response = await buildApp().request(
			`${PUBLISHED_PATH}?org=does-not-exist`,
		);

		expect(response.status).toBe(403);
		expect(mocks.findOrganization).not.toHaveBeenCalled();
	});

	/**
	 * An organization key is already pinned to its own organization, so a
	 * contradictory slug can only resolve to an id the project's cannot equal.
	 */
	it("is a 404 for an organization key naming a different organization", async () => {
		apiContext = organizationKey(ORG);
		mocks.findOrganization.mockResolvedValue({ id: "org-2" });

		const response = await buildApp().request(
			`${PUBLISHED_PATH}?org=other-org`,
		);

		expect(response.status).toBe(404);
	});

	it("refuses ?personal=1 outright, before any lookup", async () => {
		apiContext = personalKey();

		const response = await buildApp().request(
			`${PUBLISHED_PATH}?personal=1`,
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: {
				message:
					"Coding instructions are an organization surface; ?personal=1 is not supported",
			},
		});
		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
	});

	it("binds the download route the same way", async () => {
		apiContext = personalKey();
		mocks.findOrganization.mockResolvedValue({ id: "org-2" });

		const response = await buildApp().request(
			post(
				`/projects/${PROJECT}/instructions/published/download?org=other-org`,
			),
		);

		expect(response.status).toBe(404);
		expect(mocks.buildInstructionSnapshotZip).not.toHaveBeenCalled();
	});
});

describe("authorization", () => {
	it("refuses a key without instructions:read, before any tenant data is read", async () => {
		mocks.scopes = ["projects:read"];

		const response = await buildApp().request(PUBLISHED_PATH);

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({
			error: "Missing required scope: instructions:read",
		});
		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
		expect(mocks.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("refuses a scoped key whose owner lacks INSTRUCTION_READ, with a different shape", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["project:read"],
			source: "org",
			organizationId: ORG,
		});

		const response = await buildApp().request(PUBLISHED_PATH);

		expect(response.status).toBe(403);
		// Object-level refusal: `{ error: { message } }`, never the bare
		// string the scope refusal above uses.
		await expect(response.json()).resolves.toEqual({
			error: {
				message:
					"No coding-instructions read permission for this project",
			},
		});
		expect(mocks.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("reports a project hosted by another organization as not found", async () => {
		apiContext = organizationKey(ORG);
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["instruction:read"],
			source: "org",
			organizationId: "org-other",
		});

		const response = await buildApp().request(PUBLISHED_PATH);

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			error: { message: "Project not found" },
		});
		expect(mocks.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("reports a project that does not exist as not found", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(null);

		const response = await buildApp().request(PUBLISHED_PATH);

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			error: { message: "Project not found" },
		});
	});

	it("refuses a personal project, whose host organization is null", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["instruction:read"],
			source: "owner",
			organizationId: null,
		});

		const response = await buildApp().request(PUBLISHED_PATH);

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({
			error: {
				message: "Coding instructions require an organization project",
			},
		});
		expect(mocks.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
	});

	/**
	 * The guest case (review round 1, finding 6).
	 *
	 * A guest holds an accepted `ProjectMember` row on a project in an
	 * organization they are NOT a member of. `resolveEffectiveProjectPermissions`
	 * treats that row as authoritative — path C — so they pass the oRPC twin
	 * and the MCP gateway and can open the tab in the browser. Routing this
	 * surface through `resolveV1Context` refused them, because that helper
	 * answers "which organization does this CALLER belong to" and a guest
	 * belongs to none of the host's.
	 */
	it("admits an invited project guest holding a personal key", async () => {
		apiContext = personalKey("guest-user");
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["instruction:read"],
			source: "project-member",
			organizationId: ORG,
		});

		const response = await buildApp().request(PUBLISHED_PATH);

		expect(response.status).toBe(200);
		// Everything downstream runs in the PROJECT's hosting organization,
		// never in one the guest happens to belong to.
		expect(
			mocks.resolveEffectiveProjectPermissions,
		).toHaveBeenCalledExactlyOnceWith(PROJECT, "guest-user");
		expect(mocks.listInstructionFiles).toHaveBeenCalledExactlyOnceWith(
			"snap-2",
			ORG,
		);
	});

	it("still refuses a guest whose grant does not include INSTRUCTION_READ", async () => {
		apiContext = personalKey("guest-user");
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["project:read"],
			source: "project-member",
			organizationId: ORG,
		});

		const response = await buildApp().request(PUBLISHED_PATH);

		expect(response.status).toBe(403);
	});

	/**
	 * An organization key is minted for one tenant and must never read
	 * another's project, guest grant on the creator or not.
	 */
	it("keeps an organization key bound to its own organization", async () => {
		apiContext = organizationKey("org-other");
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["instruction:read"],
			source: "project-member",
			organizationId: ORG,
		});

		const response = await buildApp().request(PUBLISHED_PATH);

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			error: { message: "Project not found" },
		});
		expect(mocks.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("admits an organization key whose organization hosts the project", async () => {
		apiContext = organizationKey(ORG);

		const response = await buildApp().request(PUBLISHED_PATH);

		expect(response.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// GET published
// ---------------------------------------------------------------------------
describe("GET /projects/:projectId/instructions/published", () => {
	it("returns the manifest and the resolved source of truth", async () => {
		const response = await buildApp().request(PUBLISHED_PATH);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: {
				published: true,
				sourceOfTruth: "UPLOAD",
				snapshot: {
					id: "snap-2",
					version: 7,
					digest: "d".repeat(64),
					fileCount: 2,
					publishedAt: "2026-09-17T10:00:00.000Z",
				},
				manifest: [
					{
						path: "AGENTS.md",
						sha256: "a".repeat(64),
						size: 120,
						mode: 33188,
						kind: "INSTRUCTION",
					},
					{
						path: ".claude/skills/review/SKILL.md",
						sha256: "b".repeat(64),
						size: 64,
						mode: 33188,
						kind: "SKILL",
					},
				],
			},
		});
		expect(mocks.listInstructionFiles).toHaveBeenCalledExactlyOnceWith(
			"snap-2",
			ORG,
		);
	});

	it("reports REPOSITORY when the project's instructions come from git", async () => {
		mocks.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "REPOSITORY",
		});

		const response = await buildApp().request(PUBLISHED_PATH);
		const body = (await response.json()) as {
			data: { sourceOfTruth: string };
		};

		expect(body.data.sourceOfTruth).toBe("REPOSITORY");
	});

	it("short-circuits an equal digest without loading files", async () => {
		const response = await buildApp().request(
			`${PUBLISHED_PATH}?sinceDigest=${"d".repeat(64)}`,
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: {
				published: true,
				sourceOfTruth: "UPLOAD",
				snapshot: {
					id: "snap-2",
					version: 7,
					digest: "d".repeat(64),
					fileCount: 2,
					publishedAt: "2026-09-17T10:00:00.000Z",
				},
				unchanged: true,
				changes: { added: [], removed: [], changed: [] },
			},
		});
		expect(mocks.listInstructionFiles).not.toHaveBeenCalled();
		expect(mocks.getInstructionManifestDiff).not.toHaveBeenCalled();
	});

	it("returns the delta for a known base digest", async () => {
		mocks.getInstructionManifestDiff.mockResolvedValue({
			base: { id: "snap-1", version: 6, digest: "c".repeat(64) },
			added: ["AGENTS.md"],
			removed: ["old.md"],
			changed: [".claude/skills/review/SKILL.md"],
		});

		const response = await buildApp().request(
			`${PUBLISHED_PATH}?sinceDigest=${"c".repeat(64)}`,
		);
		const body = (await response.json()) as {
			data: { unchanged: boolean; changes: unknown; manifest: unknown[] };
		};

		expect(body.data.unchanged).toBe(false);
		expect(body.data.changes).toEqual({
			added: ["AGENTS.md"],
			removed: ["old.md"],
			changed: [".claude/skills/review/SKILL.md"],
		});
		expect(body.data.manifest).toHaveLength(2);
		expect(
			mocks.getInstructionManifestDiff,
		).toHaveBeenCalledExactlyOnceWith({
			projectId: PROJECT,
			organizationId: ORG,
			baseDigest: "c".repeat(64),
			headSnapshotId: "snap-2",
		});
	});

	it("answers changes: null with a full manifest when the base is unknown", async () => {
		mocks.getInstructionManifestDiff.mockResolvedValue(null);

		const response = await buildApp().request(
			`${PUBLISHED_PATH}?sinceDigest=${"e".repeat(64)}`,
		);
		const body = (await response.json()) as {
			data: { unchanged: boolean; changes: unknown; manifest: unknown[] };
		};

		expect(body.data.unchanged).toBe(false);
		expect(body.data.changes).toBeNull();
		expect(body.data.manifest).toHaveLength(2);
	});

	it("rejects a sinceDigest longer than 128 characters", async () => {
		const response = await buildApp().request(
			`${PUBLISHED_PATH}?sinceDigest=${"f".repeat(129)}`,
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: {
				message: "sinceDigest must be a string of 1 to 128 characters.",
			},
		});
		// Refused before ANY tenant work: the value needs nothing to
		// validate, so it must not be able to spend a project lookup and a
		// permission resolution first.
		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
		expect(mocks.getProjectInstructionSettings).not.toHaveBeenCalled();
	});

	it("rejects an empty sinceDigest before any tenant work too", async () => {
		const response = await buildApp().request(
			`${PUBLISHED_PATH}?sinceDigest=`,
		);

		expect(response.status).toBe(400);
		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
	});

	it("reports an unpublished project without erroring", async () => {
		mocks.getPublishedInstructionSnapshot.mockResolvedValue(null);

		const response = await buildApp().request(PUBLISHED_PATH);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: { published: false, sourceOfTruth: "UPLOAD" },
		});
	});

	it("treats a snapshot carrying another tenant's id as nothing published", async () => {
		mocks.getPublishedInstructionSnapshot.mockResolvedValue(
			readySnapshot({ organizationId: "org-other" }),
		);

		const response = await buildApp().request(PUBLISHED_PATH);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: { published: false, sourceOfTruth: "UPLOAD" },
		});
	});

	it("treats a READY snapshot with no digest as nothing published", async () => {
		mocks.getPublishedInstructionSnapshot.mockResolvedValue(
			readySnapshot({ digest: null }),
		);

		const response = await buildApp().request(PUBLISHED_PATH);
		const body = (await response.json()) as {
			data: { published: boolean };
		};

		expect(body.data.published).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// POST download
// ---------------------------------------------------------------------------
describe("POST /projects/:projectId/instructions/published/download", () => {
	const path = `${PUBLISHED_PATH}/download`;

	it("returns the signed archive URL for the published snapshot", async () => {
		mocks.buildInstructionSnapshotZip.mockResolvedValue({
			url: "https://storage.example.com/exports/snap-2.zip?sig=x",
			key: "exports/snap-2.zip",
		});

		const response = await buildApp().request(post(path));

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: {
				snapshotId: "snap-2",
				digest: "d".repeat(64),
				url: "https://storage.example.com/exports/snap-2.zip?sig=x",
				expiresInSeconds: 600,
			},
		});
		expect(
			mocks.buildInstructionSnapshotZip,
		).toHaveBeenCalledExactlyOnceWith({
			projectId: PROJECT,
			organizationId: ORG,
			snapshot: expect.objectContaining({ id: "snap-2" }),
			files: manifestRows(),
		});
	});

	it("404s when the project has nothing published", async () => {
		mocks.getPublishedInstructionSnapshot.mockResolvedValue(null);

		const response = await buildApp().request(post(path));

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			error: { message: "Published snapshot not found" },
		});
		expect(mocks.buildInstructionSnapshotZip).not.toHaveBeenCalled();
	});

	it("404s when the snapshot is deleted while the archive is built", async () => {
		mocks.buildInstructionSnapshotZip.mockRejectedValue(
			Object.assign(new Error("Snapshot not found"), {
				code: "NOT_FOUND",
			}),
		);

		const response = await buildApp().request(post(path));

		expect(response.status).toBe(404);
	});

	it("refuses a key without instructions:read", async () => {
		mocks.scopes = ["projects:read"];

		const response = await buildApp().request(post(path));

		expect(response.status).toBe(403);
		expect(mocks.buildInstructionSnapshotZip).not.toHaveBeenCalled();
	});
});
