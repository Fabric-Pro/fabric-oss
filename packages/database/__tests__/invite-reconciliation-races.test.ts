/**
 * Mocked-client unit tests for the TOCTOU race guard in
 * `reconcilePendingInvitesForUser`.
 *
 * The guarded interleave: an invite is revoked (org: status moved off
 * `pending`; project: row deleted / moved off `PENDING`) AFTER the initial
 * bulk read but BEFORE the per-invite transaction commits. Inside the
 * transaction the membership row is created FIRST, then the conditional
 * consume (`updateMany` gated on still-pending) runs; a 0-count result
 * throws the internal `NoLiveInviteError`, Prisma rolls the transaction —
 * and with it the just-created membership — back, and the outcome surfaces
 * as a `"canceled"` skip with NO grant recorded.
 *
 * The sub-millisecond interleave cannot be reproduced against a real
 * Postgres, but the guard's logic is fully deterministic given the
 * conditional consume's count — so the prisma client is MOCKED and the
 * count is forced to 0 (revoked mid-flight) or >0 (live). Rollback itself
 * is Postgres' job; what these tests pin is the contract around it:
 * throw-on-zero-count, the internal error never escaping, the skip
 * bookkeeping, and the member-create-before-consume lock order.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/invite-reconciliation-races.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcilePendingInvitesForUser } from "../prisma/queries/invite-reconciliation";

const { dbMock, txMock, PrismaClientKnownRequestErrorMock } = vi.hoisted(() => {
	/**
	 * Stand-in for Prisma's error class. Must be a REAL class (not a plain
	 * object) so the module's `error instanceof
	 * Prisma.PrismaClientKnownRequestError` P2002 check keeps working
	 * against the mocked namespace.
	 */
	class PrismaClientKnownRequestErrorMock extends Error {
		code: string;

		constructor(message: string, options: { code: string }) {
			super(message);
			this.name = "PrismaClientKnownRequestError";
			this.code = options.code;
		}
	}

	/** Interactive-transaction client handed to the `$transaction` callback. */
	const txMock = {
		member: { findUnique: vi.fn(), create: vi.fn() },
		invitation: { updateMany: vi.fn() },
		projectMember: { findUnique: vi.fn(), create: vi.fn() },
		projectInvitation: { updateMany: vi.fn() },
		// The copy-on-join hook (`applyGlobalDefaultFunctionTags`, wired into
		// `resolveProjectInvite` after `tx.projectMember.create`) runs inside
		// this same transaction and touches these delegates — stubbed here
		// (defaults set in `beforeEach`) purely so the hook no-ops cleanly and
		// doesn't throw; this test does not assert on them.
		project: { findUnique: vi.fn() },
		user: { findUnique: vi.fn() },
		projectUserFunctionTag: {
			findUnique: vi.fn(),
			upsert: vi.fn(),
			update: vi.fn(),
		},
	};

	const dbMock = {
		$transaction: vi.fn(),
		// `updateMany` on the root client backs the P2002 fallback consume —
		// mocked so the tests can assert it is NOT reached on the rollback
		// path (the invite row must be left entirely untouched).
		invitation: { findMany: vi.fn(), updateMany: vi.fn() },
		projectInvitation: { findMany: vi.fn(), updateMany: vi.fn() },
	};

	return { dbMock, txMock, PrismaClientKnownRequestErrorMock };
});

// invite-reconciliation.ts resolves its `db`/`Prisma` import to `../client`
// from its position at `prisma/queries/` — from this test's location at
// `__tests__/`, that same module is `../prisma/client`. `vi.mock` is
// hoisted above the static import, so the module under test sees the mock.
vi.mock("../prisma/client", () => ({
	db: dbMock,
	Prisma: {
		PrismaClientKnownRequestError: PrismaClientKnownRequestErrorMock,
	},
}));

type TxMock = typeof txMock;

const USER_ID = "test-races-user";
const EMAIL = "races-invitee@example.com";

function futureDate() {
	return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

interface OrgInviteRow {
	id: string;
	organizationId: string;
	role: string | null;
	teamId: string | null;
	expiresAt: Date;
	createdAt: Date;
}

function orgInviteRow(overrides: Partial<OrgInviteRow> = {}): OrgInviteRow {
	return {
		id: "org-invite-1",
		organizationId: "org-1",
		role: "member",
		teamId: null,
		expiresAt: futureDate(),
		createdAt: new Date(),
		...overrides,
	};
}

interface ProjectInviteRow {
	id: string;
	projectId: string;
	role: "OWNER" | "PROJECT_ADMIN" | "EDITOR" | "COMMENTER" | "VIEWER";
	invitedBy: string;
	expiresAt: Date;
}

function projectInviteRow(
	overrides: Partial<ProjectInviteRow> = {},
): ProjectInviteRow {
	return {
		id: "proj-invite-1",
		projectId: "proj-1",
		role: "EDITOR",
		invitedBy: "test-races-inviter",
		expiresAt: futureDate(),
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	// Mirror Prisma's interactive-transaction semantics: invoke the callback
	// with the tx client; a callback throw rejects `$transaction` with the
	// same error (the rollback itself is the database's job — out of scope
	// for a mocked client).
	dbMock.$transaction.mockImplementation(
		async (callback: (tx: TxMock) => Promise<unknown>) => callback(txMock),
	);
	dbMock.invitation.findMany.mockResolvedValue([]);
	dbMock.projectInvitation.findMany.mockResolvedValue([]);
	// Copy-on-join hook defaults: project exists, the joining user is NOT the
	// creator (USER_ID "test-races-user" !== "project-owner"), the "creator"
	// has an empty default set, and no existing row — the hook runs its real
	// no-op path (zero writes) instead of throwing on an unstubbed delegate.
	txMock.project.findUnique.mockResolvedValue({
		organizationId: "org-1",
		userId: "project-owner",
	});
	txMock.user.findUnique.mockResolvedValue({ defaultFunctionTags: [] });
	txMock.projectUserFunctionTag.findUnique.mockResolvedValue(null);
});

describe("reconcilePendingInvitesForUser — TOCTOU race guard (mocked client)", () => {
	it("org invite revoked mid-flight (consume count 0): no grant, 'canceled' skip, internal error never escapes", async () => {
		dbMock.invitation.findMany.mockResolvedValue([
			orgInviteRow({ id: "org-invite-1", organizationId: "org-1" }),
		]);
		txMock.member.findUnique.mockResolvedValue(null);
		txMock.member.create.mockResolvedValue({ id: "member-1" });
		// The race: every invite in the group was moved off `pending`
		// between the bulk read and the transaction's conditional consume.
		txMock.invitation.updateMany.mockResolvedValue({ count: 0 });

		// Resolves — `NoLiveInviteError` is caught inside `resolveOrgGroup`
		// and never propagates past the public function.
		const result = await reconcilePendingInvitesForUser({
			userId: USER_ID,
			email: EMAIL,
		});

		expect(result.orgInvitesFound).toBe(1);
		expect(result.orgMembershipsCreated).toBe(0);
		expect(result.createdOrgMemberships).toEqual([]);
		expect(result.skipped).toEqual([
			{
				type: "organization",
				invitationId: "org-invite-1",
				reason: "canceled",
			},
		]);
		expect(result.warnings).toEqual([]);

		// Lock-order contract: the member insert runs BEFORE the invite
		// consume, matching `acceptProjectInvitation`'s ordering so the two
		// concurrent writers can never deadlock on opposite lock order.
		expect(txMock.member.create).toHaveBeenCalledTimes(1);
		expect(txMock.invitation.updateMany).toHaveBeenCalledTimes(1);
		expect(txMock.member.create.mock.invocationCallOrder[0]).toBeLessThan(
			txMock.invitation.updateMany.mock.invocationCallOrder[0],
		);

		// The consume is CONDITIONAL on still-pending — the heart of the
		// guard: revoked rows can never be flipped back to `accepted`.
		expect(txMock.invitation.updateMany).toHaveBeenCalledWith({
			where: { id: { in: ["org-invite-1"] }, status: "pending" },
			data: { status: "accepted" },
		});

		// The non-transactional P2002 fallback consume must NOT run: the
		// rollback path leaves the invitation row entirely untouched.
		expect(dbMock.invitation.updateMany).not.toHaveBeenCalled();
	});

	it("project invite revoked mid-flight (consume count 0): no grant, 'canceled' skip", async () => {
		dbMock.projectInvitation.findMany.mockResolvedValue([
			projectInviteRow({ id: "proj-invite-1", projectId: "proj-1" }),
		]);
		txMock.projectMember.findUnique.mockResolvedValue(null);
		txMock.projectMember.create.mockResolvedValue({
			id: "proj-member-1",
			role: "EDITOR",
		});
		// The race: the invite was revoked (project revoke = row delete)
		// after the bulk read — the conditional consume matches nothing.
		txMock.projectInvitation.updateMany.mockResolvedValue({ count: 0 });

		const result = await reconcilePendingInvitesForUser({
			userId: USER_ID,
			email: EMAIL,
		});

		expect(result.projectInvitesFound).toBe(1);
		expect(result.projectMembershipsCreated).toBe(0);
		expect(result.createdProjectMemberships).toEqual([]);
		expect(result.skipped).toEqual([
			{
				type: "project",
				invitationId: "proj-invite-1",
				reason: "canceled",
			},
		]);

		// Same lock-order contract as the org path.
		expect(txMock.projectMember.create).toHaveBeenCalledTimes(1);
		expect(txMock.projectInvitation.updateMany).toHaveBeenCalledTimes(1);
		expect(
			txMock.projectMember.create.mock.invocationCallOrder[0],
		).toBeLessThan(
			txMock.projectInvitation.updateMany.mock.invocationCallOrder[0],
		);

		// Conditional consume, exactly like the manual accept path.
		expect(txMock.projectInvitation.updateMany).toHaveBeenCalledWith({
			where: { id: "proj-invite-1", status: "PENDING" },
			data: { status: "ACCEPTED", respondedAt: expect.any(Date) },
		});

		// No fallback consume on the rollback path.
		expect(dbMock.projectInvitation.updateMany).not.toHaveBeenCalled();
	});

	it("control — consume count 1: org AND project grants are recorded (count wiring is live, not vacuous)", async () => {
		dbMock.invitation.findMany.mockResolvedValue([
			orgInviteRow({
				id: "org-invite-1",
				organizationId: "org-1",
				role: "admin",
			}),
		]);
		dbMock.projectInvitation.findMany.mockResolvedValue([
			projectInviteRow({ id: "proj-invite-1", projectId: "proj-1" }),
		]);
		txMock.member.findUnique.mockResolvedValue(null);
		txMock.member.create.mockResolvedValue({ id: "member-1" });
		txMock.invitation.updateMany.mockResolvedValue({ count: 1 });
		txMock.projectMember.findUnique.mockResolvedValue(null);
		txMock.projectMember.create.mockResolvedValue({
			id: "proj-member-1",
			role: "EDITOR",
		});
		txMock.projectInvitation.updateMany.mockResolvedValue({ count: 1 });

		const result = await reconcilePendingInvitesForUser({
			userId: USER_ID,
			email: EMAIL,
		});

		expect(result.orgMembershipsCreated).toBe(1);
		expect(result.createdOrgMemberships).toEqual([
			{
				organizationId: "org-1",
				memberId: "member-1",
				role: "admin",
				invitationIds: ["org-invite-1"],
			},
		]);
		expect(result.projectMembershipsCreated).toBe(1);
		expect(result.createdProjectMemberships).toEqual([
			{
				projectId: "proj-1",
				memberId: "proj-member-1",
				role: "EDITOR",
				invitationId: "proj-invite-1",
			},
		]);
		expect(result.skipped).toEqual([]);
	});

	it("partial org group — 2 invites, consume count 1: the grant still succeeds (one live invite authorizes)", async () => {
		// findMany returns newest-first (the module relies on the query's
		// `createdAt: "desc"` ordering); the newest invite's role wins.
		dbMock.invitation.findMany.mockResolvedValue([
			orgInviteRow({
				id: "org-invite-new",
				organizationId: "org-1",
				role: "owner",
				createdAt: new Date("2026-06-02T00:00:00.000Z"),
			}),
			orgInviteRow({
				id: "org-invite-old",
				organizationId: "org-1",
				role: "member",
				createdAt: new Date("2026-06-01T00:00:00.000Z"),
			}),
		]);
		txMock.member.findUnique.mockResolvedValue(null);
		txMock.member.create.mockResolvedValue({ id: "member-1" });
		// One of the two invites was revoked mid-flight; the other is still
		// live — a single surviving pending row authorizes the grant.
		txMock.invitation.updateMany.mockResolvedValue({ count: 1 });

		const result = await reconcilePendingInvitesForUser({
			userId: USER_ID,
			email: EMAIL,
		});

		expect(result.orgInvitesFound).toBe(2);
		expect(result.orgMembershipsCreated).toBe(1);
		expect(result.createdOrgMemberships).toEqual([
			{
				organizationId: "org-1",
				memberId: "member-1",
				role: "owner",
				invitationIds: ["org-invite-new", "org-invite-old"],
			},
		]);
		expect(result.skipped).toEqual([]);

		// The whole group is consumed in ONE conditional updateMany.
		expect(txMock.invitation.updateMany).toHaveBeenCalledTimes(1);
		expect(txMock.invitation.updateMany).toHaveBeenCalledWith({
			where: {
				id: { in: ["org-invite-new", "org-invite-old"] },
				status: "pending",
			},
			data: { status: "accepted" },
		});
	});
});
