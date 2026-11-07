import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { runReportCommand } from "../../lib/report-commands";
import {
	nativeExecutionHistoryInput,
	nativeExecutionHistoryOutput,
} from "../../lib/report-history-contract";
export const listNativeReportExecutionsProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_READ, {
			requireOrganization: true,
		}),
	)
	.input(
		nativeExecutionHistoryInput.extend({
			organizationId: z.string().optional(),
		}),
	)
	.output(nativeExecutionHistoryOutput)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("FORBIDDEN");
		}
		return nativeExecutionHistoryOutput.parse(
			await runReportCommand(
				{ userId: context.user.id, organizationId, scopes: ["*"] },
				"executions",
				input,
			),
		);
	});
