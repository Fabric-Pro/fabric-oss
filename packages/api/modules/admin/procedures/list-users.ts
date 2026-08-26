import { countUsers, getUsers } from "@repo/database";
import { z } from "zod";
import {
	adminProcedure,
	Permissions,
	requirePermission,
} from "../../../orpc/procedures";

export const listUsers = adminProcedure
	.use(requirePermission(Permissions.ORG_READ))
	.route({
		method: "GET",
		path: "/admin/users",
		tags: ["Administration"],
		summary: "List users",
	})
	.input(
		z.object({
			query: z.string().optional(),
			limit: z.number().min(1).max(100).default(10),
			offset: z.number().min(0).default(0),
		}),
	)
	.handler(async ({ input: { query, limit, offset } }) => {
		const [users, total] = await Promise.all([
			getUsers({ limit, offset, query }),
			countUsers({ query }),
		]);

		return { users, total };
	});
