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

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	createInstructionSnapshot: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	assertProjectPermission: vi.fn(),
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
		// The handler-side check `publishBeforeScan` adds (Fizzy #2737).
		assertProjectPermission: (...a: unknown[]) =>
			m.assertProjectPermission(...a),
		Permissions: {
			INSTRUCTION_CREATE: "instruction:create",
			INSTRUCTION_UPDATE: "instruction:update",
		},
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

	// The browser no longer sends the paths its own preview excluded, only
	// how many there were. The stored count still has to describe the whole
	// pick, and the audit row has to say which part the server itself judged.
	it("folds the client's excluded count into the stored and returned count, and audits both", async () => {
		const result = await m.handlers.begin?.({
			input: {
				projectId: "proj_1",
				publishOnReady: true,
				clientExcludedCount: 5,
				files: [
					{ path: "CLAUDE.md", size: 10, sha256: "a".repeat(64) },
					{ path: ".git/HEAD", size: 10, sha256: "c".repeat(64) },
				],
			},
			context: ctx,
		});
		const call = m.createInstructionSnapshot.mock.calls[0]?.[0] as {
			excludedCount: number;
		};
		expect(call.excludedCount).toBe(6);
		expect(result).toMatchObject({ keptCount: 1, excludedCount: 6 });
		expect(m.recordAuditFromRequest.mock.calls[0]?.[1]).toMatchObject({
			metadata: {
				keptCount: 1,
				excludedCount: 6,
				serverExcludedCount: 1,
			},
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

	// Spec §4: while a repository is the source of truth, a browser or API
	// upload would publish files the repository never had.
	it("refuses an upload while the repository is the source of truth", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "REPOSITORY",
		});
		await expect(
			m.handlers.begin!({
				input: {
					projectId: "proj_1",
					publishOnReady: true,
					files: [
						{ path: "CLAUDE.md", size: 10, sha256: "a".repeat(64) },
					],
				},
				context: ctx,
			}),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message: expect.stringContaining("come from its repository"),
		});
		expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
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

	// A published version is installed by `fabric instructions sync`, whose own
	// path guard refuses these names — the WHOLE manifest, for everyone who
	// pulls it. Accepting them here would store a version nobody can install.
	it.each([
		["CON.md", "a Windows device name"],
		["docs/nul.txt", "a device name in a subdirectory"],
		["AGENTS.md.", "a trailing dot Windows strips"],
		["AGENTS.md ", "a trailing space Windows strips"],
		["AGENTS.md:stream", "an NTFS alternate data stream"],
		["AGENTS*.md", "a character Windows refuses in a filename"],
		["docs/a|b.md", "a redirection operator in a name"],
	])("refuses %j — %s — before touching the database", async (path) => {
		await expect(
			m.handlers.begin!({
				input: {
					projectId: "proj_1",
					publishOnReady: true,
					files: [{ path, size: 1, sha256: "a".repeat(64) }],
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
	});

	// ORDER: ignore rules first, portability second. A repository routinely
	// contains names a Windows checkout cannot write — inside `generated/`,
	// a vendored tree, build output — and every one of them is already
	// excluded. Asking the portability question first would refuse the whole
	// upload over a file the version was never going to contain, which makes
	// the ignore rules useless.
	it("does not refuse an upload for an unportable name that the ignore rules exclude", async () => {
		const result = await m.handlers.begin!({
			input: {
				projectId: "proj_1",
				publishOnReady: true,
				fabricIgnoreText: "generated/\n",
				files: [
					{ path: "CLAUDE.md", size: 1, sha256: "a".repeat(64) },
					{
						path: "generated/CON.md",
						size: 1,
						sha256: "b".repeat(64),
					},
				],
			},
			context: ctx,
		});

		expect(result).toMatchObject({ keptCount: 1, excludedCount: 1 });
		const call = m.createInstructionSnapshot.mock.calls[0]![0] as {
			files: Array<{ path: string }>;
		};
		expect(call.files.map((f) => f.path)).toEqual(["CLAUDE.md"]);
	});

	// Same ordering rule as the portable-name check, and for the same reason:
	// the collision check judges the RESULTING TREE. A repository can easily
	// hold `docs/README.md` and `docs/readme.md` in a directory the ignore
	// rules exclude — build output, a vendored dependency — and refusing the
	// whole upload over a pair the version will not contain makes the ignore
	// rules useless.
	it("does not refuse an upload for a colliding pair the ignore rules exclude", async () => {
		const result = await m.handlers.begin!({
			input: {
				projectId: "proj_1",
				publishOnReady: true,
				fabricIgnoreText: "generated/\n",
				files: [
					{ path: "CLAUDE.md", size: 1, sha256: "a".repeat(64) },
					{
						path: "generated/caf\u00e9.md",
						size: 1,
						sha256: "b".repeat(64),
					},
					{
						path: "generated/cafe\u0301.md",
						size: 1,
						sha256: "c".repeat(64),
					},
				],
			},
			context: ctx,
		});

		expect(result).toMatchObject({ keptCount: 1, excludedCount: 2 });
	});

	// Lowercasing alone does not catch this pair: same name, two Unicode
	// normalisations, one file on macOS. Uploading both would store two rows
	// and install one, with whichever landed second silently winning.
	it("refuses two spellings of one name that differ only by Unicode normalisation", async () => {
		await expect(
			m.handlers.begin!({
				input: {
					projectId: "proj_1",
					publishOnReady: true,
					files: [
						{
							path: "caf\u00e9.md",
							size: 1,
							sha256: "a".repeat(64),
						},
						{
							path: "cafe\u0301.md",
							size: 1,
							sha256: "b".repeat(64),
						},
					],
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
	});

	// Two rows that pass the duplicate check can still be impossible to
	// write together: `docs` has to be a file for one and a folder for the
	// other, and the CLI sync fails on whichever it writes second.
	it.each([[["docs", "docs/a.md"]], [["docs/a.md", "Docs"]]])(
		"refuses %j — one name as both a file and a folder",
		async (paths) => {
			const attempt = m.handlers.begin?.({
				input: {
					projectId: "proj_1",
					publishOnReady: true,
					files: paths.map((path) => ({
						path,
						size: 1,
						sha256: "a".repeat(64),
					})),
				},
				context: ctx,
			});
			await expect(attempt).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			await expect(attempt).rejects.toThrow(/both a file and a folder/);
			expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
		},
	);

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

describe("projects.instructions.begin: publish first, scan afterwards (Fizzy #2737)", () => {
	const files = [{ path: "CLAUDE.md", size: 10, sha256: "a".repeat(64) }];

	it("requires the publish permission, freezes the opt-in onto the row, and says so in the audit row", async () => {
		m.assertProjectPermission.mockResolvedValue(undefined);

		await m.handlers.begin!({
			input: {
				projectId: "proj_1",
				publishOnReady: true,
				publishBeforeScan: true,
				files,
			},
			context: ctx,
		});

		expect(m.assertProjectPermission).toHaveBeenCalledWith(
			"proj_1",
			"user_1",
			"instruction:update",
		);
		expect(m.createInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				publishOnReady: true,
				publishBeforeScan: true,
			}),
		);
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions.upload_started",
				metadata: expect.objectContaining({ publishBeforeScan: true }),
			}),
		);
	});

	it("refuses a member without the publish permission and writes nothing", async () => {
		m.assertProjectPermission.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Missing required permission: instruction:update",
			}),
		);

		await expect(
			m.handlers.begin!({
				input: {
					projectId: "proj_1",
					publishOnReady: true,
					publishBeforeScan: true,
					files,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("refuses publishBeforeScan without publishOnReady as a bad request, before any permission check", async () => {
		await expect(
			m.handlers.begin!({
				input: {
					projectId: "proj_1",
					publishOnReady: false,
					publishBeforeScan: true,
					files,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.assertProjectPermission).not.toHaveBeenCalled();
		expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("asks for nothing extra, and stores nothing extra, for an ordinary upload", async () => {
		await m.handlers.begin!({
			input: {
				projectId: "proj_1",
				publishOnReady: true,
				publishBeforeScan: false,
				files,
			},
			context: ctx,
		});

		expect(m.assertProjectPermission).not.toHaveBeenCalled();
		const call = m.createInstructionSnapshot.mock.calls[0]![0] as Record<
			string,
			unknown
		>;
		expect(call).not.toHaveProperty("publishBeforeScan");
		const [, row] = m.recordAuditFromRequest.mock.calls[0]! as [
			unknown,
			{ metadata: Record<string, unknown> },
		];
		expect(row.metadata).not.toHaveProperty("publishBeforeScan");
	});
});
