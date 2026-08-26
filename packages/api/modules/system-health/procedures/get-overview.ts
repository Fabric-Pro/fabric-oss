/**
 * Customer-facing system-health overview.
 *
 * Auth: `tenantProtectedProcedure` — any authenticated user, in either personal
 * or organization context. Deliberately NOT admin-gated: the whole point of the
 * surface is that a customer can answer "is this problem mine or yours" without
 * opening a support ticket.
 *
 * Tenant scoping matters even though most of the underlying signals are global:
 * the server-fault count and the connection inventory are the customer's OWN
 * data, and provider issues are narrowed to providers they actually connected.
 */
import { z } from "zod";
import { getTenantFilterFromContext } from "../../../orpc/middleware/tenant-context-middleware";
import { tenantProtectedProcedure } from "../../../orpc/procedures";
import { buildSystemHealthOverview } from "../lib/build-overview";

export const getSystemHealthOverviewProcedure = tenantProtectedProcedure
	.route({
		method: "GET",
		path: "/system-health/overview",
		tags: ["System Health"],
		summary: "Current platform health for the calling tenant",
		description:
			"Component statuses, active status announcements, and provider issues limited to providers this tenant has connected.",
	})
	.input(z.object({}))
	.handler(async ({ context }) => {
		const filter = getTenantFilterFromContext(context.tenantContext);
		return buildSystemHealthOverview({
			organizationId: filter.organizationId ?? null,
			userId: filter.userId ?? null,
		});
	});
