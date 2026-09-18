/**
 * Tests for `deriveSnapshotProcedure` — a new version seeded from an existing
 * READY one, which is how an in-tab file edit, a deletion and an "Add file"
 * all reach the ordinary upload path.
 *
 * Pattern mirrors `delete-snapshot.test.ts`: the stub `.use()` records each
 * middleware and the stub `.handler()` composes them ahead of the real
 * handler, so a `requireProjectPermission`-produced middleware that rejects
 * actually short-circuits the call the way the oRPC runtime would. Every
 * other file in this folder can only prove the guard INSIDE the handler.
 *
 * `@repo/instructions` is NOT mocked: the real path validation, ignore
 * matcher, secret-filename matcher and classifier run, so the tests exercise
 * the actual server-side refusals rather than a stand-in for them.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	createDerivedInstructionSnapshot: vi.fn(),
	getInstructionSnapshot: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	permissionMiddleware: vi.fn(),
	requestedPermission: undefined as string | undefined,
}));

vi.mock("@repo/database", () => ({
	createDerivedInstructionSnapshot: (...a: unknown[]) =>
		m.createDerivedInstructionSnapshot(...a),
	getInstructionSnapshot: (...a: unknown[]) => m.getInstructionSnapshot(...a),
	getProjectInstructionSettings: (...a: unknown[]) =>
		m.getProjectInstructionSettings(...a),
	getPublishedInstructionSnapshot: (...a: unknown[]) =>
		m.getPublishedInstructionSnapshot(...a),
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => m.recordAuditFromRequest(...a),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const middlewares: Array<(args: unknown) => unknown> = [];
	const b = {
		use: (mw: (args: unknown) => unknown) => {
			middlewares.push(mw);
			return b;
		},
		route: () => b,
		input: () => b,
		handler: (fn: (...a: unknown[]) => unknown) => {
			const composed = async (args: unknown) => {
				for (const mw of middlewares) {
					await mw(args);
				}
				return fn(args as never);
			};
			m.handlers.derive = composed;
			return composed;
		},
	};
	return {
		tenantProtectedProcedure: b,
		requireProjectPermission: (permission: string) => {
			m.requestedPermission = permission;
			return (args: unknown) => m.permissionMiddleware(args);
		},
		Permissions: { INSTRUCTION_CREATE: "instruction:create" },
	};
});

import "../derive-snapshot";

const ctx = { user: { id: "u" }, session: { activeOrganizationId: "org_1" } };
const BASE_PREFIX = "projects/p/instructions/snapshots/base/";

function deriveInput(
	changes: Array<Record<string, unknown>>,
	publishOnReady = true,
) {
	return {
		projectId: "p",
		baseSnapshotId: "base",
		publishOnReady,
		changes,
	};
}

const editOneFile = [
	{ op: "put", path: "CLAUDE.md", size: 12, sha256: "a".repeat(64) },
];

beforeEach(() => {
	for (const f of [
		m.createDerivedInstructionSnapshot,
		m.getInstructionSnapshot,
		m.getProjectInstructionSettings,
		m.getPublishedInstructionSnapshot,
		m.recordAuditFromRequest,
		m.resolveEffectiveProjectPermissions,
		m.permissionMiddleware,
	]) {
		f.mockReset();
	}
	m.permissionMiddleware.mockResolvedValue(undefined);
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: ["instruction:create"],
		source: "org",
		organizationId: "org_1",
	});
	m.getProjectInstructionSettings.mockResolvedValue({
		ignoreGlobs: null,
		sourceOfTruth: null,
	});
	m.getInstructionSnapshot.mockResolvedValue({
		id: "base",
		version: 7,
		status: "READY",
		settingsFrozen: {
			layer: "default",
			ignoreGlobs: ["**/tasks/**"],
		},
	});
	m.getPublishedInstructionSnapshot.mockResolvedValue({ id: "base" });
	m.createDerivedInstructionSnapshot.mockResolvedValue({
		ok: true,
		id: "snap_new",
		version: 8,
		fileCount: 12,
		inheritedCount: 11,
		staged: [{ id: "f_new", path: "CLAUDE.md" }],
	});
});

describe("projects.instructions.derive", () => {
	it("declares INSTRUCTION_CREATE as its guarding permission", () => {
		expect(m.requestedPermission).toBe("instruction:create");
	});

	it("throws FORBIDDEN and writes nothing when the permission middleware denies", async () => {
		m.permissionMiddleware.mockRejectedValueOnce(
			new ORPCError("FORBIDDEN", {
				message: "Missing required permission: instruction:create",
			}),
		);

		await expect(
			m.handlers.derive!({
				input: deriveInput(editOneFile),
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("server-generates the storage key, the MIME type and the kind", async () => {
		await m.handlers.derive!({
			input: deriveInput([
				{
					op: "put",
					path: ".claude/skills/review/SKILL.md",
					size: 12,
					sha256: "a".repeat(64),
					// A client-supplied key is not part of the input schema;
					// sending one must change nothing.
					storageKey: "anything/i/like",
				},
			]),
			context: ctx,
		});

		const call = m.createDerivedInstructionSnapshot.mock.calls[0]![0] as {
			changes: Array<Record<string, unknown>>;
			baseKeyPrefix: string;
			organizationId: string;
			userId: string;
		};
		expect(call.changes[0]).toMatchObject({
			op: "put",
			path: ".claude/skills/review/SKILL.md",
			kind: "SKILL",
			mimeType: "text/markdown",
			isText: true,
			storageKey: "projects/p/instructions/staging/pending/0",
		});
		// The base's own immutable prefix, which is the ONLY place an
		// inherited row's key may point.
		expect(call.baseKeyPrefix).toBe(BASE_PREFIX);
		// The project's HOSTING organization, resolved server-side.
		expect(call.organizationId).toBe("org_1");
		expect(call.userId).toBe("u");
	});

	it("returns only the staged rows, so the client never PUTs an inherited one", async () => {
		const result = await m.handlers.derive!({
			input: deriveInput(editOneFile),
			context: ctx,
		});

		expect(result).toEqual({
			snapshotId: "snap_new",
			version: 8,
			baseVersion: 7,
			fileCount: 12,
			inheritedCount: 11,
			staged: [{ fileId: "f_new", path: "CLAUDE.md" }],
		});
	});

	it("audits the upload_started action with the provenance and counts, never a path", async () => {
		await m.handlers.derive!({
			input: deriveInput([
				...editOneFile,
				{ op: "delete", path: "AGENTS.md" },
			]),
			context: ctx,
		});

		const audit = m.recordAuditFromRequest.mock.calls[0]![1] as {
			action: string;
			metadata: Record<string, unknown>;
		};
		expect(audit.action).toBe("project.instructions.upload_started");
		expect(audit.metadata).toEqual({
			mode: "derived",
			baseSnapshotId: "base",
			baseVersion: 7,
			putCount: 1,
			deleteCount: 1,
			inheritedCount: 11,
			keptCount: 12,
		});
		// Paths are user content; the audit row carries counts only.
		expect(JSON.stringify(audit.metadata)).not.toContain("CLAUDE.md");
		expect(JSON.stringify(audit.metadata)).not.toContain("AGENTS.md");
	});

	describe("source of truth", () => {
		it("refuses a repository-backed project and names git", async () => {
			m.getProjectInstructionSettings.mockResolvedValue({
				ignoreGlobs: null,
				sourceOfTruth: "REPOSITORY",
			});

			const error = await m.handlers.derive!({
				input: deriveInput(editOneFile),
				context: ctx,
			}).catch((e: ORPCError<string, unknown>) => e);

			expect(error).toMatchObject({ code: "PRECONDITION_FAILED" });
			expect((error as Error).message).toContain("repository");
			expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		});

		it("allows an upload-backed project", async () => {
			m.getProjectInstructionSettings.mockResolvedValue({
				ignoreGlobs: null,
				sourceOfTruth: "UPLOAD",
			});

			await m.handlers.derive!({
				input: deriveInput(editOneFile),
				context: ctx,
			});
			expect(m.createDerivedInstructionSnapshot).toHaveBeenCalled();
		});
	});

	describe("non-fast-forward", () => {
		it("refuses a publish whose base is no longer the published version", async () => {
			m.getPublishedInstructionSnapshot.mockResolvedValue({
				id: "someone-elses-newer-snapshot",
			});

			const error = await m.handlers.derive!({
				input: deriveInput(editOneFile),
				context: ctx,
			}).catch((e: ORPCError<string, unknown>) => e);

			expect(error).toMatchObject({
				code: "CONFLICT",
				data: { reason: "BASE_NOT_PUBLISHED" },
			});
			expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
			// Direction-neutral: the base may have been replaced by a
			// ROLLBACK to an older version, and History offers exactly that,
			// so "someone published a newer version" would be a falsehood
			// rather than a rounding error.
			expect((error as ORPCError<string, unknown>).message).not.toMatch(
				/newer version/i,
			);
			expect((error as ORPCError<string, unknown>).message).toMatch(
				/published version changed/i,
			);
		});

		/**
		 * "Save as a new version" makes no claim on the published pointer, so
		 * a stale base is allowed to become history without becoming the
		 * pointer. It does NOT rest on the publish transition refusing an
		 * older version — History's rollback publishes one deliberately.
		 */
		it("allows a non-publishing save from a stale base", async () => {
			m.getPublishedInstructionSnapshot.mockResolvedValue({
				id: "someone-elses-newer-snapshot",
			});

			await m.handlers.derive!({
				input: deriveInput(editOneFile, false),
				context: ctx,
			});

			expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
				expect.objectContaining({ publishOnReady: false }),
			);
		});
	});

	describe("payload refusals", () => {
		it("refuses a traversal path", async () => {
			await expect(
				m.handlers.derive!({
					input: deriveInput([
						{
							op: "put",
							path: "../escape.md",
							size: 1,
							sha256: "a".repeat(64),
						},
					]),
					context: ctx,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		});

		it("refuses a secret-shaped filename before anything is registered", async () => {
			await expect(
				m.handlers.derive!({
					input: deriveInput([
						{
							op: "put",
							path: "scripts/.env",
							size: 1,
							sha256: "a".repeat(64),
						},
					]),
					context: ctx,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		});

		/**
		 * The BASE's frozen rules, not the project's live ones: the inherited
		 * files were admitted under these, `settingsFrozen` is copied verbatim,
		 * and the gate checks the stored `.fabricignore` still parses to
		 * exactly them.
		 */
		it("refuses a path the base's frozen ignore rules exclude", async () => {
			await expect(
				m.handlers.derive!({
					input: deriveInput([
						{
							op: "put",
							path: "tasks/2026/notes.md",
							size: 1,
							sha256: "a".repeat(64),
						},
					]),
					context: ctx,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		});

		it("refuses any change to .fabricignore, edit or delete", async () => {
			for (const change of [
				{
					op: "put",
					path: ".fabricignore",
					size: 1,
					sha256: "a".repeat(64),
				},
				{ op: "delete", path: ".fabricignore" },
			]) {
				await expect(
					m.handlers.derive!({
						input: deriveInput([change]),
						context: ctx,
					}),
				).rejects.toMatchObject({ code: "BAD_REQUEST" });
			}
			expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		});

		it("refuses the same path twice in one change set", async () => {
			await expect(
				m.handlers.derive!({
					input: deriveInput([
						{
							op: "put",
							path: "CLAUDE.md",
							size: 1,
							sha256: "a".repeat(64),
						},
						{ op: "delete", path: "claude.md" },
					]),
					context: ctx,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		});

		it("refuses a file over the per-file cap", async () => {
			await expect(
				m.handlers.derive!({
					input: deriveInput([
						{
							op: "put",
							path: "big.md",
							size: 10_000_000,
							sha256: "a".repeat(64),
						},
					]),
					context: ctx,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		});
	});

	describe("base refusals from the query", () => {
		it("maps base_not_found to NOT_FOUND", async () => {
			m.createDerivedInstructionSnapshot.mockResolvedValue({
				ok: false,
				reason: "base_not_found",
			});
			await expect(
				m.handlers.derive!({
					input: deriveInput(editOneFile),
					context: ctx,
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		});

		it("maps base_not_ready to CONFLICT", async () => {
			m.createDerivedInstructionSnapshot.mockResolvedValue({
				ok: false,
				reason: "base_not_ready",
			});
			await expect(
				m.handlers.derive!({
					input: deriveInput(editOneFile),
					context: ctx,
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
		});

		it("maps delete_path_missing to CONFLICT and names the path", async () => {
			m.createDerivedInstructionSnapshot.mockResolvedValue({
				ok: false,
				reason: "delete_path_missing",
				detail: "AGENTS.md",
			});
			const error = await m.handlers.derive!({
				input: deriveInput([{ op: "delete", path: "AGENTS.md" }]),
				context: ctx,
			}).catch((e: Error) => e);
			expect(error).toMatchObject({ code: "CONFLICT" });
			expect((error as Error).message).toContain("AGENTS.md");
		});

		it("maps empty_result to BAD_REQUEST", async () => {
			m.createDerivedInstructionSnapshot.mockResolvedValue({
				ok: false,
				reason: "empty_result",
			});
			await expect(
				m.handlers.derive!({
					input: deriveInput([{ op: "delete", path: "CLAUDE.md" }]),
					context: ctx,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		});
	});

	it("404s a base snapshot outside this project's tenant", async () => {
		m.getInstructionSnapshot.mockResolvedValue(null);

		await expect(
			m.handlers.derive!({
				input: deriveInput(editOneFile),
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
	});
});
