/**
 * Contract tests for the session's default organization.
 *
 * The rule is small and the failure it prevents is not. `activeOrganizationId`
 * was written only by an explicit organization switch, so most sessions carried
 * none — read off a running deployment, not inferred. Everything that falls
 * back to that field therefore fell back to nothing, and with personal context
 * gone, "nothing" means nowhere: `requireInputOrgPermission` takes its
 * pass-through branch and the role is never examined.
 *
 * Two properties matter as much as the seeding itself, and both are pinned
 * here: it never overwrites a session that already names one, and it refuses to
 * guess when the choice is ambiguous.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveUserOrganization: vi.fn(),
	sessionUpdate: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	resolveUserOrganization: (...args: unknown[]) =>
		mocks.resolveUserOrganization(...args),
	db: {
		session: {
			update: (...args: unknown[]) => mocks.sessionUpdate(...args),
		},
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { error: (...args: unknown[]) => mocks.loggerError(...args) },
}));

import { seedSessionOrganization } from "../seed-session-organization";

const SESSION = "session_1";
const USER = "user_1";
const ORG = "org_1";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.sessionUpdate.mockResolvedValue({});
});

describe("seedSessionOrganization", () => {
	it("gives a fresh session the caller's organization", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId: ORG,
		});

		await expect(
			seedSessionOrganization({ id: SESSION, userId: USER }),
		).resolves.toBe(ORG);

		expect(mocks.sessionUpdate).toHaveBeenCalledWith({
			where: { id: SESSION },
			data: { activeOrganizationId: ORG },
		});
	});

	it("leaves a session that already names one alone", async () => {
		await expect(
			seedSessionOrganization({
				id: SESSION,
				userId: USER,
				activeOrganizationId: "org_chosen_deliberately",
			}),
		).resolves.toBeNull();

		expect(mocks.resolveUserOrganization).not.toHaveBeenCalled();
		expect(mocks.sessionUpdate).not.toHaveBeenCalled();
	});

	// The fail-closed half. Placing a multi-organization caller in whichever
	// sorts first would look like a convenience and would silently pick the
	// tenant every omitted-organization request then runs in.
	it("refuses to guess when the caller belongs to several", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "ambiguous",
			organizationIds: [ORG, "org_2"],
		});

		await expect(
			seedSessionOrganization({ id: SESSION, userId: USER }),
		).resolves.toBeNull();
		expect(mocks.sessionUpdate).not.toHaveBeenCalled();
	});

	it("does nothing for a caller who belongs nowhere yet", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "no_membership",
		});

		await expect(
			seedSessionOrganization({ id: SESSION, userId: USER }),
		).resolves.toBeNull();
		expect(mocks.sessionUpdate).not.toHaveBeenCalled();
	});

	// A sign-in must not fail over a default.
	it("swallows a failure rather than blocking the sign-in", async () => {
		mocks.resolveUserOrganization.mockRejectedValue(new Error("db down"));

		await expect(
			seedSessionOrganization({ id: SESSION, userId: USER }),
		).resolves.toBeNull();
		expect(mocks.loggerError).toHaveBeenCalled();
	});
});
