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
	canDelete: vi.fn(),
	publicRefusal: vi.fn(),
	listSharingGrants: vi.fn(),
	handler: null as Handler | null,
	output: null as ZodType | null,
}));

vi.mock("@repo/database", () => ({
	getFrameById: mocks.getFrameById,
	canDeleteOrganizationFrames: mocks.canDelete,
	publicSharingRefusal: mocks.publicRefusal,
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
		requireInputOrgPermission: vi.fn(),
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
	mocks.canDelete.mockResolvedValue(false);
	mocks.publicRefusal.mockResolvedValue(
		"Public sharing is disabled for this organization.",
	);
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
			mocks.getFrameById.mockResolvedValue({
				shareScope,
				updatedAt: new Date("2026-11-01T00:00:00Z"),
			});
			await expect(listGrants()).resolves.toEqual({
				shareScope,
				updatedAt: "2026-11-01T00:00:00.000Z",
				hasPublicLink: false,
				canRevoke: false,
				canShareFramesPublicly: false,
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

it("shows the existence of a legacy public link without exposing its bearer in metadata", async () => {
	mocks.getFrameById.mockResolvedValue({
		shareScope: "PRIVATE",
		isPublic: true,
		shareToken: "example-legacy-bearer",
		updatedAt: new Date("2026-11-01T00:00:00Z"),
	});
	const result = await listGrants();
	expect(result).toMatchObject({ hasPublicLink: true });
	expect(JSON.stringify(result)).not.toContain("example-legacy-bearer");
});

it("exposes current revocation capability without conflating it with sharing", async () => {
	mocks.getFrameById.mockResolvedValue({
		shareScope: "PRIVATE",
		updatedAt: new Date("2026-11-01T00:00:00Z"),
	});
	mocks.canDelete.mockResolvedValue(true);
	expect(await listGrants()).toMatchObject({ canRevoke: true });
	expect(mocks.canDelete).toHaveBeenCalledWith("owner-1", "org-1");
	mocks.canDelete.mockResolvedValue(false);
	expect(await listGrants()).toMatchObject({ canRevoke: false });
});

it("keeps a retained link visible but withholds its bearer while current public sharing policy is disabled", async () => {
	mocks.getFrameById.mockResolvedValue({
		shareScope: "PUBLIC",
		isPublic: true,
		shareToken: "example-retained-bearer",
		updatedAt: new Date("2026-11-01T00:00:00Z"),
	});
	const disabled = await listGrants();
	expect(disabled).toMatchObject({
		hasPublicLink: true,
		canShareFramesPublicly: false,
	});
	expect(disabled).not.toHaveProperty("shareToken");
	expect(mocks.publicRefusal).toHaveBeenCalledWith("org-1");
	mocks.publicRefusal.mockResolvedValue(null);
	expect(await listGrants()).toMatchObject({
		canShareFramesPublicly: true,
		shareToken: "example-retained-bearer",
	});
});
