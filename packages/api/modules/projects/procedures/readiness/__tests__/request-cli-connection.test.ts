/**
 * Asking teammates to connect a coding CLI (Fizzy #2457).
 *
 * The handler resolves an audience, and every test here is about the audience
 * being the server's answer rather than the caller's:
 *
 *  - explicit ids reach exactly the people named, and nobody else;
 *  - a function tag reaches its holders ON THIS PROJECT — the roster is the
 *    only source, so a tag-holder who has left cannot be reached by naming
 *    their tag;
 *  - an id off the roster fails the WHOLE call, rather than being dropped into
 *    a smaller success the caller cannot see;
 *  - the asker is never in the audience;
 *  - a roster member who cannot mint an API key is dropped before the write,
 *    because the ask is to create one;
 *  - the numbers returned are what the fan-out actually did — written, skipped
 *    and FAILED kept apart, because a caller told "already asked" about a write
 *    that broke has been told something false;
 *  - and, before any of that, only a member of the project's ORGANIZATION may
 *    originate one: a project guest clears `PROJECT_READ` and must not be able
 *    to push their own display name into org members' inboxes and email.
 *
 * The permission matrix is REAL — `@repo/permissions` is not mocked — so the
 * eligibility filter is tested against the same role definitions production
 * uses rather than against a restatement of them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockIsFeatureEnabled,
	mockGather,
	mockResolveAccess,
	mockHasProjectAccess,
	mockIsOrganizationMember,
	mockGetProjectMemberFunctionTags,
	mockUsersWhoCanCreateKeys,
	mockFanOut,
} = vi.hoisted(() => ({
	mockIsFeatureEnabled: vi.fn(),
	mockGather: vi.fn(),
	mockResolveAccess: vi.fn(),
	mockHasProjectAccess: vi.fn(),
	mockIsOrganizationMember: vi.fn(),
	mockGetProjectMemberFunctionTags: vi.fn(),
	mockUsersWhoCanCreateKeys: vi.fn(),
	mockFanOut: vi.fn(),
}));

// Spread the real module rather than replacing it: importing the procedure
// pulls in the whole oRPC stack, which reaches other `@repo/database` exports
// through `@repo/payments`. It also keeps `membersHoldingTags` and
// `FUNCTION_TAG_VALUES` real — the tag expansion under test is theirs.
//
// The two org-role questions are mocked at the `@repo/database` boundary
// rather than at `db`, because that is where the handler now asks them: the
// named helpers own the query, and their own contract test lives beside them in
// `packages/database`. What is NOT mocked away here is the matrix — the
// eligibility stub below resolves the fixture's roles through the real
// `resolveOrgPermissions`/`hasPermission`, so a matrix change still moves these
// answers.
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
	isOrganizationMember: (...args: unknown[]) =>
		mockIsOrganizationMember(...args),
	getProjectMemberFunctionTags: (...args: unknown[]) =>
		mockGetProjectMemberFunctionTags(...args),
	usersWhoCanCreateOrganizationApiKeys: (...args: unknown[]) =>
		mockUsersWhoCanCreateKeys(...args),
}));

vi.mock("../../../lib/readiness/evidence", () => ({
	gatherReadinessEvidence: (...args: unknown[]) => mockGather(...args),
}));

// The resolver behind `requireProjectPermission`. Mocked so the declared gate
// can be exercised for real without a database.
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...args: unknown[]) =>
		mockResolveAccess(...args),
}));

vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: {
		cliConnectionRequested: (...args: unknown[]) => mockFanOut(...args),
	},
}));

import { hasPermission, resolveOrgPermissions } from "@repo/permissions";
import { Permissions } from "../../../../../orpc/procedures";
import { requestCliConnectionProcedure } from "../request-cli-connection";

const ORG = "org-1";
const PROJECT = "project-a";
const ASKER = "user-asker";

/**
 * The project roster, exactly as `getProjectMemberFunctionTags` returns it:
 * one row per current member, with the tags they hold on THIS project.
 */
const ROSTER = [
	{ userId: ASKER, tags: ["PRODUCT_OWNER"] },
	{ userId: "dev-1", tags: ["DEVELOPER"] },
	{ userId: "dev-2", tags: ["DEVELOPER", "ARCHITECT"] },
	{ userId: "designer-1", tags: ["DESIGNER"] },
	{ userId: "guest-1", tags: ["DEVELOPER"] },
	{ userId: "stale-role-1", tags: ["DEVELOPER"] },
	{ userId: "untagged-1", tags: [] },
];

/**
 * Organization membership for the project's host organization.
 *
 * Two roster members are ineligible for reasons no edit to the permission
 * matrix can change, which is deliberately how they were chosen:
 *
 *  - `guest-1` has NO row here at all — a project guest reaching the project
 *    through a `ProjectMember` row without membership of its host
 *    organization. An absent role resolves to the empty permission set.
 *  - `stale-role-1` carries a role string the matrix does not recognise, which
 *    also resolves to empty. Fail closed, not fail open.
 *
 * No fixture pins a NAMED role to an expected answer. Which ranks carry
 * `ORG_API_KEYS_CREATE` has already moved once (Fizzy #2380) and is moving
 * again beside this work, and a test that restated the matrix would have
 * quietly kept the old answer — the same trap the handler avoids by asking the
 * matrix instead of listing ranks.
 */
const ORG_ROLES: Record<string, string> = {
	[ASKER]: "member",
	"dev-1": "member",
	"dev-2": "admin",
	"designer-1": "member",
	"stale-role-1": "auditor",
	"untagged-1": "owner",
};

function ask(input: Record<string, unknown>, userId = ASKER): Promise<unknown> {
	const handler = (
		requestCliConnectionProcedure as unknown as {
			"~orpc": { handler: (opts: unknown) => Promise<unknown> };
		}
	)["~orpc"].handler;
	return handler({
		input: {
			projectId: PROJECT,
			userIds: [],
			functionTags: [],
			...input,
		},
		context: { user: { id: userId, name: "Ada" }, session: {} },
	});
}

/** The recipient list the fan-out was actually handed, sorted for comparison. */
function notifiedIds(): string[] {
	const args = mockFanOut.mock.calls[0]?.[0] as
		| { recipientUserIds: string[] }
		| undefined;
	return [...(args?.recipientUserIds ?? [])].sort();
}

beforeEach(() => {
	vi.clearAllMocks();

	mockIsFeatureEnabled.mockResolvedValue(true);
	mockGather.mockImplementation(async (projectId: string) =>
		projectId === PROJECT
			? {
					evidence: {},
					tenant: { userId: "owner-1", organizationId: ORG },
					project: { name: "Atlas", status: "ACTIVE" },
					cliNudgeEnabled: true,
				}
			: null,
	);
	mockHasProjectAccess.mockResolvedValue(true);
	// Membership of the project's organization: a fixture with a role row has
	// it, `guest-1` has none. The helper itself is contract-tested in
	// `packages/database`; here it is the originator bar.
	mockIsOrganizationMember.mockImplementation(
		async (userId: string, organizationId: string) =>
			organizationId === ORG && ORG_ROLES[userId] !== undefined,
	);
	mockGetProjectMemberFunctionTags.mockResolvedValue(ROSTER);
	// The real matrix, asked of the fixture's roles — the named helper's own
	// body, minus the query. A rank that stopped carrying
	// `ORG_API_KEYS_CREATE` would move these answers, which is the property the
	// fixtures were chosen to preserve.
	mockUsersWhoCanCreateKeys.mockImplementation(
		async (organizationId: string, userIds: string[]) =>
			new Set(
				organizationId === ORG
					? userIds.filter((userId) =>
							hasPermission(
								resolveOrgPermissions(ORG_ROLES[userId]),
								Permissions.ORG_API_KEYS_CREATE,
							),
						)
					: [],
			),
	);
	mockResolveAccess.mockResolvedValue({
		permissions: [Permissions.PROJECT_READ],
		source: "org",
		organizationId: ORG,
	});
	// One row per recipient handed over, unless a test says otherwise.
	mockFanOut.mockImplementation(
		async ({ recipientUserIds }: { recipientUserIds: string[] }) => ({
			notified: recipientUserIds.length,
			skipped: 0,
			failed: 0,
		}),
	);
});

describe("projects.readiness.requestCliConnection", () => {
	it("notifies exactly the teammates named, and nobody else", async () => {
		const result = await ask({ userIds: ["dev-1", "designer-1"] });

		expect(notifiedIds()).toEqual(["designer-1", "dev-1"]);
		expect(result).toEqual({
			notifiedCount: 2,
			recipientCount: 2,
			ineligibleCount: 0,
			failedCount: 0,
		});
		expect(mockFanOut.mock.calls[0][0]).toMatchObject({
			projectId: PROJECT,
			projectName: "Atlas",
			organizationId: ORG,
			actorUserId: ASKER,
			actorName: "Ada",
			link: `projects/${PROJECT}`,
		});
	});

	it("refuses a project guest, who may READ the project but is outside its organization", async () => {
		// The exploit this bar exists for. `guest-1` is on the roster through a
		// `ProjectMember` row and holds no membership of the host
		// organization, so every gate before this one passes: the feature is
		// on, the rollout gate is on, `hasProjectAccess` is true and
		// `PROJECT_READ` is resolved. What must not follow is the product
		// mailing fifty organization members a subject line the guest wrote,
		// because a display name is the guest's own to edit.
		await expect(
			ask({ userIds: ["dev-1", "dev-2"] }, "guest-1"),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { code: "ORGANIZATION_MEMBERSHIP_REQUIRED" },
		});

		expect(mockHasProjectAccess).toHaveBeenCalled();
		expect(mockFanOut).not.toHaveBeenCalled();
		// Refused before any audience is resolved, so the refusal teaches a
		// tampered client nothing about who is on the project.
		expect(mockGetProjectMemberFunctionTags).not.toHaveBeenCalled();
		expect(mockUsersWhoCanCreateKeys).not.toHaveBeenCalled();
	});

	it("asks membership of the PROJECT's organization, not of anything in the request", async () => {
		await ask({ userIds: ["dev-1"], organizationId: "org-elsewhere" });

		expect(mockIsOrganizationMember).toHaveBeenCalledTimes(1);
		expect(mockIsOrganizationMember).toHaveBeenCalledWith(ASKER, ORG);
	});

	it("still lets an organization member of any rank ask", async () => {
		// The low gate is the point of the procedure: whoever notices the gap
		// should be able to hand it to whoever can close it. The bar added
		// above is membership, not a rank, so this must keep working for a
		// fixture whose role is never named in an assertion.
		const result = await ask({ userIds: ["dev-1"] }, "designer-1");

		expect(result).toMatchObject({ notifiedCount: 1, recipientCount: 1 });
	});

	it("expands a function tag to its holders on THIS project", async () => {
		const result = await ask({ functionTags: ["DEVELOPER"] });

		// dev-1 and dev-2 hold DEVELOPER and can mint a key. guest-1 and
		// stale-role-1 hold it too and are dropped on eligibility;
		// designer-1 and untagged-1 do not hold it at all.
		expect(notifiedIds()).toEqual(["dev-1", "dev-2"]);
		expect(result).toMatchObject({ recipientCount: 2 });
	});

	it("cannot reach a tag-holder who is no longer on the project roster", async () => {
		// The roster is the only source the expansion reads, so a departed
		// member simply is not in it — there is no org-wide tag lookup to
		// resurface them.
		mockGetProjectMemberFunctionTags.mockResolvedValue(
			ROSTER.filter((entry) => entry.userId !== "dev-2"),
		);

		await ask({ functionTags: ["DEVELOPER"] });

		expect(notifiedIds()).toEqual(["dev-1"]);
	});

	it("asks somebody once when they are both named and tagged", async () => {
		const result = await ask({
			userIds: ["dev-1"],
			functionTags: ["DEVELOPER"],
		});

		expect(notifiedIds()).toEqual(["dev-1", "dev-2"]);
		expect(result).toMatchObject({ recipientCount: 2 });
	});

	it("fails the whole call when any id is off the project roster", async () => {
		await expect(
			ask({ userIds: ["dev-1", "outsider-9"] }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		// Not a partial success: the valid recipient is not notified either.
		expect(mockFanOut).not.toHaveBeenCalled();
	});

	it("never notifies the asker, whether they name themselves or their own tag", async () => {
		const byName = await ask({ userIds: [ASKER, "dev-1"] });
		expect(notifiedIds()).toEqual(["dev-1"]);
		expect(byName).toMatchObject({ recipientCount: 1 });

		mockFanOut.mockClear();

		// The asker is the project's only PRODUCT_OWNER.
		const byTag = await ask({ functionTags: ["PRODUCT_OWNER"] });
		expect(mockFanOut).not.toHaveBeenCalled();
		expect(byTag).toEqual({
			notifiedCount: 0,
			recipientCount: 0,
			ineligibleCount: 0,
			failedCount: 0,
		});
	});

	it("drops roster members who cannot create an API key, and says how many", async () => {
		// guest-1 has no organization membership at all; stale-role-1 holds a
		// role the matrix does not know. Neither can mint the key the ask is
		// asking for, so neither is written to — and the caller is told how
		// many were dropped rather than left to infer it from a short count.
		const result = await ask({
			userIds: ["dev-1", "guest-1", "stale-role-1"],
		});

		expect(notifiedIds()).toEqual(["dev-1"]);
		expect(result).toEqual({
			notifiedCount: 1,
			recipientCount: 1,
			ineligibleCount: 2,
			failedCount: 0,
		});
	});

	it("asks the live permission matrix rather than a copy of it", async () => {
		// The guard on every eligibility assertion above: if the roles the
		// fixture treats as eligible ever stopped carrying the permission, the
		// other tests would pass while proving nothing.
		for (const role of ["member", "admin", "owner"]) {
			expect(
				hasPermission(
					resolveOrgPermissions(role),
					Permissions.ORG_API_KEYS_CREATE,
				),
			).toBe(true);
		}
		// And the two ineligible fixtures are ineligible structurally: an
		// absent role and an unrecognised one both resolve to nothing.
		for (const role of [undefined, "auditor"]) {
			expect(
				hasPermission(
					resolveOrgPermissions(role),
					Permissions.ORG_API_KEYS_CREATE,
				),
			).toBe(false);
		}
	});

	it("resolves eligibility in one batched question, not one per recipient", async () => {
		await ask({ userIds: ["dev-1", "dev-2", "designer-1"] });

		// The named helper owns the read, and it is asked once for the whole
		// resolved list. One call per recipient would be an N+1 on a surface
		// whose recipient list can be a function tag on a large project.
		expect(mockUsersWhoCanCreateKeys).toHaveBeenCalledTimes(1);
		expect(mockUsersWhoCanCreateKeys).toHaveBeenCalledWith(ORG, [
			"dev-1",
			"dev-2",
			"designer-1",
		]);
	});

	it("returns the rows the fan-out actually wrote, not the number attempted", async () => {
		// e.g. one recipient still holds an unread ask about this project.
		mockFanOut.mockResolvedValue({ notified: 1, skipped: 1, failed: 0 });

		const result = await ask({ userIds: ["dev-1", "dev-2"] });

		expect(result).toEqual({
			notifiedCount: 1,
			recipientCount: 2,
			ineligibleCount: 0,
			failedCount: 0,
		});
	});

	it("reports zero notified when a repeated ask is fully deduped", async () => {
		mockFanOut.mockResolvedValue({ notified: 0, skipped: 2, failed: 0 });

		const result = await ask({ userIds: ["dev-1", "dev-2"] });

		expect(result).toMatchObject({
			notifiedCount: 0,
			recipientCount: 2,
			// Nothing broke. The difference between this and the test below is
			// the whole reason `failedCount` exists.
			failedCount: 0,
		});
	});

	it("reports a write that FAILED as failed, never folded into the skips", async () => {
		// The fan-out swallows a per-recipient write failure so it cannot break
		// the asker's request. Before this count existed, the caller saw only
		// `notifiedCount: 1` of two and told the asker their colleague already
		// had an unread ask — about a row that was never written.
		mockFanOut.mockResolvedValue({ notified: 1, skipped: 0, failed: 1 });

		const result = await ask({ userIds: ["dev-1", "dev-2"] });

		expect(result).toEqual({
			notifiedCount: 1,
			recipientCount: 2,
			ineligibleCount: 0,
			failedCount: 1,
		});
		// The three buckets account for every recipient, so the skipped count
		// the client renders is a subtraction that cannot go negative.
		expect(
			(result as { recipientCount: number }).recipientCount -
				(result as { notifiedCount: number }).notifiedCount -
				(result as { failedCount: number }).failedCount,
		).toBe(0);
	});

	it("refuses an over-cap ask with a code the client can act on, not just a message", async () => {
		const crowd = Array.from({ length: 60 }, (_, i) => `dev-${100 + i}`);
		mockGetProjectMemberFunctionTags.mockResolvedValue(
			crowd.map((userId) => ({ userId, tags: ["DEVELOPER"] })),
		);
		mockUsersWhoCanCreateKeys.mockImplementation(
			async (_organizationId: string, userIds: string[]) =>
				new Set(userIds),
		);

		// "Try again" is false for this refusal — the same tag resolves to the
		// same crowd forever — so the error has to carry enough for the client
		// to say something true, including the size the caller could not know
		// before sending.
		await expect(
			ask({ functionTags: ["DEVELOPER"] }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			data: {
				code: "TOO_MANY_RECIPIENTS",
				recipientCount: 60,
				maxRecipients: 50,
			},
		});
		expect(mockFanOut).not.toHaveBeenCalled();
	});

	it("counts the cap against the ELIGIBLE list, as its contract says", async () => {
		// 60 tag-holders, but only 50 can mint a key. The cap is checked after
		// the eligibility filter, so this is an ask that goes through — and the
		// doc-comment on `MAX_RECIPIENTS` now says so.
		const crowd = Array.from({ length: 60 }, (_, i) => `dev-${100 + i}`);
		mockGetProjectMemberFunctionTags.mockResolvedValue(
			crowd.map((userId) => ({ userId, tags: ["DEVELOPER"] })),
		);
		mockUsersWhoCanCreateKeys.mockImplementation(
			async (_organizationId: string, userIds: string[]) =>
				new Set(userIds.slice(0, 50)),
		);

		const result = await ask({ functionTags: ["DEVELOPER"] });

		expect(result).toMatchObject({
			recipientCount: 50,
			ineligibleCount: 10,
		});
	});

	it("resolves the tenant from the project, never from caller input", async () => {
		await ask({ userIds: ["dev-1"], organizationId: "org-elsewhere" });

		expect(mockFanOut.mock.calls[0][0]).toMatchObject({
			organizationId: ORG,
		});
		expect(mockUsersWhoCanCreateKeys).toHaveBeenCalledWith(ORG, ["dev-1"]);
		expect(mockIsOrganizationMember).toHaveBeenCalledWith(ASKER, ORG);
	});

	it("refuses, and sends nothing, when readiness is disabled", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);

		await expect(ask({ userIds: ["dev-1"] })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mockIsFeatureEnabled).toHaveBeenCalledWith("PROJECT_READINESS");
		expect(mockGather).not.toHaveBeenCalled();
		expect(mockFanOut).not.toHaveBeenCalled();
	});

	it("refuses when the CLI rollout gate is off for this organization", async () => {
		mockGather.mockResolvedValue({
			evidence: {},
			tenant: { userId: "owner-1", organizationId: ORG },
			project: { name: "Atlas", status: "ACTIVE" },
			cliNudgeEnabled: false,
		});

		await expect(ask({ userIds: ["dev-1"] })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mockFanOut).not.toHaveBeenCalled();
	});

	it("refuses when the caller no longer reaches the project", async () => {
		mockHasProjectAccess.mockResolvedValue(false);

		await expect(ask({ userIds: ["dev-1"] })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mockGetProjectMemberFunctionTags).not.toHaveBeenCalled();
		expect(mockFanOut).not.toHaveBeenCalled();
	});

	it("refuses when the project has no organization", async () => {
		mockGather.mockResolvedValue({
			evidence: {},
			tenant: { userId: "owner-1", organizationId: null },
			project: { name: "Atlas", status: "ACTIVE" },
			cliNudgeEnabled: true,
		});

		await expect(ask({ userIds: ["dev-1"] })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mockFanOut).not.toHaveBeenCalled();
	});

	it("refuses when the project does not exist", async () => {
		await expect(
			ask({ projectId: "nope", userIds: ["dev-1"] }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockFanOut).not.toHaveBeenCalled();
	});
});
