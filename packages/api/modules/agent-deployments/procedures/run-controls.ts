import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { resolvedOrganizationId } from "../../agents/procedures/conversations/resolved-organization";
import { executeAgentFromPortal } from "../../external-api/procedures/execute-agent";
import {
	cancelAgentRunCommand,
	getAgentRunCommand,
	listAgentRunCommand,
	scheduleAgentRunCommand,
} from "../lib/run-commands";
import {
	agentRunHistorySchema,
	agentRunIdentitySchema,
	agentRunIdSchema,
	agentRunListSchema,
	agentRunMessageSchema,
	agentRunScheduleSchema,
} from "../lib/run-contracts";
import { resolveRunControlInstance } from "../lib/run-control-access";
import { searchAgentRunCommand } from "../lib/run-history";

const id = agentRunIdSchema;
const org = { organizationId: id.optional() };
const message = agentRunMessageSchema;
const read = tenantProtectedProcedure.use(
	requireInputOrgPermission(Permissions.AGENT_READ, {
		requireOrganization: true,
	}),
);
const run = tenantProtectedProcedure.use(
	requireInputOrgPermission(Permissions.AGENT_EXECUTE, {
		requireOrganization: true,
	}),
);
const schedule = tenantProtectedProcedure.use(
	requireInputOrgPermission(Permissions.AGENT_UPDATE, {
		requireOrganization: true,
	}),
);
export const listAgentRunsProcedure = read
	.input(agentRunListSchema.extend(org))
	.handler(async ({ input, context }) => {
		const { organizationId: _, ...command } = input;
		return listAgentRunCommand(
			{
				userId: context.user.id,
				organizationId: resolvedOrganizationId(input, context.session),
			},
			command,
		);
	});
export const searchAgentRunsProcedure = read
	.input(agentRunHistorySchema.safeExtend(org))
	.handler(async ({ input, context }) => {
		const { organizationId: _, ...command } = input;
		return searchAgentRunCommand(
			{
				userId: context.user.id,
				organizationId: resolvedOrganizationId(input, context.session),
			},
			command,
		);
	});
export const startAgentRunProcedure = run
	.input(
		z
			.object({
				...org,
				instanceId: id,
				input: message,
				idempotencyKey: z.string().regex(/^[\x21-\x7e]{1,200}$/),
			})
			.strict(),
	)
	.handler(async ({ input, context }) => {
		const actor = {
			userId: context.user.id,
			organizationId: resolvedOrganizationId(input, context.session),
		};
		const instance = await resolveRunControlInstance(
			input.instanceId,
			actor,
			true,
		);
		const result = await executeAgentFromPortal(
			instance.id,
			{ input: input.input, idempotencyKey: input.idempotencyKey },
			actor,
		);
		if (result.error !== undefined) {
			const error =
				typeof result.error === "string"
					? { message: result.error }
					: result.error;
			throw new ORPCError(
				result.status === 404
					? "NOT_FOUND"
					: result.status === 403
						? "FORBIDDEN"
						: result.status === 409
							? "CONFLICT"
							: result.status === 429
								? "TOO_MANY_REQUESTS"
								: result.status === 503
									? "SERVICE_UNAVAILABLE"
									: "BAD_REQUEST",
				{
					message: error.message,
					data:
						typeof result.error === "object"
							? result.error
							: undefined,
				},
			);
		}
		return result.data;
	});

export const getAgentRunProcedure = read
	.input(agentRunIdentitySchema.extend(org))
	.handler(async ({ input, context }) => {
		const { organizationId: _, ...command } = input;
		return getAgentRunCommand(
			{
				userId: context.user.id,
				organizationId: resolvedOrganizationId(input, context.session),
			},
			command,
		);
	});
export const cancelAgentRunProcedure = run
	.input(agentRunIdentitySchema.extend(org))
	.handler(async ({ input, context }) => {
		const { organizationId: _, ...command } = input;
		return cancelAgentRunCommand(
			{
				userId: context.user.id,
				organizationId: resolvedOrganizationId(input, context.session),
			},
			command,
			async (event) => recordAuditFromRequest(context, event),
		);
	});
const scheduleAgentRunProcedure = schedule
	.input(agentRunScheduleSchema.extend(org))
	.handler(async ({ input, context }) => {
		const { organizationId: _, ...command } = input;
		return scheduleAgentRunCommand(
			{
				userId: context.user.id,
				organizationId: resolvedOrganizationId(input, context.session),
			},
			command,
			async (event) => recordAuditFromRequest(context, event),
		);
	});
export const agentRunControls = {
	search: searchAgentRunsProcedure,
	list: listAgentRunsProcedure,
	start: startAgentRunProcedure,
	get: getAgentRunProcedure,
	cancel: cancelAgentRunProcedure,
	schedule: scheduleAgentRunProcedure,
};
