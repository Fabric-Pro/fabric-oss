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
			limit: z.number().min(1).max(100).default(10),
			offset: z.number().min(0).default(0),
		}),
	)
	.handler(async ({ input: { query, limit, offset } }) => {
		const organizations = await getOrganizations({
			limit,
			offset,
			query,
		});

		const total = await countAllOrganizations();

		return { organizations, total };
	});
