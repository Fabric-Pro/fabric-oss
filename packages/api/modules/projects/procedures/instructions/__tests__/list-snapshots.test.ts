import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handler: null as null | ((arg: { input: any; context: any }) => unknown),
	listInstructionSnapshots: vi.fn(),
	canReviewInstructionProposals: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listInstructionSnapshots: (...args: unknown[]) =>
		m.listInstructionSnapshots(...args),
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

import "../list-snapshots";

beforeEach(() => {
	m.listInstructionSnapshots.mockReset().mockResolvedValue([]);
	m.canReviewInstructionProposals.mockReset().mockResolvedValue(false);
	m.resolveEffectiveProjectPermissions.mockReset().mockResolvedValue({
		organizationId: "org_1",
		permissions: [],
		source: "guest",
	});
});

describe("projects.instructions.listSnapshots", () => {
	it("passes query-level owner visibility for a non-reviewer", async () => {
		await m.handler!({
			input: { projectId: "p" },
			context: { user: { id: "reader" } },
		});

		expect(m.listInstructionSnapshots).toHaveBeenCalledWith("p", "org_1", {
			viewerUserId: "reader",
			canReviewProposals: false,
		});
	});

	it("allows a reviewer to see all proposal history", async () => {
		m.canReviewInstructionProposals.mockResolvedValue(true);
		await m.handler!({
			input: { projectId: "p" },
			context: { user: { id: "editor" } },
		});

		expect(m.listInstructionSnapshots).toHaveBeenCalledWith("p", "org_1", {
			viewerUserId: "editor",
			canReviewProposals: true,
		});
	});
});
