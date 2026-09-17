/**
 * Tests for `deleteSnapshotProcedure`.
 *
 * The `.use()`/`.handler()` builder stub every sibling test in this folder
 * uses (`use: () => b`) discards whatever `requireProjectPermission(...)`
 * returns, so a denial from that middleware is invisible to a handler
 * invoked directly — every other file here can only prove the ORGANIZATION
 * guard inside the handler body, never the PERMISSION guard outside it.
 * Case (permission denies) below closes that gap for this destructive
 * procedure: the stub `.use()` records each middleware it receives and the
 * stub `.handler()` composes them ahead of the real handler, so a mocked
 * `requireProjectPermission`-produced middleware that rejects actually
 * short-circuits the call the same way the real oRPC runtime would.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	getInstructionSnapshot: vi.fn(),
	getPublishedInstructionSnapshot: vi.fn(),
	countInFlightDerivedSnapshots: vi.fn(),
	listInstructionFiles: vi.fn(),
	deleteInstructionSnapshot: vi.fn(),
	deleteObjects: vi.fn(),
	listObjects: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	permissionMiddleware: vi.fn(),
	requestedPermission: undefined as string | undefined,
}));

vi.mock("@repo/database", () => ({
	countInFlightDerivedSnapshots: (...a: unknown[]) =>
		m.countInFlightDerivedSnapshots(...a),
	getInstructionSnapshot: (...a: unknown[]) => m.getInstructionSnapshot(...a),
	getPublishedInstructionSnapshot: (...a: unknown[]) =>
		m.getPublishedInstructionSnapshot(...a),
	listInstructionFiles: (...a: unknown[]) => m.listInstructionFiles(...a),
	deleteInstructionSnapshot: (...a: unknown[]) =>
		m.deleteInstructionSnapshot(...a),
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		deleteObjects: (...a: unknown[]) => m.deleteObjects(...a),
		listObjects: (...a: unknown[]) => m.listObjects(...a),
	}),
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => m.recordAuditFromRequest(...a),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../../orpc/procedures", () => {
	// Middlewares registered via `.use()`, run in order ahead of the
	// captured `.handler()` function — a minimal stand-in for the real
	// oRPC composition, scoped to this test file only.
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
			m.handlers.delete = composed;
			return composed;
		},
	};
	return {
		tenantProtectedProcedure: b,
		requireProjectPermission: (permission: string) => {
			m.requestedPermission = permission;
			return (args: unknown) => m.permissionMiddleware(args);
		},
		Permissions: { INSTRUCTION_DELETE: "instruction:delete" },
	};
});

import "../delete-snapshot";

const ctx = { user: { id: "u" }, session: { activeOrganizationId: "org_1" } };
const baseInput = { projectId: "p", snapshotId: "s" };
/**
 * The snapshot's OWN promoted prefix. Fixtures use real keys because the
 * handler now filters the delete set through `isKeyOwnedBySnapshot`: a
 * derived snapshot's inherited rows carry the BASE's keys until promotion
 * rewrites them, and deleting a rejected edit by row key would take the base's
 * bytes — in the ordinary case the project's published instructions.
 */
const OWN_PREFIX = "projects/p/instructions/snapshots/s/";

beforeEach(() => {
	for (const f of [
		m.getInstructionSnapshot,
		m.getPublishedInstructionSnapshot,
		m.countInFlightDerivedSnapshots,
		m.listInstructionFiles,
		m.deleteInstructionSnapshot,
		m.deleteObjects,
		m.listObjects,
		m.recordAuditFromRequest,
		m.resolveEffectiveProjectPermissions,
		m.permissionMiddleware,
	]) {
		f.mockReset();
	}
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: [],
		source: "org",
		organizationId: "org_1",
	});
	m.listObjects.mockResolvedValue({ objects: [] });
	m.deleteInstructionSnapshot.mockResolvedValue({ deleted: true });
	// Default: nothing is deriving from the snapshot under test.
	m.countInFlightDerivedSnapshots.mockResolvedValue(0);
	// Default: the permission gate allows. Individual tests override this
	// to simulate a denial.
	m.permissionMiddleware.mockResolvedValue(undefined);
});

describe("projects.instructions.delete", () => {
	it("declares INSTRUCTION_DELETE as its guarding permission", () => {
		expect(m.requestedPermission).toBe("instruction:delete");
	});

	it("throws FORBIDDEN and deletes nothing when the permission middleware denies", async () => {
		m.permissionMiddleware.mockRejectedValueOnce(
			new ORPCError("FORBIDDEN", {
				message: "Missing required permission: instruction:delete",
			}),
		);
		await expect(
			m.handlers.delete!({ input: baseInput, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.getInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.listInstructionFiles).not.toHaveBeenCalled();
		expect(m.deleteObjects).not.toHaveBeenCalled();
		expect(m.deleteInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND and deletes nothing when the scoped snapshot lookup returns null", async () => {
		m.getInstructionSnapshot.mockResolvedValue(null);
		await expect(
			m.handlers.delete!({ input: baseInput, context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.getPublishedInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.listInstructionFiles).not.toHaveBeenCalled();
		expect(m.deleteObjects).not.toHaveBeenCalled();
		expect(m.deleteInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("throws CONFLICT and deletes nothing when the snapshot is the project's published one", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 3,
			status: "READY",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({ id: "s" });
		await expect(
			m.handlers.delete!({ input: baseInput, context: ctx }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.listInstructionFiles).not.toHaveBeenCalled();
		expect(m.deleteObjects).not.toHaveBeenCalled();
		expect(m.deleteInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	/**
	 * Important 3 (round 4). The handler verified existence and publication
	 * but never the snapshot's own status, so an authorized caller invoking
	 * the procedure directly could delete a VALIDATING row while an activity
	 * was processing it: the next activity's `loadVerifiedSnapshot` then
	 * raised a non-retryable tenant-mismatch failure for a self-inflicted
	 * delete, and a promotion already in flight could write immutable objects
	 * after this handler had collected the keys it meant to remove. The tab
	 * hid the button for those statuses, but the UI is not a boundary.
	 */
	it.each(["RECEIVING", "VALIDATING"])(
		"throws CONFLICT for a %s snapshot and touches neither rows nor storage",
		async (status) => {
			m.getInstructionSnapshot.mockResolvedValue({
				id: "s",
				version: 4,
				status,
			});

			await expect(
				m.handlers.delete!({ input: baseInput, context: ctx }),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(m.deleteInstructionSnapshot).not.toHaveBeenCalled();
			expect(m.deleteObjects).not.toHaveBeenCalled();
			expect(m.listObjects).not.toHaveBeenCalled();
			expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		},
	);

	// The read above is a read-then-delete check a fresh "Try again" can win,
	// which is why the DELETE carries the predicate too. When IT is the one
	// that refuses, the same CONFLICT comes back and no object is touched.
	it("throws CONFLICT when the delete itself reports the snapshot became active", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 4,
			status: "FAILED",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({ id: "other" });
		m.listInstructionFiles.mockResolvedValue([
			{ storageKey: `${OWN_PREFIX}f1` },
		]);
		m.deleteInstructionSnapshot.mockResolvedValue({
			deleted: false,
			reason: "active",
		});

		await expect(
			m.handlers.delete!({ input: baseInput, context: ctx }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(m.deleteObjects).not.toHaveBeenCalled();
		expect(m.listObjects).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("deletes the rows first, then the storage objects, and audits with ids/counts only", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 2,
			status: "READY",
		});
		// A different snapshot is published — this one is free to delete.
		m.getPublishedInstructionSnapshot.mockResolvedValue({ id: "other" });
		m.listInstructionFiles.mockResolvedValue([
			{ storageKey: `${OWN_PREFIX}f1` },
			{ storageKey: `${OWN_PREFIX}f2` },
		]);
		m.deleteObjects.mockResolvedValue({ deleted: 2, errors: [] });

		const result = await m.handlers.delete!({
			input: baseInput,
			context: ctx,
		});
		expect(result).toEqual({ deleted: true });

		expect(m.deleteObjects).toHaveBeenCalledWith(
			[`${OWN_PREFIX}f1`, `${OWN_PREFIX}f2`],
			{ bucket: "skills" },
		);
		expect(m.deleteInstructionSnapshot).toHaveBeenCalledWith(
			"s",
			"p",
			"org_1",
		);
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions.deleted",
				organizationId: "org_1",
				projectId: "p",
				resource: {
					type: "project_instruction_snapshot",
					id: "s",
					name: "v2",
				},
				metadata: { fileCount: 2 },
			}),
		);

		// I3: the ROWS go first. The old order deleted the objects and only
		// then the row, so a publish that won the race against the
		// read-then-delete check above left the project pointing at a
		// snapshot whose bytes were already gone. Reading the file rows for
		// their keys still has to happen before the delete, because the rows
		// are the only record of where the objects live.
		const keysReadOrder =
			m.listInstructionFiles.mock.invocationCallOrder[0]!;
		const rowOrder =
			m.deleteInstructionSnapshot.mock.invocationCallOrder[0]!;
		const storageOrder = m.deleteObjects.mock.invocationCallOrder[0]!;
		expect(keysReadOrder).toBeLessThan(rowOrder);
		expect(rowOrder).toBeLessThan(storageOrder);
	});

	// I1: `deleteObjects` never throws and reports per-key failures in
	// `errors` (packages/storage/types.ts). Discarding that result told the
	// caller the version was gone while its bytes were still in the bucket —
	// for someone who deleted it precisely because of what it held.
	it("throws INTERNAL_SERVER_ERROR when a stored object could not be deleted, naming no key", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 2,
			status: "READY",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({ id: "other" });
		m.listInstructionFiles.mockResolvedValue([
			{ storageKey: `${OWN_PREFIX}f1` },
		]);
		m.deleteObjects.mockResolvedValue({
			deleted: 0,
			errors: [{ key: "k1", message: "AccessDenied" }],
		});

		const error = await m.handlers.delete!({
			input: baseInput,
			context: ctx,
		}).then(
			() => null,
			(e: { code: string; message: string }) => e,
		);

		expect(error?.code).toBe("INTERNAL_SERVER_ERROR");
		expect(error?.message).toContain("1 stored object(s)");
		expect(error?.message).not.toContain(`${OWN_PREFIX}f1`);
	});

	// I3: the pre-check above is a read-then-delete guard, and a publish
	// committing between it and the delete slips past it. The foreign key is
	// `onDelete: Restrict`, so the row delete raises P2003 and reports
	// `reason: "published"` — the same CONFLICT, but from the database, and
	// with nothing deleted. The old `SetNull` FK instead cleared the pointer
	// and left the project with no published instructions at all.
	it("refuses via the foreign key when a publish wins the race against the pre-check", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 2,
			status: "READY",
		});
		// The pre-check sees a DIFFERENT snapshot published; the publish
		// lands before the delete runs.
		m.getPublishedInstructionSnapshot.mockResolvedValue({ id: "other" });
		m.listInstructionFiles.mockResolvedValue([
			{ storageKey: `${OWN_PREFIX}f1` },
		]);
		m.deleteInstructionSnapshot.mockResolvedValue({
			deleted: false,
			reason: "published",
		});

		await expect(
			m.handlers.delete!({ input: baseInput, context: ctx }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		// Nothing was removed: not the objects, not the export zips, and no
		// audit row claiming a deletion that did not happen.
		expect(m.deleteObjects).not.toHaveBeenCalled();
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	// R32/I4: the file rows only know their own keys, so nothing recorded
	// which export zips had been built from this snapshot. Deleting a version
	// because it held something you did not want stored left a full copy of
	// its contents in the bucket, for every Download and every MCP bundle
	// call ever made against it.
	it("also deletes the export zips built from the snapshot, found by prefix", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "s",
			version: 2,
			status: "READY",
		});
		m.getPublishedInstructionSnapshot.mockResolvedValue({ id: "other" });
		m.listInstructionFiles.mockResolvedValue([
			{ storageKey: `${OWN_PREFIX}f1` },
		]);
		m.deleteObjects.mockResolvedValue({ deleted: 1, errors: [] });
		// Two pages, and a stale wall-clock-stamped object from before the
		// key became deterministic — the prefix finds both shapes.
		m.listObjects
			.mockResolvedValueOnce({
				objects: [
					{ key: "projects/p/instructions/exports/s-digest.zip" },
				],
				nextContinuationToken: "page2",
			})
			.mockResolvedValueOnce({
				objects: [
					{
						key: "projects/p/instructions/exports/s-1757000000000.zip",
					},
				],
			});

		await m.handlers.delete!({ input: baseInput, context: ctx });

		expect(m.listObjects).toHaveBeenCalledWith({
			bucket: "skills",
			prefix: "projects/p/instructions/exports/s-",
			continuationToken: undefined,
		});
		expect(m.deleteObjects).toHaveBeenCalledWith(
			["projects/p/instructions/exports/s-digest.zip"],
			{ bucket: "skills" },
		);
		expect(m.deleteObjects).toHaveBeenCalledWith(
			["projects/p/instructions/exports/s-1757000000000.zip"],
			{ bucket: "skills" },
		);
	});
	/**
	 * Fizzy #2546. A derived snapshot's inherited rows point at the BASE's
	 * promoted objects until its own promotion rewrites them. Deleting a
	 * rejected or failed EDIT must therefore never delete a key by row alone:
	 * the base is normally the project's published version, and the object
	 * store has no undo.
	 */
	describe("the base-key guard", () => {
		it("deletes only keys under this snapshot's own prefixes", async () => {
			m.getInstructionSnapshot.mockResolvedValue({
				id: "s",
				version: 9,
				status: "REJECTED",
			});
			m.getPublishedInstructionSnapshot.mockResolvedValue({
				id: "base",
			});
			m.listInstructionFiles.mockResolvedValue([
				// This snapshot's own staged upload.
				{ storageKey: "projects/p/instructions/staging/s/f1" },
				// An inherited row: the BASE's immutable promoted object.
				{ storageKey: "projects/p/instructions/snapshots/base/bf1" },
				// And one from another project entirely, which no code path
				// should ever produce and none may act on.
				{ storageKey: "projects/other/instructions/snapshots/x/y" },
			]);
			m.deleteObjects.mockResolvedValue({ deleted: 1, errors: [] });
			m.listObjects.mockResolvedValue({ objects: [] });

			await m.handlers.delete!({ input: baseInput, context: ctx });

			expect(m.deleteObjects).toHaveBeenCalledWith(
				["projects/p/instructions/staging/s/f1"],
				{ bucket: "skills" },
			);
			for (const call of m.deleteObjects.mock.calls) {
				expect(call[0]).not.toContain(
					"projects/p/instructions/snapshots/base/bf1",
				);
			}
		});

		it("refuses to delete a version an in-flight edit is deriving from", async () => {
			m.getInstructionSnapshot.mockResolvedValue({
				id: "s",
				version: 4,
				status: "READY",
			});
			m.countInFlightDerivedSnapshots.mockResolvedValue(1);

			await expect(
				m.handlers.delete!({ input: baseInput, context: ctx }),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(m.countInFlightDerivedSnapshots).toHaveBeenCalledWith(
				"s",
				"p",
				"org_1",
			);
			expect(m.deleteInstructionSnapshot).not.toHaveBeenCalled();
			expect(m.deleteObjects).not.toHaveBeenCalled();
		});

		it("reports the same conflict when a derivation starts after the check", async () => {
			m.getInstructionSnapshot.mockResolvedValue({
				id: "s",
				version: 4,
				status: "READY",
			});
			m.getPublishedInstructionSnapshot.mockResolvedValue({
				id: "other",
			});
			m.listInstructionFiles.mockResolvedValue([
				{ storageKey: `${OWN_PREFIX}f1` },
			]);
			// The read said zero; the DELETE's own predicate disagreed.
			m.deleteInstructionSnapshot.mockResolvedValue({
				deleted: false,
				reason: "base_in_flight",
			});

			await expect(
				m.handlers.delete!({ input: baseInput, context: ctx }),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(m.deleteObjects).not.toHaveBeenCalled();
			expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
		});
	});
});
