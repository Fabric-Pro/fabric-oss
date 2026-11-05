import { agentPreviewStartSchema } from "@repo/temporal/agent-preview-contracts";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	agentPreviewIdentitySchema,
	cancelAgentPreviewCommand,
	getAgentPreviewCommand,
	startAgentPreviewCommand,
} from "../lib/agent-preview-commands";
import { resolvedOrganizationId } from "./conversations/resolved-organization";

const org = { organizationId: z.string().min(1).optional() };
const execute = tenantProtectedProcedure.use(
	requireInputOrgPermission(Permissions.AGENT_EXECUTE, {
		requireOrganization: true,
	}),
);
const read = tenantProtectedProcedure.use(
	requireInputOrgPermission(Permissions.AGENT_READ, {
		requireOrganization: true,
	}),
);
export const agentPreviewProcedures = {
	start: execute
		.input(agentPreviewStartSchema.extend(org))
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return startAgentPreviewCommand(
				{
					userId: context.user.id,
					organizationId: resolvedOrganizationId(
						input,
						context.session,
					),
				},
				request,
				(event) => recordAuditFromRequest(context, event),
			);
		}),
	get: read
		.input(agentPreviewIdentitySchema.extend(org))
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return getAgentPreviewCommand(
				{
					userId: context.user.id,
					organizationId: resolvedOrganizationId(
						input,
						context.session,
					),
				},
				request,
			);
		}),
	cancel: execute
		.input(agentPreviewIdentitySchema.extend(org))
		.handler(async ({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return cancelAgentPreviewCommand(
				{
					userId: context.user.id,
					organizationId: resolvedOrganizationId(
						input,
						context.session,
					),
				},
				request,
				(event) => recordAuditFromRequest(context, event),
			);
		}),
};
