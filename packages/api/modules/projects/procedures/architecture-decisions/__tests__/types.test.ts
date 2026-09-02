/**
 * Tests for the decision-type taxonomy mutations (`archive` / `restore`).
 *
 * The DB helpers are boundary-mocked; what this file pins is the part that
 * lives in the procedure and nowhere else: the permission it gates on, the
 * membership re-check, the NOT_FOUND branch when the id is not this project's,
 * and the activity emitted.
 *
 * The permission assertion matters most. Retiring a type removes an option
 * every future decision would have seen, so it must gate on the decision DELETE
 * permission — not the READ permission viewers and commenters inherit. A
 * refactor that quietly swapped it would otherwise let any viewer reshape the
 * taxonomy.
 */

import { ORPCError } from "@orpc/client";
import {
	PROJECT_ROLE_PERMISSIONS,
	Permissions as RealPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks, captured } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		hasProjectAccess: vi.fn(),
		listDecisionTypes: vi.fn(),
		archiveDecisionType: vi.fn(),
		restoreDecisionType: vi.fn(),
		emitActivity: vi.fn(),
	};
	const captured: { permissions: unknown[] } = { permissions: [] };
	return { handlers, mocks, captured };
});

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		hasProjectAccess: mocks.hasProjectAccess,
		listDecisionTypes: mocks.listDecisionTypes,
		archiveDecisionType: mocks.archiveDecisionType,
		restoreDecisionType: mocks.restoreDecisionType,
	};
});

vi.mock("../../../../../lib/realtime", () => ({
	emitActivity: (...a: unknown[]) => mocks.emitActivity(...a),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["list", "archive", "restore"];
	let cursor = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const key = importedHandlerKeys[cursor++] ?? `proc-${cursor}`;
			handlers[key] = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: {
			ARCHITECTURE_DECISION_READ: "architecture_decision:read",
			ARCHITECTURE_DECISION_DELETE: "architecture_decision:delete",
		},
		requireProjectPermission: (permission: unknown) => {
			captured.permissions.push(permission);
			return (c: unknown) => c;
		},
		requireInputOrgPermission: (permission: unknown) => {
			captured.permissions.push(permission);
			return (c: unknown) => c;
		},
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

await import("../types");

const context = {
	user: { id: "user-1", email: "owner@example.com", name: "Owner" },
	session: { id: "sess-1" },
};

const input = { projectId: "p-1", id: "type-1", organizationId: "org-1" };

const typeRow = {
	id: "type-1",
	name: "Reliability",
	origin: "AI" as const,
	archivedAt: new Date("2026-09-01T00:00:00.000Z"),
	createdAt: new Date("2026-08-01T00:00:00.000Z"),
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.emitActivity.mockResolvedValue(undefined);
});

describe("decision-type mutations — permission gate", () => {
	it("gates on the decision DELETE permission, which viewers do not hold", () => {
		const perm = RealPermissions.ARCHITECTURE_DECISION_DELETE;
		expect(captured.permissions).toContain("architecture_decision:delete");
		expect(PROJECT_ROLE_PERMISSIONS.VIEWER).not.toContain(perm);
		expect(PROJECT_ROLE_PERMISSIONS.COMMENTER).not.toContain(perm);
		expect(PROJECT_ROLE_PERMISSIONS.OWNER).toContain(perm);
	});
});

describe("archiveDecisionType procedure", () => {
	it("refuses a caller without access to the project", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		await expect(
			handlers.archive({ input, context }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.archiveDecisionType).not.toHaveBeenCalled();
	});

	// The query scopes its update by projectId, so a type belonging to another
	// project comes back null — that must surface as NOT_FOUND, never as a
	// silent success that implies something was archived.
	it("answers NOT_FOUND when the id is not this project's", async () => {
		mocks.archiveDecisionType.mockResolvedValue(null);
		await expect(
			handlers.archive({ input, context }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.emitActivity).not.toHaveBeenCalled();
	});

	it("archives scoped by project and records the activity", async () => {
		mocks.archiveDecisionType.mockResolvedValue(typeRow);
		const out = (await handlers.archive({ input, context })) as {
			type: typeof typeRow;
		};
		expect(mocks.archiveDecisionType).toHaveBeenCalledWith({
			id: "type-1",
			projectId: "p-1",
		});
		expect(out.type.name).toBe("Reliability");
		expect(mocks.emitActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				activityType: "decision_type_archived",
				resourceId: "type-1",
				resourceName: "Reliability",
			}),
		);
	});
});

describe("restoreDecisionType procedure", () => {
	it("refuses a caller without access to the project", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		await expect(
			handlers.restore({ input, context }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.restoreDecisionType).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND when there is no archived row to restore", async () => {
		mocks.restoreDecisionType.mockResolvedValue(null);
		await expect(
			handlers.restore({ input, context }),
		).rejects.toBeInstanceOf(ORPCError);
	});

	it("restores scoped by project and records the activity", async () => {
		mocks.restoreDecisionType.mockResolvedValue({
			...typeRow,
			archivedAt: null,
		});
		await handlers.restore({ input, context });
		expect(mocks.restoreDecisionType).toHaveBeenCalledWith({
			id: "type-1",
			projectId: "p-1",
		});
		expect(mocks.emitActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				activityType: "decision_type_restored",
			}),
		);
	});
});
