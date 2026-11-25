import { os } from "@orpc/server";
import type { Prisma } from "@repo/database";
import { describe, expect, it, vi } from "vitest";

export const projectId = "example-project";
export const organizationId = "example-org";
export const otherOrganizationId = "example-other-org";
const ownerId = "example-owner";
export const userId = "example-user";
export const projectWhere = { projectId };
export const grantProjectAccess = vi.fn();
export const accessDb = {
	project: { findFirst: vi.fn(), findUnique: vi.fn() },
	member: { findFirst: vi.fn() },
	projectMember: { findFirst: vi.fn(), findUnique: vi.fn() },
};

export type ProjectTestContext = ReturnType<typeof projectContext>;

function projectContext(user: string, activeOrg: string, role: string | null) {
	return {
		user: { id: user, name: "Example", email: "dev@example.com" },
		session: { activeOrganizationId: activeOrg },
		tenantContext: {
			userId: user,
			type: "organization" as const,
			organizationId: activeOrg,
		},
		activeOrganizationRole: role,
		allowedProjectIds: [] as string[],
	};
}

const project = {
	id: projectId,
	organizationId,
	userId: ownerId,
	organization: { deletedAt: null },
};

export function installProjectRows(
	options: {
		role?: "VIEWER" | "PROJECT_ADMIN";
		localMember?: boolean;
		pending?: boolean;
		missing?: boolean;
	} = {},
) {
	const row = options.missing ? null : project;
	accessDb.project.findFirst.mockResolvedValue(row);
	accessDb.project.findUnique.mockResolvedValue(row);
	accessDb.member.findFirst.mockImplementation(async ({ where }) =>
		options.localMember && where.organizationId === organizationId
			? { id: "example-membership", role: "admin" }
			: null,
	);
	accessDb.projectMember.findUnique.mockResolvedValue(
		options.role
			? {
					role: options.role,
					acceptedAt: options.pending
						? null
						: new Date("2026-01-01T00:00:00Z"),
					expiresAt: null,
				}
			: null,
	);
	accessDb.projectMember.findFirst.mockResolvedValue(
		options.role && !options.pending
			? { id: "example-project-membership" }
			: null,
	);
}

export const guest = () =>
	projectContext(userId, otherOrganizationId, "member");
export const projectOwner = () =>
	projectContext(ownerId, organizationId, "admin");

type ProjectRequest = {
	name: string;
	run: (context: ProjectTestContext) => PromiseLike<unknown>;
	/** Viewer-level operations can be used by an invited viewer. */
	write?: boolean;
};

export function describeProjectAccess(
	requests: ProjectRequest[],
	assertNoEffects: () => void,
) {
	describe.each(requests)("$name project access", ({ run, write }) => {
		it("hides the project from an organization admin without project reach", async () => {
			installProjectRows({ localMember: true });
			await expect(
				run(projectContext(userId, organizationId, "admin")),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
				message: "Project not found",
			});
			assertNoEffects();
		});

		it("hides the project from a foreign member with a pending invitation", async () => {
			installProjectRows({ role: "PROJECT_ADMIN", pending: true });
			await expect(run(guest())).rejects.toMatchObject({
				code: "NOT_FOUND",
				message: "Project not found",
			});
			expect(grantProjectAccess).not.toHaveBeenCalled();
			assertNoEffects();
		});

		it("returns the same not-found result when the project is missing", async () => {
			installProjectRows({ role: "PROJECT_ADMIN", missing: true });
			await expect(run(guest())).rejects.toMatchObject({
				code: "NOT_FOUND",
				message: "Project not found",
			});
			assertNoEffects();
		});

		if (write) {
			it("denies a viewer's write even when the viewer is a host organization admin", async () => {
				installProjectRows({ role: "VIEWER", localMember: true });
				await expect(
					run(projectContext(userId, organizationId, "admin")),
				).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
				assertNoEffects();
			});
		}
	});
}

// Use the production object access query and permission middleware with the
// mocked rows above. The builder supplies the authenticated request context.
export async function projectAccessQuery() {
	const { hasProjectAccess } = await import(
		"@repo/database/prisma/queries/projects/projects"
	);
	return (project: string, user: string, organization?: string) =>
		hasProjectAccess(
			project,
			user,
			organization,
			accessDb as unknown as Prisma.TransactionClient,
		);
}

export async function projectProcedureTestExports() {
	const { requireProjectPermission } = await import(
		"../../../../../orpc/middleware/require-permission"
	);
	const { runWithProjectBindingHolder, resolveBoundOrganization } =
		await import("../../../../../lib/authorized-project-binding");
	const { Permissions } = await import("@repo/permissions");
	return {
		tenantProtectedProcedure: os
			.$context<ProjectTestContext>()
			.use(({ next }) => runWithProjectBindingHolder(() => next())),
		requireProjectPermission,
		Permissions,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: ProjectTestContext["session"],
		) => {
			const binding = resolveBoundOrganization(input);
			return binding.bound
				? binding.organizationId
				: (input ?? session.activeOrganizationId);
		},
	};
}
