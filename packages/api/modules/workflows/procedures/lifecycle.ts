import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	workflowIdentitySchema,
	workflowScheduleSchema,
} from "../lib/lifecycle-contracts";
import {
	changeWorkflowLifecycleCommand,
	configureWorkflowScheduleCommand,
	getWorkflowScheduleCommand,
} from "../lib/workflow-lifecycle-commands";
import { workflowActor, workflowCommandErrors } from "./workflow-actor";

const org = { organizationId: z.string().nullable().optional() };
const read = tenantProtectedProcedure.use(workflowCommandErrors).use(
	requireInputOrgPermission(Permissions.WORKSPACE_READ, {
		requireOrganization: true,
	}),
);
const write = tenantProtectedProcedure.use(workflowCommandErrors).use(
	requireInputOrgPermission(Permissions.WORKSPACE_UPDATE, {
		requireOrganization: true,
	}),
);
export const getScheduleProcedure = read
	.input(workflowIdentitySchema.extend(org))
	.handler(({ input, context }) =>
		getWorkflowScheduleCommand(
			workflowActor(
				context.user.id,
				resolveOrganizationId(input.organizationId, context.session),
			),
			{ workflowId: input.workflowId },
		),
	);
export const configureScheduleProcedure = write
	.input(workflowScheduleSchema.extend(org))
	.handler(({ input, context }) => {
		const { organizationId, ...value } = input;
		return configureWorkflowScheduleCommand(
			workflowActor(
				context.user.id,
				resolveOrganizationId(organizationId, context.session),
			),
			value,
		);
	});
export const pauseWorkflowProcedure = write
	.input(workflowIdentitySchema.extend(org))
	.handler(({ input, context }) =>
		changeWorkflowLifecycleCommand(
			workflowActor(
				context.user.id,
				resolveOrganizationId(input.organizationId, context.session),
			),
			"pause",
			{ workflowId: input.workflowId },
		),
	);
export const resumeWorkflowProcedure = write
	.input(workflowIdentitySchema.extend(org))
	.handler(({ input, context }) =>
		changeWorkflowLifecycleCommand(
			workflowActor(
				context.user.id,
				resolveOrganizationId(input.organizationId, context.session),
			),
			"resume",
			{ workflowId: input.workflowId },
		),
	);
