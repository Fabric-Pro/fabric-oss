import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn() }));
vi.mock("../prisma/client", () => ({
	db: {
		agentDeploymentExecution: { findMany: h.find, updateMany: h.update },
	},
}));

import {
	claimAgentExecutionReceiptObservation,
	listAgentExecutionReceiptCandidates,
} from "../prisma/queries/agent-deployments/receipt-recovery";

const at = new Date("2026-01-01T00:00:00Z");
const row = {
	id: "example-receipt",
	userId: "example-user",
	organizationId: "example-org",
	status: "COMPLETED" as const,
	metadata: {
		fabricAdmission: { version: 1 },
		unrelated: { retained: true },
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	h.update.mockResolvedValue({ count: 1 });
});
describe("bounded receipt observation queries", () => {
	it("selects scoped unreceipted intents fairly and excludes model payloads/results", async () => {
		h.find.mockResolvedValue([]);
		await listAgentExecutionReceiptCandidates({ limit: 25, before: at });
		expect(h.find).toHaveBeenCalledWith(
			expect.objectContaining({
				take: 25,
				orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
				where: expect.objectContaining({
					organizationId: { not: null },
					runId: null,
					workflowId: { not: null },
					updatedAt: { lte: at },
				}),
			}),
		);
		const select = h.find.mock.calls[0]?.[0].select;
		expect(select.input).toBeUndefined();
		expect(select.output).toBeUndefined();
	});
	it.each([0, 26, 1.5, Number.NaN])(
		"rejects an invalid bound %s before IO",
		(limit) => {
			expect(() =>
				listAgentExecutionReceiptCandidates({ limit, before: at }),
			).toThrow();
			expect(h.find).not.toHaveBeenCalled();
		},
	);
	it("uses exact actor/org and metadata/status CAS without changing results or counts", async () => {
		expect(await claimAgentExecutionReceiptObservation(row, at)).toBe(true);
		expect(h.update).toHaveBeenCalledWith({
			where: {
				id: row.id,
				userId: row.userId,
				organizationId: row.organizationId,
				runId: null,
				status: row.status,
				metadata: { equals: row.metadata },
			},
			data: {
				metadata: {
					...row.metadata,
					fabricReceiptRecovery: { observedAt: at.toISOString() },
				},
			},
		});
	});
	it("does not claim a row changed by the worker", async () => {
		h.update.mockResolvedValue({ count: 0 });
		expect(await claimAgentExecutionReceiptObservation(row, at)).toBe(
			false,
		);
	});
	it("fails closed without organization or bounded object metadata", async () => {
		expect(
			await claimAgentExecutionReceiptObservation(
				{ ...row, organizationId: null },
				at,
			),
		).toBe(false);
		expect(
			await claimAgentExecutionReceiptObservation(
				{ ...row, metadata: null },
				at,
			),
		).toBe(false);
		expect(h.update).not.toHaveBeenCalled();
	});
});
