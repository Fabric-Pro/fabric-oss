import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { hasPermission } from "@repo/permissions";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { resolveHostingOrganizationAccess } from "../hosting-organization";
import {
	grantMemberAccess,
	type InstructionsRepositoryTarget,
	listMemberAccess,
	loadInstructionsRepositoryTarget,
	MAX_GRANTS_PER_REQUEST,
	revokeMemberAccess,
} from "./member-access";

/**
 * "Plugin access" on the Coding Instructions tab (spec 2026-11-04 §4.4, the
 * on-request mode): project members get read access to the project's private
 * instructions repository on GitHub so they can install the plugin.
 *
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible
 * (`hasProjectAccess`) on all three; `list` needs INSTRUCTION_READ, `grant`
 * and `revoke` PROJECT_SETTINGS_EDIT, which the handlers re-check against the
 * same resolution before calling GitHub. The organization is the project's
 * own, resolved server-side; a caller-supplied `organizationId` never
 * chooses it.
 */

async function resolveScope(projectId: string, userId: string) {
	const access = await resolveHostingOrganizationAccess(projectId, userId);
	const project = await db.project.findFirst({
		where: { id: projectId, organizationId: access.organizationId },
		select: { name: true },
	});
	if (!project) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}
	const canGrant =
		access.source === "owner" ||
		hasPermission(access.permissions, Permissions.PROJECT_SETTINGS_EDIT);
	return {
		organizationId: access.organizationId,
		projectName: project.name,
		canGrant,
	};
}

async function requireGrantTarget(
	projectId: string,
	userId: string,
): Promise<InstructionsRepositoryTarget> {
	const scope = await resolveScope(projectId, userId);
	if (!scope.canGrant) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"Changing who can read the instructions repository needs permission to edit the project's settings.",
		});
	}
	const target = await loadInstructionsRepositoryTarget({
		projectId,
		projectName: scope.projectName,
		organizationId: scope.organizationId,
	});
	if (!target) {
		throw new ORPCError("NOT_FOUND", {
			message:
				"This project's coding instructions are not read from a GitHub repository.",
		});
	}
	return target;
}

const projectInput = {
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
};

export const listInstructionsMemberAccessProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/member-access",
		tags: ["Projects", "Instructions"],
		summary:
			"List project members' read access to the coding-instructions repository",
	})
	.input(z.object(projectInput))
	.handler(async ({ input, context }) => {
		const scope = await resolveScope(input.projectId, context.user.id);
		const target = await loadInstructionsRepositoryTarget({
			projectId: input.projectId,
			projectName: scope.projectName,
			organizationId: scope.organizationId,
		});
		return listMemberAccess({
			target,
			callerId: context.user.id,
			canGrant: scope.canGrant,
		});
	});

export const grantInstructionsMemberAccessProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/member-access/grant",
		tags: ["Projects", "Instructions"],
		summary:
			"Give project members read access to the coding-instructions repository",
	})
	.input(
		z
			.object({
				...projectInput,
				userIds: z
					.array(z.string().min(1))
					.min(1)
					.max(MAX_GRANTS_PER_REQUEST)
					.optional(),
				all: z.literal(true).optional(),
				/** Acknowledges that a personal repository gives write access. */
				confirmPersonalWriteAccess: z.boolean().optional(),
			})
			.refine((value) => (value.all === true) !== !!value.userIds, {
				message: "Pass either userIds or all: true",
			}),
	)
	.handler(async ({ input, context }) => {
		const target = await requireGrantTarget(
			input.projectId,
			context.user.id,
		);
		return grantMemberAccess({
			target,
			context,
			callerId: context.user.id,
			userIds: input.all ? "all" : (input.userIds ?? []),
			confirmPersonalWriteAccess:
				input.confirmPersonalWriteAccess ?? false,
		});
	});

export const revokeInstructionsMemberAccessProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/member-access/revoke",
		tags: ["Projects", "Instructions"],
		summary:
			"Take back read access to the coding-instructions repository that Fabric granted a member",
	})
	.input(z.object({ ...projectInput, userId: z.string().min(1) }))
	.handler(async ({ input, context }) => {
		const target = await requireGrantTarget(
			input.projectId,
			context.user.id,
		);
		return revokeMemberAccess({ target, context, userId: input.userId });
	});
