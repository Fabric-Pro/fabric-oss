import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	generateMetricWebhookSecret,
	hashMetricWebhookSecret,
} from "../../../../lib/metric-secrets";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	loadMetricOrThrow,
	loadProjectTenant,
	METRIC_SELECT,
	metricScope,
	type ShownOnceSecret,
	toMetricDto,
} from "./shared";

/**
 * AUTHORIZATION: `requireProjectPermission(PROJECT_GOVERNANCE_MANAGE)` —
 * project OWNER, org owner/admin. Editors (PROJECT_UPDATE) cannot rotate: a
 * rotation invalidates whatever the customer's system is sending today.
 *
 * Replaces the stored hash atomically; the old token stops working with the
 * same write. The new plaintext is returned once and never logged.
 */
export const rotateMetricWebhookSecretProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_GOVERNANCE_MANAGE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/metrics/{metricId}/rotate-secret",
		tags: ["Projects", "Metrics"],
		summary: "Rotate metric webhook secret",
		description:
			"Mint a new webhook secret for a WEBHOOK metric. The previous secret stops working immediately; the new one is shown once.",
	})
	.input(
		z.object({
			projectId: z.string(),
			metricId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const project = await loadProjectTenant(input.projectId);
		const existing = await loadMetricOrThrow(input.metricId, project);
		if (existing.sourceKind !== "WEBHOOK") {
			throw new ORPCError("BAD_REQUEST", {
				message: "Only WEBHOOK metrics have a secret to rotate",
			});
		}

		const secret = generateMetricWebhookSecret();
		await db.projectSuccessMetric.updateMany({
			where: { id: existing.id, ...metricScope(project) },
			data: { webhookSecretHash: hashMetricWebhookSecret(secret) },
		});
		const row = await db.projectSuccessMetric.findFirst({
			where: { id: existing.id, ...metricScope(project) },
			select: METRIC_SELECT,
		});
		const webhookSecret: ShownOnceSecret = {
			value: secret,
			shownOnce: true,
		};
		return { metric: toMetricDto(row ?? existing), webhookSecret };
	});
