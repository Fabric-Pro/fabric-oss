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
	nativeArtifactHistoryInput,
	nativeArtifactHistoryOutput,
} from "../../lib/report-history-contract";
/** Native template-instance artifacts only. The retired ReportArtifact model is never merged into these results. */
export const listArtifactsProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_READ, {
			requireOrganization: true,
		}),
	)
	.input(
		nativeArtifactHistoryInput.extend({
			organizationId: z.string().optional(),
		}),
	)
	.output(nativeArtifactHistoryOutput)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("FORBIDDEN");
		}
		return nativeArtifactHistoryOutput.parse(
			await runReportCommand(
				{ userId: context.user.id, organizationId, scopes: ["*"] },
				"artifacts",
				input,
			),
		);
	});
