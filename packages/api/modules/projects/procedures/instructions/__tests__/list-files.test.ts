import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handler: null as
		| null
		| ((args: {
				input: Record<string, unknown>;
				context: { user: { id: string } };
		  }) => Promise<unknown>),
	getInstructionSnapshot: vi.fn(),
	listInstructionFiles: vi.fn(),
	requireHostingOrganizationId: vi.fn(),
	assertMutationAccess: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getInstructionSnapshot: (...args: unknown[]) =>
		m.getInstructionSnapshot(...args),
	listInstructionFiles: (...args: unknown[]) =>
		m.listInstructionFiles(...args),
}));
vi.mock("../hosting-organization", () => ({
	requireHostingOrganizationId: (...args: unknown[]) =>
		m.requireHostingOrganizationId(...args),
}));
vi.mock("../proposal-authorization", () => ({
	isInstructionSnapshotContentReadable: (snapshot: {
		status: string;
		proposalStatus: string | null;
	}) =>
		snapshot.status === "READY" &&
		(snapshot.proposalStatus === null ||
			snapshot.proposalStatus === "APPROVED"),
	assertInstructionSnapshotMutationAccess: (...args: unknown[]) =>
		m.assertMutationAccess(...args),
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

import "../list-files";

const input = {
	projectId: "project_1",
	snapshotId: "proposal_1",
	includeReceiving: true,
};

beforeEach(() => {
	vi.clearAllMocks();
	m.requireHostingOrganizationId.mockResolvedValue("org_1");
	m.getInstructionSnapshot.mockResolvedValue({
		id: "proposal_1",
		status: "RECEIVING",
		userId: "reader_1",
		proposalStatus: "PENDING",
	});
	m.listInstructionFiles.mockResolvedValue([
		{ id: "file_1", path: "CLAUDE.md" },
	]);
});

describe("listFiles includeReceiving authorization", () => {
	it("allows the proposal owner after the live mutation-access check", async () => {
		m.assertMutationAccess.mockResolvedValue(undefined);

		await expect(
			m.handler?.({ input, context: { user: { id: "reader_1" } } }),
		).resolves.toEqual([{ id: "file_1", path: "CLAUDE.md" }]);
		expect(m.assertMutationAccess).toHaveBeenCalledWith({
			projectId: "project_1",
			userId: "reader_1",
			snapshot: expect.objectContaining({ id: "proposal_1" }),
		});
	});

	it("does not enumerate paths when another reader fails the owner check", async () => {
		m.assertMutationAccess.mockRejectedValue(
			Object.assign(new Error("forbidden"), { code: "FORBIDDEN" }),
		);

		await expect(
			m.handler?.({ input, context: { user: { id: "reader_2" } } }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.listInstructionFiles).not.toHaveBeenCalled();
	});
});
