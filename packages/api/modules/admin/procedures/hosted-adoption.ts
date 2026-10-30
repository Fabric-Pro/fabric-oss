import { getHostedAdoptionCounts } from "@repo/database";
import { z } from "zod";
import {
	adminProcedure,
	Permissions,
	requirePermission,
} from "../../../orpc/procedures";

/** Global aggregates; authorization is the instance-admin gate. */
export const getHostedAdoptionCountsProcedure = adminProcedure
	// Explicit decorator follows AI Adoption's permission-coverage contract.
	.use(requirePermission(Permissions.ORG_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/admin/hosted-adoption",
		tags: ["Admin"],
		summary: "Get hosted adoption counts",
	})
	.output(
		z.object({
			organizations: z.number().int().nonnegative(),
			projects: z.number().int().nonnegative(),
			users: z.number().int().nonnegative(),
		}),
	)
	.handler(async () => {
		const { organizations, projects, users } =
			await getHostedAdoptionCounts();
		return { organizations, projects, users };
	});
