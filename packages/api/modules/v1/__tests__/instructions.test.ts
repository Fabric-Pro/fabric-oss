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
		submitInstructionChange: vi.fn(),
		/** `db.organization.findFirst`, for the explicit `?org=` binding. */
		findOrganization: vi.fn(),
		/** `db.user.findUnique`, for the audit actor snapshot on a write. */
		findUser: vi.fn(),
		/** The scopes the caller's key carries, read by the `requireScope` stub. */
		scopes: ["instructions:read"] as string[],
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		organization: { findFirst: mocks.findOrganization },
		user: { findUnique: mocks.findUser },
	},
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

// The shared entry point is mocked, not exercised: what this suite owns is the
// ROUTE — its scope gate, its tenant resolution, the shape it accepts and the
// statuses it maps refusals onto. The authorization inside
// `submitInstructionChange` is its own concern and is reached the same way from
// three surfaces.
vi.mock("../../projects/procedures/instructions/submit-change", () => ({
	submitInstructionChange: mocks.submitInstructionChange,
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

const CHANGES_PATH = `/projects/${PROJECT}/instructions/changes`;
/** The published snapshot every change set here is stated against. */
const BASE = "snap-2";

function postJson(path: string, body: unknown) {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function submitted(overrides: Record<string, unknown> = {}) {
	return {
		snapshotId: "snap-3",
		version: 8,
		baseSnapshotId: "snap-2",
		baseVersion: 7,
		fileCount: 2,
		inheritedCount: 1,
		putCount: 1,
		deleteCount: 0,
		proposalStatus: "PENDING",
		status: "VALIDATING",
		...overrides,
	};
}

/** An `ORPCError`-shaped rejection, as the shared function throws. */
function orpcRefusal(code: string, message: string, reason?: string) {
	return Object.assign(new Error(message), {
		code,
		message,
		...(reason ? { data: { reason } } : {}),
	});
}

function putChange(overrides: Record<string, unknown> = {}) {
	return { op: "put", path: "AGENTS.md", content: "new\n", ...overrides };
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
	mocks.findUser.mockResolvedValue({
		email: "dev@example.com",
		name: "Example Developer",
	});
	mocks.submitInstructionChange.mockResolvedValue(submitted());
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

// ---------------------------------------------------------------------------
// POST /projects/:projectId/instructions/changes
// ---------------------------------------------------------------------------
/**
 * The write half of this surface (Fizzy #2539).
 *
 * Two gates, separately refusable, is the property under test: the key's
 * declared scope is `instructions:write` and NOT `instructions:read`, and the
 * object-level resolution that decides the tenant is the same one the read
 * routes use — a project supplies its own organization, which is what keeps an
 * invited guest able to suggest a change to a project they can open in the app.
 */
describe("POST instructions/changes", () => {
	// The write route is gated on `instructions:write`; the suite-wide default
	// is the read scope the other two routes need.
	beforeEach(() => {
		mocks.scopes = ["instructions:write"];
	});

	it("opens a proposal and echoes what the server made of it", async () => {
		const response = await buildApp().request(
			postJson(CHANGES_PATH, {
				baseSnapshotId: BASE,
				changes: [putChange()],
			}),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			data: submitted(),
		});
		expect(mocks.submitInstructionChange).toHaveBeenCalledExactlyOnceWith({
			userId: "user-1",
			projectId: PROJECT,
			// No `mode`: this route only ever opens a proposal, so there is
			// nothing for a caller to ask for.
			baseSnapshotId: BASE,
			changes: [
				{
					op: "put",
					path: "AGENTS.md",
					content: "new\n",
					encoding: "utf8",
				},
			],
			audit: {
				user: {
					id: "user-1",
					email: "dev@example.com",
					name: "Example Developer",
				},
			},
			via: "v1:organization-key",
		});
	});

	it("carries the caller's base snapshot through", async () => {
		await buildApp().request(
			postJson(CHANGES_PATH, {
				baseSnapshotId: "snap-2",
				changes: [{ op: "delete", path: "old.md" }],
			}),
		);

		expect(mocks.submitInstructionChange).toHaveBeenCalledWith(
			expect.objectContaining({
				baseSnapshotId: "snap-2",
				changes: [{ op: "delete", path: "old.md" }],
			}),
		);
	});

	/**
	 * `baseSnapshotId` is the stale-base protection in its entirety, and it
	 * used to be optional — the server fell back to whatever was published
	 * now, so a caller that left it out silently turned the check off and got
	 * its edit rebased onto a version it had never read.
	 */
	it("refuses a body with no baseSnapshotId, saying where to get one", async () => {
		const response = await buildApp().request(
			postJson(CHANGES_PATH, { changes: [putChange()] }),
		);

		expect(response.status).toBe(400);
		const body = (await response.json()) as {
			error: { message: string };
		};
		expect(body.error.message).toContain("baseSnapshotId is required");
		expect(body.error.message).toContain("instructions/published");
		expect(mocks.submitInstructionChange).not.toHaveBeenCalled();
	});

	it.each([[""], [null], [42], [{}]])(
		"refuses a baseSnapshotId of %j",
		async (baseSnapshotId) => {
			const response = await buildApp().request(
				postJson(CHANGES_PATH, {
					baseSnapshotId,
					changes: [putChange()],
				}),
			);

			expect(response.status).toBe(400);
			expect(mocks.submitInstructionChange).not.toHaveBeenCalled();
		},
	);

	/**
	 * There is no publish mode on this route, and the absence is the security
	 * property: the key that reaches it carries `instructions:write`, which
	 * the Connect dialog offers to read-only roles and describes as
	 * review-gated. A mode would make that description false for any key
	 * whose creator happens to hold the publishing permission.
	 */
	it("ignores a mode the caller sends and still only proposes", async () => {
		const response = await buildApp().request(
			postJson(CHANGES_PATH, {
				mode: "publish",
				baseSnapshotId: BASE,
				changes: [putChange()],
			}),
		);

		expect(response.status).toBe(200);
		const call = mocks.submitInstructionChange.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(call).not.toHaveProperty("mode");
	});

	// `instructions:read` is the read routes' scope and must not reach this
	// one; that split is the entire reason the new scope exists.
	it("refuses a key holding only instructions:read", async () => {
		mocks.scopes = ["instructions:read"];

		const response = await buildApp().request(
			postJson(CHANGES_PATH, {
				baseSnapshotId: BASE,
				changes: [putChange()],
			}),
		);

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({
			error: "Missing required scope: instructions:write",
		});
		expect(mocks.submitInstructionChange).not.toHaveBeenCalled();
	});

	it("accepts a key holding instructions:write", async () => {
		mocks.scopes = ["instructions:write"];

		const response = await buildApp().request(
			postJson(CHANGES_PATH, {
				baseSnapshotId: BASE,
				changes: [putChange()],
			}),
		);

		expect(response.status).toBe(200);
	});

	// The object-level gate, independent of the scope: a key carrying the
	// scope whose creator no longer reads this project's instructions is a 403
	// with the nested error shape, distinguishable from the scope refusal
	// above.
	it("refuses a caller without INSTRUCTION_READ on the project", async () => {
		mocks.scopes = ["instructions:write"];
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["project:read"],
			source: "org",
			organizationId: ORG,
		});

		const response = await buildApp().request(
			postJson(CHANGES_PATH, {
				baseSnapshotId: BASE,
				changes: [putChange()],
			}),
		);

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({
			error: {
				message:
					"No coding-instructions read permission for this project",
			},
		});
		expect(mocks.submitInstructionChange).not.toHaveBeenCalled();
	});

	it("404s an organization key naming another tenant's project", async () => {
		mocks.scopes = ["instructions:write"];
		apiContext = organizationKey("org-2");
		apiContext.scopes = ["instructions:write"];

		const response = await buildApp().request(
			postJson(CHANGES_PATH, {
				baseSnapshotId: BASE,
				changes: [putChange()],
			}),
		);

		expect(response.status).toBe(404);
		expect(mocks.submitInstructionChange).not.toHaveBeenCalled();
	});

	it("refuses ?personal=1, as the read routes do", async () => {
		mocks.scopes = ["instructions:write"];
		apiContext = personalKey();
		apiContext.scopes = ["instructions:write"];

		const response = await buildApp().request(
			postJson(`${CHANGES_PATH}?personal=1`, {
				baseSnapshotId: BASE,
				changes: [putChange()],
			}),
		);

		expect(response.status).toBe(403);
		expect(mocks.submitInstructionChange).not.toHaveBeenCalled();
	});
});

describe("POST instructions/changes body validation", () => {
	// The write route is gated on `instructions:write`; the suite-wide default
	// is the read scope the other two routes need.
	beforeEach(() => {
		mocks.scopes = ["instructions:write"];
	});

	it("refuses a body that is not JSON", async () => {
		const response = await buildApp().request(
			new Request(`http://localhost${CHANGES_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			}),
		);

		expect(response.status).toBe(400);
		expect(mocks.submitInstructionChange).not.toHaveBeenCalled();
	});

	it("refuses changes that are not an array", async () => {
		const response = await buildApp().request(
			postJson(CHANGES_PATH, {
				baseSnapshotId: BASE,
				changes: "AGENTS.md",
			}),
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: { message: "changes must be an array." },
		});
	});

	it("refuses a put with no content", async () => {
		const response = await buildApp().request(
			postJson(CHANGES_PATH, {
				baseSnapshotId: BASE,
				changes: [{ op: "put", path: "AGENTS.md" }],
			}),
		);

		expect(response.status).toBe(400);
	});

	it("refuses an unknown encoding", async () => {
		const response = await buildApp().request(
			postJson(CHANGES_PATH, {
				changes: [putChange({ encoding: "rot13" })],
			}),
		);

		expect(response.status).toBe(400);
	});

	// The shape is checked before the project is resolved: an obviously
	// malformed body must not spend a permission resolution first.
	it("refuses a malformed body before resolving the project", async () => {
		await buildApp().request(postJson(CHANGES_PATH, { changes: 7 }));

		expect(mocks.resolveEffectiveProjectPermissions).not.toHaveBeenCalled();
	});
});

describe("POST instructions/changes refusals", () => {
	// The write route is gated on `instructions:write`; the suite-wide default
	// is the read scope the other two routes need.
	beforeEach(() => {
		mocks.scopes = ["instructions:write"];
	});

	it("maps a stale base to 409 PULL_FIRST", async () => {
		mocks.submitInstructionChange.mockRejectedValue(
			orpcRefusal(
				"CONFLICT",
				"The published version changed since your copy was taken.",
				"BASE_NOT_PUBLISHED",
			),
		);

		const response = await buildApp().request(
			postJson(CHANGES_PATH, {
				baseSnapshotId: "snap-1",
				changes: [putChange()],
			}),
		);

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error: {
				message:
					"The published version changed since your copy was taken.",
				code: "PULL_FIRST",
			},
		});
	});

	it("maps a proposal cap to 409 with its own code", async () => {
		mocks.submitInstructionChange.mockRejectedValue(
			orpcRefusal(
				"CONFLICT",
				"You already have five active coding-instructions proposals for this project.",
				"PROPOSAL_PROPOSER_LIMIT",
			),
		);

		const response = await buildApp().request(
			postJson(CHANGES_PATH, {
				baseSnapshotId: BASE,
				changes: [putChange()],
			}),
		);

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "PROPOSAL_PROPOSER_LIMIT" },
		});
	});

	it("maps a repository-backed project to 412", async () => {
		mocks.submitInstructionChange.mockRejectedValue(
			orpcRefusal(
				"PRECONDITION_FAILED",
				"This project's coding instructions come from its repository.",
				"REPOSITORY_SOURCE_OF_TRUTH",
			),
		);

		const response = await buildApp().request(
			postJson(CHANGES_PATH, {
				baseSnapshotId: BASE,
				changes: [putChange()],
			}),
		);

		expect(response.status).toBe(412);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "REPOSITORY_SOURCE_OF_TRUTH" },
		});
	});

	it("maps the live permission refusal to 403", async () => {
		mocks.submitInstructionChange.mockRejectedValue(
			orpcRefusal(
				"FORBIDDEN",
				"Missing required permission: instruction:create",
			),
		);

		const response = await buildApp().request(
			postJson(CHANGES_PATH, {
				baseSnapshotId: BASE,
				changes: [putChange()],
			}),
		);

		expect(response.status).toBe(403);
	});

	it("maps a project with nothing published to 404", async () => {
		mocks.submitInstructionChange.mockRejectedValue(
			orpcRefusal(
				"NOT_FOUND",
				"This project has no published coding instructions to change yet.",
				"NOTHING_PUBLISHED",
			),
		);

		const response = await buildApp().request(
			postJson(CHANGES_PATH, {
				baseSnapshotId: BASE,
				changes: [putChange()],
			}),
		);

		expect(response.status).toBe(404);
	});

	// An unrecognised failure is a 500, not a silently swallowed 400: the
	// mapper returns null and the error propagates.
	it("lets an unexpected failure propagate", async () => {
		mocks.submitInstructionChange.mockRejectedValue(
			new Error("storage unavailable"),
		);

		const response = await buildApp().request(
			postJson(CHANGES_PATH, {
				baseSnapshotId: BASE,
				changes: [putChange()],
			}),
		);

		expect(response.status).toBe(500);
	});
});
