import { countAllOrganizations, getOrganizations } from "@repo/database";
import { z } from "zod";
import {
	adminProcedure,
	Permissions,
	requirePermission,
} from "../../../orpc/procedures";

export const listOrganizations = adminProcedure
	.use(requirePermission(Permissions.ORG_READ))
	.route({
		method: "GET",
		path: "/admin/organizations",
		tags: ["Administration"],
		summary: "List organizations",
	})
	.input(
		z.object({
			query: z.string().optional(),
			status: z.enum(["active", "deactivated", "all"]).default("active"),
			sort: z
				.enum(["name", "members", "projects", "createdAt"])
				.default("createdAt"),
			direction: z.enum(["asc", "desc"]).default("desc"),
			limit: z.number().int().min(1).max(100).default(10),
			offset: z.number().int().min(0).default(0),
		}),
	)
	.handler(async ({ input }) => {
		const [organizations, total] = await Promise.all([
			getOrganizations(input),
			countAllOrganizations(input),
		]);
		return { organizations, total };
	});
