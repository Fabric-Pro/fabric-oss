import { call, ORPCError, os } from "@orpc/server";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	write: vi.fn(),
	access: vi.fn(),
	grant: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	recordAiOutcome: mocks.write,
	db: {},
	getOrganizationMembership: vi.fn(),
	getTenantContext: () => ({
		type: "organization",
		organizationId: "example-org",
		userId: "example-user",
	}),
	grantProjectAccess: mocks.grant,
}));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: mocks.access,
}));
vi.mock("../../../../../orpc/procedures", async () => {
	const guards = await import(
		"../../../../../orpc/middleware/require-permission"
	);
	return {
		tenantProtectedProcedure: os
			.$context<{
				user: { id: string };
				session: { activeOrganizationId: string };
				activeOrganizationRole: string | null;
				allowedProjectIds: string[];
				tenantContext: {
					type: "organization";
					userId: string;
					organizationId: string;
				};
			}>()
			.use(({ context, next }) => {
				if (!context.user?.id) {
					throw new ORPCError("UNAUTHORIZED");
				}
				return next();
			}),
		Permissions: (await import("@repo/permissions")).Permissions,
		requirePermission: guards.requirePermission,
		requireProjectPermission: guards.requireProjectPermission,
		resolveOrganizationId: (
			_input: undefined,
			session: { activeOrganizationId: string },
		) => session.activeOrganizationId,
	};
});

import { confirmAiDraft } from "../confirm-draft";

const context = {
	user: { id: "example-user" },
	session: { activeOrganizationId: "example-org" },
	activeOrganizationRole: "member" as string | null,
	allowedProjectIds: [] as string[],
	tenantContext: {
		type: "organization" as const,
		organizationId: "example-org",
		userId: "example-user",
	},
};
const input = {
	surface: "document" as const,
	projectId: "example-project",
	draftId: "example-draft",
	verdict: "rejected" as const,
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.access.mockResolvedValue({
		source: "project-member",
		organizationId: "example-org",
		permissions: [Permissions.PROJECT_UPDATE],
	});
});
describe("confirm draft permission middleware", () => {
	it.each(["none", "missing"])(
		"refuses another organization's caller with %s project access",
		async (source) => {
			mocks.access.mockResolvedValue(
				source === "missing"
					? null
					: {
							source: "none",
							organizationId: "example-other-org",
							permissions: [],
						},
			);
			await expect(
				call(confirmAiDraft, input, { context }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(mocks.write).not.toHaveBeenCalled();
		},
	);
	it("refuses a project viewer", async () => {
		mocks.access.mockResolvedValue({
			source: "project-member",
			organizationId: "example-org",
			permissions: [Permissions.PROJECT_READ],
		});
		await expect(
			call(confirmAiDraft, input, { context }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("permits invited project editors without organization membership", async () => {
		await call(confirmAiDraft, input, {
			context: { ...context, activeOrganizationRole: null },
		});
		expect(mocks.grant).toHaveBeenCalledWith(
			"example-project",
			"example-org",
		);
		expect(mocks.write).toHaveBeenCalledOnce();
	});
	it("refuses projectless callers without AI_CHAT", async () => {
		await expect(
			call(
				confirmAiDraft,
				{
					surface: "prompt-enhancer",
					draftId: "example-draft",
					verdict: "accepted",
				},
				{ context: { ...context, activeOrganizationRole: null } },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.write).not.toHaveBeenCalled();
	});

	it("requires analysis revision permission for topic rejections, even from a project editor", async () => {
		await expect(
			call(
				confirmAiDraft,
				{ ...input, surface: "topic-analysis" },
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.write).not.toHaveBeenCalled();
		mocks.access.mockResolvedValue({
			source: "project-member",
			organizationId: "example-org",
			permissions: [Permissions.PUBLISHING_TOPIC_UPDATE],
		});
		await call(
			confirmAiDraft,
			{ ...input, surface: "topic-analysis" },
			{ context },
		);
		expect(mocks.write).toHaveBeenCalledOnce();
	});
	it("refuses unauthenticated callers", async () => {
		await expect(
			call(confirmAiDraft, input, {
				context: { ...context, user: { id: "" } },
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.write).not.toHaveBeenCalled();
	});
});
