import { ORPCError } from "@orpc/client";
import { createStoryStatus, Prisma } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

export const createStoryStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/statuses",
		tags: ["Projects", "Stories"],
		summary: "Create story status",
		description: "Create a new story status (Kanban column)",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			name: z.string().min(1).max(50),
			color: z
				.string()
				.regex(/^#[0-9A-Fa-f]{6}$/, "Must be a valid hex color"),
			order: z.number().int().min(0),
			isDefault: z.boolean().optional(),
			isFinal: z.boolean().optional(),
		}),
	)
	.handler(async ({ input }) => {
		try {
			const status = await createStoryStatus({
				projectId: input.projectId,
				name: input.name,
				color: input.color,
				order: input.order,
				isDefault: input.isDefault,
				isFinal: input.isFinal,
			});

			return { status };
		} catch (err) {
			if (
				err instanceof Prisma.PrismaClientKnownRequestError &&
				err.code === "P2002"
			) {
				throw new ORPCError("BAD_REQUEST", {
					message: `A column named "${input.name}" already exists in this project`,
				});
			}
			throw err;
		}
	});
