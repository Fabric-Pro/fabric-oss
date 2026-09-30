import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handler: null as null | ((arg: { input: any; context: any }) => unknown),
	getInstructionSnapshot: vi.fn(),
	canReviewInstructionProposals: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getInstructionSnapshot: (...args: unknown[]) =>
		m.getInstructionSnapshot(...args),
}));
vi.mock("../proposal-authorization", () => ({
	canReviewInstructionProposals: (...args: unknown[]) =>
		m.canReviewInstructionProposals(...args),
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...args: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...args),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const builder = {
		use: () => builder,
		route: () => builder,
		input: () => builder,
		handler: (handler: typeof m.handler) => {
			m.handler = handler;
			return handler;
		},
	};
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: () => ({}),
		Permissions: { INSTRUCTION_READ: "instruction:read" },
	};
});

import "../get-snapshot";

const input = { projectId: "p", snapshotId: "s1" };

beforeEach(() => {
	m.getInstructionSnapshot.mockReset().mockResolvedValue({ id: "s1" });
	m.canReviewInstructionProposals.mockReset().mockResolvedValue(false);
	m.resolveEffectiveProjectPermissions.mockReset().mockResolvedValue({
		organizationId: "org_1",
		permissions: [],
		source: "guest",
	});
});

describe("projects.instructions.getSnapshot", () => {
	it("reads a non-reviewer's snapshot through the visibility the list applies", async () => {
		await m.handler!({ input, context: { user: { id: "reader" } } });

		expect(m.getInstructionSnapshot).toHaveBeenCalledWith(
			"s1",
			"p",
			"org_1",
			{
				viewerUserId: "reader",
				canReviewProposals: false,
			},
		);
	});

	it("reads a reviewer's snapshot with reviewer visibility", async () => {
		m.canReviewInstructionProposals.mockResolvedValue(true);

		await m.handler!({ input, context: { user: { id: "editor" } } });

		expect(m.getInstructionSnapshot).toHaveBeenCalledWith(
			"s1",
			"p",
			"org_1",
			{
				viewerUserId: "editor",
				canReviewProposals: true,
			},
		);
	});

	it("answers NOT_FOUND when the query hides the snapshot from the viewer", async () => {
		m.getInstructionSnapshot.mockResolvedValue(null);

		await expect(
			m.handler!({ input, context: { user: { id: "reader" } } }),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Snapshot not found",
		});
	});
});
