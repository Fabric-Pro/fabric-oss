/**
 * Approving a nomination: what it binds, what it closes, and who wins a race.
 *
 * FR18 says approving one nomination supersedes the others for that action. The
 * word doing the work is "for that action": closing every pending nomination
 * for the tier would silently discard proposals about entirely unrelated
 * actions that nobody has reviewed. That is the assertion worth having.
 *
 * FR23 says the reviewer may edit the action set before approving, so what gets
 * bound is what the REVIEWER settled on, not what the nominator proposed.
 *
 * And because "two people propose different prompts for the same action" is the
 * exact scenario the queue is built to display, two admins deciding at once is
 * a real sequence rather than a hypothetical one. The PENDING status is claimed
 * atomically before anything is bound, so the loser of that race never writes a
 * binding at all.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/prompt-nominations.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	bindToTargets,
	claimUpdateMany,
	txFindUnique,
	txFindMany,
	txUpdateMany,
	transaction,
} = vi.hoisted(() => {
	const txFindUnique = vi.fn();
	const txFindMany = vi.fn();
	const txUpdateMany = vi.fn();
	return {
		bindToTargets: vi.fn(),
		// The claim runs OUTSIDE the transaction, before binding — kept as its
		// own mock so a test can tell the claim apart from the supersede.
		claimUpdateMany: vi.fn(),
		txFindUnique,
		txFindMany,
		txUpdateMany,
		transaction: vi.fn(async (fn: any) =>
			fn({
				promptNomination: {
					findUnique: txFindUnique,
					findMany: txFindMany,
					updateMany: txUpdateMany,
				},
			}),
		),
	};
});

vi.mock("../prisma/client", () => ({
	db: {
		$transaction: transaction,
		promptNomination: {
			create: vi.fn(),
			update: vi.fn(),
			updateMany: claimUpdateMany,
			findMany: vi.fn(),
			findUnique: vi.fn(),
		},
	},
	Prisma: {},
}));

vi.mock("../prisma/queries/prompts", () => ({
	bindPromptVersionToTargets: bindToTargets,
}));

import { approvePromptNomination } from "../prisma/queries/prompt-nominations";

const DRAFTER = {
	targetKey: "test_case_drafter",
	documentType: "GENERAL",
	storyKind: null,
};
const REVISER = {
	targetKey: "test_case_step_reviser",
	documentType: "GENERAL",
	storyKind: null,
};

const approve = (targets = [DRAFTER]) =>
	approvePromptNomination({
		nominationId: "nom-1",
		reviewedById: "admin-1",
		targets: targets as any,
		promptVersionId: "pv-1",
		targetScope: "SYSTEM",
	});

describe("approvePromptNomination", () => {
	beforeEach(() => {
		bindToTargets.mockReset();
		bindToTargets.mockResolvedValue({ bound: 1 });
		claimUpdateMany.mockReset();
		claimUpdateMany.mockResolvedValue({ count: 1 });
		txFindUnique.mockReset();
		txFindUnique.mockResolvedValue({ id: "nom-1", status: "APPROVED" });
		txFindMany.mockReset();
		txFindMany.mockResolvedValue([]);
		txUpdateMany.mockReset();
		txUpdateMany.mockResolvedValue({ count: 0 });
	});

	it("binds the prompt as the default for the approved actions", async () => {
		await approve();

		expect(bindToTargets).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "SYSTEM",
				promptVersionId: "pv-1",
				isDefault: true,
				targets: [
					expect.objectContaining({ targetKey: "test_case_drafter" }),
				],
			}),
		);
	});

	it("binds what the reviewer settled on, not what was proposed", async () => {
		// FR23: the reviewer may add or remove actions before approving.
		await approve([REVISER]);

		expect(bindToTargets).toHaveBeenCalledWith(
			expect.objectContaining({
				targets: [
					expect.objectContaining({
						targetKey: "test_case_step_reviser",
					}),
				],
			}),
		);
		// And the row records the reviewer's set, not the original.
		expect(claimUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "APPROVED",
					targets: [REVISER],
				}),
			}),
		);
	});

	it("supersedes a competing nomination for the same action", async () => {
		txFindMany.mockResolvedValue([{ id: "nom-2", targets: [DRAFTER] }]);
		txUpdateMany.mockResolvedValue({ count: 1 });

		const result = await approve();

		expect(result.supersededCount).toBe(1);
		expect(txUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["nom-2"] } },
				data: expect.objectContaining({ status: "SUPERSEDED" }),
			}),
		);
	});

	it("leaves a nomination about a different action alone", async () => {
		// The rule is per action. Closing this would discard a proposal nobody
		// has reviewed, about something the approval did not touch.
		txFindMany.mockResolvedValue([{ id: "nom-2", targets: [REVISER] }]);

		const result = await approve();

		expect(result.supersededCount).toBe(0);
		expect(txUpdateMany).not.toHaveBeenCalled();
	});

	it("supersedes on any overlap, not only an exact match", async () => {
		txFindMany.mockResolvedValue([
			{ id: "nom-2", targets: [REVISER, DRAFTER] },
		]);

		const result = await approve();

		expect(result.supersededCount).toBe(1);
	});

	it("treats the same document type at different kinds as different actions", async () => {
		txFindMany.mockResolvedValue([
			{
				id: "nom-2",
				targets: [
					{
						targetKey: "project_document_generator",
						documentType: "DRAFT",
						storyKind: "BUG",
					},
				],
			},
		]);

		const result = await approvePromptNomination({
			nominationId: "nom-1",
			reviewedById: "admin-1",
			targets: [
				{
					targetKey: "project_document_generator",
					documentType: "DRAFT",
					storyKind: "FEATURE",
				},
			],
			promptVersionId: "pv-1",
			targetScope: "SYSTEM",
		});

		expect(result.supersededCount).toBe(0);
	});

	it("records who reviewed it and when", async () => {
		await approve();

		expect(claimUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					reviewedById: "admin-1",
					reviewedAt: expect.any(Date),
				}),
			}),
		);
	});
});

describe("two admins approving at once", () => {
	beforeEach(() => {
		// `transaction` is asserted on below, so its call history has to start
		// empty here rather than carrying over from the suite above.
		transaction.mockClear();
		bindToTargets.mockReset();
		bindToTargets.mockResolvedValue({ bound: 1 });
		claimUpdateMany.mockReset();
		txFindUnique.mockReset();
		txFindUnique.mockResolvedValue({ id: "nom-1" });
		txFindMany.mockReset();
		txFindMany.mockResolvedValue([]);
		txUpdateMany.mockReset();
		txUpdateMany.mockResolvedValue({ count: 0 });
	});

	it("claims the nomination only while it is still pending", async () => {
		claimUpdateMany.mockResolvedValue({ count: 1 });

		await approve();

		// The status IS the lock. Without PENDING in the where clause, a second
		// approval overwrites the first's record of who decided it.
		expect(claimUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "nom-1", status: "PENDING" },
			}),
		);
	});

	it("does not bind anything when the claim finds it already decided", async () => {
		// The loser of the race. Binding here is what makes the live default
		// depend on write ordering rather than on which approval was recorded.
		claimUpdateMany.mockResolvedValue({ count: 0 });

		await expect(approve()).rejects.toThrow(/already decided/i);
		expect(bindToTargets).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
	});

	it("hands the claim back if the binding fails", async () => {
		// Otherwise the nomination leaves the queue as APPROVED while the
		// default it promised was never actually changed — invisible, because
		// nobody looks at an approved nomination again.
		claimUpdateMany.mockResolvedValue({ count: 1 });
		bindToTargets.mockRejectedValue(new Error("db down"));

		await expect(approve()).rejects.toThrow(/db down/i);

		expect(claimUpdateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: { id: "nom-1", status: "APPROVED" },
				data: expect.objectContaining({ status: "PENDING" }),
			}),
		);
	});
});
