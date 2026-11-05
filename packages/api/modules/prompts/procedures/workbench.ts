import {
	promptAssistInput,
	promptAssistOutput,
	promptTryInput,
	promptTryOutput,
} from "@repo/ai/lib/prompt-workbench-contracts";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { resolvedOrganizationId } from "../../agents/procedures/conversations/resolved-organization";
import { assistPrompt, tryPrompt } from "../lib/workbench";

const org = {
	organizationId: z.string().min(1).max(200).nullable().optional(),
};
export const promptWorkbenchProcedures = {
	assist: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.PROMPT_UPDATE, {
				requireOrganization: true,
			}),
		)
		.input(promptAssistInput.safeExtend(org))
		.output(promptAssistOutput)
		.handler(({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return assistPrompt(
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
	preview: tenantProtectedProcedure
		.use(
			requireInputOrgPermission(Permissions.PROMPT_READ, {
				requireOrganization: true,
			}),
		)
		.input(promptTryInput.safeExtend(org))
		.output(promptTryOutput)
		.handler(({ input, context }) => {
			const { organizationId: _, ...request } = input;
			return tryPrompt(
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
};
