/**
 * Tests for `removeAllInstructionsProcedure`: remove every coding-instructions
 * version of a project and start over.
 *
 * The builder stub is the one `delete-snapshot.test.ts` uses: `.use()` records
 * each middleware and `.handler()` runs them ahead of the real handler, so a
 * permission middleware that rejects short-circuits the call as the oRPC
 * runtime would. Visibility-before-permission on the REAL chain is pinned in
 * `core-visibility.test.ts`.
 *
 * What this pins:
 *  - INSTRUCTION_DELETE is the permission, and a denial removes nothing;
 *  - the organization acted in is the project's hosting one, never the
 *    caller-supplied `organizationId`, and a personal project is refused;
 *  - only the keys each snapshot OWNS are deleted (an edit's inherited row
 *    naming its base's key is left to the base's own sweep), after the
 *    removal, snapshot by snapshot, with each snapshot's prefixes swept;
 *  - every refusal is a CONFLICT naming its reason, and touches no storage;
 *  - nothing to remove answers zero and sweeps nothing;
 *  - a storage sweep that fails does not fail a removal that happened.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	listProjectInstructionStorageKeys: vi.fn(),
	removeAllProjectInstructions: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	getMemberProposalBranch: vi.fn(),
	deleteObjects: vi.fn(),
	listObjects: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	markCuratedAuditWritten: vi.fn(),
	loggerWarn: vi.fn(),
	permissionMiddleware: vi.fn(),
	requestedPermission: undefined as string | undefined,
	calls: [] as string[],
}));

vi.mock("../../../../../orpc/middleware/project-visibility", () => ({
	PROJECT_NOT_FOUND_MESSAGE: "Project not found",
	projectNotFoundUnlessVisible: async () => undefined,
}));
vi.mock("@repo/database", () => ({
	listProjectInstructionStorageKeys: (...a: unknown[]) =>
		m.listProjectInstructionStorageKeys(...a),
	removeAllProjectInstructions: (...a: unknown[]) => {
		m.calls.push("remove");
		return m.removeAllProjectInstructions(...a);
	},
	getProjectInstructionSettings: (...a: unknown[]) =>
		m.getProjectInstructionSettings(...a),
	getMemberProposalBranch: (...a: unknown[]) =>
		m.getMemberProposalBranch(...a),
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		deleteObjects: (...a: unknown[]) => {
			m.calls.push("deleteObjects");
			return m.deleteObjects(...a);
		},
		listObjects: (...a: unknown[]) => m.listObjects(...a),
	}),
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: (...a: unknown[]) => m.loggerWarn(...a) },
}));
vi.mock("../../../../../lib/audit", () => ({
	auditRequestFields: () => ({
		impersonatedById: null,
		ipAddress: "203.0.113.7",
		userAgent: "vitest",
		requestId: "req_1",
		sessionId: "sess_1",
		correlationId: "corr_1",
	}),
	resolveActor: (context: { user: { id: string } }) => ({
		type: "user",
		userId: context.user.id,
	}),
}));
vi.mock("../../../../../orpc/middleware/audit-timing-middleware", () => ({
	markCuratedAuditWritten: () => m.markCuratedAuditWritten(),
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
			m.handlers.removeAll = composed;
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
			INSTRUCTION_CREATE: "instruction:create",
			INSTRUCTION_DELETE: "instruction:delete",
		},
	};
});

import "../remove-all";

const ctx = { user: { id: "u" }, session: { activeOrganizationId: "org_1" } };
const input = { projectId: "p" };
const ownKey = (snapshotId: string, file: string) =>
	`projects/p/instructions/snapshots/${snapshotId}/${file}`;

function run(overrides: Record<string, unknown> = {}) {
	return m.handlers.removeAll!({
		input: { ...input, ...overrides },
		context: ctx,
	});
}

beforeEach(() => {
	for (const f of [
		m.listProjectInstructionStorageKeys,
		m.removeAllProjectInstructions,
		m.getProjectInstructionSettings,
		m.getMemberProposalBranch,
		m.deleteObjects,
		m.listObjects,
		m.resolveEffectiveProjectPermissions,
		m.markCuratedAuditWritten,
		m.loggerWarn,
		m.permissionMiddleware,
	]) {
		f.mockReset();
	}
	m.calls.length = 0;
	m.permissionMiddleware.mockResolvedValue(undefined);
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: [],
		source: "project",
		organizationId: "org_1",
	});
	m.listProjectInstructionStorageKeys.mockResolvedValue([]);
	m.listObjects.mockResolvedValue({ objects: [] });
	m.deleteObjects.mockResolvedValue({ deleted: 1, errors: [] });
});

describe("projects.instructions.removeAll", () => {
	it("declares INSTRUCTION_DELETE, the project admin's permission", () => {
		expect(m.requestedPermission).toBe("instruction:delete");
	});

	it("removes nothing when the permission middleware denies", async () => {
		m.permissionMiddleware.mockRejectedValueOnce(
			new ORPCError("FORBIDDEN", {
				message: "Missing required permission: instruction:delete",
			}),
		);

		await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.removeAllProjectInstructions).not.toHaveBeenCalled();
		expect(m.deleteObjects).not.toHaveBeenCalled();
	});

	it("refuses a personal project and removes nothing", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "project",
			organizationId: null,
		});

		await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.removeAllProjectInstructions).not.toHaveBeenCalled();
	});

	it("removes every version in the hosting organization, then deletes only each snapshot's own objects", async () => {
		m.listProjectInstructionStorageKeys.mockResolvedValue([
			{ snapshotId: "s1", storageKey: ownKey("s1", "a") },
			{ snapshotId: "s2", storageKey: ownKey("s2", "b") },
			// s2 is an edit of s1 whose inherited row still names s1's key:
			// s1's own sweep removes it, s2's must not.
			{ snapshotId: "s2", storageKey: ownKey("s1", "a") },
		]);
		m.removeAllProjectInstructions.mockResolvedValue({
			status: "removed",
			snapshotIds: ["s1", "s2"],
			publishedVersion: 3,
		});

		const result = await run({ organizationId: "org_attacker" });

		expect(result).toEqual({
			removed: 2,
			publishedVersion: 3,
			storageCleanupPending: false,
		});
		expect(m.removeAllProjectInstructions).toHaveBeenCalledWith({
			projectId: "p",
			organizationId: "org_1",
			audit: {
				actor: { type: "user", userId: "u" },
				ipAddress: "203.0.113.7",
				userAgent: "vitest",
				requestId: "req_1",
				sessionId: "sess_1",
				correlationId: "corr_1",
			},
		});
		expect(m.listProjectInstructionStorageKeys).toHaveBeenCalledWith(
			"p",
			"org_1",
		);
		expect(m.deleteObjects.mock.calls).toEqual([
			[[ownKey("s1", "a")], { bucket: "skills" }],
			[[ownKey("s2", "b")], { bucket: "skills" }],
		]);
		// Rows first, storage after: the removal is decided before any byte goes.
		expect(m.calls[0]).toBe("remove");
		// Each snapshot's three owned prefixes are swept, which also takes the
		// export zips and staged objects no row names.
		const swept = m.listObjects.mock.calls.map(
			(call) => (call[0] as { prefix: string }).prefix,
		);
		expect(swept).toEqual([
			"projects/p/instructions/staging/s1/",
			"projects/p/instructions/snapshots/s1/",
			"projects/p/instructions/exports/s1-",
			"projects/p/instructions/staging/s2/",
			"projects/p/instructions/snapshots/s2/",
			"projects/p/instructions/exports/s2-",
		]);
		expect(m.markCuratedAuditWritten).toHaveBeenCalledTimes(1);
	});

	it("answers zero and sweeps nothing when there is nothing to remove", async () => {
		m.removeAllProjectInstructions.mockResolvedValue({
			status: "removed",
			snapshotIds: [],
			publishedVersion: null,
		});

		await expect(run()).resolves.toEqual({
			removed: 0,
			publishedVersion: null,
			storageCleanupPending: false,
		});
		expect(m.deleteObjects).not.toHaveBeenCalled();
		expect(m.listObjects).not.toHaveBeenCalled();
		expect(m.markCuratedAuditWritten).not.toHaveBeenCalled();
	});

	it.each([
		["repository_mode", "REPOSITORY_MODE", /Switch back to upload mode/],
		["active", "SNAPSHOT_ACTIVE", /still being received or checked/],
		[
			"pull_request_unresolved",
			"PULL_REQUEST_UNRESOLVED",
			/pull request is still open/,
		],
		["proposal_pending", "PROPOSAL_PENDING", /waiting for review/],
	] as const)(
		"answers a %s refusal as CONFLICT %s and touches no storage",
		async (reason, code, message) => {
			m.listProjectInstructionStorageKeys.mockResolvedValue([
				{ snapshotId: "s1", storageKey: ownKey("s1", "a") },
			]);
			m.removeAllProjectInstructions.mockResolvedValue({
				status: "refused",
				reason,
			});

			const error = await run().catch((e: unknown) => e);

			expect(error).toBeInstanceOf(ORPCError);
			expect(error).toMatchObject({
				code: "CONFLICT",
				data: { reason: code },
				message: expect.stringMatching(message),
			});
			expect(m.deleteObjects).not.toHaveBeenCalled();
			expect(m.listObjects).not.toHaveBeenCalled();
		},
	);

	it("answers an open move into a repository as MIGRATION_OPEN", async () => {
		m.removeAllProjectInstructions.mockResolvedValue({
			status: "refused",
			reason: "migration_open",
		});
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "UPLOAD",
			migration: {
				state: "PROPOSING",
				snapshotId: "s1",
				branchId: null,
				syncId: "sync_1",
				pullRequestUrl: null,
				startedAt: "2026-11-01T00:00:00.000Z",
				userId: "u",
			},
		});

		await expect(run()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "MIGRATION_OPEN", state: "PROPOSING" },
		});
		expect(m.deleteObjects).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND when the project row is gone", async () => {
		m.removeAllProjectInstructions.mockResolvedValue({
			status: "refused",
			reason: "not_found",
		});

		await expect(run()).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("reports a failed storage sweep as pending cleanup instead of failing a removal that happened", async () => {
		m.listProjectInstructionStorageKeys.mockResolvedValue([
			{ snapshotId: "s1", storageKey: ownKey("s1", "a") },
			{ snapshotId: "s2", storageKey: ownKey("s2", "b") },
		]);
		m.removeAllProjectInstructions.mockResolvedValue({
			status: "removed",
			snapshotIds: ["s1", "s2"],
			publishedVersion: null,
		});
		m.deleteObjects
			.mockResolvedValueOnce({
				deleted: 0,
				errors: [{ key: ownKey("s1", "a"), message: "denied" }],
			})
			.mockResolvedValue({ deleted: 1, errors: [] });

		await expect(run()).resolves.toEqual({
			removed: 2,
			publishedVersion: null,
			storageCleanupPending: true,
		});
		// The next snapshot is still swept.
		expect(m.deleteObjects).toHaveBeenCalledWith([ownKey("s2", "b")], {
			bucket: "skills",
		});
		expect(m.loggerWarn).toHaveBeenCalledTimes(1);
	});
});
