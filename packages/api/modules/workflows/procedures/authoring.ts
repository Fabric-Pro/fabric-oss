import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	checkWorkflowReadiness,
	createWorkflowFromStarter,
	listWorkflowStarters,
	readinessInput,
	starterInput,
} from "../lib/workflow-authoring";
import { workflowActor, workflowCommandErrors } from "./workflow-actor";

const org = z.object({ organizationId: z.string().nullable().optional() });
export const listStartersProcedure = tenantProtectedProcedure
	.use(workflowCommandErrors)
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_READ, {
			requireOrganization: true,
		}),
	)
	.input(org)
	.handler(async ({ input, context }) =>
		listWorkflowStarters(
			workflowActor(
				context.user.id,
				resolveOrganizationId(input.organizationId, context.session),
			),
		),
	);
export const createFromStarterProcedure = tenantProtectedProcedure
	.use(workflowCommandErrors)
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_CREATE, {
			requireOrganization: true,
		}),
	)
	.input(starterInput.extend(org.shape))
	.handler(async ({ input, context }) => {
		const { organizationId, ...value } = input;
		return createWorkflowFromStarter(
			workflowActor(
				context.user.id,
				resolveOrganizationId(organizationId, context.session),
			),
			value,
		);
	});
export const checkReadinessProcedure = tenantProtectedProcedure
	.use(workflowCommandErrors)
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_READ, {
			requireOrganization: true,
		}),
	)
	.input(readinessInput.extend(org.shape))
	.handler(async ({ input, context }) =>
		checkWorkflowReadiness(
			workflowActor(
				context.user.id,
				resolveOrganizationId(input.organizationId, context.session),
			),
			{ id: input.id },
		),
	);
