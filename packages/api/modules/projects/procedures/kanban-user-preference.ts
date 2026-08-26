import { ORPCError } from "@orpc/client";
import { db, getProjectAccessById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

function getProjectUserPreferenceDelegate() {
	return (
		db as typeof db & {
			projectUserPreference?: {
				findUnique: (args: {
					where: {
						projectId_userId: {
							projectId: string;
							userId: string;
						};
					};
					select: { kanbanLocalRepoPath: true };
				}) => Promise<{ kanbanLocalRepoPath: string | null } | null>;
				upsert: (args: {
					where: {
						projectId_userId: {
							projectId: string;
							userId: string;
						};
					};
					create: {
						projectId: string;
						userId: string;
						organizationId: string | null;
						kanbanLocalRepoPath: string | null;
					};
					update: {
						organizationId: string | null;
						kanbanLocalRepoPath: string | null;
					};
					select: { kanbanLocalRepoPath: true };
				}) => Promise<{ kanbanLocalRepoPath: string | null }>;
			};
		}
	).projectUserPreference;
}

const kanbanPreferenceInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const getKanbanUserPreferenceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/kanban-preference",
		tags: ["Projects"],
		summary: "Get per-user kanban preference for a project",
	})
	.input(kanbanPreferenceInput)
	.output(
		z.object({
			kanbanLocalRepoPath: z.string().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const project = await getProjectAccessById(
			input.projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found or you don't have access",
			});
		}
		const projectUserPreferenceDelegate =
			getProjectUserPreferenceDelegate();
		const preference = projectUserPreferenceDelegate
			? await projectUserPreferenceDelegate.findUnique({
					where: {
						projectId_userId: {
							projectId: input.projectId,
							userId: context.user.id,
						},
					},
					select: { kanbanLocalRepoPath: true },
				})
			: null;
		return {
			kanbanLocalRepoPath: preference?.kanbanLocalRepoPath ?? null,
		};
	});

export const updateKanbanUserPreferenceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/kanban-preference",
		tags: ["Projects"],
		summary: "Update per-user kanban preference for a project",
	})
	.input(
		kanbanPreferenceInput.extend({
			kanbanLocalRepoPath: z.string().trim().nullable(),
		}),
	)
	.output(
		z.object({
			kanbanLocalRepoPath: z.string().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const project = await getProjectAccessById(
			input.projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found or you don't have access",
			});
		}
		const normalizedPath = input.kanbanLocalRepoPath?.trim() || null;
		const projectUserPreferenceDelegate =
			getProjectUserPreferenceDelegate();
		if (!projectUserPreferenceDelegate) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"Project user preferences are unavailable until the Prisma client is regenerated.",
			});
		}
		const preference = await projectUserPreferenceDelegate.upsert({
			where: {
				projectId_userId: {
					projectId: input.projectId,
					userId: context.user.id,
				},
			},
			create: {
				projectId: input.projectId,
				userId: context.user.id,
				organizationId: project.organizationId,
				kanbanLocalRepoPath: normalizedPath,
			},
			update: {
				organizationId: project.organizationId,
				kanbanLocalRepoPath: normalizedPath,
			},
			select: { kanbanLocalRepoPath: true },
		});
		return {
			kanbanLocalRepoPath: preference.kanbanLocalRepoPath,
		};
	});
