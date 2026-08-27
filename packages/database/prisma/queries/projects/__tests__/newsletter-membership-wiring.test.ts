/**
 * Wiring tests for newsletter enrol-on-join (Fizzy #2290): assert that
 * `acceptProjectInvitation` reaches `enrollProjectMemberIfNewsletterEnabled`
 * from EVERY branch that hands back a membership, and that it does so after
 * the transaction has committed.
 *
 * "Every branch" is load-bearing, not thoroughness for its own sake. Two
 * runners can both see no member; one commits and the other takes the P2002
 * branch. If only the winner enrolled and it then died, nobody would write the
 * subscriber row and the member would stay invisible in project settings until
 * the next send — the exact defect this change exists to fix.
 *
 * Kept in its OWN file, separate from the newsletter query suites, for the
 * same reason `function-tags-wiring.test.ts` is: this file hoists
 * `vi.mock("../newsletter", ...)` to swap the real helper for a spy, and that
 * mock would otherwise turn the helper's own tests into tautologies against a
 * `vi.fn()`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnrollIfEnabled } = vi.hoisted(() => ({
	mockEnrollIfEnabled: vi.fn(),
}));

vi.mock("../newsletter", () => ({
	enrollProjectMemberIfNewsletterEnabled: mockEnrollIfEnabled,
}));

vi.mock("../function-tags", () => ({
	applyGlobalDefaultFunctionTags: vi.fn(),
}));

const { dbMock, FakeKnownRequestError } = vi.hoisted(() => {
	// Stands in for Prisma.PrismaClientKnownRequestError so the `instanceof`
	// guard in the P2002 recovery branch resolves against a real constructor.
	class FakeKnownRequestError extends Error {
		code: string;
		constructor(code: string) {
			super(`prisma error ${code}`);
			this.code = code;
		}
	}
	return {
		FakeKnownRequestError,
		dbMock: {
			projectInvitation: {
				findFirst: vi.fn(),
				updateMany: vi.fn(),
			},
			projectMember: {
				findUnique: vi.fn(),
				create: vi.fn(),
			},
			$transaction: vi.fn(),
		},
	};
});

// Resolves to the same absolute module (`prisma/client.ts`) that `members.ts`
// imports as `../../client` — one level deeper from inside `__tests__/`.
vi.mock("../../../client", () => ({
	db: dbMock,
	Prisma: { PrismaClientKnownRequestError: FakeKnownRequestError },
}));

vi.mock("@repo/logs", () => ({
	logger: {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

import { logger } from "@repo/logs";
import { acceptProjectInvitation } from "../members";

const EMAIL = "member@example.com";
const MEMBER = {
	id: "member-1",
	projectId: "proj-1",
	userId: "user-1",
	role: "VIEWER",
};

function livePendingInvitation() {
	return {
		id: "inv-1",
		projectId: "proj-1",
		email: EMAIL,
		role: "VIEWER",
		invitedBy: "inviter-1",
		status: "PENDING",
		expiresAt: new Date(Date.now() + 100_000),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.$transaction.mockImplementation(
		async (cb: (tx: typeof dbMock) => unknown) => cb(dbMock),
	);
	dbMock.projectInvitation.updateMany.mockResolvedValue({ count: 1 });
	mockEnrollIfEnabled.mockResolvedValue({ enrolled: 1 });
});

describe("acceptProjectInvitation — newsletter enrol-on-join wiring", () => {
	it("enrols after the transaction commits on a genuine member create", async () => {
		dbMock.projectInvitation.findFirst.mockResolvedValue(
			livePendingInvitation(),
		);
		dbMock.projectMember.findUnique.mockResolvedValue(null);
		dbMock.projectMember.create.mockResolvedValue(MEMBER);

		const order: string[] = [];
		dbMock.$transaction.mockImplementation(
			async (cb: (tx: typeof dbMock) => unknown) => {
				order.push("tx-start");
				const result = await cb(dbMock);
				order.push("tx-commit");
				return result;
			},
		);
		mockEnrollIfEnabled.mockImplementation(async () => {
			order.push("enrol");
			return { enrolled: 1 };
		});

		await acceptProjectInvitation("inv-1", "user-1", EMAIL);

		expect(mockEnrollIfEnabled).toHaveBeenCalledTimes(1);
		expect(mockEnrollIfEnabled).toHaveBeenCalledWith({
			projectId: "proj-1",
			email: EMAIL,
		});
		// Outside the transaction: a newsletter failure must never be able to
		// roll the membership back, and in Postgres a failed statement inside
		// a transaction poisons the whole thing regardless of try/catch.
		expect(order).toEqual(["tx-start", "tx-commit", "enrol"]);
	});

	it("enrols on the P2002 branch, where a concurrent runner won the create", async () => {
		dbMock.projectInvitation.findFirst.mockResolvedValue(
			livePendingInvitation(),
		);
		// Existence check sees nothing, then the create loses the race.
		dbMock.projectMember.findUnique
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(MEMBER);
		dbMock.projectMember.create.mockRejectedValue(
			new FakeKnownRequestError("P2002"),
		);

		await acceptProjectInvitation("inv-1", "user-1", EMAIL);

		expect(mockEnrollIfEnabled).toHaveBeenCalledTimes(1);
		expect(mockEnrollIfEnabled).toHaveBeenCalledWith({
			projectId: "proj-1",
			email: EMAIL,
		});
	});

	it("enrols on the idempotent already-a-member branch (invitation ACCEPTED)", async () => {
		dbMock.projectInvitation.findFirst.mockResolvedValue({
			...livePendingInvitation(),
			status: "ACCEPTED",
		});
		dbMock.projectMember.findUnique.mockResolvedValue(MEMBER);

		await acceptProjectInvitation("inv-1", "user-1", EMAIL);

		expect(dbMock.projectMember.create).not.toHaveBeenCalled();
		expect(mockEnrollIfEnabled).toHaveBeenCalledWith({
			projectId: "proj-1",
			email: EMAIL,
		});
	});

	it("enrols on the idempotent already-a-member branch (invitation still PENDING)", async () => {
		dbMock.projectInvitation.findFirst.mockResolvedValue(
			livePendingInvitation(),
		);
		dbMock.projectMember.findUnique.mockResolvedValue(MEMBER);

		await acceptProjectInvitation("inv-1", "user-1", EMAIL);

		expect(dbMock.projectMember.create).not.toHaveBeenCalled();
		expect(mockEnrollIfEnabled).toHaveBeenCalledWith({
			projectId: "proj-1",
			email: EMAIL,
		});
	});

	it("does not enrol when the invitation is rejected", async () => {
		dbMock.projectInvitation.findFirst.mockResolvedValue(null);

		await expect(
			acceptProjectInvitation("inv-1", "user-1", EMAIL),
		).rejects.toThrow();
		expect(mockEnrollIfEnabled).not.toHaveBeenCalled();
	});

	it("returns the member and logs when enrolment throws", async () => {
		dbMock.projectInvitation.findFirst.mockResolvedValue(
			livePendingInvitation(),
		);
		dbMock.projectMember.findUnique.mockResolvedValue(null);
		dbMock.projectMember.create.mockResolvedValue(MEMBER);
		mockEnrollIfEnabled.mockRejectedValue(new Error("newsletter is down"));

		// Best-effort: the membership is the user's access, and it must survive
		// a newsletter outage.
		await expect(
			acceptProjectInvitation("inv-1", "user-1", EMAIL),
		).resolves.toMatchObject({ id: "member-1" });
		expect(logger.error).toHaveBeenCalled();
	});
});
