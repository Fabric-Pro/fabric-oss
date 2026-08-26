import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requirePermission,
} from "../../../orpc/procedures";

export const updateLastActiveWorkspaceProcedure = protectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/users/last-active-workspace",
		tags: ["Users"],
		summary: "Persist last active workspace",
		description:
			"Stores the organization ID (or null for personal workspace) the user was last active in, so they can be routed back on next login.",
	})
	.input(
		z.object({
			organizationId: z.string().nullable(),
		}),
	)
	.output(
		z.object({
			success: z.literal(true),
		}),
	)
	.handler(async ({ context: { user }, input: { organizationId } }) => {
		await db.user.update({
			where: { id: user.id },
			data: { lastActiveOrganizationId: organizationId },
		});
		return { success: true as const };
	});
