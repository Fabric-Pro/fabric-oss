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
 *
 * There are two paths, mounted on the two session-creation hooks. The
 * create-time one returns a patch for the row about to be written, which is
 * what puts the organization in the signed session cookie as well as the row;
 * the after-hook one updates the row it is handed, which is what covers an
 * account whose membership is created later in the same request. Their return
 * values are a contract with the library — documented on
 * `seedSessionOrganizationOnCreate` — and are pinned exactly here. WHERE each
 * is mounted is locked by `seed-session-organization-wiring.test.ts`.
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

import {
	seedSessionOrganization,
	seedSessionOrganizationOnCreate,
} from "../seed-session-organization";

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

	// AE16 / R17. The create-time hook runs before the membership exists for a
	// brand-new signup, so this path is that account's only seed and must keep
	// working exactly as it does today.
	it("still writes the row for a membership created later in the same request", async () => {
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
});

describe("seedSessionOrganizationOnCreate", () => {
	// AE1. The row that is about to be written carries the organization, which
	// is what puts it in the signed session cookie too.
	it("hands row creation the caller's organization", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId: ORG,
		});

		await expect(
			seedSessionOrganizationOnCreate({ userId: USER }),
		).resolves.toEqual({ data: { activeOrganizationId: ORG } });
	});

	// The `{ data }` wrapper is not decoration. `createWithHooks` merges only a
	// return with a `data` key; handed the session object itself it merges
	// nothing, and the fix ships as a no-op that a source-reading wiring test
	// still passes.
	it("returns the wrapper the library merges, not the session", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId: ORG,
		});

		const result = await seedSessionOrganizationOnCreate({ userId: USER });

		expect(result).toHaveProperty("data");
		expect(result).not.toHaveProperty("activeOrganizationId");
	});

	// It reads a membership and returns a patch. It must not write the row —
	// there is no row yet.
	it("writes nothing itself", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId: ORG,
		});

		await seedSessionOrganizationOnCreate({ userId: USER });

		expect(mocks.sessionUpdate).not.toHaveBeenCalled();
	});

	it("leaves a session that already names one alone", async () => {
		await expect(
			seedSessionOrganizationOnCreate({
				userId: USER,
				activeOrganizationId: "org_chosen_deliberately",
			}),
		).resolves.toBeUndefined();

		expect(mocks.resolveUserOrganization).not.toHaveBeenCalled();
	});

	// AE2 / R11. `false` aborts the session creation outright, and `null` is
	// dereferenced by the library's `"data" in result` merge check — either one
	// turns a refusal to guess into a failed sign-in. Asserted by identity, not
	// by falsiness, because every wrong answer here is also falsy.
	it.each([
		["ambiguous", { kind: "ambiguous", organizationIds: [ORG, "org_2"] }],
		["no_membership", { kind: "no_membership" }],
	])(
		"returns undefined — never false, never null — when resolution is %s",
		async (_label, resolution) => {
			mocks.resolveUserOrganization.mockResolvedValue(resolution);

			const result = await seedSessionOrganizationOnCreate({
				userId: USER,
			});

			expect(result).toBeUndefined();
			expect(result).not.toBe(false);
			expect(result).not.toBeNull();
		},
	);

	// AE3 / R11. The create-time path runs inside the session-creation path, so
	// a throw here costs the sign-in rather than a background log line.
	it("returns undefined — never false, never null — when resolution throws", async () => {
		mocks.resolveUserOrganization.mockRejectedValue(new Error("db down"));

		const result = await seedSessionOrganizationOnCreate({ userId: USER });

		expect(result).toBeUndefined();
		expect(result).not.toBe(false);
		expect(result).not.toBeNull();
		expect(mocks.loggerError).toHaveBeenCalled();
	});

	// AE4 / AE5. An impersonation session is seeded from the impersonated
	// person's own userId, and gets nothing when that does not resolve — the
	// impersonation still starts, because this path cannot refuse a creation.
	it("resolves from the userId it is given, whoever that session belongs to", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId: ORG,
		});

		await expect(
			seedSessionOrganizationOnCreate({ userId: "user_impersonated" }),
		).resolves.toEqual({ data: { activeOrganizationId: ORG } });
		expect(mocks.resolveUserOrganization).toHaveBeenCalledWith(
			"user_impersonated",
		);
	});
});
