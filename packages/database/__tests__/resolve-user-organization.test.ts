/**
 * Contract tests for the shared organization resolver. The Prisma client is
 * mocked; these pin the resolution rule itself — which cases resolve, which
 * fail closed, and that the two absences stay distinguishable by the caller.
 *
 * The fail-closed cases are the point of the suite. A future change that makes
 * an ambiguous caller resolve to "the first membership" would look like a
 * tidy-up and would silently hand every API key a tenant its holder never
 * named; these tests are what stops that landing quietly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	userFindUnique: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: { user: { findUnique: mocks.userFindUnique } },
}));

import {
	resolveUserOrganization,
	type UserOrganizationResolution,
} from "../prisma/queries/resolve-user-organization";

const USER_ID = "user_test_1";
const ORG_A = "org_test_a";
const ORG_B = "org_test_b";
const ORG_C = "org_test_c";

/** Shapes the single row read the resolver issues. */
function givenUser(row: {
	lastActiveOrganizationId: string | null;
	organizationIds: string[];
}) {
	mocks.userFindUnique.mockResolvedValue({
		lastActiveOrganizationId: row.lastActiveOrganizationId,
		members: row.organizationIds.map((organizationId) => ({
			organizationId,
		})),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("resolveUserOrganization", () => {
	it("resolves a single membership to that organization", async () => {
		givenUser({ lastActiveOrganizationId: null, organizationIds: [ORG_A] });

		await expect(resolveUserOrganization(USER_ID)).resolves.toEqual({
			kind: "resolved",
			organizationId: ORG_A,
		});
	});

	it("resolves several memberships to a valid last-active organization", async () => {
		givenUser({
			lastActiveOrganizationId: ORG_B,
			organizationIds: [ORG_A, ORG_B, ORG_C],
		});

		await expect(resolveUserOrganization(USER_ID)).resolves.toEqual({
			kind: "resolved",
			organizationId: ORG_B,
		});
	});

	it("returns the ambiguous absence when last-active is a membership the user has lost", async () => {
		givenUser({
			lastActiveOrganizationId: ORG_C,
			organizationIds: [ORG_A, ORG_B],
		});

		await expect(resolveUserOrganization(USER_ID)).resolves.toEqual({
			kind: "ambiguous",
			organizationIds: [ORG_A, ORG_B],
		});
	});

	it("returns the ambiguous absence when several memberships have no last-active set", async () => {
		givenUser({
			lastActiveOrganizationId: null,
			organizationIds: [ORG_A, ORG_B],
		});

		await expect(resolveUserOrganization(USER_ID)).resolves.toEqual({
			kind: "ambiguous",
			organizationIds: [ORG_A, ORG_B],
		});
	});

	it("never picks a tie-break winner for an ambiguous caller", async () => {
		givenUser({
			lastActiveOrganizationId: null,
			organizationIds: [ORG_A, ORG_B, ORG_C],
		});

		const result = await resolveUserOrganization(USER_ID);

		expect(result.kind).not.toBe("resolved");
		expect(result).not.toHaveProperty("organizationId");
	});

	it("returns the no-membership absence rather than throwing or inventing one", async () => {
		givenUser({ lastActiveOrganizationId: null, organizationIds: [] });

		await expect(resolveUserOrganization(USER_ID)).resolves.toEqual({
			kind: "no_membership",
		});
	});

	it("treats a last-active pointer with no memberships as no-membership, not ambiguous", async () => {
		// A stale pointer left behind by a membership that was revoked.
		givenUser({ lastActiveOrganizationId: ORG_A, organizationIds: [] });

		await expect(resolveUserOrganization(USER_ID)).resolves.toEqual({
			kind: "no_membership",
		});
	});

	it("reports no-membership for a user row that does not exist", async () => {
		mocks.userFindUnique.mockResolvedValue(null);

		await expect(resolveUserOrganization(USER_ID)).resolves.toEqual({
			kind: "no_membership",
		});
	});

	it("short-circuits an empty user id without querying", async () => {
		await expect(resolveUserOrganization("")).resolves.toEqual({
			kind: "no_membership",
		});
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
	});

	it("reads the memberships and the last-active pointer in one query", async () => {
		givenUser({
			lastActiveOrganizationId: ORG_A,
			organizationIds: [ORG_A],
		});

		await resolveUserOrganization(USER_ID);

		expect(mocks.userFindUnique).toHaveBeenCalledTimes(1);
		expect(mocks.userFindUnique).toHaveBeenCalledWith({
			where: { id: USER_ID },
			select: {
				lastActiveOrganizationId: true,
				members: {
					select: { organizationId: true },
					orderBy: { organizationId: "asc" },
				},
			},
		});
	});
});

describe("the two absences are distinguishable by a caller", () => {
	/**
	 * The behaviour R2c actually asks for: a caller branching on the result
	 * has to be able to tell "nowhere to go" from "has not said where",
	 * because only the second is answerable by naming an organization. This
	 * models that caller rather than asserting on a log line.
	 */
	function callerAdvice(result: UserOrganizationResolution): string {
		switch (result.kind) {
			case "resolved":
				return `run in ${result.organizationId}`;
			case "ambiguous":
				return `name one of: ${result.organizationIds.join(", ")}`;
			case "no_membership":
				return "join or create an organization first";
		}
	}

	it("gives a caller different advice for each absence", async () => {
		givenUser({
			lastActiveOrganizationId: null,
			organizationIds: [ORG_A, ORG_B],
		});
		const ambiguous = await resolveUserOrganization(USER_ID);

		givenUser({ lastActiveOrganizationId: null, organizationIds: [] });
		const noMembership = await resolveUserOrganization(USER_ID);

		expect(ambiguous.kind).toBe("ambiguous");
		expect(noMembership.kind).toBe("no_membership");
		expect(ambiguous.kind).not.toBe(noMembership.kind);

		expect(callerAdvice(ambiguous)).toBe(`name one of: ${ORG_A}, ${ORG_B}`);
		expect(callerAdvice(noMembership)).toBe(
			"join or create an organization first",
		);
	});

	it("hands the ambiguous caller the organizations it may name", async () => {
		givenUser({
			lastActiveOrganizationId: null,
			organizationIds: [ORG_A, ORG_B],
		});

		const result = await resolveUserOrganization(USER_ID);

		// Narrowing on `kind` is what a real caller does; if the union ever
		// collapses to a nullable string this stops compiling.
		if (result.kind !== "ambiguous") {
			throw new Error(
				`expected an ambiguous absence, got ${result.kind}`,
			);
		}
		expect(result.organizationIds).toEqual([ORG_A, ORG_B]);
	});
});
