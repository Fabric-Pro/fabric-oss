import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";

type Handler = (args: {
	input: { id: string; organizationId: string };
	context: { user: { id: string }; session: Record<string, unknown> };
}) => Promise<unknown>;

interface Procedure {
	use: () => Procedure;
	route: () => Procedure;
	input: () => Procedure;
	output: (schema: ZodType) => Procedure;
	handler: (handler: Handler) => Handler;
}

const mocks = vi.hoisted(() => ({
	getFrameById: vi.fn(),
	listSharingGrants: vi.fn(),
	handler: null as Handler | null,
	output: null as ZodType | null,
}));

vi.mock("@repo/database", () => ({
	getFrameById: mocks.getFrameById,
	listSharingGrants: mocks.listSharingGrants,
}));

vi.mock("../../../../orpc/procedures", () => {
	const procedure: Procedure = {
		use: () => procedure,
		route: () => procedure,
		input: () => procedure,
		output: (schema) => {
			mocks.output = schema;
			return procedure;
		},
		handler: (handler) => {
			mocks.handler = handler;
			return handler;
		},
	};
	return {
		tenantProtectedProcedure: procedure,
		Permissions: { WORKSPACE_READ: "workspace.read" },
		requirePermission: vi.fn(),
		resolveOrganizationId: (id: string) => id,
	};
});

import "../list-grants";

async function listGrants() {
	if (!mocks.handler || !mocks.output) {
		throw new Error("List grants procedure was not registered");
	}
	return mocks.output.parse(
		await mocks.handler({
			input: { id: "frame-1", organizationId: "org-1" },
			context: { user: { id: "owner-1" }, session: {} },
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.listSharingGrants.mockResolvedValue([]);
});

describe("frames.listGrants", () => {
	it.each([
		"PRIVATE",
		"PROJECT",
		"PUBLIC",
		"EMAILS_ONLY",
		"WORKSPACE_AND_EMAILS",
	])(
		"validates the actual %s access scope without narrowing it",
		async (shareScope) => {
			mocks.getFrameById.mockResolvedValue({ shareScope });
			await expect(listGrants()).resolves.toEqual({
				shareScope,
				grants: [],
			});
			expect(mocks.getFrameById).toHaveBeenCalledWith({
				id: "frame-1",
				userId: "owner-1",
				organizationId: "org-1",
			});
		},
	);

	it("does not list grants for a frame outside the owner's access", async () => {
		mocks.getFrameById.mockResolvedValue(null);
		await expect(listGrants()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.listSharingGrants).not.toHaveBeenCalled();
	});
});
