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
	submitInstructionChange: vi.fn(),
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

// The shared entry point, mocked: its own authorization, path rules and
// storage writes are covered in `submit-change.test.ts`. What this file owns
// is the TOOL — its argument checking, the live access gate it runs first, and
// the words it hands back to an agent.
vi.mock(
	"@repo/api/modules/projects/procedures/instructions/submit-change",
	() => ({
		submitInstructionChange: (...a: unknown[]) =>
			m.submitInstructionChange(...a),
	}),
);

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
	TOOL_SCOPES,
} from "../../../../modules/saas/mcp/lib/gateway/platform-tools";

const session = {
	userId: "user_1",
	organizationId: "org_1",
	scopes: ["instructions:read"],
} as never;

/** The same session with the write scope the proposal tool requires. */
const writeSession = {
	userId: "user_1",
	userName: "Example Developer",
	email: "dev@example.com",
	sessionId: "gateway_session_1",
	organizationId: "org_1",
	scopes: ["instructions:read", "instructions:write"],
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

		// Fizzy #2671: a version that only flips a file's executable bit now
		// carries a new digest (`computeSnapshotDigest` folds mode in), and
		// this tool must surface that path under `changes.changed` rather
		// than an empty delta. The mode-aware comparison itself is pinned in
		// `packages/database/__tests__/instruction-manifest-diff.test.ts`;
		// this only pins the tool's pass-through of the diff result.
		it("lists a mode-only changed path under changes.changed", async () => {
			published();
			m.getInstructionManifestDiff.mockResolvedValue({
				base: { id: "snap_base", version: 8, digest: "digest_base" },
				added: [],
				removed: [],
				changed: ["scripts/run.sh"],
			});

			const { body } = await call(tool, {
				projectId: "proj_1",
				sinceDigest: "digest_base",
			});

			expect(body.unchanged).toBe(false);
			expect(body.changes).toEqual({
				added: [],
				removed: [],
				changed: ["scripts/run.sh"],
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

// ---------------------------------------------------------------------------
// fabric_propose_project_instruction_change
// ---------------------------------------------------------------------------
/**
 * The write tool (Fizzy #2539).
 *
 * It proposes and never publishes: there is no `mode` argument, and the
 * response has to say in words that nothing has changed yet, because that
 * sentence is what an agent repeats to the person it is working with.
 */
describe("fabric_propose_project_instruction_change", () => {
	function accepted(overrides: Record<string, unknown> = {}) {
		return {
			snapshotId: "snap_new",
			version: 8,
			baseSnapshotId: "snap_1",
			baseVersion: 7,
			fileCount: 12,
			inheritedCount: 11,
			putCount: 1,
			deleteCount: 0,
			proposalStatus: "PENDING",
			mode: "proposal",
			status: "VALIDATING",
			...overrides,
		};
	}

	const change = {
		op: "put",
		path: "AGENTS.md",
		content: "# Updated\n",
	};

	it("proposes the change and says it is pending review", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.submitInstructionChange.mockResolvedValue(accepted());

		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_1",
				changes: [change],
				baseSnapshotId: "snap_1",
			},
			writeSession,
		);

		expect(r.isError).toBeFalsy();
		const text = JSON.stringify(r);
		expect(text).toContain("PENDING");
		expect(text).toContain("approves it");
		expect(m.submitInstructionChange).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user_1",
				projectId: "proj_1",
				baseSnapshotId: "snap_1",
				changes: [{ ...change, encoding: "utf8" }],
				via: "mcp-gateway",
			}),
		);
	});

	/**
	 * A retried tool call can be answered with the proposal the first call
	 * opened — and that proposal may no longer be pending, because the
	 * attempt it is repeating was closed out or its validation rejected it.
	 * The agent puts this text in front of a person, so telling them a
	 * rejected proposal is "waiting for their review" sends them to look for
	 * something that is not there.
	 */
	it("does not claim a closed-out proposal is waiting for review", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.submitInstructionChange.mockResolvedValue(
			accepted({ proposalStatus: "REJECTED", status: "REJECTED" }),
		);

		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_1",
				changes: [change],
				baseSnapshotId: "snap_1",
			},
			writeSession,
		);

		const text = JSON.stringify(r);
		expect(text).not.toContain("PENDING REVIEW");
		expect(text).not.toContain("waiting for their review");
		expect(text).toContain("send it again");
	});

	/**
	 * The rule every one of these answers obeys: never tell the agent to send
	 * the change again when the server's content dedup would match the same
	 * row. A PENDING proposal is exactly what the next call would match, so
	 * those answers describe the state instead of asking for a retry.
	 */
	it("says another attempt is still sending rather than asking for a retry", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.submitInstructionChange.mockResolvedValue(
			accepted({ proposalStatus: "PENDING", status: "RECEIVING" }),
		);

		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_1",
				changes: [change],
				baseSnapshotId: "snap_1",
			},
			writeSession,
		);

		const text = JSON.stringify(r);
		expect(text).toContain("still sending");
		expect(text).not.toContain("PENDING REVIEW");
		// Sending again is never the answer here, at any age: the row is
		// still PENDING so the next call dedups back onto it, and nothing
		// closes a RECEIVING row out on this call's behalf — the browser tab
		// opens proposals through the same query and holds its upload
		// capabilities for an hour. Only the two exits that do exist are
		// named.
		expect(text).not.toContain("send it again");
		expect(text).not.toContain("sent once more");
		expect(text).toContain("cancel it there");
		expect(text).toContain("six hours");
	});

	it("names the failed checks instead of announcing a review", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.submitInstructionChange.mockResolvedValue(
			accepted({ proposalStatus: "PENDING", status: "FAILED" }),
		);

		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_1",
				changes: [change],
				baseSnapshotId: "snap_1",
			},
			writeSession,
		);

		const text = JSON.stringify(r);
		expect(text).toContain("did not pass its checks");
		expect(text).not.toContain("PENDING REVIEW");
		// NOT "send it again": a FAILED proposal stays PENDING, so the next
		// call dedups straight back onto it.
		expect(text).not.toContain("send the change again");
		expect(text).not.toContain("send it again");
	});

	// A row that vanished between the finalizer and the re-read reports
	// `proposalStatus: null` beside the finalizer's last status. Nothing is
	// left to retry or cancel, so the closed-out branch must answer.
	it("asks for the change to be sent again when the failed row is already gone", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.submitInstructionChange.mockResolvedValue(
			accepted({ proposalStatus: null, status: "FAILED" }),
		);

		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_1",
				changes: [change],
				baseSnapshotId: "snap_1",
			},
			writeSession,
		);

		const text = JSON.stringify(r);
		expect(text).not.toContain("did not pass its checks");
		expect(text).not.toContain("still sending");
		expect(text).toContain("no longer open for review");
	});

	it("reports an approved proposal as already applied", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.submitInstructionChange.mockResolvedValue(
			accepted({ proposalStatus: "APPROVED", status: "READY" }),
		);

		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_1",
				changes: [change],
				baseSnapshotId: "snap_1",
			},
			writeSession,
		);

		const text = JSON.stringify(r);
		expect(text).toContain("already been approved");
		expect(text).not.toContain("PENDING REVIEW");
	});

	// Built the way `announceStoryCreated` builds one: no HTTP request exists
	// at this layer, so the gateway session supplies the actor and the
	// correlation handle.
	it("passes an audit context built from the gateway session", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.submitInstructionChange.mockResolvedValue(accepted());

		await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_1",
				changes: [change],
				baseSnapshotId: "snap_1",
			},
			writeSession,
		);

		expect(m.submitInstructionChange).toHaveBeenCalledWith(
			expect.objectContaining({
				audit: {
					user: {
						id: "user_1",
						email: "dev@example.com",
						name: "Example Developer",
					},
					session: {
						id: "gateway_session_1",
						activeOrganizationId: "org_1",
					},
				},
			}),
		);
	});

	// The live access check, first and unconditional, exactly as the read
	// handlers do it — and with the same wording, so nothing here confirms
	// that a project id exists in another tenant.
	it("refuses a caller with no project access, before proposing anything", async () => {
		m.getProjectAccessContext.mockResolvedValue(null);

		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_other",
				changes: [change],
				baseSnapshotId: "snap_1",
			},
			writeSession,
		);

		expect(r.isError).toBe(true);
		expect(JSON.stringify(r)).toContain("not found or access denied");
		expect(m.submitInstructionChange).not.toHaveBeenCalled();
	});

	it("requires a projectId", async () => {
		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{ changes: [change] },
			writeSession,
		);

		expect(r.isError).toBe(true);
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	// The gateway does not enforce a tool definition's `inputSchema`, so every
	// bound it advertises is re-checked in the handler — these values reach a
	// database write.
	it("refuses an empty change set", async () => {
		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{ projectId: "proj_1", changes: [] },
			writeSession,
		);

		expect(r.isError).toBe(true);
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("refuses more than 50 changes and points at the tab", async () => {
		const changes = Array.from({ length: 51 }, (_, i) => ({
			op: "put",
			path: `rules/${i}.md`,
			content: "x",
		}));

		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{ projectId: "proj_1", changes, baseSnapshotId: "snap_1" },
			writeSession,
		);

		expect(r.isError).toBe(true);
		expect(JSON.stringify(r)).toContain("Coding Instructions tab");
		expect(m.submitInstructionChange).not.toHaveBeenCalled();
	});

	it("refuses a put with no content", async () => {
		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_1",
				changes: [{ op: "put", path: "AGENTS.md" }],
			},
			writeSession,
		);

		expect(r.isError).toBe(true);
		expect(m.submitInstructionChange).not.toHaveBeenCalled();
	});

	it("refuses an unknown op", async () => {
		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_1",
				changes: [{ op: "append", path: "AGENTS.md", content: "x" }],
			},
			writeSession,
		);

		expect(r.isError).toBe(true);
	});

	/**
	 * `baseSnapshotId` is required, and the requirement is the stale-base
	 * protection in its entirety.
	 *
	 * It used to be optional, and the server then fell back to whatever was
	 * published now. An agent that read v7, spent a minute composing an edit
	 * and sent it while a person published v8 had that edit rebased onto v8
	 * in silence — reverting v8's changes to the files it touched, with
	 * nothing in the response saying so. An agent cannot notice that; the
	 * only defence is making it state which version it read.
	 */
	it("refuses a proposal that names no base, and says where to get one", async () => {
		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{ projectId: "proj_1", changes: [change] },
			writeSession,
		);

		expect(r.isError).toBe(true);
		const text = JSON.stringify(r);
		expect(text).toContain("baseSnapshotId is required");
		expect(text).toContain("fabric_get_project_instruction_bundle");
		expect(m.submitInstructionChange).not.toHaveBeenCalled();
	});

	it("declares baseSnapshotId required in its schema", () => {
		const tool = PLATFORM_TOOL_DEFINITIONS.find(
			(t) => t.name === "fabric_propose_project_instruction_change",
		);
		expect(
			(tool?.inputSchema as { required?: string[] }).required,
		).toContain("baseSnapshotId");
	});

	// The id an agent needs has to be in something it already calls. Both read
	// tools put it on `snapshot.id`, on the changed path and the unchanged
	// one alike, so there is never a call that leaves the agent without it.
	it.each([
		"fabric_list_project_instructions",
		"fabric_get_project_instruction_bundle",
	])("%s reports the snapshot id an agent must pass back", async (tool) => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({
			id: "snap_1",
			version: 7,
			status: "READY",
			digest: "d",
			fileCount: 1,
			projectId: "proj_1",
			organizationId: "org_1",
		});
		m.listInstructionFiles.mockResolvedValue([]);
		m.buildInstructionSnapshotZip.mockResolvedValue({
			key: "k",
			bucket: "b",
		});
		m.getSignedUrl.mockResolvedValue("https://example.com/zip");

		const r = await executePlatformTool(
			tool,
			{ projectId: "proj_1" },
			session,
		);

		const payload = JSON.parse((r.content[0] as { text: string }).text) as {
			snapshot?: { id?: string };
		};
		expect(payload.snapshot?.id).toBe("snap_1");
	});

	it("refuses an overlong baseSnapshotId before touching the project", async () => {
		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_1",
				changes: [change],
				baseSnapshotId: "x".repeat(129),
			},
			writeSession,
		);

		expect(r.isError).toBe(true);
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("accepts a delete with no content", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.submitInstructionChange.mockResolvedValue(
			accepted({ putCount: 0, deleteCount: 1 }),
		);

		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_1",
				changes: [{ op: "delete", path: "old.md" }],
				baseSnapshotId: "snap_1",
			},
			writeSession,
		);

		expect(r.isError).toBeFalsy();
		expect(m.submitInstructionChange).toHaveBeenCalledWith(
			expect.objectContaining({
				changes: [{ op: "delete", path: "old.md" }],
			}),
		);
	});

	// A refusal from the shared function is written for a person already; it
	// must reach the agent as a tool error rather than a success with a
	// confusing body.
	//
	// The fixture carries a `code`, which is what `submitInstructionChange`
	// actually throws (an `ORPCError`), and what the handler now requires
	// before quoting a message back — see "the proposal tool's error surface"
	// below for the other half of that rule.
	it("reports a refusal from the shared entry point as a tool error", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.submitInstructionChange.mockRejectedValue(
			Object.assign(
				new Error(
					"This project's coding instructions come from its repository.",
				),
				{ code: "PRECONDITION_FAILED" },
			),
		);

		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_1",
				changes: [change],
				baseSnapshotId: "snap_1",
			},
			writeSession,
		);

		expect(r.isError).toBe(true);
		expect(JSON.stringify(r)).toContain("repository");
	});
});

// ---------------------------------------------------------------------------
// Scope isolation
// ---------------------------------------------------------------------------
/**
 * The read scope must not reach the write tool. `instructions:read` is what
 * the Connect dialog has been minting and what a session-start hook needs;
 * if it also proposed changes, every key already in the field would have
 * gained a capability its holder never agreed to.
 */
describe("the proposal tool's scope", () => {
	it("is instructions:write, as a write", () => {
		expect(TOOL_SCOPES.fabric_propose_project_instruction_change).toEqual({
			scope: "instructions:write",
			kind: "write",
		});
	});

	it("is not satisfied by instructions:read", async () => {
		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{ projectId: "proj_1", changes: [] },
			session,
		);

		expect(r.isError).toBe(true);
		expect(JSON.stringify(r)).toContain("instructions:write");
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	// `mcp:read` is the umbrella the gateway applies to every READ tool, and
	// the Connect dialog mints it. It must stop at the boundary this tool sits
	// on the far side of.
	it("is not satisfied by the coarse mcp:read umbrella", async () => {
		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{ projectId: "proj_1", changes: [] },
			{ ...(session as object), scopes: ["mcp:read"] } as never,
		);

		expect(r.isError).toBe(true);
		expect(JSON.stringify(r)).toContain("instructions:write");
	});

	it("is satisfied by the coarse mcp:write umbrella", async () => {
		m.getProjectAccessContext.mockResolvedValue(null);

		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_1",
				changes: [{ op: "delete", path: "a.md" }],
				baseSnapshotId: "snap_1",
			},
			{ ...(session as object), scopes: ["mcp:write"] } as never,
		);

		// Past the scope gate and refused by the ACCESS gate instead, which is
		// what proves the scope was satisfied.
		expect(JSON.stringify(r)).toContain("not found or access denied");
	});

	// The read tools must not have moved: they are what a session-start hook
	// and the Connect dialog's key depend on.
	it("leaves the read tools on instructions:read", () => {
		expect(TOOL_SCOPES.fabric_list_project_instructions).toEqual({
			scope: "instructions:read",
			kind: "read",
		});
		expect(TOOL_SCOPES.fabric_get_project_instruction_bundle).toEqual({
			scope: "instructions:read",
			kind: "read",
		});
	});
});

// A write tool must not advertise itself as one a client may call freely.
describe("the proposal tool's definition", () => {
	it("carries no readOnlyHint", () => {
		const tool = PLATFORM_TOOL_DEFINITIONS.find(
			(t) => t.name === "fabric_propose_project_instruction_change",
		);
		expect(tool).toBeDefined();
		expect(tool?.annotations?.readOnlyHint).toBeUndefined();
	});

	/**
	 * The tool's schema offers no `mode`, and the absence is a security
	 * property rather than a missing feature.
	 *
	 * The tool is reachable with `instructions:write`, which the Connect
	 * dialog offers to read-only roles and describes as review-gated. A
	 * publish mode gated on the caller's permissions would make that
	 * description false for anyone who happened to hold the publishing
	 * permission, so the scope would no longer describe what the key can do.
	 * Publishing from outside the browser lives behind its own scope,
	 * `instructions:publish`, which no tool here asks for.
	 */
	it("offers an agent no way to publish", () => {
		const tool = PLATFORM_TOOL_DEFINITIONS.find(
			(t) => t.name === "fabric_propose_project_instruction_change",
		);
		const properties = (
			tool?.inputSchema as { properties?: Record<string, unknown> }
		).properties;
		expect(properties).not.toHaveProperty("mode");
		expect(properties).toHaveProperty("changes");
	});
});

/**
 * An organization API key is bound to the organization it was issued in. Its
 * creator may well be a legitimate guest of a project in ANOTHER organization
 * — `getProjectAccessContext` says yes, correctly — but the KEY is not, and
 * an `org_` key minted in one tenant must not read or write a project hosted
 * in another. The scope check and the live access check both pass here; this
 * is the third question, and it is the one the credential answers.
 *
 * These run the REAL handler against a mocked database, so what is asserted
 * is the refusal the shared gate produces and the fact that nothing past it
 * was reached.
 */
describe("organization-key tenant binding", () => {
	/** An `org_`-key session for org_1. */
	const orgKeySession = {
		userId: "user_1",
		userName: "Example Developer",
		email: "dev@example.com",
		sessionId: "gateway_session_1",
		organizationId: "org_1",
		credential: "organization-key",
		scopes: ["instructions:read", "instructions:write"],
	} as never;

	beforeEach(() => {
		// The caller genuinely has access to the project — as a guest of the
		// OTHER organization. Nothing below is a permission failure.
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_2",
		});
	});

	it("refuses a read tool a project outside the key's organization", async () => {
		const r = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_elsewhere" },
			orgKeySession,
		);

		expect(r.isError).toBe(true);
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("refuses the bundle tool a project outside the key's organization", async () => {
		const r = await executePlatformTool(
			"fabric_get_project_instruction_bundle",
			{ projectId: "proj_elsewhere" },
			orgKeySession,
		);

		expect(r.isError).toBe(true);
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.buildInstructionSnapshotZip).not.toHaveBeenCalled();
	});

	it("refuses the proposal tool before the shared entry point is reached", async () => {
		const r = await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_elsewhere",
				changes: [{ op: "put", path: "AGENTS.md", content: "x\n" }],
				baseSnapshotId: "snap_1",
			},
			orgKeySession,
		);

		expect(r.isError).toBe(true);
		// The refusal is the gateway's own. `submitInstructionChange` would
		// resolve the project's hosting organization and never see the key at
		// all, so it cannot be the thing that answers this question.
		expect(m.submitInstructionChange).not.toHaveBeenCalled();
	});

	it("says the same thing for a project outside the key as for one that does not exist", async () => {
		const outside = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_elsewhere" },
			orgKeySession,
		);
		m.getProjectAccessContext.mockResolvedValue(null);
		const missing = await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_nonexistent" },
			orgKeySession,
		);

		// Two different reasons must not be two different messages: the
		// difference tells an `org_` key holder which project ids exist
		// elsewhere.
		expect(outside.content).toEqual(missing.content);
	});

	// A personal-key or browser-session caller is the PERSON, not a tenant
	// credential, so a project they are a guest of stays reachable.
	it("leaves a personal-key caller's cross-organization access alone", async () => {
		m.getPublishedInstructionSnapshot.mockResolvedValue(null);

		await executePlatformTool(
			"fabric_list_project_instructions",
			{ projectId: "proj_elsewhere" },
			{
				...(orgKeySession as object),
				credential: "personal-key",
			} as never,
		);

		expect(m.getPublishedInstructionSnapshot).toHaveBeenCalled();
	});
});

/**
 * An unexpected failure inside the shared entry point must not be quoted back
 * to the agent. A refusal it wrote for a person is safe and useful; a database
 * or storage error message is neither, and an agent will happily repeat it
 * into a commit message or a chat transcript.
 */
describe("the proposal tool's error surface", () => {
	beforeEach(() => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
	});

	const call = () =>
		executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_1",
				changes: [{ op: "put", path: "AGENTS.md", content: "x\n" }],
				baseSnapshotId: "snap_1",
			},
			writeSession,
		);

	it("does not quote a generic error back to the agent", async () => {
		const logged = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		m.submitInstructionChange.mockRejectedValue(
			new Error("connect ECONNREFUSED 10.0.0.4:5432"),
		);

		const r = await call();

		expect(r.isError).toBe(true);
		const text = JSON.stringify(r.content);
		expect(text).not.toContain("ECONNREFUSED");
		expect(text).not.toContain("10.0.0.4");
		expect(text).toContain("internal error");
		// The operator still gets it.
		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});
});

/**
 * The scope an agent reaches this tool with cannot publish, and cannot be
 * made to.
 */
describe("what instructions:write can reach", () => {
	// Both tools that hold this scope propose and never publish — the lesson
	// tool is the positive sibling of the proposal tool, added later, and
	// shares its scope for the same reason: what it reaches is the proposal
	// path, which is what a reader can already do in the tab.
	it("maps only the proposal tools, never a publishing one", () => {
		const writeScoped = Object.entries(TOOL_SCOPES)
			.filter(([, v]) => v.scope === "instructions:write")
			.map(([name]) => name);

		expect(writeScoped).toEqual([
			"fabric_propose_project_instruction_change",
			"fabric_add_instruction_lesson",
		]);
	});

	// Belt and braces at the dispatch layer: the handler passes the proposal
	// mode as a CONSTANT, so a caller that invents one is not consulted. The
	// shared entry point does have a publish mode now — it is reachable only
	// from a REST route behind `instructions:publish`, a scope no tool map
	// mentions and the Connect dialog never mints.
	it("ignores a mode an agent invents", async () => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.submitInstructionChange.mockResolvedValue({
			snapshotId: "snap_new",
			version: 8,
			baseSnapshotId: "snap_1",
			baseVersion: 7,
			fileCount: 1,
			inheritedCount: 0,
			putCount: 1,
			deleteCount: 0,
			proposalStatus: "PENDING",
			status: "VALIDATING",
		});

		await executePlatformTool(
			"fabric_propose_project_instruction_change",
			{
				projectId: "proj_1",
				changes: [{ op: "put", path: "AGENTS.md", content: "x\n" }],
				baseSnapshotId: "snap_1",
				mode: "publish",
			},
			writeSession,
		);

		const call = m.submitInstructionChange.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(call.mode).toBe("proposal");
	});
});

// ---------------------------------------------------------------------------
// fabric_add_instruction_lesson
// ---------------------------------------------------------------------------
/**
 * The positive sibling of `fabric_propose_project_instruction_change`: an
 * agent records a lesson (a mistake the team should not repeat) as a new
 * `Lessons/<date>-<slug>.md` file, submitted through the same
 * `submitInstructionChange` proposal path. Same scope, same access gate, same
 * `mode: "proposal"` constant, same refusal handling — the one difference is
 * that this tool resolves `baseSnapshotId` itself instead of requiring the
 * caller to state it, so the mocked `getPublishedInstructionSnapshot` and
 * `listInstructionFiles` reads stand in for that resolution.
 */
describe("fabric_add_instruction_lesson", () => {
	const publishedSnapshot = {
		id: "snap_1",
		organizationId: "org_1",
		version: 7,
		status: "READY",
		digest: "d",
		fileCount: 3,
		projectId: "proj_1",
	};

	function accepted(overrides: Record<string, unknown> = {}) {
		return {
			snapshotId: "snap_new",
			version: 8,
			baseSnapshotId: "snap_1",
			baseVersion: 7,
			fileCount: 4,
			inheritedCount: 3,
			putCount: 1,
			deleteCount: 0,
			proposalStatus: "PENDING",
			mode: "proposal",
			status: "VALIDATING",
			...overrides,
		};
	}

	const LESSON_PATH_RE = /^Lessons\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

	beforeEach(() => {
		m.getProjectAccessContext.mockResolvedValue({
			organizationId: "org_1",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue(publishedSnapshot);
		m.listInstructionFiles.mockResolvedValue([]);
	});

	it("requires a projectId", async () => {
		const r = await executePlatformTool(
			"fabric_add_instruction_lesson",
			{ title: "Title", body: "Body." },
			writeSession,
		);

		expect(r.isError).toBe(true);
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("requires a title", async () => {
		const r = await executePlatformTool(
			"fabric_add_instruction_lesson",
			{ projectId: "proj_1", body: "Body." },
			writeSession,
		);

		expect(r.isError).toBe(true);
		expect(JSON.stringify(r)).toContain("title is required");
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("refuses a title over 120 characters", async () => {
		const r = await executePlatformTool(
			"fabric_add_instruction_lesson",
			{ projectId: "proj_1", title: "x".repeat(121), body: "Body." },
			writeSession,
		);

		expect(r.isError).toBe(true);
		expect(JSON.stringify(r)).toContain("120 characters");
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("refuses an empty body", async () => {
		const r = await executePlatformTool(
			"fabric_add_instruction_lesson",
			{ projectId: "proj_1", title: "Title", body: "   " },
			writeSession,
		);

		expect(r.isError).toBe(true);
		expect(JSON.stringify(r)).toContain("body is required");
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("refuses a relatedPaths entry that escapes the instruction tree", async () => {
		const r = await executePlatformTool(
			"fabric_add_instruction_lesson",
			{
				projectId: "proj_1",
				title: "Title",
				body: "Body.",
				relatedPaths: ["../../etc/passwd"],
			},
			writeSession,
		);

		expect(r.isError).toBe(true);
		expect(JSON.stringify(r)).toContain(
			"not a valid instruction-tree path",
		);
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("refuses more than 20 relatedPaths", async () => {
		const relatedPaths = Array.from({ length: 21 }, (_, i) => `f${i}.md`);

		const r = await executePlatformTool(
			"fabric_add_instruction_lesson",
			{
				projectId: "proj_1",
				title: "Title",
				body: "Body.",
				relatedPaths,
			},
			writeSession,
		);

		expect(r.isError).toBe(true);
		expect(JSON.stringify(r)).toContain("relatedPaths");
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("is refused by a read-only session, before touching the project", async () => {
		const r = await executePlatformTool(
			"fabric_add_instruction_lesson",
			{ projectId: "proj_1", title: "Title", body: "Body." },
			session,
		);

		expect(r.isError).toBe(true);
		expect(JSON.stringify(r)).toContain("instructions:write");
		expect(m.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("refuses a caller with no project access, before reading any snapshot", async () => {
		m.getProjectAccessContext.mockResolvedValue(null);

		const r = await executePlatformTool(
			"fabric_add_instruction_lesson",
			{ projectId: "proj_other", title: "Title", body: "Body." },
			writeSession,
		);

		expect(r.isError).toBe(true);
		expect(JSON.stringify(r)).toContain("not found or access denied");
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.submitInstructionChange).not.toHaveBeenCalled();
	});

	it("refuses a project with no published coding instructions yet", async () => {
		m.getPublishedInstructionSnapshot.mockResolvedValue(null);

		const r = await executePlatformTool(
			"fabric_add_instruction_lesson",
			{ projectId: "proj_1", title: "Title", body: "Body." },
			writeSession,
		);

		expect(r.isError).toBe(true);
		expect(JSON.stringify(r)).toContain(
			"no published coding instructions yet",
		);
		expect(m.submitInstructionChange).not.toHaveBeenCalled();
	});

	// This tool now resolves the base snapshot through
	// `resolvePublishedInstructionSnapshot` — the same scoped resolver the
	// three read tools use — instead of calling the unscoped
	// `getPublishedInstructionSnapshot` pointer directly. These three mirror
	// the invariants pinned for the read tools in the "organization resolution
	// (R31 / spec §6.5)" suite above: a snapshot that fails any of them reads
	// as nothing published, identically, and neither `listInstructionFiles`
	// nor `submitInstructionChange` is ever reached.
	describe("tenant scoping", () => {
		it("treats a snapshot from another organization as nothing published", async () => {
			m.getPublishedInstructionSnapshot.mockResolvedValue({
				...publishedSnapshot,
				organizationId: "org_other",
			});

			const r = await executePlatformTool(
				"fabric_add_instruction_lesson",
				{ projectId: "proj_1", title: "Title", body: "Body." },
				writeSession,
			);

			expect(r.isError).toBe(true);
			expect(JSON.stringify(r)).toContain(
				"no published coding instructions yet",
			);
			expect(m.listInstructionFiles).not.toHaveBeenCalled();
			expect(m.submitInstructionChange).not.toHaveBeenCalled();
		});

		it("treats a non-READY snapshot as nothing published", async () => {
			m.getPublishedInstructionSnapshot.mockResolvedValue({
				...publishedSnapshot,
				status: "PENDING",
			});

			const r = await executePlatformTool(
				"fabric_add_instruction_lesson",
				{ projectId: "proj_1", title: "Title", body: "Body." },
				writeSession,
			);

			expect(r.isError).toBe(true);
			expect(JSON.stringify(r)).toContain(
				"no published coding instructions yet",
			);
			expect(m.listInstructionFiles).not.toHaveBeenCalled();
			expect(m.submitInstructionChange).not.toHaveBeenCalled();
		});

		it("treats a snapshot whose projectId does not match the requested project as nothing published", async () => {
			m.getPublishedInstructionSnapshot.mockResolvedValue({
				...publishedSnapshot,
				projectId: "proj_other",
			});

			const r = await executePlatformTool(
				"fabric_add_instruction_lesson",
				{ projectId: "proj_1", title: "Title", body: "Body." },
				writeSession,
			);

			expect(r.isError).toBe(true);
			expect(JSON.stringify(r)).toContain(
				"no published coding instructions yet",
			);
			expect(m.listInstructionFiles).not.toHaveBeenCalled();
			expect(m.submitInstructionChange).not.toHaveBeenCalled();
		});
	});

	it("drafts the lesson file and proposes it", async () => {
		m.submitInstructionChange.mockResolvedValue(accepted());

		const r = await executePlatformTool(
			"fabric_add_instruction_lesson",
			{
				projectId: "proj_1",
				title: "Never skip the migration check",
				body: "We shipped a migration without running it. Run pnpm migrate before every deploy.",
			},
			writeSession,
		);

		expect(r.isError).toBeFalsy();
		const text = JSON.stringify(r);
		expect(text).toContain("PENDING");
		expect(text).toContain("Lesson drafted as Lessons/");

		expect(m.submitInstructionChange).toHaveBeenCalledTimes(1);
		const call = m.submitInstructionChange.mock.calls[0]?.[0] as {
			userId: string;
			projectId: string;
			baseSnapshotId: string;
			mode: string;
			via: string;
			changes: Array<{
				op: string;
				path: string;
				content: string;
				encoding: string;
			}>;
		};
		expect(call.userId).toBe("user_1");
		expect(call.projectId).toBe("proj_1");
		expect(call.baseSnapshotId).toBe("snap_1");
		expect(call.mode).toBe("proposal");
		expect(call.via).toBe("mcp-gateway");
		expect(call.changes).toHaveLength(1);
		const [change] = call.changes;
		expect(change.op).toBe("put");
		expect(change.encoding).toBe("utf8");
		expect(change.path).toMatch(LESSON_PATH_RE);
		expect(change.content).toContain("---\n");
		expect(change.content).toContain(
			'name: "Never skip the migration check"',
		);
		expect(change.content).toContain("# Never skip the migration check");
		expect(change.content).toContain(
			"We shipped a migration without running it.",
		);
	});

	it("suffixes the path when the base snapshot already has today's lesson file", async () => {
		const todayIso = new Date().toISOString().slice(0, 10);
		m.listInstructionFiles.mockResolvedValue([
			{ path: `Lessons/${todayIso}-title.md` },
		]);
		m.submitInstructionChange.mockResolvedValue(accepted());

		await executePlatformTool(
			"fabric_add_instruction_lesson",
			{ projectId: "proj_1", title: "Title", body: "Body." },
			writeSession,
		);

		const call = m.submitInstructionChange.mock.calls[0]?.[0] as {
			changes: Array<{ path: string }>;
		};
		expect(call.changes[0]?.path).toBe(`Lessons/${todayIso}-title-2.md`);
	});

	it("passes an audit context built from the gateway session", async () => {
		m.submitInstructionChange.mockResolvedValue(accepted());

		await executePlatformTool(
			"fabric_add_instruction_lesson",
			{ projectId: "proj_1", title: "Title", body: "Body." },
			writeSession,
		);

		expect(m.submitInstructionChange).toHaveBeenCalledWith(
			expect.objectContaining({
				audit: {
					user: {
						id: "user_1",
						email: "dev@example.com",
						name: "Example Developer",
					},
					session: {
						id: "gateway_session_1",
						activeOrganizationId: "org_1",
					},
				},
			}),
		);
	});

	it("passes related paths through, normalized, into the rendered file", async () => {
		m.submitInstructionChange.mockResolvedValue(accepted());

		await executePlatformTool(
			"fabric_add_instruction_lesson",
			{
				projectId: "proj_1",
				title: "Title",
				body: "Body.",
				relatedPaths: ["fabric/standards/backend/migrations.md"],
			},
			writeSession,
		);

		const call = m.submitInstructionChange.mock.calls[0]?.[0] as {
			changes: Array<{ content: string }>;
		};
		expect(call.changes[0]?.content).toContain(
			"  - fabric/standards/backend/migrations.md",
		);
	});

	describe("error surface", () => {
		it("quotes a CONFLICT refusal from the shared entry point back to the agent", async () => {
			m.submitInstructionChange.mockRejectedValue(
				Object.assign(
					new Error(
						"The published version changed since your copy was taken.",
					),
					{ code: "CONFLICT" },
				),
			);

			const r = await executePlatformTool(
				"fabric_add_instruction_lesson",
				{ projectId: "proj_1", title: "Title", body: "Body." },
				writeSession,
			);

			expect(r.isError).toBe(true);
			expect(JSON.stringify(r)).toContain("published version changed");
		});

		it("quotes a PRECONDITION_FAILED refusal (repository-backed project) back to the agent", async () => {
			m.submitInstructionChange.mockRejectedValue(
				Object.assign(
					new Error(
						"This project's coding instructions come from its repository.",
					),
					{ code: "PRECONDITION_FAILED" },
				),
			);

			const r = await executePlatformTool(
				"fabric_add_instruction_lesson",
				{ projectId: "proj_1", title: "Title", body: "Body." },
				writeSession,
			);

			expect(r.isError).toBe(true);
			expect(JSON.stringify(r)).toContain("repository");
		});

		it("does not quote a generic error back to the agent", async () => {
			const logged = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);
			m.submitInstructionChange.mockRejectedValue(
				new Error("connect ECONNREFUSED 10.0.0.4:5432"),
			);

			const r = await executePlatformTool(
				"fabric_add_instruction_lesson",
				{ projectId: "proj_1", title: "Title", body: "Body." },
				writeSession,
			);

			expect(r.isError).toBe(true);
			const text = JSON.stringify(r.content);
			expect(text).not.toContain("ECONNREFUSED");
			expect(text).not.toContain("10.0.0.4");
			expect(text).toContain("internal error");
			expect(logged).toHaveBeenCalled();
			logged.mockRestore();
		});

		// Fix: the snapshot resolution used to run outside the handler's
		// try/catch, so a Prisma/storage failure here would have escaped
		// `instructionRefusalMessage` entirely and propagated as an unhandled
		// rejection rather than a tool error. It now runs inside the same
		// try/catch as the submission, so it is reported identically to one.
		it("does not quote a getPublishedInstructionSnapshot failure back to the agent", async () => {
			const logged = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);
			m.getPublishedInstructionSnapshot.mockRejectedValue(
				new Error("connect ECONNREFUSED db.internal.example:5432"),
			);

			const r = await executePlatformTool(
				"fabric_add_instruction_lesson",
				{ projectId: "proj_1", title: "Title", body: "Body." },
				writeSession,
			);

			expect(r.isError).toBe(true);
			const text = JSON.stringify(r);
			expect(text).not.toContain("db.internal.example");
			expect(text).toContain("internal error");
			expect(m.submitInstructionChange).not.toHaveBeenCalled();
			expect(logged).toHaveBeenCalled();
			logged.mockRestore();
		});

		it("does not quote a listInstructionFiles failure back to the agent", async () => {
			const logged = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);
			m.listInstructionFiles.mockRejectedValue(
				new Error("connect ECONNREFUSED db.internal.example:5432"),
			);

			const r = await executePlatformTool(
				"fabric_add_instruction_lesson",
				{ projectId: "proj_1", title: "Title", body: "Body." },
				writeSession,
			);

			expect(r.isError).toBe(true);
			const text = JSON.stringify(r);
			expect(text).not.toContain("db.internal.example");
			expect(text).toContain("internal error");
			expect(m.submitInstructionChange).not.toHaveBeenCalled();
			expect(logged).toHaveBeenCalled();
			logged.mockRestore();
		});
	});

	describe("scope and definition", () => {
		it("is instructions:write, as a write", () => {
			expect(TOOL_SCOPES.fabric_add_instruction_lesson).toEqual({
				scope: "instructions:write",
				kind: "write",
			});
		});

		it("carries no readOnlyHint", () => {
			const tool = PLATFORM_TOOL_DEFINITIONS.find(
				(t) => t.name === "fabric_add_instruction_lesson",
			);
			expect(tool).toBeDefined();
			expect(tool?.annotations?.readOnlyHint).toBeUndefined();
		});

		it("offers an agent no mode argument", () => {
			const tool = PLATFORM_TOOL_DEFINITIONS.find(
				(t) => t.name === "fabric_add_instruction_lesson",
			);
			const properties = (
				tool?.inputSchema as { properties?: Record<string, unknown> }
			).properties;
			expect(properties).not.toHaveProperty("mode");
			expect(properties).not.toHaveProperty("baseSnapshotId");
			expect(properties).toHaveProperty("title");
			expect(properties).toHaveProperty("body");
		});

		it("requires only projectId, title and body", () => {
			const tool = PLATFORM_TOOL_DEFINITIONS.find(
				(t) => t.name === "fabric_add_instruction_lesson",
			);
			expect(
				(tool?.inputSchema as { required?: string[] }).required,
			).toEqual(["projectId", "title", "body"]);
		});
	});
});
