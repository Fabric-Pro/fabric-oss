/**
 * Wiring tests for copy-on-join: assert `applyGlobalDefaultFunctionTags` is
 * invoked from the two member-creation paths (invite accept + signup/sign-in
 * reconciliation), each inside its own transaction.
 *
 * Kept in its OWN file, separate from `function-tags.test.ts`: this file
 * hoists `vi.mock("../function-tags", ...)` to replace the real helper with
 * a spy. If that mock lived in `function-tags.test.ts`, it would also
 * replace the real helper for Task 3's real-helper tests in that file,
 * silently turning them into tautologies against a `vi.fn()`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockApplyGlobalDefaultFunctionTags } = vi.hoisted(() => ({
	mockApplyGlobalDefaultFunctionTags: vi.fn(),
}));

// Resolves to the same absolute module (`queries/projects/function-tags.ts`)
// that both `members.ts` (`./function-tags`) and `invite-reconciliation.ts`
// (`./projects/function-tags`) import — one mock covers both consumers.
vi.mock("../function-tags", () => ({
	applyGlobalDefaultFunctionTags: mockApplyGlobalDefaultFunctionTags,
}));

const { dbMock } = vi.hoisted(() => ({
	dbMock: {
		projectInvitation: {
			findFirst: vi.fn(),
			findMany: vi.fn(),
			updateMany: vi.fn(),
		},
		projectMember: {
			findUnique: vi.fn(),
			create: vi.fn(),
		},
		invitation: {
			findMany: vi.fn(),
		},
		$transaction: vi.fn(),
	},
}));

vi.mock("../../../client", () => ({
	db: dbMock,
	Prisma: {},
}));

import { reconcilePendingInvitesForUser } from "../../invite-reconciliation";
import { acceptProjectInvitation } from "../members";

function stubTransaction() {
	// Mirrors the tx-stub convention used elsewhere in this suite (e.g.
	// test-plans.test.ts): the transaction callback runs against the same
	// mock object standing in for `db`, so calls made "inside tx" are
	// observable on the shared mocks.
	dbMock.$transaction.mockImplementation(
		async (cb: (tx: typeof dbMock) => unknown) => cb(dbMock),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	stubTransaction();
});

describe("acceptProjectInvitation — copy-on-join wiring", () => {
	it("calls applyGlobalDefaultFunctionTags once inside the transaction, before consuming the invitation", async () => {
		const invitation = {
			id: "inv-1",
			projectId: "proj-1",
			email: "member@example.com",
			role: "VIEWER",
			invitedBy: "inviter-1",
			status: "PENDING",
			expiresAt: new Date(Date.now() + 100_000),
		};
		dbMock.projectInvitation.findFirst.mockResolvedValue(invitation);
		// No existing member — drives the happy-path member create.
		dbMock.projectMember.findUnique.mockResolvedValue(null);
		dbMock.projectMember.create.mockResolvedValue({
			id: "member-1",
			projectId: "proj-1",
			userId: "user-1",
			role: "VIEWER",
		});

		const callOrder: string[] = [];
		mockApplyGlobalDefaultFunctionTags.mockImplementation(async () => {
			callOrder.push("apply-tags");
		});
		dbMock.projectInvitation.updateMany.mockImplementation(async () => {
			callOrder.push("consume-invite");
			return { count: 1 };
		});

		await acceptProjectInvitation("inv-1", "user-1", "member@example.com");

		expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
		expect(mockApplyGlobalDefaultFunctionTags).toHaveBeenCalledTimes(1);
		expect(mockApplyGlobalDefaultFunctionTags).toHaveBeenCalledWith(
			dbMock,
			{
				projectId: "proj-1",
				userId: "user-1",
			},
		);
		// Ran inside the transaction, after the member create, before the
		// invitation is consumed.
		expect(callOrder).toEqual(["apply-tags", "consume-invite"]);
	});
});

describe("reconcilePendingInvitesForUser — copy-on-join wiring", () => {
	it("calls applyGlobalDefaultFunctionTags once in the project-invite transaction", async () => {
		// No qualifying org invites — isolates this test to the project-invite
		// path, which has its own independent transaction.
		dbMock.invitation.findMany.mockResolvedValue([]);
		dbMock.projectInvitation.findMany.mockResolvedValue([
			{
				id: "inv-2",
				projectId: "proj-2",
				role: "VIEWER",
				invitedBy: "inviter-2",
				expiresAt: new Date(Date.now() + 100_000),
			},
		]);
		// No existing project membership — drives the happy-path member create.
		dbMock.projectMember.findUnique.mockResolvedValue(null);
		dbMock.projectMember.create.mockResolvedValue({
			id: "member-2",
			projectId: "proj-2",
			userId: "user-2",
			role: "VIEWER",
		});
		dbMock.projectInvitation.updateMany.mockResolvedValue({ count: 1 });

		const result = await reconcilePendingInvitesForUser({
			userId: "user-2",
			email: "member2@example.com",
		});

		expect(result.projectMembershipsCreated).toBe(1);
		expect(mockApplyGlobalDefaultFunctionTags).toHaveBeenCalledTimes(1);
		expect(mockApplyGlobalDefaultFunctionTags).toHaveBeenCalledWith(
			dbMock,
			{
				projectId: "proj-2",
				userId: "user-2",
			},
		);
	});
});
