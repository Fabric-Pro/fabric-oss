/**
 * `fabric_list_project_instructions`, `fabric_get_project_instruction`, and
 * `fabric_get_project_instruction_bundle` — the MCP platform tools that expose
 * a project's published coding-instruction snapshot to a connected agent.
 *
 * Mocking setup follows `apps/web/__tests__/api/mcp-session-scopes.test.ts`:
 * `executePlatformTool` is exercised directly (not mocked) so the live
 * project-access gate and the org-mismatch guard around the unscoped
 * `getPublishedInstructionSnapshot` lookup actually run.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getProjectAccessContext: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	getPublishedInstructionSummariesForProjects: vi.fn(),
	getInstructionManifestDiff: vi.fn(),
	listInstructionFiles: vi.fn(),
	getInstructionFileByPath: vi.fn(),
	listProjects: vi.fn(),
	getProjectSummaryById: vi.fn(),
	downloadFile: vi.fn(),
	getSignedUrl: vi.fn(),
	buildInstructionSnapshotZip: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectAccessContext: m.getProjectAccessContext,
	getPublishedInstructionSnapshot: m.getPublishedInstructionSnapshot,
	getPublishedInstructionSummariesForProjects:
		m.getPublishedInstructionSummariesForProjects,
	getInstructionManifestDiff: m.getInstructionManifestDiff,
	listInstructionFiles: m.listInstructionFiles,
	getInstructionFileByPath: m.getInstructionFileByPath,
	listProjects: m.listProjects,
	getProjectSummaryById: m.getProjectSummaryById,
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		downloadFile: m.downloadFile,
		getSignedUrl: m.getSignedUrl,
	}),
}));

vi.mock("@repo/api/modules/projects/procedures/instructions/build-zip", () => ({
	buildInstructionSnapshotZip: (...a: unknown[]) =>
		m.buildInstructionSnapshotZip(...a),
}));

import { executePlatformTool } from "../../../../modules/saas/mcp/lib/gateway/platform-tools";

const session = {
	userId: "user_1",
	organizationId: "org_1",
	scopes: ["instructions:read"],
} as never;

beforeEach(() => {
	for (const fn of Object.values(m)) {
		fn.mockReset();
	}
});

describe("fabric_list_project_instructions", () => {
	it("returns 'not found' when the caller has no project access, before touching the snapshot", async () => {
		m.getProjectAccessContext.mockResolvedValue(null);
		const r = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_other" },
			session,
		);
		expect(r.isError).toBe(true);
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("lists the published snapshot's files without storage keys", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 7,
			status: "READY",
			digest: "d",
			fileCount: 1,
			projectId: "proj_1",
			organizationId: "org_1",
		});
		m.listInstructionFiles.mockResolvedValue([
			{
				id: "f",
				path: ".claude/skills/x/SKILL.md",
				kind: "SKILL",
				name: "x",
				description: "d",
				size: 10,
				mimeType: "text/markdown",
				isText: true,
				sha256: "h",
				storageKey: "SECRET",
				mode: null,
			},
		]);
		const r = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_1" },
			session,
		);
		const body = JSON.parse(r.content[0]!.text);
		expect(body.snapshot).toEqual({
			id: "s",
			version: 7,
			digest: "d",
			fileCount: 1,
		});
		expect(body.files[0]).toEqual({
			path: ".claude/skills/x/SKILL.md",
			kind: "SKILL",
			name: "x",
			description: "d",
			size: 10,
			mimeType: "text/markdown",
			isText: true,
			sha256: "h",
		});
		expect(JSON.stringify(body)).not.toContain("SECRET");
	});

	// M10: the gateway does not enforce a tool definition's `inputSchema`
	// enum, so an out-of-enum `kind` used to reach Prisma and return a
	// driver-level enum error instead of a tool-level message. The oRPC twin
	// validates against the same list (`list-files.ts`).
	it("refuses an out-of-enum kind before querying", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 7,
			status: "READY",
			digest: "d",
			fileCount: 1,
			projectId: "proj_1",
			organizationId: "org_1",
		});
		const r = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_1", kind: "nope" },
			session,
		);
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content[0]!.text).error).toContain("Unknown kind");
		expect(m.listInstructionFiles).not.toHaveBeenCalled();
	});

	it("passes a valid kind through as a filter", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 7,
			status: "READY",
			digest: "d",
			fileCount: 0,
			projectId: "proj_1",
			organizationId: "org_1",
		});
		m.listInstructionFiles.mockResolvedValue([]);
		await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_1", kind: "SKILL", query: "qa" },
			session,
		);
		expect(m.listInstructionFiles).toHaveBeenCalledWith("s", "org_1", {
			kind: "SKILL",
			query: "qa",
		});
	});

	it("says so when nothing is published", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue(null);
		const r = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_1" },
			session,
		);
		expect(JSON.parse(r.content[0]!.text)).toEqual({
			snapshot: null,
			files: [],
			message: "This project has no published coding instructions yet.",
		});
	});
});

describe("fabric_get_project_instruction", () => {
	it("pages a text body", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 7,
			status: "READY",
			projectId: "proj_1",
			organizationId: "org_1",
		});
		m.getInstructionFileByPath.mockResolvedValue({
			path: "CLAUDE.md",
			kind: "INSTRUCTIONS",
			name: null,
			description: null,
			size: 11,
			mimeType: "text/markdown",
			isText: true,
			storageKey: "k",
			mode: null,
			projectId: "proj_1",
		});
		m.downloadFile.mockResolvedValue({
			data: Buffer.from("hello world"),
			contentType: "text/markdown",
			size: 11,
		});
		const r = await executePlatformTool(
			"fabric_get_project_instruction",
			{ projectId: "proj_1", path: "CLAUDE.md", maxLength: 5 },
			session,
		);
		expect(JSON.parse(r.content[0]!.text)).toMatchObject({
			path: "CLAUDE.md",
			body: "hello",
			truncated: true,
			nextOffset: 5,
		});
	});
});

describe("fabric_get_project_instruction_bundle", () => {
	it("returns the manifest and a signed URL, with no file bytes", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 7,
			status: "READY",
			digest: "d",
			fileCount: 1,
			projectId: "proj_1",
			organizationId: "org_1",
		});
		m.listInstructionFiles.mockResolvedValue([
			{
				id: "f",
				path: "CLAUDE.md",
				kind: "INSTRUCTIONS",
				name: null,
				description: null,
				size: 11,
				mimeType: "text/markdown",
				isText: true,
				sha256: "h",
				storageKey: "SECRET",
				mode: null,
			},
		]);
		m.buildInstructionSnapshotZip.mockResolvedValue({
			url: "https://storage.example.com/signed-bundle",
			key: "projects/proj_1/instructions/exports/s-123.zip",
		});

		const r = await executePlatformTool(
			"fabric_get_project_instruction_bundle",
			{ projectId: "proj_1" },
			session,
		);
		const body = JSON.parse(r.content[0]!.text);
		expect(body).toEqual({
			snapshot: { id: "s", version: 7, digest: "d", fileCount: 1 },
			manifest: [
				{
					path: "CLAUDE.md",
					sha256: "h",
					size: 11,
					mode: null,
					kind: "INSTRUCTIONS",
				},
			],
			url: "https://storage.example.com/signed-bundle",
			expiresInSeconds: 600,
		});
		expect(JSON.stringify(body)).not.toContain("SECRET");
		expect(m.buildInstructionSnapshotZip).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj_1",
				// I3: the builder re-reads the snapshot after uploading the
				// archive, so it needs the project's hosting organization to
				// scope that read.
				organizationId: "org_1",
				snapshot: expect.objectContaining({ id: "s", version: 7 }),
			}),
		);
	});
});

describe("organization resolution (R31 / spec \u00a76.5)", () => {
	// R23/R31: `getPublishedInstructionSnapshot` is UNSCOPED, so the org
	// comparison in `resolvePublishedInstructionSnapshot` is the only thing
	// standing between a caller and any project's published pointer. It
	// compares against the PROJECT'S hosting organization
	// (`getProjectAccessContext`), never the session's — see the
	// invited-guest case below for why the difference is not cosmetic.
	it("treats a snapshot from another organization the same as nothing published, for all three tools", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 7,
			status: "READY",
			digest: "d",
			fileCount: 1,
			projectId: "proj_1",
			organizationId: "org_other",
		});

		const list = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_1" },
			session,
		);
		expect(JSON.parse(list.content[0]!.text)).toEqual({
			snapshot: null,
			files: [],
			message: "This project has no published coding instructions yet.",
		});

		const get = await executePlatformTool(
			"fabric_get_project_instruction",
			{ projectId: "proj_1", path: "CLAUDE.md" },
			session,
		);
		expect(get.isError).toBe(true);
		expect(JSON.parse(get.content[0]!.text)).toEqual({
			error: "This project has no published coding instructions yet.",
		});

		const bundle = await executePlatformTool(
			"fabric_get_project_instruction_bundle",
			{ projectId: "proj_1" },
			session,
		);
		expect(bundle.isError).toBe(true);
		expect(JSON.parse(bundle.content[0]!.text)).toEqual({
			error: "This project has no published coding instructions yet.",
		});

		expect(m.listInstructionFiles).not.toHaveBeenCalled();
		expect(m.getInstructionFileByPath).not.toHaveBeenCalled();
		expect(m.downloadFile).not.toHaveBeenCalled();
		expect(m.getSignedUrl).not.toHaveBeenCalled();
		expect(m.buildInstructionSnapshotZip).not.toHaveBeenCalled();
	});

	// The case spec \u00a76.5 names in its own words: "resolving the project's
	// *hosting* organization rather than the key's home org so invited guests
	// keep access". A project-scoped guest holds no membership in the host
	// org, so their session is scoped to their own — comparing the snapshot
	// against THAT denied them what the same person is served in the browser.
	it("serves an invited guest whose session organization differs from the project's host organization", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_host",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 7,
			status: "READY",
			digest: "d",
			fileCount: 1,
			projectId: "proj_1",
			organizationId: "org_host",
		});
		m.listInstructionFiles.mockResolvedValue([]);

		const guestSession = {
			userId: "guest_1",
			organizationId: "org_guest_home",
			scopes: ["instructions:read"],
		} as never;
		const r = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_1" },
			guestSession,
		);

		const body = JSON.parse(r.content[0]!.text);
		expect(body.snapshot).toEqual({
			id: "s",
			version: 7,
			digest: "d",
			fileCount: 1,
		});
		// The access check is made against the caller, never the session's
		// organization: that is what makes the guest resolvable at all.
		expect(m.getProjectAccessContext).toHaveBeenCalledWith(
			"proj_1",
			"guest_1",
		);
	});

	it("denies a same-organization non-member, who has no project access at all", async () => {
		m.getProjectAccessContext.mockResolvedValue(null);
		m.getPublishedInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 7,
			status: "READY",
			projectId: "proj_1",
			organizationId: "org_1",
		});

		const r = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_1" },
			session,
		);

		expect(r.isError).toBe(true);
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
	});

	// Spec \u00a76.5: the live permission check is unconditional, "wildcard keys
	// included". A `*` scope satisfies the SCOPE gate and nothing else.
	it("still runs the live access check for a wildcard-scope key", async () => {
		m.getProjectAccessContext.mockResolvedValue(null);

		const wildcardSession = {
			userId: "user_1",
			organizationId: "org_1",
			scopes: ["*"],
		} as never;
		const r = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_1" },
			wildcardSession,
		);

		expect(r.isError).toBe(true);
		expect(m.getProjectAccessContext).toHaveBeenCalledWith(
			"proj_1",
			"user_1",
		);
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
	});

	// UI/MCP parity, spec \u00a76.5's last required case. The oRPC half lives in
	// `packages/api/modules/projects/procedures/instructions/__tests__/get-published.test.ts`
	// ("serves an invited guest..."), which drives the real `getPublished`
	// handler against THESE SAME fixture values; the two files cannot import
	// each other's surface, so the fixtures are the contract. Both must
	// return the snapshot for a guest whose own organization is not the
	// project's host organization.
	it("agrees with the oRPC getPublished handler for the same guest on the same project", async () => {
		const hostSnapshot = {
			id: "snap_parity",
			version: 4,
			status: "READY",
			digest: "digest_parity",
			fileCount: 2,
			projectId: "proj_parity",
			organizationId: "org_host",
		};
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_host",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue(hostSnapshot);
		m.listInstructionFiles.mockResolvedValue([]);

		const r = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_parity" },
			{
				userId: "guest_parity",
				organizationId: "org_guest_home",
				scopes: ["instructions:read"],
			} as never,
		);

		expect(JSON.parse(r.content[0]!.text).snapshot).toEqual({
			id: "snap_parity",
			version: 4,
			digest: "digest_parity",
			fileCount: 2,
		});
	});
});

describe("scope: instructions:read replaces projects:read", () => {
	// The three tools used to sit behind the coarse `projects:read` scope
	// (see TOOL_SCOPES in platform-tools.ts), which meant a key could not be
	// narrowed to reading instructions without also being able to read every
	// other project surface. This is the regression case: the old scope alone
	// must no longer satisfy them.
	it("refuses a key holding only the old projects:read scope, before touching the snapshot", async () => {
		const r = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_1" },
			{
				userId: "user_1",
				organizationId: "org_1",
				scopes: ["projects:read"],
			} as never,
		);

		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content[0]!.text).error).toContain(
			"instructions:read",
		);
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	// The coarse `mcp:read` still has to cover every read tool, this one
	// included — the umbrella `scopeSatisfied` check in platform-tools.ts
	// makes no per-tool exception.
	it("accepts a key holding only the coarse mcp:read scope", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 7,
			status: "READY",
			digest: "d",
			fileCount: 0,
			projectId: "proj_1",
			organizationId: "org_1",
		});
		m.listInstructionFiles.mockResolvedValue([]);

		const r = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_1" },
			{
				userId: "user_1",
				organizationId: "org_1",
				scopes: ["mcp:read"],
			} as never,
		);

		expect(r.isError).toBeUndefined();
		expect(JSON.parse(r.content[0]!.text).snapshot).toEqual({
			id: "s",
			version: 7,
			digest: "d",
			fileCount: 0,
		});
	});
});

/**
 * `sinceDigest` — "what changed since the copy I already installed".
 *
 * The argument exists so a connected agent can keep an installed tree current
 * without re-downloading it, and the equal-digest case is the one that has to
 * be cheap: no file rows listed, no zip built, no signed URL minted. The
 * assertions on `buildInstructionSnapshotZip` and `listInstructionFiles` below
 * are what hold that, not the response shape alone.
 */
describe("sinceDigest", () => {
	/** The snapshot published now, in both tools' fixtures. */
	const HEAD = {
		id: "snap_head",
		version: 9,
		status: "READY",
		digest: "digest_head",
		fileCount: 2,
		projectId: "proj_1",
		organizationId: "org_1",
	};

	/** The manifest `listInstructionFiles` returns for HEAD. */
	const HEAD_FILES = [
		{
			id: "f1",
			path: "AGENTS.md",
			kind: "INSTRUCTIONS",
			name: null,
			description: null,
			size: 11,
			mimeType: "text/markdown",
			isText: true,
			sha256: "h1",
			storageKey: "SECRET",
			mode: null,
		},
		{
			id: "f2",
			path: ".claude/skills/x/SKILL.md",
			kind: "SKILL",
			name: "x",
			description: null,
			size: 22,
			mimeType: "text/markdown",
			isText: true,
			sha256: "h2",
			storageKey: "SECRET",
			mode: null,
		},
	];

	function published() {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue(HEAD);
		m.listInstructionFiles.mockResolvedValue(HEAD_FILES);
		m.buildInstructionSnapshotZip.mockResolvedValue({
			url: "https://storage.example.com/signed-bundle",
			key: "projects/proj_1/instructions/exports/snap_head.zip",
		});
	}

	async function call(tool: string, args: Record<string, unknown>) {
		const r = await executePlatformTool(tool, args, session);
		return { result: r, body: JSON.parse(r.content[0]!.text) };
	}

	describe.each([
		"fabric_list_project_instructions",
		"fabric_get_project_instruction_bundle",
	])("%s", (tool) => {
		it("answers unchanged, and does no work, when the digest still matches", async () => {
			published();

			const { body } = await call(tool, {
				projectId: "proj_1",
				sinceDigest: "digest_head",
			});

			expect(body).toEqual({
				snapshot: {
					id: "snap_head",
					version: 9,
					digest: "digest_head",
					fileCount: 2,
				},
				unchanged: true,
				changes: { added: [], removed: [], changed: [] },
			});
			// The whole point: nothing was listed, nothing was archived, and
			// no signed URL exists for a caller that already has the content.
			expect(body.files).toBeUndefined();
			expect(body.manifest).toBeUndefined();
			expect(body.url).toBeUndefined();
			expect(m.listInstructionFiles).not.toHaveBeenCalled();
			expect(m.buildInstructionSnapshotZip).not.toHaveBeenCalled();
			expect(m.getInstructionManifestDiff).not.toHaveBeenCalled();
		});

		it("returns the full response plus the diff when the base digest is known", async () => {
			published();
			m.getInstructionManifestDiff.mockResolvedValue({
				base: { id: "snap_base", version: 8, digest: "digest_base" },
				added: [".claude/skills/x/SKILL.md"],
				removed: ["CLAUDE.md"],
				changed: ["AGENTS.md"],
			});

			const { body } = await call(tool, {
				projectId: "proj_1",
				sinceDigest: "digest_base",
			});

			expect(body.unchanged).toBe(false);
			expect(body.changes).toEqual({
				added: [".claude/skills/x/SKILL.md"],
				removed: ["CLAUDE.md"],
				changed: ["AGENTS.md"],
			});
			expect(body.since).toEqual({
				id: "snap_base",
				version: 8,
				digest: "digest_base",
			});
			// The delta is ADDITIVE: a caller that cannot use it still gets
			// the whole answer.
			expect(
				tool === "fabric_list_project_instructions"
					? body.files
					: body.manifest,
			).toHaveLength(2);
			// The organization is the one the resolver has already compared
			// to this caller's project access, so a base row on this project
			// belonging to another tenant cannot be read (the query's own
			// filters are pinned in
			// `packages/database/__tests__/instruction-manifest-diff.test.ts`).
			expect(m.getInstructionManifestDiff).toHaveBeenCalledWith({
				projectId: "proj_1",
				organizationId: "org_1",
				baseDigest: "digest_base",
				headSnapshotId: "snap_head",
			});
		});

		// The base lookup is scoped by project, so a digest from ANOTHER
		// project matches nothing here — it is reported as an unknown base,
		// never as that project's history.
		it("reports changes:null for a digest this project has never published", async () => {
			published();
			m.getInstructionManifestDiff.mockResolvedValue(null);

			const { body } = await call(tool, {
				projectId: "proj_1",
				sinceDigest: "digest_from_another_project",
			});

			expect(body.unchanged).toBe(false);
			expect(body.changes).toBeNull();
			expect(body.since).toBeUndefined();
			// `changes: null` means "take a full copy", so the full copy has
			// to be in the same response.
			expect(
				tool === "fabric_list_project_instructions"
					? body.files
					: body.manifest,
			).toHaveLength(2);
		});

		it("leaves the response exactly as it was when sinceDigest is omitted", async () => {
			published();

			const { body } = await call(tool, { projectId: "proj_1" });

			expect(body.unchanged).toBeUndefined();
			expect(body.changes).toBeUndefined();
			expect(body.since).toBeUndefined();
			expect(m.getInstructionManifestDiff).not.toHaveBeenCalled();
		});

		// The gateway does not enforce a tool definition's `inputSchema`, so
		// the bounds it advertises are checked in the handler — this value
		// reaches a query.
		it("refuses an over-long sinceDigest before touching the project", async () => {
			published();

			const { result, body } = await call(tool, {
				projectId: "proj_1",
				sinceDigest: "x".repeat(129),
			});

			expect(result.isError).toBe(true);
			expect(body.error).toContain("sinceDigest");
			expect(m.getProjectAccessContext).not.toHaveBeenCalled();
		});
	});
});

/**
 * `codingInstructions` on the project responses — how a connected agent finds
 * out a project has published coding instructions at all, without being told.
 *
 * The scope rule is the part worth pinning. These two tools need only
 * `projects:read`, and the instruction tools need `instructions:read`, so a
 * key narrowed to projects must not learn anything here about a surface it
 * cannot read: it gets no `codingInstructions` key at all, which is a
 * different answer from `published: false`.
 */
describe("codingInstructions on project responses", () => {
	const PROJECT = {
		id: "proj_1",
		name: "Example Project",
		description: null,
		status: "ACTIVE",
		heroEmojis: [],
		createdAt: new Date("2026-01-01T00:00:00Z"),
		updatedAt: new Date("2026-01-02T00:00:00Z"),
	};

	const PUBLISHED = {
		version: 9,
		fileCount: 2,
		digest: "digest_head",
		publishedAt: new Date("2026-01-03T00:00:00Z"),
	};

	function sessionWith(scopes: string[]) {
		return { userId: "user_1", organizationId: "org_1", scopes } as never;
	}

	async function getProject(scopes: string[]) {
		const r = await executePlatformTool(
			"fabric_get_project",
			{ projectId: "proj_1" },
			sessionWith(scopes),
		);
		return JSON.parse(r.content[0]!.text);
	}

	beforeEach(() => {
		m.getProjectSummaryById.mockResolvedValue(PROJECT);
		m.listProjects.mockResolvedValue({
			projects: [PROJECT],
			total: 1,
			hasMore: false,
		});
	});

	it("carries the published snapshot's summary on fabric_get_project", async () => {
		m.getPublishedInstructionSummariesForProjects.mockResolvedValue(
			new Map([["proj_1", PUBLISHED]]),
		);

		const body = await getProject(["projects:read", "instructions:read"]);

		expect(body.codingInstructions).toEqual({
			published: true,
			version: 9,
			fileCount: 2,
			digest: "digest_head",
			publishedAt: PUBLISHED.publishedAt.toISOString(),
		});
		// Nothing else about the response moved.
		expect(body.id).toBe("proj_1");
		expect(body.name).toBe("Example Project");
		expect(body.status).toBe("ACTIVE");
	});

	it("carries it on every project fabric_list_projects returns, in one query", async () => {
		m.getPublishedInstructionSummariesForProjects.mockResolvedValue(
			new Map([["proj_1", PUBLISHED]]),
		);

		const r = await executePlatformTool(
			"fabric_list_projects",
			{},
			sessionWith(["mcp:read"]),
		);
		const body = JSON.parse(r.content[0]!.text);

		expect(body.projects[0].codingInstructions).toEqual({
			published: true,
			version: 9,
			fileCount: 2,
			digest: "digest_head",
			publishedAt: PUBLISHED.publishedAt.toISOString(),
		});
		expect(body.total).toBe(1);
		expect(body.hasMore).toBe(false);
		expect(
			m.getPublishedInstructionSummariesForProjects,
		).toHaveBeenCalledTimes(1);
		expect(
			m.getPublishedInstructionSummariesForProjects,
		).toHaveBeenCalledWith(["proj_1"]);
	});

	// A project guest who IS in the session's organization — which is the
	// only guest `fabric_get_project` can serve, because
	// `getProjectSummaryById` is scoped by the session's organization, not by
	// the project's hosting one. That is a deliberate difference from the
	// instruction tools (see the organization-resolution suite above, where a
	// guest whose home org differs IS served), and this asserts the argument
	// rather than assuming it: a cross-organization guest reaches the
	// instruction tools directly, not through this field.
	it("carries it for an invited guest inside the session's own organization", async () => {
		m.getPublishedInstructionSummariesForProjects.mockResolvedValue(
			new Map([["proj_1", PUBLISHED]]),
		);

		const r = await executePlatformTool(
			"fabric_get_project",
			{ projectId: "proj_1" },
			{
				userId: "guest_1",
				organizationId: "org_1",
				scopes: ["projects:read", "instructions:read"],
			} as never,
		);

		expect(m.getProjectSummaryById).toHaveBeenCalledWith(
			"proj_1",
			"guest_1",
			"org_1",
		);
		expect(JSON.parse(r.content[0]!.text).codingInstructions).toEqual({
			published: true,
			version: 9,
			fileCount: 2,
			digest: "digest_head",
			publishedAt: PUBLISHED.publishedAt.toISOString(),
		});
	});

	// The three reasons the summary query answers `null` — no pointer, a
	// pointer to a snapshot that is not READY, and a snapshot whose
	// organization is not the project's — are all reported identically, so a
	// caller cannot tell a mis-tenanted snapshot from an absent one.
	it("says published:false when the query has no summary for the project", async () => {
		m.getPublishedInstructionSummariesForProjects.mockResolvedValue(
			new Map([["proj_1", null]]),
		);

		expect((await getProject(["mcp:read"])).codingInstructions).toEqual({
			published: false,
		});
	});

	it("says published:false when the project is absent from the map entirely", async () => {
		m.getPublishedInstructionSummariesForProjects.mockResolvedValue(
			new Map(),
		);

		expect((await getProject(["mcp:read"])).codingInstructions).toEqual({
			published: false,
		});
	});

	it("omits the key, and the query, for a projects:read-only key", async () => {
		const body = await getProject(["projects:read"]);

		expect(body.id).toBe("proj_1");
		expect("codingInstructions" in body).toBe(false);
		expect(
			m.getPublishedInstructionSummariesForProjects,
		).not.toHaveBeenCalled();
	});

	it("omits the key on fabric_list_projects for that same key", async () => {
		const r = await executePlatformTool(
			"fabric_list_projects",
			{},
			sessionWith(["projects:read"]),
		);
		const body = JSON.parse(r.content[0]!.text);

		expect("codingInstructions" in body.projects[0]).toBe(false);
		expect(
			m.getPublishedInstructionSummariesForProjects,
		).not.toHaveBeenCalled();
	});
});

/**
 * A READY snapshot with no digest is treated as nothing published.
 *
 * `markInstructionSnapshotReady` writes the digest in the same statement that
 * writes READY, so this is an invariant guard rather than a reachable state.
 * It is asserted because the `codingInstructions` field on the project
 * responses already requires a digest — it has one to advertise or it has
 * nothing to say — and if the two surfaces disagreed, an agent would be told a
 * project has published instructions by one tool and told it has none by the
 * next three.
 */
describe("a READY snapshot without a digest", () => {
	beforeEach(() => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 7,
			status: "READY",
			digest: null,
			fileCount: 1,
			projectId: "proj_1",
			organizationId: "org_1",
		});
	});

	it("reads as nothing published to all three instruction tools", async () => {
		const list = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_1" },
			session,
		);
		expect(JSON.parse(list.content[0]!.text)).toEqual({
			snapshot: null,
			files: [],
			message: "This project has no published coding instructions yet.",
		});

		const get = await executePlatformTool(
			"fabric_get_project_instruction",
			{ projectId: "proj_1", path: "CLAUDE.md" },
			session,
		);
		expect(get.isError).toBe(true);

		const bundle = await executePlatformTool(
			"fabric_get_project_instruction_bundle",
			{ projectId: "proj_1" },
			session,
		);
		expect(bundle.isError).toBe(true);

		// Refused before any of them touched storage or the file rows.
		expect(m.listInstructionFiles).not.toHaveBeenCalled();
		expect(m.getInstructionFileByPath).not.toHaveBeenCalled();
		expect(m.buildInstructionSnapshotZip).not.toHaveBeenCalled();
	});

	// The same answer the `codingInstructions` summary query gives for such a
	// snapshot, which is what keeps the two surfaces from contradicting.
	it("cannot be reached with a sinceDigest either", async () => {
		const r = await executePlatformTool(
			"fabric_get_project_instruction_bundle",
			{ projectId: "proj_1", sinceDigest: "digest_installed" },
			session,
		);

		expect(r.isError).toBe(true);
		expect(m.getInstructionManifestDiff).not.toHaveBeenCalled();
	});
});
