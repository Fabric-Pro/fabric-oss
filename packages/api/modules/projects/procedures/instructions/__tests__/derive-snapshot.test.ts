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
	assertInstructionDeriveAccess: vi.fn(),
	admit: vi.fn(),
	startAdmittedProposalPullRequest: vi.fn(),
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
	// The template builder's two inputs, reduced to what a synthetic context
	// carries.
	resolveActor: (context: { user?: { id: string } }) => ({
		type: "user",
		userId: context.user?.id ?? null,
	}),
	auditRequestFields: () => ({
		impersonatedById: null,
		ipAddress: "203.0.113.7",
		userAgent: null,
		requestId: "req_1",
		sessionId: null,
		correlationId: null,
	}),
}));
// Admission is its own suite (`proposal-admission.test.ts`); here it is the
// seam, so each test states the destination it decided. The pure helpers
// that turn an admission into the create's input stay real.
vi.mock("../proposal-admission", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	admitInstructionProposal: (...a: unknown[]) => m.admit(...a),
}));
vi.mock("../proposal-pull-request", () => ({
	startAdmittedProposalPullRequest: (...a: unknown[]) =>
		m.startAdmittedProposalPullRequest(...a),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../proposal-authorization", () => ({
	assertInstructionDeriveAccess: (...a: unknown[]) =>
		m.assertInstructionDeriveAccess(...a),
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
		Permissions: {
			INSTRUCTION_READ: "instruction:read",
			INSTRUCTION_CREATE: "instruction:create",
		},
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
		proposal: false,
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
		m.assertInstructionDeriveAccess,
		m.admit,
		m.startAdmittedProposalPullRequest,
	]) {
		f.mockReset();
	}
	m.admit.mockResolvedValue({ destination: "FABRIC", note: null });
	m.startAdmittedProposalPullRequest.mockResolvedValue(undefined);
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
	it("declares INSTRUCTION_READ as its baseline guarding permission", () => {
		expect(m.requestedPermission).toBe("instruction:read");
	});

	it("throws FORBIDDEN and writes nothing when the permission middleware denies", async () => {
		m.permissionMiddleware.mockRejectedValueOnce(
			new ORPCError("FORBIDDEN", {
				message: "Missing required permission: instruction:read",
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
		expect(call).toMatchObject({ proposal: false, publishOnReady: true });
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
			proposalStatus: null,
			staged: [{ fileId: "f_new", path: "CLAUDE.md" }],
			pullRequest: null,
		});
	});

	it("lets a reader submit a proposal and forces manual publication", async () => {
		const result = await m.handlers.derive!({
			input: { ...deriveInput(editOneFile), proposal: true },
			context: ctx,
		});

		expect(m.assertInstructionDeriveAccess).toHaveBeenCalledWith({
			projectId: "p",
			userId: "u",
			proposal: true,
		});
		expect(m.createDerivedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				proposal: true,
				publishOnReady: false,
			}),
		);
		expect(result).toMatchObject({ proposalStatus: "PENDING" });
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
		it("asks admission in direct mode and passes its refusal through with data.reason", async () => {
			// Plan R16: the tab's derive used to refuse without `data.reason`,
			// unlike the inline entry point; one admission gives both the code.
			m.admit.mockRejectedValue(
				new ORPCError("PRECONDITION_FAILED", {
					message:
						"This project's coding instructions come from its repository. Change the files there and sync the project.",
					data: { reason: "REPOSITORY_SOURCE_OF_TRUTH" },
				}),
			);

			const error = await m.handlers.derive!({
				input: deriveInput(editOneFile),
				context: ctx,
			}).catch((e: ORPCError<string, unknown>) => e);

			expect(error).toMatchObject({
				code: "PRECONDITION_FAILED",
				data: { reason: "REPOSITORY_SOURCE_OF_TRUTH" },
			});
			expect((error as Error).message).toContain("repository");
			expect(m.admit).toHaveBeenCalledWith(
				expect.objectContaining({ mode: "direct" }),
			);
			expect(m.createDerivedInstructionSnapshot).not.toHaveBeenCalled();
		});

		it("allows an upload-backed project", async () => {
			await m.handlers.derive!({
				input: deriveInput(editOneFile),
				context: ctx,
			});
			expect(m.createDerivedInstructionSnapshot).toHaveBeenCalled();
		});
	});

	describe("repository proposals (Fizzy #2563)", () => {
		const NOTE = { title: "Tighten the review skill", body: "Why: flaky" };
		const CONTEXT = {
			v: 1,
			syncId: "sync_1",
			syncGeneration: 4,
			branch: "fabric/instructions/op_1",
		};

		function repositoryAdmission(overrides: Record<string, unknown> = {}) {
			return {
				destination: "REPOSITORY",
				note: NOTE,
				operationId: "op_1",
				context: CONTEXT,
				syncId: "sync_1",
				syncGeneration: 4,
				...overrides,
			};
		}

		function proposeInput() {
			return {
				...deriveInput([
					...editOneFile,
					{ op: "delete", path: "AGENTS.md" },
				]),
				proposal: true,
				note: NOTE,
			};
		}

		const proposer = {
			...ctx,
			user: { id: "u", email: "", name: "Pat Example" },
		};

		it("asks admission with the proposal mode, the raw note, the proposer's name and the change count", async () => {
			await m.handlers.derive!({
				input: proposeInput(),
				context: proposer,
			});

			expect(m.admit).toHaveBeenCalledWith({
				projectId: "p",
				organizationId: "org_1",
				userId: "u",
				mode: "proposal",
				note: NOTE,
				proposerName: "Pat Example",
				fileCount: 2,
			});
		});

		it("creates the row with the frozen destination and writes upload_started only inside the create", async () => {
			m.admit.mockResolvedValue(repositoryAdmission());
			m.createDerivedInstructionSnapshot.mockResolvedValue({
				ok: true,
				id: "snap_new",
				version: 8,
				fileCount: 12,
				inheritedCount: 11,
				staged: [{ id: "f_new", path: "CLAUDE.md" }],
				auditWritten: true,
			});

			const result = await m.handlers.derive!({
				input: proposeInput(),
				context: proposer,
			});

			const call = m.createDerivedInstructionSnapshot.mock.calls[0]![0];
			expect(call).toMatchObject({
				proposal: true,
				publishOnReady: false,
				note: NOTE,
				destination: {
					kind: "REPOSITORY",
					operationId: "op_1",
					context: CONTEXT,
					syncId: "sync_1",
					syncGeneration: 4,
					branch: "fabric/instructions/op_1",
					uploadStartedAudit: {
						actor: { type: "user", userId: "u" },
						organizationId: "org_1",
						projectId: "p",
						ipAddress: "203.0.113.7",
						requestId: "req_1",
						metadata: {
							mode: "proposal",
							baseSnapshotId: "base",
							baseVersion: 7,
							putCount: 1,
							deleteCount: 1,
						},
					},
				},
			});
			expect(call.destination).not.toHaveProperty("blocked");
			// One upload_started, the one the create transaction writes.
			expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				snapshotId: "snap_new",
				proposalStatus: "PENDING",
				pullRequest: {
					operationId: "op_1",
					state: "QUEUED",
					url: null,
					externalId: null,
					failure: null,
					lastCheckedAt: null,
				},
			});
		});

		it("starts the operation's workflow after the row commits", async () => {
			m.admit.mockResolvedValue(repositoryAdmission());

			await m.handlers.derive!({
				input: proposeInput(),
				context: proposer,
			});

			expect(m.startAdmittedProposalPullRequest).toHaveBeenCalledTimes(1);
			expect(m.startAdmittedProposalPullRequest).toHaveBeenCalledWith({
				snapshotId: "snap_new",
				projectId: "p",
				organizationId: "org_1",
				operationId: "op_1",
			});
			expect(
				m.createDerivedInstructionSnapshot.mock.invocationCallOrder[0],
			).toBeLessThan(
				m.startAdmittedProposalPullRequest.mock.invocationCallOrder[0]!,
			);
		});

		it("admits an attribution-refused row BLOCKED and starts no workflow", async () => {
			const blocked = {
				phase: "admission",
				code: "ATTRIBUTION_REJECTED",
				retryable: false,
				at: "2026-09-24T12:00:00.000Z",
				params: {},
			};
			m.admit.mockResolvedValue(repositoryAdmission({ blocked }));

			const result = await m.handlers.derive!({
				input: proposeInput(),
				context: proposer,
			});

			expect(
				m.createDerivedInstructionSnapshot.mock.calls[0]![0],
			).toMatchObject({ destination: { blocked } });
			expect(m.startAdmittedProposalPullRequest).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				pullRequest: { state: "BLOCKED", failure: blocked },
			});
		});

		it("starts nothing for a duplicate", async () => {
			m.admit.mockResolvedValue(repositoryAdmission());
			m.createDerivedInstructionSnapshot.mockResolvedValue({
				ok: false,
				reason: "duplicate_proposal",
				existing: { id: "snap_existing", version: 8 },
			});

			await expect(
				m.handlers.derive!({
					input: proposeInput(),
					context: proposer,
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(m.startAdmittedProposalPullRequest).not.toHaveBeenCalled();
			expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		});

		it("a FABRIC proposal keeps its note and its post-commit audit, and has no pull request", async () => {
			m.admit.mockResolvedValue({ destination: "FABRIC", note: NOTE });

			const result = await m.handlers.derive!({
				input: proposeInput(),
				context: proposer,
			});

			const call = m.createDerivedInstructionSnapshot.mock.calls[0]![0];
			expect(call).toMatchObject({ note: NOTE });
			expect(call).not.toHaveProperty("destination");
			expect(m.recordAuditFromRequest).toHaveBeenCalledTimes(1);
			expect(m.startAdmittedProposalPullRequest).not.toHaveBeenCalled();
			expect(result).toMatchObject({ pullRequest: null });
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

		it("refuses an always-excluded path even when the base's frozen settings are unreadable (Fizzy #2704)", async () => {
			// An older row can hold any shape in `settingsFrozen`. That drops
			// the base's own rules, never the always layer: nothing after this
			// point re-checks it, and the CLI refuses a bundle naming
			// `.fabric/…` outright.
			m.getInstructionSnapshot.mockResolvedValue({
				id: "base",
				version: 7,
				status: "READY",
				settingsFrozen: { legacy: true },
			});
			await expect(
				m.handlers.derive!({
					input: deriveInput([
						{
							op: "put",
							path: ".fabric/instructions.lock",
							size: 1,
							sha256: "a".repeat(64),
						},
					]),
					context: ctx,
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining(".fabric/**"),
			});
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

		it("returns a clear conflict when the proposer's active cap is full", async () => {
			m.createDerivedInstructionSnapshot.mockResolvedValue({
				ok: false,
				reason: "proposal_proposer_limit",
			});
			await expect(
				m.handlers.derive!({
					input: { ...deriveInput(editOneFile), proposal: true },
					context: ctx,
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				data: { reason: "PROPOSAL_PROPOSER_LIMIT" },
			});
		});

		/**
		 * The tab REFUSES an identical pending proposal rather than
		 * resuming it (Fizzy #2605). Its flow is three round trips and the
		 * browser owns the middle one, so handing this request the other
		 * snapshot's staged file ids would have a second tab uploading into
		 * a snapshot it did not create. The proposal the proposer already
		 * has is in their own list, where it can be reviewed or cancelled.
		 */
		it("refuses an identical pending proposal and names the one that exists", async () => {
			m.createDerivedInstructionSnapshot.mockResolvedValue({
				ok: false,
				reason: "duplicate_proposal",
				existing: {
					id: "snap_existing",
					version: 8,
					status: "VALIDATING",
					proposalStatus: "PENDING",
					fileCount: 12,
					inheritedCount: 11,
					staged: [{ id: "f_old", path: "CLAUDE.md" }],
				},
			});

			await expect(
				m.handlers.derive!({
					input: { ...deriveInput(editOneFile), proposal: true },
					context: ctx,
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining("version 8"),
				data: {
					reason: "PROPOSAL_DUPLICATE",
					snapshotId: "snap_existing",
					version: 8,
				},
			});
			// Nothing was started, so nothing may be recorded as started.
			expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
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
