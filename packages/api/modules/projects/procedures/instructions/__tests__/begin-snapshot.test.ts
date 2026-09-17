/**
 * Tests for `beginSnapshotProcedure` — registers a coding-instructions
 * upload: validates every path, applies ignore rules server-side, enforces
 * the `@repo/instructions` caps, and creates the RECEIVING snapshot with
 * server-generated staging keys (never a client-supplied storage key).
 *
 * Pattern mirrors `diagrams/__tests__/create-from-chat.test.ts`: a
 * chainable mock of the oRPC procedure builder captures the handler
 * function, and `@repo/database` + `../../../../lib/audit` are stubbed with
 * hoisted spies. `@repo/instructions` is NOT mocked — the real path
 * validation, classification, and ignore-glob resolution run so the tests
 * exercise the actual server-side exclusion logic.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	createInstructionSnapshot: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	createInstructionSnapshot: (...a: unknown[]) =>
		m.createInstructionSnapshot(...a),
	getProjectInstructionSettings: (...a: unknown[]) =>
		m.getProjectInstructionSettings(...a),
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => m.recordAuditFromRequest(...a),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const builder = {
		use: () => builder,
		route: () => builder,
		input: () => builder,
		handler: (fn: (...a: unknown[]) => unknown) => {
			m.handlers.begin = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: () => ({}),
		Permissions: { INSTRUCTION_CREATE: "instruction:create" },
	};
});

import "../begin-snapshot";

const ctx = {
	user: { id: "user_1" },
	session: { activeOrganizationId: "org_1" },
};

beforeEach(() => {
	for (const fn of Object.values(m)) {
		if (typeof fn === "function") {
			(fn as ReturnType<typeof vi.fn>).mockReset?.();
		}
	}
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: ["instruction:create"],
		source: "org",
		organizationId: "org_1",
	});
	m.getProjectInstructionSettings.mockResolvedValue({
		ignoreGlobs: null,
		sourceOfTruth: null,
	});
	m.createInstructionSnapshot.mockResolvedValue({
		id: "snap_1",
		version: 1,
		files: [{ id: "f1", path: "CLAUDE.md", storageKey: "k" }],
	});
});

describe("projects.instructions.begin", () => {
	it("stores kept files, counts excluded ones, and never trusts client keys", async () => {
		const result = await m.handlers.begin!({
			input: {
				projectId: "proj_1",
				publishOnReady: true,
				files: [
					{ path: "CLAUDE.md", size: 10, sha256: "a".repeat(64) },
					{
						path: "tasks/1/notes.md",
						size: 10,
						sha256: "b".repeat(64),
					},
					{ path: ".git/HEAD", size: 10, sha256: "c".repeat(64) },
				],
			},
			context: ctx,
		});
		const call = m.createInstructionSnapshot.mock.calls[0]![0] as {
			files: Array<{ path: string; storageKey: string; kind: string }>;
			excludedCount: number;
		};
		expect(call.files.map((f) => f.path)).toEqual(["CLAUDE.md"]);
		expect(call.files[0]!.kind).toBe("INSTRUCTIONS");
		expect(call.files[0]!.storageKey).toMatch(
			/^projects\/proj_1\/instructions\/staging\/pending\//,
		);
		expect(call.excludedCount).toBe(2);
		expect(result).toEqual({
			snapshotId: "snap_1",
			version: 1,
			keptCount: 1,
			excludedCount: 2,
			excluded: [
				{
					path: "tasks/1/notes.md",
					rule: "**/tasks/**",
					layer: "default",
				},
				{ path: ".git/HEAD", rule: "**/.git/**", layer: "always" },
			],
		});
	});

	it("rejects a traversal path before touching the database", async () => {
		await expect(
			m.handlers.begin!({
				input: {
					projectId: "proj_1",
					publishOnReady: true,
					files: [
						{ path: "../x.md", size: 1, sha256: "a".repeat(64) },
					],
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("rejects when caps are exceeded", async () => {
		const files = Array.from({ length: 5001 }, (_, i) => ({
			path: `f${i}.md`,
			size: 1,
			sha256: "a".repeat(64),
		}));
		await expect(
			m.handlers.begin!({
				input: { projectId: "proj_1", publishOnReady: true, files },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	// M8: `resolveOrganizationId` hands back a caller-supplied
	// `organizationId` verbatim, so before this the snapshot and every file
	// row it creates could be tagged with an organization that does not host
	// the project — rows that violate the tenancy invariant every read and
	// the publish path then fail closed on.
	it("tags rows with the project's host organization, not the one the caller named", async () => {
		await m.handlers.begin!({
			input: {
				projectId: "proj_1",
				organizationId: "org_attacker",
				publishOnReady: true,
				files: [
					{ path: "CLAUDE.md", size: 10, sha256: "a".repeat(64) },
				],
			},
			context: ctx,
		});
		const call = m.createInstructionSnapshot.mock.calls[0]![0] as {
			organizationId: string;
		};
		expect(call.organizationId).toBe("org_1");
		expect(m.getProjectInstructionSettings).toHaveBeenCalledWith(
			"proj_1",
			"org_1",
		);
		expect(m.recordAuditFromRequest.mock.calls[0]![1]).toMatchObject({
			organizationId: "org_1",
		});
	});

	it("refuses a project with no hosting organization", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: ["instruction:create"],
			source: "owner",
			organizationId: null,
		});
		await expect(
			m.handlers.begin!({
				input: {
					projectId: "proj_personal",
					organizationId: "org_1",
					publishOnReady: true,
					files: [
						{ path: "CLAUDE.md", size: 1, sha256: "a".repeat(64) },
					],
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("uses .fabricignore from the upload when present", async () => {
		await m.handlers.begin!({
			input: {
				projectId: "proj_1",
				publishOnReady: true,
				fabricIgnoreText: "docs/\n",
				files: [
					{ path: "docs/a.md", size: 1, sha256: "a".repeat(64) },
					{ path: "tasks/x.md", size: 1, sha256: "a".repeat(64) },
				],
			},
			context: ctx,
		});
		const call = m.createInstructionSnapshot.mock.calls[0]![0] as {
			files: Array<{ path: string }>;
		};
		expect(call.files.map((f) => f.path)).toEqual(["tasks/x.md"]);
	});
});
