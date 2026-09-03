import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a departure has to do, and what a failure is allowed to do about it.
 *
 * The load-bearing claim is that the two paths fail in OPPOSITE directions, and
 * that this is a consequence of when they run rather than a preference.
 *
 * A removal revokes access in `beforeRemoveMember`, before better-auth deletes
 * the member row. A failure there can still refuse, so it must: the state to
 * avoid is somebody out of the organization on paper whose `ProjectMember` rows
 * keep authorizing them, because organization membership is the last rung of
 * the permission ladder rather than a precondition. Leaving the member row in
 * place instead is the recoverable direction.
 *
 * A leave revokes after the row is already gone — `/organization/leave` has no
 * before-hook, and a global one would run ahead of better-auth's own
 * preconditions. There is nothing left to refuse, so it contains and logs.
 */

vi.mock("@repo/database", () => ({
	revokeOrganizationMemberAccess: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("../organization", () => ({
	updateSeatsInOrganizationSubscription: vi.fn(),
}));

import { revokeOrganizationMemberAccess } from "@repo/database";
import { logger } from "@repo/logs";
import type { Mock } from "vitest";
import {
	revokeDepartingMemberAccess,
	syncSeatsAfterDeparture,
} from "../member-offboarding";
import { updateSeatsInOrganizationSubscription } from "../organization";

const revoke = revokeOrganizationMemberAccess as unknown as Mock;
const seats = updateSeatsInOrganizationSubscription as unknown as Mock;

const REMOVED = {
	organizationId: "org-1",
	userId: "user-1",
	trigger: "removed" as const,
};
const LEFT = { ...REMOVED, trigger: "left" as const };

beforeEach(() => {
	vi.clearAllMocks();
	revoke.mockResolvedValue({
		projectMemberships: 3,
		workspaceMemberships: 2,
		sessionsCleared: 1,
	});
	seats.mockResolvedValue(undefined);
});

describe("revokeDepartingMemberAccess", () => {
	it.each([REMOVED, LEFT])(
		"revokes the same access whichever way out it was ($trigger)",
		async (input) => {
			// Both ways out mean the same thing for access. The asymmetry that
			// prompted this module was that only one of them did anything.
			await revokeDepartingMemberAccess(input);

			expect(revoke).toHaveBeenCalledWith({
				organizationId: "org-1",
				userId: "user-1",
			});
		},
	);

	it("REFUSES a removal it could not back with a revocation", async () => {
		// The whole reason this call sits in `beforeRemoveMember`. Throwing
		// leaves the member row in place; an admin retrying is a much better
		// outcome than a departed member who is still authorized.
		revoke.mockRejectedValue(new Error("database down"));

		await expect(revokeDepartingMemberAccess(REMOVED)).rejects.toThrow(
			/revoke the member's project access/i,
		);
		expect(logger.error).toHaveBeenCalledWith(
			"[Auth] Failed to revoke organization access on offboarding",
			expect.objectContaining({ trigger: "removed" }),
		);
	});

	it("does NOT refuse a leave it could not back — there is nothing to refuse", async () => {
		// The member row is already deleted by the time this runs, so throwing
		// would answer a completed departure with a 500 and invite a retry of
		// something that already happened. The residual is real and logged.
		revoke.mockRejectedValue(new Error("database down"));

		await expect(
			revokeDepartingMemberAccess(LEFT),
		).resolves.toBeUndefined();
		expect(logger.error).toHaveBeenCalledWith(
			"[Auth] Failed to revoke organization access on offboarding",
			expect.objectContaining({ trigger: "left" }),
		);
	});

	it("logs what was actually revoked", async () => {
		// The counts are the only evidence an operator has that offboarding did
		// anything; "revoked access" with no numbers is also true of a no-op.
		await revokeDepartingMemberAccess(REMOVED);

		expect(logger.info).toHaveBeenCalledWith(
			"[Auth] Revoked organization access on offboarding",
			expect.objectContaining({
				organizationId: "org-1",
				userId: "user-1",
				trigger: "removed",
				projectMemberships: 3,
				workspaceMemberships: 2,
				sessionsCleared: 1,
			}),
		);
	});

	it.each([
		["organizationId", { organizationId: "" }],
		["userId", { userId: "" }],
	])(
		"refuses a removal with an empty %s rather than widening the scope",
		async (_label, override) => {
			// An empty organization id would widen the revocation to "every project
			// whose organizationId is the empty string" instead of narrowing it,
			// and better-auth reaches its own handler with an empty id by falling
			// back to the session's active organization — so the value handed here
			// need not be the one it acted on.
			await expect(
				revokeDepartingMemberAccess({ ...REMOVED, ...override }),
			).rejects.toThrow(/revoke the member's project access/i);

			expect(revoke).not.toHaveBeenCalled();
		},
	);

	it("swallows an empty id on the leave path, still without querying", async () => {
		await expect(
			revokeDepartingMemberAccess({ ...LEFT, organizationId: "" }),
		).resolves.toBeUndefined();

		expect(revoke).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledWith(
			"[Auth] Offboarding called without both ids",
			expect.objectContaining({ trigger: "left" }),
		);
	});

	it("does not touch billing", async () => {
		// Seats are a separate call on purpose: they have to be counted AFTER
		// the member row is gone, and this one runs before it on the removal
		// path.
		await revokeDepartingMemberAccess(REMOVED);

		expect(seats).not.toHaveBeenCalled();
	});
});

describe("syncSeatsAfterDeparture", () => {
	it("updates the seat count for the organization", async () => {
		await syncSeatsAfterDeparture("org-1");

		expect(seats).toHaveBeenCalledWith("org-1");
	});

	it("never throws when the billing provider is unreachable", async () => {
		// A departure that completed must not be reported as an error because
		// a subscription could not be re-counted; the next membership change
		// re-derives it from scratch.
		seats.mockRejectedValue(new Error("billing down"));

		await expect(syncSeatsAfterDeparture("org-1")).resolves.toBeUndefined();
		expect(logger.error).toHaveBeenCalledWith(
			"[Auth] Failed to update seats on offboarding",
			expect.objectContaining({ organizationId: "org-1" }),
		);
	});

	it("does not revoke anything of its own", async () => {
		// The split is what keeps the seat count honest: seats have to be
		// counted after the member row is gone, and the revocation has to
		// happen before it. Folding them back into one function would force
		// one of the two to run at the wrong moment. Which hook each is wired
		// to is pinned in `member-offboarding-wiring.test.ts` — a unit test
		// cannot see that, because it calls them itself.
		await syncSeatsAfterDeparture("org-1");

		expect(revoke).not.toHaveBeenCalled();
	});
});
