import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	getProjectDeliverySnapshot,
	projectDeliveryInput,
} from "../lib/delivery-snapshot";

export const deliverySnapshotProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/delivery",
		tags: ["Projects"],
		summary: "Inspect current delivery evidence and context health",
	})
	.input(projectDeliveryInput)
	.handler(async ({ input, context }) => {
		const access = await import(
			"../../../lib/effective-project-permissions"
		).then((module) =>
			module.resolveEffectiveProjectPermissions(
				input.projectId,
				context.user.id,
			),
		);
		return getProjectDeliverySnapshot(
			{
				userId: context.user.id,
				organizationId: access?.organizationId ?? "",
			},
			input,
		);
	});
