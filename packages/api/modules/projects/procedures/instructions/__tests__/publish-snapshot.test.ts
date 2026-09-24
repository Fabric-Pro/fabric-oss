import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	publishInstructionSnapshot: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	runInBackground: vi.fn(),
	warmInstructionSnapshotExport: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	publishInstructionSnapshot: (...a: unknown[]) =>
		m.publishInstructionSnapshot(...a),
}));
// The archive pre-build is scheduled, not awaited. Mocking the wrapper is how
// "a continuation was scheduled" is asserted at all — `run-in-background.ts`
// exists as a local module for exactly that (its own docblock says so).
vi.mock("../../../../../modules/weave/lib/run-in-background", () => ({
	runInBackground: (...a: unknown[]) => m.runInBackground(...a),
}));
vi.mock("@repo/instructions/export", () => ({
	warmInstructionSnapshotExport: (...a: unknown[]) =>
		m.warmInstructionSnapshotExport(...a),
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => m.recordAuditFromRequest(...a),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const b = {
		use: () => b,
		route: () => b,
		input: () => b,
		handler: (fn: (...a: unknown[]) => unknown) => {
			m.handlers.publish = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: b,
		requireProjectPermission: () => ({}),
		Permissions: { INSTRUCTION_UPDATE: "instruction:update" },
	};
});
import "../publish-snapshot";
const ctx = { user: { id: "u" }, session: { activeOrganizationId: "org_1" } };
beforeEach(() => {
	m.publishInstructionSnapshot.mockReset();
	m.recordAuditFromRequest.mockReset();
	m.runInBackground.mockReset();
	m.warmInstructionSnapshotExport.mockReset();
	m.warmInstructionSnapshotExport.mockResolvedValue(undefined);
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: [],
		source: "org",
		organizationId: "org_1",
	});
});

describe("projects.instructions.publish", () => {
	// Spec §4: while a repository is the source of truth, History may not
	// publish an uploaded version — the same refusal an edit gets.
	it("maps a repository_backed refusal to PRECONDITION_FAILED and audits nothing", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: false,
			changed: false,
			reason: "repository_backed",
		});
		await expect(
			m.handlers.publish!({
				input: { projectId: "p", snapshotId: "s" },
				context: ctx,
			}),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message: expect.stringContaining("come from its repository"),
		});
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(m.runInBackground).not.toHaveBeenCalled();
	});

	it("publishes and audits the call that moved the pointer", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: true,
			changed: true,
			version: 9,
			previousVersion: 8,
		});
		await expect(
			m.handlers.publish!({
				input: { projectId: "p", snapshotId: "s" },
				context: ctx,
			}),
		).resolves.toEqual({ published: true });
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions.published",
				metadata: { version: 9, previousVersion: 8, rollback: false },
			}),
		);
	});

	/**
	 * The whole point of the flag. History's button exists so someone can
	 * choose an earlier version deliberately; the version rule refused it with
	 * "A newer version is already published", which is a race guard written
	 * for the AUTOMATIC publish-on-ready answering a request nobody automated.
	 */
	it("asks the query for a rollback and records one on the audit row", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: true,
			changed: true,
			version: 7,
			previousVersion: 9,
		});
		await expect(
			m.handlers.publish!({
				input: { projectId: "p", snapshotId: "s" },
				context: ctx,
			}),
		).resolves.toEqual({ published: true });
		expect(m.publishInstructionSnapshot).toHaveBeenCalledWith({
			snapshotId: "s",
			projectId: "p",
			organizationId: "org_1",
			allowRollback: true,
		});
		// Both ends of the move and the direction, so the row reads as a
		// rollback rather than as a publication whose order has to be
		// reconstructed from the rows around it. Version numbers only — a path
		// or a file's content would be user data.
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions.published",
				metadata: { version: 7, previousVersion: 9, rollback: true },
			}),
		);
	});

	it("never passes requireBaseUnmoved, which the query refuses to combine with allowRollback", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: true,
			changed: true,
			version: 2,
			previousVersion: null,
		});
		await m.handlers.publish!({
			input: { projectId: "p", snapshotId: "s" },
			context: ctx,
		});
		expect(
			m.publishInstructionSnapshot.mock.calls[0]?.[0],
		).not.toHaveProperty("requireBaseUnmoved");
		// Nothing published before, so there is no direction to roll back in.
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				metadata: {
					version: 2,
					previousVersion: null,
					rollback: false,
				},
			}),
		);
	});

	// M1: the query reports `published: true` for the idempotent case too, so
	// auditing on `published` recorded a second publication for one pointer
	// transition — which is exactly what a lost response plus a client retry
	// produces. The Temporal activity already gated on `changed`.
	it("records no audit for a repeat publish of the snapshot that is already the pointer", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: true,
			changed: false,
		});

		await expect(
			m.handlers.publish!({
				input: { projectId: "p", snapshotId: "s" },
				context: ctx,
			}),
		).resolves.toEqual({ published: true });
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});
	// The arm is kept fail-closed, but its old message cannot be true here any
	// more: under `allowRollback` the only pointer the write excludes is this
	// snapshot itself, which resolves as the idempotent case above. A refusal
	// that still reaches here means the project row stopped matching the
	// organization, and telling someone a newer version won would be a
	// fabrication.
	it("maps a refusal the rollback predicate cannot explain to CONFLICT, without claiming a newer version", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: false,
			reason: "older_than_current",
		});
		await expect(
			m.handlers.publish!({
				input: { projectId: "p", snapshotId: "s" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const error = await m.handlers.publish!({
			input: { projectId: "p", snapshotId: "s" },
			context: ctx,
		}).catch((e: Error) => e);
		expect((error as Error).message).not.toMatch(/newer version/i);
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});
	it("maps a missing snapshot to NOT_FOUND and does not audit", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: false,
			reason: "not_found",
		});
		await expect(
			m.handlers.publish!({
				input: { projectId: "p", snapshotId: "s" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});
	it("throws FORBIDDEN and never calls publishInstructionSnapshot when the organization cannot be resolved", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "owner",
			organizationId: null,
		});
		await expect(
			m.handlers.publish!({
				input: { projectId: "p", snapshotId: "s" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.publishInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});
});

/**
 * The download archive is keyed on the snapshot's digest and reused once
 * written, so before this the entire build fell on whoever downloaded a new
 * version first — inside a request the CLI gives a short budget, which on a
 * large tree meant `fabric instructions sync` timed out and its retries
 * started further concurrent builds of the same archive.
 */
describe("pre-building the export archive on publish", () => {
	it("schedules the warm for the snapshot that just became the pointer", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: true,
			changed: true,
			version: 9,
			previousVersion: 8,
		});

		await m.handlers.publish!({
			input: { projectId: "p", snapshotId: "s" },
			context: ctx,
		});

		expect(m.warmInstructionSnapshotExport).toHaveBeenCalledWith({
			projectId: "p",
			// The PROJECT's hosting organization, resolved server-side — never
			// a caller-supplied value or the session's active organization.
			organizationId: "org_1",
			snapshotId: "s",
		});
		// Scheduled through the wrapper, not `void`-ed: on Vercel a bare
		// floating promise is not guaranteed to finish once the response
		// returns.
		expect(m.runInBackground).toHaveBeenCalledTimes(1);
	});

	// The idempotent case is warmed too, and it is cheap: the builder's reuse
	// check finds the object and does a single metadata read.
	it("schedules the warm for the idempotent republish as well", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: true,
			changed: false,
		});

		await m.handlers.publish!({
			input: { projectId: "p", snapshotId: "s" },
			context: ctx,
		});

		expect(m.runInBackground).toHaveBeenCalledTimes(1);
	});

	it("schedules nothing when the publish was refused", async () => {
		m.publishInstructionSnapshot.mockResolvedValue({
			published: false,
			reason: "not_ready",
		});

		await expect(
			m.handlers.publish!({
				input: { projectId: "p", snapshotId: "s" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		// Nothing took the pointer, so there is no new version to pre-build —
		// and a refusal must not spend the object store's time.
		expect(m.warmInstructionSnapshotExport).not.toHaveBeenCalled();
		expect(m.runInBackground).not.toHaveBeenCalled();
	});
});
