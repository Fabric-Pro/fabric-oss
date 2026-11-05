import { ORPCError } from "@orpc/server";
import { db, getReportTemplate, isFeatureEnabled } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertReportPermission } from "../../lib/report-access";
import { probeReportConnections } from "../../lib/report-connection-test";
import { testConnectionsOutputSchema } from "./test-connections";

/** A template declares a handful of sources; this bounds what one request opens. */
const MAX_PROBED_CONFIGS = 10;
/** A person is waiting on a dialog: a slower server reads as unreachable. */
const PROBE_TIMEOUT_MS = 15_000;

const probeConnectionsInputSchema = z.object({
	templateId: z.string().min(1),
	organizationId: z.string().nullable().optional(),
	configIds: z.array(z.string().min(1)).max(MAX_PROBED_CONFIGS),
});

/**
 * The "Test connections" check before a report exists: the create dialog's
 * readiness, for the connections the person has chosen. It connects and lists
 * tools only, so it spends no AI credits. Only the caller's own configs are
 * tried, since a config holds its owner's credentials.
 *
 * AUTHORIZATION: REPORT_EXECUTE, as `testConnections`: this opens live outbound
 * MCP connections. The middleware only admits members and the handler asks for
 * it, because a platform admin holds it in any organization they belong to.
 */
export const probeConnectionsProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_READ, {
			requireOrganization: true,
		}),
	)
	.input(probeConnectionsInputSchema)
	.output(testConnectionsOutputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "An organization is required",
			});
		}
		await assertReportPermission(
			organizationId,
			context.user,
			Permissions.REPORT_EXECUTE,
		);
		if (!(await isFeatureEnabled("REPORT_SUITE_V2", organizationId))) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Connection checks are not available in this organization",
			});
		}
		const template = await getReportTemplate({
			id: input.templateId,
			userId: context.user.id,
			organizationId,
		});
		if (!template) {
			throw new ORPCError("NOT_FOUND", {
				message: "Report template not found or access denied",
			});
		}
		const ownConfigs = await db.mCPConfig.findMany({
			where: {
				id: { in: input.configIds },
				userId: context.user.id,
				organizationId,
			},
			select: { id: true },
		});
		const diagnostics = await probeReportConnections(
			ownConfigs.map((config) => config.id),
			template.definition,
			{ userId: context.user.id, organizationId },
			{ timeoutMs: PROBE_TIMEOUT_MS },
		);
		return { diagnostics };
	});
