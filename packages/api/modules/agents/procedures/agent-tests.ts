import { ORPCError } from "@orpc/server";
import {
	AgentTestError,
	agentTestCaseArchiveSchema,
	agentTestCaseCreateSchema,
	agentTestCaseListSchema,
	agentTestCaseUpdateSchema,
	agentTestCompareSchema,
	agentTestErrorDataSchema,
	agentTestRunIdentitySchema,
	agentTestRunListSchema,
	agentTestRunStartSchema,
} from "@repo/temporal/agent-test-contracts";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	archiveAgentTestCaseCommand,
	cancelAgentTestRunCommand,
	compareAgentTestRunsCommand,
	createAgentTestCaseCommand,
	getAgentTestRunCommand,
	listAgentTestCasesCommand,
	listAgentTestRunsCommand,
	startAgentTestRunCommand,
	updateAgentTestCaseCommand,
} from "../lib/agent-test-commands";
import { resolvedOrganizationId } from "./conversations/resolved-organization";

const org = { organizationId: z.string().min(1).max(200).optional() };
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
async function translate<T>(operation: () => Promise<T>) {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof AgentTestError) {
			const data = agentTestErrorDataSchema.safeParse(error.data);
			throw new ORPCError(error.code, {
				message: error.message,
				...(data.success ? { data: data.data } : {}),
			});
		}
		throw error;
	}
}
export const agentTestProcedures = {
	cases: {
		list: read
			.input(agentTestCaseListSchema.safeExtend(org))
			.handler(async ({ input, context }) => {
				const { organizationId: _, ...request } = input;
				return translate(() =>
					listAgentTestCasesCommand(
						{
							userId: context.user.id,
							organizationId: resolvedOrganizationId(
								input,
								context.session,
							),
						},
						request,
					),
				);
			}),
		create: execute
			.input(agentTestCaseCreateSchema.safeExtend(org))
			.handler(async ({ input, context }) => {
				const { organizationId: _, ...request } = input;
				return translate(() =>
					createAgentTestCaseCommand(
						{
							userId: context.user.id,
							organizationId: resolvedOrganizationId(
								input,
								context.session,
							),
						},
						request,
						(event) => recordAuditFromRequest(context, event),
					),
				);
			}),
		update: execute
			.input(agentTestCaseUpdateSchema.safeExtend(org))
			.handler(async ({ input, context }) => {
				const { organizationId: _, ...request } = input;
				return translate(() =>
					updateAgentTestCaseCommand(
						{
							userId: context.user.id,
							organizationId: resolvedOrganizationId(
								input,
								context.session,
							),
						},
						request,
						(event) => recordAuditFromRequest(context, event),
					),
				);
			}),
		archive: execute
			.input(agentTestCaseArchiveSchema.safeExtend(org))
			.handler(async ({ input, context }) => {
				const { organizationId: _, ...request } = input;
				return translate(() =>
					archiveAgentTestCaseCommand(
						{
							userId: context.user.id,
							organizationId: resolvedOrganizationId(
								input,
								context.session,
							),
						},
						request,
						(event) => recordAuditFromRequest(context, event),
					),
				);
			}),
	},
	runs: {
		start: execute
			.input(agentTestRunStartSchema.safeExtend(org))
			.handler(async ({ input, context }) => {
				const { organizationId: _, ...request } = input;
				return translate(() =>
					startAgentTestRunCommand(
						{
							userId: context.user.id,
							organizationId: resolvedOrganizationId(
								input,
								context.session,
							),
						},
						request,
						(event) => recordAuditFromRequest(context, event),
					),
				);
			}),
		get: read
			.input(agentTestRunIdentitySchema.safeExtend(org))
			.handler(async ({ input, context }) => {
				const { organizationId: _, ...request } = input;
				return translate(() =>
					getAgentTestRunCommand(
						{
							userId: context.user.id,
							organizationId: resolvedOrganizationId(
								input,
								context.session,
							),
						},
						request,
					),
				);
			}),
		list: read
			.input(agentTestRunListSchema.safeExtend(org))
			.handler(async ({ input, context }) => {
				const { organizationId: _, ...request } = input;
				return translate(() =>
					listAgentTestRunsCommand(
						{
							userId: context.user.id,
							organizationId: resolvedOrganizationId(
								input,
								context.session,
							),
						},
						request,
					),
				);
			}),
		cancel: execute
			.input(agentTestRunIdentitySchema.safeExtend(org))
			.handler(async ({ input, context }) => {
				const { organizationId: _, ...request } = input;
				return translate(() =>
					cancelAgentTestRunCommand(
						{
							userId: context.user.id,
							organizationId: resolvedOrganizationId(
								input,
								context.session,
							),
						},
						request,
						(event) => recordAuditFromRequest(context, event),
					),
				);
			}),
		compare: read
			.input(agentTestCompareSchema.safeExtend(org))
			.handler(async ({ input, context }) => {
				const { organizationId: _, ...request } = input;
				return translate(() =>
					compareAgentTestRunsCommand(
						{
							userId: context.user.id,
							organizationId: resolvedOrganizationId(
								input,
								context.session,
							),
						},
						request,
					),
				);
			}),
	},
};
