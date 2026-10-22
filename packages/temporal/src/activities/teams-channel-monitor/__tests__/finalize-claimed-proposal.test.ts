import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	row: {} as Record<string, any>,
	updateMany: vi.fn(),
	session: vi.fn(),
}));
vi.mock("@repo/database/prisma/client", () => ({
	db: {
		pendingBacklogProposal: {
			findUnique: async () => h.row,
			updateMany: (...args: any[]) => h.updateMany(...args),
		},
	},
}));
vi.mock("@repo/database", async () => ({
	...(await import(
		"../../../../../database/prisma/queries/projects/pending-backlog-proposals"
	)),
	db: {
		pendingBacklogProposal: {
			updateMany: (...args: any[]) => h.updateMany(...args),
		},
	},
	finalizeBacklogUpdateSession: (...args: any[]) => h.session(...args),
}));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("../../lib/job-progress", () => ({}));

import { finalizeClaimedProposalActivity } from "../fetch-channel-cursor";

const input = {
	proposalId: "example-proposal",
	applyWorkflowId: "example-workflow",
	outcome: "applied" as const,
};
beforeEach(() => {
	vi.resetAllMocks();
	h.row = {
		id: "example-proposal",
		source: "AI_UPDATE_SIDEBAR",
		status: "PENDING",
		applyWorkflowId: "example-workflow",
		applyStartedAt: new Date(),
	};
	h.updateMany.mockImplementation(async ({ where, data }: any) => {
		if (
			!Object.entries(where).every(([key, value]) => h.row[key] === value)
		) {
			return { count: 0 };
		}
		Object.assign(h.row, data);
		return { count: 1 };
	});
	h.session.mockResolvedValue(1);
});
describe("claimed finalization during rollout", () => {
	it.each(["applied", "failed"] as const)(
		"finalizes old PENDING dispatch with own id: %s",
		async (outcome) => {
			expect(
				await finalizeClaimedProposalActivity({
					...input,
					outcome,
					errorClass: "ExampleFailure",
					errorMessage: "Example error",
					rawApplyError: "Example details",
				}),
			).toEqual({ finalized: true, legacyFallback: true });
			expect(h.row.status).toBe(
				outcome === "applied" ? "APPLIED" : "FAILED",
			);
			if (outcome === "failed") {
				expect(h.row).toMatchObject({
					errorClass: "ExampleFailure",
					errorMessage: "Example error",
					applyError: "Example details",
					failedAt: expect.any(Date),
				});
			}
			expect(h.session).toHaveBeenCalledTimes(1);
		},
	);
	it.each([null, "example-other-workflow"])(
		"refuses PENDING with workflow id %s",
		async (applyWorkflowId) => {
			h.row.applyWorkflowId = applyWorkflowId;
			expect(await finalizeClaimedProposalActivity(input)).toEqual({
				finalized: false,
				legacyFallback: false,
			});
			expect(h.row.status).toBe("PENDING");
			expect(h.session).not.toHaveBeenCalled();
		},
	);
	it.each(["FAILED", "APPLYING", "PENDING"])(
		"does not clobber %s racing the legacy CAS",
		async (status) => {
			const update = h.updateMany.getMockImplementation();
			if (!update) {
				throw new Error("Missing row fixture");
			}
			h.updateMany.mockImplementation(async (args: any) => {
				if (args.where.status === "PENDING") {
					h.row.status = status;
					h.row.applyWorkflowId = "example-replacement";
				}
				return update(args);
			});
			expect(await finalizeClaimedProposalActivity(input)).toEqual({
				finalized: false,
				legacyFallback: false,
			});
			expect(h.row.status).toBe(status);
			expect(h.row.applyWorkflowId).toBe("example-replacement");
			expect(h.session).not.toHaveBeenCalled();
		},
	);
	it("still finalizes the ordinary APPLYING claim", async () => {
		h.row.status = "APPLYING";
		expect(await finalizeClaimedProposalActivity(input)).toEqual({
			finalized: true,
			legacyFallback: false,
		});
		expect(h.row.status).toBe("APPLIED");
	});
});
