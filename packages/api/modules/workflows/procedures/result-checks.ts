import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	applyWorkflowCheckSchema,
	checkIdentitySchema,
	inspectWorkflowResultSchema,
	previewWorkflowCheckSchema,
	removeWorkflowCheckSchema,
	saveWorkflowCheckSchema,
} from "../lib/result-check-contracts";
import {
	applyWorkflowCheck,
	inspectWorkflowResult,
	listWorkflowChecks,
	previewWorkflowCheck,
	removeWorkflowCheck,
	saveWorkflowCheck,
} from "../lib/workflow-result-checks";
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
const actor = (
	context: {
		user: { id: string };
		session: Parameters<typeof resolveOrganizationId>[1];
	},
	organizationId: string | null | undefined,
) =>
	workflowActor(
		context.user.id,
		resolveOrganizationId(organizationId, context.session),
	);
export const workflowResultChecks = {
	inspect: read
		.input(inspectWorkflowResultSchema.extend(org))
		.handler(({ input, context }) => {
			const { organizationId, ...value } = input;
			return inspectWorkflowResult(actor(context, organizationId), value);
		}),
	list: read
		.input(checkIdentitySchema.extend(org))
		.handler(({ input, context }) => {
			const { organizationId, ...value } = input;
			return listWorkflowChecks(actor(context, organizationId), value);
		}),
	preview: read
		.input(previewWorkflowCheckSchema.safeExtend(org))
		.handler(({ input, context }) => {
			const { organizationId, ...value } = input;
			return previewWorkflowCheck(actor(context, organizationId), value);
		}),
	save: write
		.input(saveWorkflowCheckSchema.safeExtend(org))
		.handler(({ input, context }) => {
			const { organizationId, ...value } = input;
			return saveWorkflowCheck(actor(context, organizationId), value);
		}),
	apply: read
		.input(applyWorkflowCheckSchema.extend(org))
		.handler(({ input, context }) => {
			const { organizationId, ...value } = input;
			return applyWorkflowCheck(actor(context, organizationId), value);
		}),
	remove: write
		.input(removeWorkflowCheckSchema.extend(org))
		.handler(({ input, context }) => {
			const { organizationId, ...value } = input;
			return removeWorkflowCheck(actor(context, organizationId), value);
		}),
};
