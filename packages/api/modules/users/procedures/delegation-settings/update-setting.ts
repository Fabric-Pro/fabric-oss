import { updateUserDelegationSetting } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const updateUserDelegationSettingProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "PUT",
		path: "/users/delegation-settings",
		tags: ["Users"],
		summary: "Update user delegation setting",
		description: "Update the current user's Fabric AI delegation setting",
	})
	.input(
		z.object({
			useDelegatedExecution: z.boolean(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			useDelegatedExecution: z.boolean(),
		}),
	)
	.handler(
		async ({ context: { user }, input: { useDelegatedExecution } }) => {
			const result = await updateUserDelegationSetting({
				userId: user.id,
				useDelegatedExecution,
			});

			return {
				success: true,
				useDelegatedExecution: result.useDelegatedExecution,
			};
		},
	);
