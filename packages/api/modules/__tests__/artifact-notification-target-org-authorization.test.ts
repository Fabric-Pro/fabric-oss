import { ORPCError } from "@orpc/server";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Middleware = (
	args: {
		context: Record<string, unknown>;
		next: () => Promise<unknown>;
	},
	input: unknown,
) => Promise<unknown>;

const { handlers, mounted, mocks } = vi.hoisted(() => ({
	handlers: [] as Array<
		(args: {
			input: Record<string, unknown>;
			context: Record<string, unknown>;
		}) => Promise<unknown>
	>,
	mounted: [] as Middleware[],
	mocks: {
		getOrganizationMembership: vi.fn(),
		getTenantContext: vi.fn(() => ({ effectiveWriteOrgId: undefined })),
		hasOrganizationTie: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: vi.fn() },
		member: { findFirst: vi.fn(), findUnique: vi.fn() },
		projectMember: { findUnique: vi.fn() },
		notification: {
			findMany: vi.fn(),
			updateMany: vi.fn(),
			count: vi.fn(),
		},
		user: { findMany: vi.fn() },
		organization: { findMany: vi.fn() },
	},
	NotificationCategory: { SYSTEM: "SYSTEM" },
	NotificationType: { SYSTEM_INCIDENT: "SYSTEM_INCIDENT" },
	getOrganizationMembership: mocks.getOrganizationMembership,
	getTenantContext: mocks.getTenantContext,
	hasOrganizationTie: mocks.hasOrganizationTie,
	grantProjectAccess: vi.fn(),
	getChatArtifact: vi.fn(),
	listChatArtifacts: vi.fn(),
	deleteChatArtifact: vi.fn(),
	initializeMemoryFromTemplate: vi.fn(),
	listMemoryFiles: vi.fn(),
}));
vi.mock("../../lib/notification-cache", () => ({
	getCachedUnreadCount: vi.fn(),
	setCachedUnreadCount: vi.fn(),
	invalidateUnreadCount: vi.fn(),
}));
vi.mock("../../orpc/procedures", async () => {
	const { requireInputOrgPermission, requirePermission } = await import(
		"../../orpc/middleware/require-permission"
	);
	const { Permissions: permissionValues } = await import("@repo/permissions");
	const chain = {
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (
			handler: (args: {
				input: Record<string, unknown>;
				context: Record<string, unknown>;
			}) => Promise<unknown>,
		) => {
			handlers.push(handler);
			return chain;
		},
	};
	return {
		Permissions: permissionValues,
		requireInputOrgPermission,
		requirePermission,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) =>
			(input === undefined ? session.activeOrganizationId : input) ??
			undefined,
		resolveOrganizationIdForCaller: async (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
			userId: string,
		) => {
			const organizationId =
				(input === undefined ? session.activeOrganizationId : input) ??
				undefined;
			if (!organizationId) {
				return undefined;
			}
			if (!(await mocks.hasOrganizationTie(userId, organizationId))) {
				throw new ORPCError("FORBIDDEN", {
					message: "You do not have access to this organization",
				});
			}
			return organizationId;
		},
		tenantProtectedProcedure: {
			use: (middleware: Middleware) => {
				mounted.push(middleware);
				return chain;
			},
		},
	};
});

await import("../artifacts/procedures/get");
await import("../artifacts/procedures/list");
await import("../artifacts/procedures/delete");
await import("../notifications/procedures/list");
await import("../notifications/procedures/archive");
await import("../notifications/procedures/restore");
await import("../notifications/procedures/mark-all-read");
await import("../notifications/procedures/unread-count");
await import("../agent-memory/procedures/initialize-memory");

const { PERMISSION_MIDDLEWARE_TAG } = await import(
	"../../orpc/middleware/require-permission"
);

const membershipCases = [
	["artifacts.get", Permissions.REPORT_READ],
	["artifacts.list", Permissions.REPORT_READ],
	["artifacts.delete", Permissions.REPORT_DELETE],
	["agent-memory.initialize", Permissions.AI_MEMORY_MANAGE],
] as const;

const notificationCases = [
	["notifications.list", Permissions.NOTIFICATIONS_READ, 3],
	["notifications.archive", Permissions.NOTIFICATIONS_WRITE, 4],
	["notifications.restore", Permissions.NOTIFICATIONS_WRITE, 5],
	["notifications.mark-all-read", Permissions.NOTIFICATIONS_READ, 6],
	["notifications.unread-count", Permissions.NOTIFICATIONS_READ, 7],
] as const;

const context = {
	user: { id: "example-user" },
	session: { activeOrganizationId: "example-org-a" },
	activeOrganizationRole: "owner",
	tenantContext: {
		userId: "example-user",
		type: "organization",
		organizationId: "example-org-a",
	},
};

beforeEach(async () => {
	vi.clearAllMocks();
	mocks.getTenantContext.mockReturnValue({
		effectiveWriteOrgId: undefined,
	});
	mocks.hasOrganizationTie.mockResolvedValue(true);
	const { db } = await import("@repo/database");
	vi.mocked(db.notification.findMany).mockResolvedValue([]);
	vi.mocked(db.notification.updateMany).mockResolvedValue({ count: 0 });
	vi.mocked(db.notification.count).mockResolvedValue(0);
});

describe.each(membershipCases)(
	"%s target organization authorization",
	(name, permission) => {
		const middleware =
			mounted[
				[
					"artifacts.get",
					"artifacts.list",
					"artifacts.delete",
					"notifications.list",
					"notifications.archive",
					"notifications.restore",
					"notifications.mark-all-read",
					"notifications.unread-count",
					"agent-memory.initialize",
				].indexOf(name)
			];

		it("refuses a session-org owner who is not a member of the input organization", async () => {
			mocks.getOrganizationMembership.mockResolvedValue(null);
			const next = vi.fn().mockResolvedValue({ output: "ok" });

			const error = await middleware(
				{ context, next },
				{ organizationId: "example-org-b" },
			).then(
				() => null,
				(caught: unknown) => caught,
			);

			expect(error).toBeInstanceOf(ORPCError);
			expect(error).toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
				"example-org-b",
				"example-user",
			);
			expect(next).not.toHaveBeenCalled();
		});

		it("admits a member of the input organization with the required permission", async () => {
			mocks.getOrganizationMembership.mockResolvedValue({
				role: "admin",
				organization: { deletedAt: null },
			});
			const next = vi.fn().mockResolvedValue({ output: "ok" });

			await middleware(
				{ context, next },
				{ organizationId: "example-org-b" },
			);

			expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
				"example-org-b",
				"example-user",
			);
			expect(next).toHaveBeenCalledTimes(1);
			expect(
				(middleware as Middleware & Record<symbol, string>)[
					PERMISSION_MIDDLEWARE_TAG
				],
			).toBe(permission);
		});

		it("refuses an explicit null organization before data access", async () => {
			const next = vi.fn().mockResolvedValue({ output: "ok" });

			const error = await middleware(
				{ context, next },
				{ organizationId: null },
			).then(
				() => null,
				(caught: unknown) => caught,
			);

			expect(error).toBeInstanceOf(ORPCError);
			expect(error).toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.getOrganizationMembership).not.toHaveBeenCalled();
			expect(next).not.toHaveBeenCalled();
		});
	},
);

describe.each(notificationCases)(
	"%s organization-tie authorization",
	(name, permission, index) => {
		const middleware = mounted[index];
		const handler = handlers[index];
		const input =
			name.includes("archive") || name.includes("restore")
				? {
						organizationId: "example-org-b",
						ids: ["example-notification"],
					}
				: { organizationId: "example-org-b" };

		const invoke = (
			procedureInput: Record<string, unknown>,
			invocationContext = context,
		) =>
			middleware(
				{
					context: invocationContext,
					next: () =>
						handler({
							input: procedureInput,
							context: invocationContext,
						}),
				},
				procedureInput,
			);

		it("admits an accepted project guest of the input organization", async () => {
			mocks.getOrganizationMembership.mockResolvedValue(null);
			mocks.hasOrganizationTie.mockResolvedValue(true);

			await expect(invoke(input)).resolves.toBeDefined();
			expect(mocks.hasOrganizationTie).toHaveBeenCalledWith(
				"example-user",
				"example-org-b",
			);
			expect(
				(middleware as Middleware & Record<symbol, string>)[
					PERMISSION_MIDDLEWARE_TAG
				],
			).toBe(permission);
		});

		if (name.includes("archive") || name.includes("restore")) {
			it.each(["viewer", "member"] as const)(
				"admits an organization %s using the real role permission set",
				async (role) => {
					mocks.hasOrganizationTie.mockResolvedValue(true);

					await expect(
						invoke(input, {
							...context,
							activeOrganizationRole: role,
						}),
					).resolves.toBeDefined();
				},
			);
		}

		it("refuses a caller with no tie to the input organization", async () => {
			mocks.hasOrganizationTie.mockResolvedValue(false);

			await expect(invoke(input)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			const { db } = await import("@repo/database");
			expect(db.notification.findMany).not.toHaveBeenCalled();
			expect(db.notification.updateMany).not.toHaveBeenCalled();
			expect(db.notification.count).not.toHaveBeenCalled();
		});

		it("refuses an explicit null organization before data access", async () => {
			await expect(
				invoke({ ...input, organizationId: null }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.hasOrganizationTie).not.toHaveBeenCalled();
			const { db } = await import("@repo/database");
			expect(db.notification.findMany).not.toHaveBeenCalled();
			expect(db.notification.updateMany).not.toHaveBeenCalled();
			expect(db.notification.count).not.toHaveBeenCalled();
		});
	},
);
