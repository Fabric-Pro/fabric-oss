/**
 * Unit tests for the BacklogProposalDraft claim/lifecycle queries — the
 * race-safety guarantees behind "one draft per (proposal, kind), shared across
 * users/tabs, never double-spent".
 *
 * Boundary mocked: Prisma client only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, FakePrismaKnownError } = vi.hoisted(() => {
	class FakePrismaKnownError extends Error {
		code: string;
		constructor(code: string) {
			super(code);
			this.code = code;
			this.name = "PrismaClientKnownRequestError";
		}
	}
	return {
		mocks: {
			findUnique: vi.fn(),
			findUniqueOrThrow: vi.fn(),
			findMany: vi.fn(),
			create: vi.fn(),
			updateMany: vi.fn(),
		},
		FakePrismaKnownError,
	};
});

vi.mock("../prisma/client", () => ({
	db: {
		backlogProposalDraft: {
			findUnique: mocks.findUnique,
			findUniqueOrThrow: mocks.findUniqueOrThrow,
			findMany: mocks.findMany,
			create: mocks.create,
			updateMany: mocks.updateMany,
		},
	},
}));

vi.mock("../prisma/generated/client", () => ({
	Prisma: { PrismaClientKnownRequestError: FakePrismaKnownError },
}));

import {
	cancelProposalDraft,
	claimProposalDraft,
	completeProposalDraft,
} from "../prisma/queries/projects/backlog-proposal-drafts";

const KEY = { proposalId: "prop-1", kind: "BUG" as const };

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
});

describe("claimProposalDraft — race-safe single claim", () => {
	it("no existing row → inserts RUNNING and claims it", async () => {
		mocks.findUnique.mockResolvedValue(null);
		mocks.create.mockResolvedValue({ ...KEY, status: "RUNNING" });

		const { claimed } = await claimProposalDraft({ ...KEY });

		expect(claimed).toBe(true);
		expect(mocks.create).toHaveBeenCalledOnce();
	});

	it("existing RUNNING row → reuses it, does NOT start a second draft", async () => {
		mocks.findUnique.mockResolvedValue({ ...KEY, status: "RUNNING" });

		const { claimed } = await claimProposalDraft({ ...KEY });

		expect(claimed).toBe(false);
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("existing COMPLETED row → reuses it (no re-draft, no re-spend)", async () => {
		mocks.findUnique.mockResolvedValue({ ...KEY, status: "COMPLETED" });

		const { claimed } = await claimProposalDraft({ ...KEY });

		expect(claimed).toBe(false);
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("lost the insert race (P2002) and the winner is RUNNING → defers, no dup", async () => {
		mocks.findUnique
			.mockResolvedValueOnce(null) // initial read: nothing yet
			.mockResolvedValueOnce({ ...KEY, status: "RUNNING" }); // winner's row
		mocks.create.mockRejectedValue(new FakePrismaKnownError("P2002"));

		const { claimed } = await claimProposalDraft({ ...KEY });

		expect(claimed).toBe(false);
	});

	it("re-claims a FAILED row when it wins the compare-and-set", async () => {
		mocks.findUnique.mockResolvedValue({ ...KEY, status: "FAILED" });
		mocks.updateMany.mockResolvedValue({ count: 1 });
		mocks.findUniqueOrThrow.mockResolvedValue({
			...KEY,
			status: "RUNNING",
		});

		const { claimed } = await claimProposalDraft({ ...KEY });

		expect(claimed).toBe(true);
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.updateMany).toHaveBeenCalledOnce();
	});

	it("loses the re-claim race on a CANCELLED row (count 0) → does NOT claim", async () => {
		mocks.findUnique.mockResolvedValue({ ...KEY, status: "CANCELLED" });
		mocks.updateMany.mockResolvedValue({ count: 0 });
		mocks.findUniqueOrThrow.mockResolvedValue({
			...KEY,
			status: "RUNNING",
		});

		const { claimed } = await claimProposalDraft({ ...KEY });

		expect(claimed).toBe(false);
	});
});

describe("completeProposalDraft — drop late results", () => {
	it("writes COMPLETED when the row is still RUNNING", async () => {
		mocks.updateMany.mockResolvedValue({ count: 1 });
		const wrote = await completeProposalDraft({
			...KEY,
			description: "drafted",
		});
		expect(wrote).toBe(true);
	});

	it("drops the result when the row is no longer RUNNING (cancelled mid-flight)", async () => {
		mocks.updateMany.mockResolvedValue({ count: 0 });
		const wrote = await completeProposalDraft({
			...KEY,
			description: "drafted",
		});
		expect(wrote).toBe(false);
	});
});

describe("cancelProposalDraft", () => {
	it("cancels a RUNNING draft and returns its workflowId for abort", async () => {
		mocks.findUnique.mockResolvedValue({
			...KEY,
			status: "RUNNING",
			workflowId: "wf-1",
		});
		mocks.updateMany.mockResolvedValue({ count: 1 });

		const res = await cancelProposalDraft({ ...KEY });

		expect(res).toEqual({ workflowId: "wf-1" });
	});

	it("returns null when there is no RUNNING draft to cancel", async () => {
		mocks.findUnique.mockResolvedValue({ ...KEY, status: "COMPLETED" });

		const res = await cancelProposalDraft({ ...KEY });

		expect(res).toBeNull();
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});
});
