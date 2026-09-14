import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The access fence on contributor-name resolution.
 *
 * The defect: `resolveContributorNames` resolved display names with an
 * unscoped `db.user.findMany`, so a person removed from a project kept having
 * their name sent to the configured AI provider on every subsequent generation
 * for a topic they had once contributed to. Eight generators call this helper,
 * so the fence lives here rather than in each of them.
 *
 * ## Why this file evaluates the WHERE clause instead of canning a return
 *
 * A mock that answers `findMany` with a fixed array proves only that the
 * helper filtered its own output — it cannot distinguish a correct predicate
 * from an absent one, because the mock, not the predicate, chose the rows. So
 * the fake below actually applies the submitted `where` to fixture rows, and
 * throws on any operator it does not model rather than matching everything.
 * Delete a clause from the helper and the fixture rows it was excluding start
 * coming back.
 *
 * ## The rung each case isolates
 *
 * Access is `resolveProjectAccess`'s ladder — the one the publishing suite's
 * own runtime re-check already asks through `checkPublishingGenerationActor`:
 *
 *   A. personal-project owner         — `userId` matches AND `organizationId` is null
 *   C. active `ProjectMember` row     — accepted, and unexpired
 *   B. org membership on the host org — the fallback when C does not apply
 *
 * Every positive case below is built so exactly ONE rung can carry it: the
 * personal-project owner has no membership row of any kind, the org-role
 * contributor is neither owner nor project member, and the project-member
 * cases sit on a PERSONAL project so rung B cannot quietly rescue them. That
 * last one is the trap — an expired membership on an ORG project is still
 * access, via B, so a fixture that used an org project there would have gone
 * green without the expiry clause ever being consulted.
 */

type Row = Record<string, unknown>;

interface RecordedCall {
	table: string;
	method: string;
	args: Record<string, unknown>;
}

const calls: RecordedCall[] = [];
let projectRows: Row[] = [];
let projectMemberRows: Row[] = [];
let memberRows: Row[] = [];
let userRows: Row[] = [];

function equals(value: unknown, operand: unknown): boolean {
	if (value instanceof Date && operand instanceof Date) {
		return value.getTime() === operand.getTime();
	}
	return value === operand;
}

function matchesCondition(value: unknown, condition: unknown): boolean {
	if (
		condition === null ||
		condition instanceof Date ||
		typeof condition === "string" ||
		typeof condition === "number" ||
		typeof condition === "boolean"
	) {
		return equals(value, condition);
	}
	if (typeof condition !== "object") {
		throw new Error(`fake db: unsupported condition ${String(condition)}`);
	}
	return Object.entries(condition as Record<string, unknown>).every(
		([operator, operand]) => {
			switch (operator) {
				case "in":
					if (!Array.isArray(operand)) {
						throw new Error("fake db: `in` needs an array");
					}
					return operand.some((o) => equals(value, o));
				case "not":
					return !matchesCondition(value, operand);
				case "gt":
					return (
						value instanceof Date &&
						operand instanceof Date &&
						value.getTime() > operand.getTime()
					);
				case "lt":
					return (
						value instanceof Date &&
						operand instanceof Date &&
						value.getTime() < operand.getTime()
					);
				default:
					// Loudly, not silently: an operator this fake does not model
					// would otherwise behave as a clause that filters nothing,
					// and the whole point of this file is that clauses filter.
					throw new Error(
						`fake db: unsupported operator "${operator}"`,
					);
			}
		},
	);
}

function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, condition]) => {
		if (key === "OR") {
			if (!Array.isArray(condition)) {
				throw new Error("fake db: `OR` needs an array");
			}
			return condition.some((clause) =>
				matchesWhere(row, clause as Record<string, unknown>),
			);
		}
		if (key === "AND") {
			if (!Array.isArray(condition)) {
				throw new Error("fake db: `AND` needs an array");
			}
			return condition.every((clause) =>
				matchesWhere(row, clause as Record<string, unknown>),
			);
		}
		// Prisma ignores an `undefined` where-condition, so the fake does too.
		if (condition === undefined) {
			return true;
		}
		if (!(key in row)) {
			throw new Error(`fake db: fixture row has no field "${key}"`);
		}
		return matchesCondition(row[key], condition);
	});
}

/**
 * Projects a matched row down to the fields a `select` named, the way Prisma
 * would: only keys selected as exactly `true` are copied. Prisma always
 * returns every selected scalar (null when the column itself is null), so a
 * selected field missing from a fixture row is a fixture defect, not a
 * legitimately narrower row — the fake throws on it instead of guessing.
 */
function applySelect(row: Row, select: Record<string, unknown>): Row {
	const projected: Row = {};
	for (const [key, wanted] of Object.entries(select)) {
		if (wanted !== true) {
			continue;
		}
		if (!(key in row)) {
			throw new Error(`fake db: fixture row has no field "${key}"`);
		}
		projected[key] = row[key];
	}
	return projected;
}

function fakeTable(name: string, rows: () => Row[]) {
	const select = (args: Record<string, unknown>, method: string): Row[] => {
		calls.push({ table: name, method, args });
		const where = (args.where ?? {}) as Record<string, unknown>;
		const matched = rows().filter((row) => matchesWhere(row, where));
		const fields = args.select as Record<string, unknown> | undefined;
		return fields
			? matched.map((row) => applySelect(row, fields))
			: matched;
	};
	return {
		findUnique: async (args: Record<string, unknown>) =>
			select(args, "findUnique")[0] ?? null,
		findFirst: async (args: Record<string, unknown>) =>
			select(args, "findFirst")[0] ?? null,
		findMany: async (args: Record<string, unknown>) =>
			select(args, "findMany"),
	};
}

vi.mock("@repo/database", () => ({
	db: {
		project: fakeTable("project", () => projectRows),
		projectMember: fakeTable("projectMember", () => projectMemberRows),
		member: fakeTable("member", () => memberRows),
		user: fakeTable("user", () => userRows),
	},
}));

import { resolveContributorNames } from "../contributor-names";

/**
 * The clock is frozen so the expiry fixtures can sit a SECOND either side of
 * "now" instead of decades either side of it. A cutoff that is merely some
 * fixed date far in the past (`PAST`) and some fixed date far in the future
 * (`FUTURE`) cannot tell the helper's real `new Date()` apart from a
 * hard-coded stand-in for it — almost any fixed date drawn from between those
 * two extremes would classify both fixtures identically. Anchoring both
 * fixtures to the same instant the helper is actually asked to compare
 * against closes that gap.
 */
const NOW = new Date("2026-01-15T12:00:00.000Z");
const PAST = new Date(NOW.getTime() - 1_000);
const FUTURE = new Date(NOW.getTime() + 1_000);

/** An accepted, never-expiring membership row on the project under test. */
function membership(userId: string, over: Row = {}): Row {
	return {
		projectId: "proj-1",
		userId,
		acceptedAt: PAST,
		expiresAt: null,
		...over,
	};
}

/**
 * `projectId` defaults to "proj-1" because that is the scope almost every
 * case in this file exercises — but it is a real parameter, not a comment: a
 * helper that silently returned the literal instead would make every case
 * built on the default look identical to one built on an argument that never
 * arrived. The two "a SECOND project/organization" cases below are what
 * exercise the non-default path.
 */
function personalProject(ownerId: string, projectId = "proj-1"): Row {
	return { id: projectId, userId: ownerId, organizationId: null };
}

function orgProject(
	ownerId: string,
	projectId = "proj-1",
	organizationId = "org-1",
): Row {
	return { id: projectId, userId: ownerId, organizationId };
}

/**
 * A user row for every id these cases use, so an id missing from a result is
 * always the fence's doing and never an absent fixture.
 */
const NAMES: Record<string, string | null> = {
	"owner-1": "The Project Owner",
	"keeps-1": "A Current Collaborator",
	"gone-1": "A Departed Collaborator",
	"org-only-1": "An Organization Colleague",
	"outsider-1": "Somebody In Another Organization",
	"expired-1": "A Lapsed Collaborator",
	"pending-1": "An Unaccepted Invitee",
	"elsewhere-1": "A Member Of Another Project",
	"temp-1": "A Time-Boxed Collaborator",
	"demoted-1": "A Lapsed Colleague",
	"nameless-1": null,
	"keeps-2": "A Second-Project Collaborator",
	"org-two-1": "A Second-Organization Colleague",
};

beforeEach(() => {
	// See the comment on `NOW` above: every case in this file compares its
	// fixtures against this frozen instant rather than the real clock, so a
	// hard-coded stand-in for `new Date()` in the helper has a fixed target to
	// diverge from.
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	calls.length = 0;
	projectRows = [];
	projectMemberRows = [];
	memberRows = [];
	userRows = Object.entries(NAMES).map(([id, name]) => ({ id, name }));
});

afterEach(() => {
	vi.useRealTimers();
});

/**
 * The ids the helper actually asked the user table about, or null if it never
 * asked. Reading the submitted clause is the only way to show a fenced-out id
 * never reached the user table, as opposed to being dropped from the result
 * after its row had already been read.
 */
function idsSentToUserTable(): string[] | null {
	const call = calls.find((c) => c.table === "user");
	if (!call) {
		return null;
	}
	const where = call.args.where as { id: { in: string[] } };
	return where.id.in;
}

function tablesQueried(): string[] {
	return calls.map((c) => c.table).sort();
}

/**
 * The `where` clause submitted to the FIRST `project.findUnique` call, or null
 * if none was made. A helper that hard-coded the project id instead of using
 * its own `projectId` argument would still find "proj-1" in most of this
 * file's fixtures — reading the submitted clause, on a case scoped to a
 * DIFFERENT project, is the only way to catch that.
 */
function projectFindUniqueWhere(): Record<string, unknown> | null {
	const call = calls.find(
		(c) => c.table === "project" && c.method === "findUnique",
	);
	return (call?.args.where as Record<string, unknown>) ?? null;
}

/**
 * The `where` clause submitted to the FIRST `member.findMany` call, or null if
 * none was made. Same rationale as `projectFindUniqueWhere`, for the
 * organization id.
 */
function memberFindManyWhere(): Record<string, unknown> | null {
	const call = calls.find(
		(c) => c.table === "member" && c.method === "findMany",
	);
	return (call?.args.where as Record<string, unknown>) ?? null;
}

/**
 * The `where` clause submitted to the FIRST `projectMember.findMany` call, or
 * null if none was made.
 */
function projectMemberFindManyWhere(): Record<string, unknown> | null {
	const call = calls.find(
		(c) => c.table === "projectMember" && c.method === "findMany",
	);
	return (call?.args.where as Record<string, unknown>) ?? null;
}

describe("resolveContributorNames — the fence", () => {
	it("drops a contributor whose project membership is gone, and never reads their user row", async () => {
		projectRows = [personalProject("owner-1")];
		projectMemberRows = [membership("keeps-1")];

		const result = await resolveContributorNames({
			contributorUserIds: ["keeps-1", "gone-1"],
			projectId: "proj-1",
		});

		expect(result).toEqual([
			{ id: "keeps-1", name: "A Current Collaborator" },
		]);
		// Not merely absent from the output — absent from the query. The leak
		// this change exists to stop is the name LEAVING the database.
		expect(idsSentToUserTable()).toEqual(["keeps-1"]);
	});

	it("keeps the owner of a personal project, who has no ProjectMember row at all", async () => {
		// Rung A alone. No membership row exists for anyone, and a personal
		// project has no organization, so nothing else in the ladder can carry
		// this case: a fence written as a bare ProjectMember lookup drops the
		// project's own author from attribution in every generator.
		projectRows = [personalProject("owner-1")];
		projectMemberRows = [];
		memberRows = [];

		const result = await resolveContributorNames({
			contributorUserIds: ["owner-1"],
			projectId: "proj-1",
		});

		expect(result).toEqual([{ id: "owner-1", name: "The Project Owner" }]);
	});

	it("keeps the owner of an organization project, who is carried by org membership", async () => {
		// Rung B for the owner. Rung A cannot apply (the project HAS an
		// organization) and rung C cannot (no membership rows exist at all).
		projectRows = [orgProject("owner-1")];
		projectMemberRows = [];
		memberRows = [{ organizationId: "org-1", userId: "owner-1" }];

		const result = await resolveContributorNames({
			contributorUserIds: ["owner-1"],
			projectId: "proj-1",
		});

		expect(result).toEqual([{ id: "owner-1", name: "The Project Owner" }]);
	});

	it("keeps an organization colleague who is neither owner nor project member", async () => {
		// Rung B proper — the contributor authored stories in an organization
		// project without ever being invited to it individually, which is the
		// ordinary shape for an organization's own staff.
		projectRows = [orgProject("owner-1")];
		projectMemberRows = [];
		memberRows = [{ organizationId: "org-1", userId: "org-only-1" }];

		const result = await resolveContributorNames({
			contributorUserIds: ["org-only-1"],
			projectId: "proj-1",
		});

		expect(result).toEqual([
			{ id: "org-only-1", name: "An Organization Colleague" },
		]);
	});

	it("drops an owner who has left the host organization", async () => {
		// The negative half of the org-owner case above. Without it, that case
		// would also pass against a fence that returned the owner
		// unconditionally.
		projectRows = [orgProject("owner-1")];
		projectMemberRows = [];
		memberRows = [];

		const result = await resolveContributorNames({
			contributorUserIds: ["owner-1"],
			projectId: "proj-1",
		});

		expect(result).toEqual([]);
		expect(idsSentToUserTable()).toBeNull();
	});

	it("drops a member of a DIFFERENT organization", async () => {
		// An org-membership lookup that forgot to scope by the project's own
		// organization would return this row and still go green on every
		// positive case above.
		projectRows = [orgProject("owner-1")];
		projectMemberRows = [];
		memberRows = [{ organizationId: "org-2", userId: "outsider-1" }];

		const result = await resolveContributorNames({
			contributorUserIds: ["outsider-1"],
			projectId: "proj-1",
		});

		expect(result).toEqual([]);
	});

	it("drops an expired membership on a personal project", async () => {
		// PERSONAL on purpose: on an organization project rung B would carry an
		// org colleague whose project row has lapsed, and this case would pass
		// without the `expiresAt` clause ever being consulted.
		projectRows = [personalProject("owner-1")];
		projectMemberRows = [
			membership("expired-1", { expiresAt: PAST }),
			membership("temp-1", { expiresAt: FUTURE }),
		];

		const result = await resolveContributorNames({
			contributorUserIds: ["expired-1", "temp-1"],
			projectId: "proj-1",
		});

		// The unexpired time-boxed collaborator is the control: a fence that
		// dropped every row CARRYING an `expiresAt` would fail here while
		// looking correct on the expired one.
		expect(result).toEqual([
			{ id: "temp-1", name: "A Time-Boxed Collaborator" },
		]);
	});

	it("drops an invitation that was never accepted", async () => {
		projectRows = [personalProject("owner-1")];
		projectMemberRows = [membership("pending-1", { acceptedAt: null })];

		const result = await resolveContributorNames({
			contributorUserIds: ["pending-1"],
			projectId: "proj-1",
		});

		expect(result).toEqual([]);
	});

	it("drops a membership that belongs to a different project", async () => {
		projectRows = [personalProject("owner-1")];
		projectMemberRows = [
			membership("elsewhere-1", { projectId: "proj-2" }),
		];

		const result = await resolveContributorNames({
			contributorUserIds: ["elsewhere-1"],
			projectId: "proj-1",
		});

		expect(result).toEqual([]);
	});

	it("keeps an organization colleague whose project membership has lapsed", async () => {
		// The C-then-B fall-through `resolveProjectAccess` performs: an
		// inactive project row does not subtract the access an org role already
		// grants. Pinned so a later tightening of the expiry clause cannot
		// quietly turn a colleague into a stranger.
		projectRows = [orgProject("owner-1")];
		projectMemberRows = [membership("demoted-1", { expiresAt: PAST })];
		memberRows = [{ organizationId: "org-1", userId: "demoted-1" }];

		const result = await resolveContributorNames({
			contributorUserIds: ["demoted-1"],
			projectId: "proj-1",
		});

		expect(result).toEqual([
			{ id: "demoted-1", name: "A Lapsed Colleague" },
		]);
	});

	it("returns nothing and reads no user row when the project is gone", async () => {
		projectRows = [];
		projectMemberRows = [membership("keeps-1")];

		const result = await resolveContributorNames({
			contributorUserIds: ["keeps-1"],
			projectId: "proj-1",
		});

		expect(result).toEqual([]);
		expect(idsSentToUserTable()).toBeNull();
	});

	it("preserves a surviving contributor's missing display name as null", async () => {
		projectRows = [personalProject("owner-1")];
		projectMemberRows = [membership("nameless-1")];

		const result = await resolveContributorNames({
			contributorUserIds: ["nameless-1"],
			projectId: "proj-1",
		});

		expect(result).toEqual([{ id: "nameless-1", name: null }]);
	});

	/**
	 * Every case above runs on "proj-1"/"org-1", `membership()` and
	 * `orgProject()`'s own defaults. A helper rewritten to query those two
	 * literals instead of its `projectId`/`organizationId` arguments would
	 * still pass every one of them — this is the only case in the file where
	 * the project actually queried is something else.
	 */
	it("keeps a contributor on a SECOND project, not just the fixtures' default", async () => {
		projectRows = [personalProject("owner-2", "proj-2")];
		projectMemberRows = [membership("keeps-2", { projectId: "proj-2" })];

		const result = await resolveContributorNames({
			contributorUserIds: ["keeps-2"],
			projectId: "proj-2",
		});

		expect(result).toEqual([
			{ id: "keeps-2", name: "A Second-Project Collaborator" },
		]);
		expect(projectFindUniqueWhere()).toEqual({ id: "proj-2" });
	});

	/**
	 * Same idea for the organization half: `orgProject()`'s own default host is
	 * "org-1", and the existing "different organization" control below never
	 * exercises a case where the project's REAL organization is anything else
	 * — a helper that hard-coded "org-1" into the `member` query would still
	 * pass that control, because the project under test there also happens to
	 * live in "org-1".
	 */
	it("keeps a contributor carried by a SECOND host organization, not just the fixtures' default", async () => {
		projectRows = [orgProject("owner-3", "proj-3", "org-2")];
		memberRows = [{ organizationId: "org-2", userId: "org-two-1" }];

		const result = await resolveContributorNames({
			contributorUserIds: ["org-two-1"],
			projectId: "proj-3",
		});

		expect(result).toEqual([
			{ id: "org-two-1", name: "A Second-Organization Colleague" },
		]);
		expect(memberFindManyWhere()).toEqual({
			organizationId: "org-2",
			userId: { in: ["org-two-1"] },
		});
	});
});

describe("resolveContributorNames — the query budget", () => {
	it("issues no query at all for an empty contributor list", async () => {
		const result = await resolveContributorNames({
			contributorUserIds: [],
			projectId: "proj-1",
		});

		expect(result).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("costs four queries on an organization project when contributors survive, whatever their count, and bounds each membership query to the submitted ids", async () => {
		projectRows = [orgProject("owner-1")];
		const contributorUserIds = [
			"owner-1",
			"keeps-1",
			"temp-1",
			"org-only-1",
			"gone-1",
		];
		projectMemberRows = [
			membership("keeps-1"),
			membership("temp-1", { expiresAt: FUTURE }),
			// A current, accepted, unexpired project member who was NOT among
			// the contributors submitted above. Deleting the `in` filter from
			// the helper's projectMember query would fetch this row anyway —
			// it just wouldn't change `result`, because `withAccess`
			// re-intersects with the submitted ids afterward. The `result`
			// assertion below cannot see that; only the recorded `where` can.
			membership("roster-1"),
		];
		memberRows = [
			{ organizationId: "org-1", userId: "org-only-1" },
			{ organizationId: "org-1", userId: "owner-1" },
			// Same idea, for the organization roster.
			{ organizationId: "org-1", userId: "roster-2" },
		];

		const result = await resolveContributorNames({
			contributorUserIds,
			projectId: "proj-1",
		});

		// Four of the five survive, so the budget is not being met by an early
		// return on an empty survivor set.
		expect(result.map((r) => r.id).sort()).toEqual([
			"keeps-1",
			"org-only-1",
			"owner-1",
			"temp-1",
		]);
		// Five contributors, four queries. A per-user access helper called in a
		// loop would show as five `projectMember` reads here — the shape this
		// helper exists to keep out of every generation.
		expect(tablesQueried()).toEqual([
			"member",
			"project",
			"projectMember",
			"user",
		]);

		// Not merely WHICH tables were read — WITH WHAT PREDICATE. A missing
		// `in` filter on either membership query returns the exact same
		// `result` above while quietly loading the whole roster fixtured as
		// `roster-1` / `roster-2`.
		expect(projectMemberFindManyWhere()).toEqual({
			projectId: "proj-1",
			userId: { in: contributorUserIds },
			acceptedAt: { not: null },
			OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
		});
		expect(memberFindManyWhere()).toEqual({
			organizationId: "org-1",
			userId: { in: contributorUserIds },
		});
	});

	it("skips the organization lookup entirely on a personal project, and bounds the membership query to the submitted ids", async () => {
		projectRows = [personalProject("owner-1")];
		const contributorUserIds = ["owner-1", "keeps-1", "gone-1"];
		projectMemberRows = [
			membership("keeps-1"),
			// A current member not among the submitted contributors — see the
			// organization-project case above for why this matters.
			membership("roster-1"),
		];

		const result = await resolveContributorNames({
			contributorUserIds,
			projectId: "proj-1",
		});

		expect(result.map((r) => r.id).sort()).toEqual(["keeps-1", "owner-1"]);
		expect(tablesQueried()).toEqual(["project", "projectMember", "user"]);
		expect(projectMemberFindManyWhere()).toEqual({
			projectId: "proj-1",
			userId: { in: contributorUserIds },
			acceptedAt: { not: null },
			OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
		});
	});
});
