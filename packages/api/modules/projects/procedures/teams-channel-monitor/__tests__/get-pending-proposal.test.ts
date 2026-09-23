/**
 * Unit tests for `getPendingProposalProcedure`: the project check, and the
 * additive `createdChangeIndexes` read from the application table — which,
 * unlike the `appliedChangeIndexes` mirror, never counts a duplicate skip.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		getProposal: vi.fn(),
		getAppliedChangeIndexes: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	getPendingBacklogProposal: mocks.getProposal,
	getAppliedChangeIndexes: mocks.getAppliedChangeIndexes,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.get = fn;
			return { _handler: fn };
		},
	});

	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_READ: "project:read" },
		requireProjectPermission: () => (c: unknown) => c,
	};
});

await import("../get-pending-proposal");

const input = {
	projectId: "project-1",
	organizationId: null,
	proposalId: "proposal-1",
};

function callGet() {
	const handler = handlers.get;
	if (!handler) {
		throw new Error("get handler was not captured");
	}
	return handler({ input });
}

beforeEach(() => {
	mocks.getProposal.mockReset();
	mocks.getAppliedChangeIndexes.mockReset();
});

describe("getPendingProposalProcedure", () => {
	it("returns the row plus the created indexes, sorted, apart from the mirror", async () => {
		mocks.getProposal.mockResolvedValue({
			id: "proposal-1",
			projectId: "project-1",
			appliedChangeIndexes: [3, 0, 2],
		});
		mocks.getAppliedChangeIndexes.mockResolvedValue(new Set([3, 0]));

		const result = await callGet();

		expect(mocks.getAppliedChangeIndexes).toHaveBeenCalledWith(
			"proposal-1",
		);
		expect(result).toEqual({
			id: "proposal-1",
			projectId: "project-1",
			appliedChangeIndexes: [3, 0, 2],
			createdChangeIndexes: [0, 3],
		});
	});

	it("is NOT_FOUND for another project's proposal, without reading its applications", async () => {
		mocks.getProposal.mockResolvedValue({
			id: "proposal-1",
			projectId: "project-2",
			appliedChangeIndexes: [],
		});

		await expect(callGet()).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.getAppliedChangeIndexes).not.toHaveBeenCalled();
	});

	it("is NOT_FOUND for a missing proposal", async () => {
		mocks.getProposal.mockResolvedValue(null);

		await expect(callGet()).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
