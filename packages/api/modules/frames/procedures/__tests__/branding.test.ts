import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ get: vi.fn(), apply: vi.fn() }));
vi.mock("@repo/database", () => ({
	getFrameBranding: m.get,
	applyFrameBranding: m.apply,
	ArtifactBrandingError: class extends Error {
		constructor(readonly code: string) {
			super(code);
		}
	},
}));
vi.mock("../../../../orpc/procedures", () => {
	const chain: any = {
		use: () => chain,
		input: () => chain,
		handler: (fn: unknown) => ({ _handler: fn }),
	};
	return {
		tenantProtectedProcedure: chain,
		Permissions: {
			WORKSPACE_READ: "workspace:read",
			WORKSPACE_UPDATE: "workspace:update",
		},
		requireInputOrgPermission: () => undefined,
		resolveOrganizationId: () => "example-org",
	};
});
vi.mock("../../lib/frame-edit-errors", () => ({ frameEditErrors: undefined }));

import { ArtifactBrandingError } from "@repo/database";
import { getFrameBrandingProcedure } from "../branding";

beforeEach(() => vi.resetAllMocks());
it("maps an inaccessible project brand behind a named Frame grant to NOT_FOUND", async () => {
	m.get.mockRejectedValue(new ArtifactBrandingError("NOT_FOUND"));
	await expect(
		(getFrameBrandingProcedure as any)._handler({
			input: { id: "example-frame" },
			context: {
				user: { id: "example-user", email: "dev@example.com" },
				session: {},
			},
		}),
	).rejects.toMatchObject({ code: "NOT_FOUND" });
});
