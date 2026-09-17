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
	listInstructionFiles: vi.fn(),
	getInstructionFileByPath: vi.fn(),
	downloadFile: vi.fn(),
	getSignedUrl: vi.fn(),
	buildInstructionSnapshotZip: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectAccessContext: m.getProjectAccessContext,
	getPublishedInstructionSnapshot: m.getPublishedInstructionSnapshot,
	listInstructionFiles: m.listInstructionFiles,
	getInstructionFileByPath: m.getInstructionFileByPath,
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
