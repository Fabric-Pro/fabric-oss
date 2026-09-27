/**
 * `checkBranchProposalReadiness` (Fizzy #2738 spec §6 item 12): #2563's
 * readiness for the branch's head proposal, with #2563's 6 h validation
 * clock kept on the database clock, so a continued-as-new or restarted
 * branch workflow keeps it. The clock starts at the snapshot's creation and
 * restarts at a recorded VALIDATION_FAILED. Every identifier is synthetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getProposalOperation: vi.fn(),
	getBranchProposal: vi.fn(),
	checkInstructionProposalReadiness: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	getProposalOperation: h.getProposalOperation,
	getBranchProposal: h.getBranchProposal,
}));
vi.mock(
	"../src/activities/instruction-proposal-pull-requests",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../src/activities/instruction-proposal-pull-requests")
		>()),
		checkInstructionProposalReadiness: h.checkInstructionProposalReadiness,
	}),
);

import { checkBranchProposalReadiness } from "../src/activities/instruction-proposal-branches";
import { PROPOSAL_VALIDATION_CLOCK_MS } from "../src/lib/instruction-proposal-pull-request-types";

const ORG = "org_example";
const PROJECT = "proj_example";
const BRANCH = "branch_example";
const SNAPSHOT = "snap_example";
const NOW = new Date("2026-09-26T12:00:00.000Z");
const MINUTE_MS = 60 * 1000;

const input = {
	branchId: BRANCH,
	organizationId: ORG,
	projectId: PROJECT,
	snapshotId: SNAPSHOT,
};

function operation(over: {
	createdAt: Date;
	pullRequestFailure?: unknown;
	pullRequestOperationId?: string | null;
}) {
	return {
		id: SNAPSHOT,
		projectId: PROJECT,
		organizationId: ORG,
		pullRequestOperationId: "pr_op_example",
		pullRequestFailure: null,
		databaseNow: NOW,
		...over,
	};
}

const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("checkBranchProposalReadiness (spec §6 item 12)", () => {
	beforeEach(() => {
		h.getProposalOperation.mockReset();
		h.getBranchProposal.mockReset();
		h.checkInstructionProposalReadiness.mockReset();
		h.getBranchProposal.mockResolvedValue({ proposalBranchId: BRANCH });
		h.checkInstructionProposalReadiness.mockResolvedValue({
			kind: "pending",
		});
	});

	it("delegates to #2563's readiness with the row's ids and answers its kind", async () => {
		h.getProposalOperation.mockResolvedValue(
			operation({ createdAt: ago(MINUTE_MS) }),
		);
		h.checkInstructionProposalReadiness.mockResolvedValue({
			kind: "ready",
			attempt: 3,
		});
		expect(await checkBranchProposalReadiness(input)).toEqual({
			kind: "ready",
		});
		expect(h.getProposalOperation).toHaveBeenCalledWith({
			snapshotId: SNAPSHOT,
			projectId: PROJECT,
			organizationId: ORG,
		});
		expect(h.checkInstructionProposalReadiness).toHaveBeenCalledWith({
			snapshotId: SNAPSHOT,
			projectId: PROJECT,
			organizationId: ORG,
			operationId: "pr_op_example",
			deadlineReached: false,
		});
	});

	it.each([
		[
			"just under 6 h since creation",
			PROPOSAL_VALIDATION_CLOCK_MS - 1,
			false,
		],
		["exactly 6 h since creation", PROPOSAL_VALIDATION_CLOCK_MS, true],
		[
			"more than 6 h since creation",
			PROPOSAL_VALIDATION_CLOCK_MS + MINUTE_MS,
			true,
		],
	])("the clock on the database: %s", async (_name, age, reached) => {
		h.getProposalOperation.mockResolvedValue(
			operation({ createdAt: ago(age) }),
		);
		await checkBranchProposalReadiness(input);
		expect(h.checkInstructionProposalReadiness).toHaveBeenCalledWith(
			expect.objectContaining({ deadlineReached: reached }),
		);
	});

	it("a recorded VALIDATION_FAILED restarts the clock; any other failure does not", async () => {
		const old = ago(PROPOSAL_VALIDATION_CLOCK_MS + MINUTE_MS);
		h.getProposalOperation.mockResolvedValueOnce(
			operation({
				createdAt: old,
				pullRequestFailure: {
					code: "VALIDATION_FAILED",
					at: ago(MINUTE_MS).toISOString(),
				},
			}),
		);
		await checkBranchProposalReadiness(input);
		expect(h.checkInstructionProposalReadiness).toHaveBeenLastCalledWith(
			expect.objectContaining({ deadlineReached: false }),
		);
		h.getProposalOperation.mockResolvedValueOnce(
			operation({
				createdAt: old,
				pullRequestFailure: {
					code: "PUSH_OUTCOME_UNKNOWN",
					at: ago(MINUTE_MS).toISOString(),
				},
			}),
		);
		await checkBranchProposalReadiness(input);
		expect(h.checkInstructionProposalReadiness).toHaveBeenLastCalledWith(
			expect.objectContaining({ deadlineReached: true }),
		);
	});

	it.each([
		["no snapshot row", null, { proposalBranchId: BRANCH }],
		[
			"no pull-request operation",
			operation({ createdAt: NOW, pullRequestOperationId: null }),
			{ proposalBranchId: BRANCH },
		],
		[
			"a proposal that left the branch",
			operation({ createdAt: NOW }),
			{ proposalBranchId: "branch_elsewhere" },
		],
		["no branch proposal", operation({ createdAt: NOW }), null],
	])("stops without asking #2563 on %s", async (_name, row, placed) => {
		h.getProposalOperation.mockResolvedValue(row);
		h.getBranchProposal.mockResolvedValue(placed);
		expect(await checkBranchProposalReadiness(input)).toEqual({
			kind: "stop",
		});
		expect(h.checkInstructionProposalReadiness).not.toHaveBeenCalled();
	});
});
