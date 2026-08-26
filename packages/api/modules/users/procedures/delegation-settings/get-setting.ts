import { getUserDelegationSetting } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const getUserDelegationSettingProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_READ_SELF))
	.route({
		method: "GET",
		path: "/users/delegation-settings",
		tags: ["Users"],
		summary: "Get user delegation setting",
		description:
			"Get the current user's Fabric AI delegation setting (whether to delegate execution to Fabric AI server or run in Temporal)",
	})
	.output(
		z.object({
			useDelegatedExecution: z.boolean(),
		}),
	)
	.handler(async ({ context: { user } }) => {
		const useDelegatedExecution = await getUserDelegationSetting(user.id);
		return { useDelegatedExecution };
	});
