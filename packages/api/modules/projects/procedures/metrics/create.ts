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
	loadProjectTenant,
	METRIC_SELECT,
	metricDirectionSchema,
	metricSourceKindSchema,
	metricTenantFor,
	type ShownOnceSecret,
	toMetricDto,
} from "./shared";

/**
 * AUTHORIZATION: `requireProjectPermission(PROJECT_UPDATE)` — editors and up.
 *
 * For `sourceKind: WEBHOOK` a 32-byte secret is generated, only its sha256
 * is stored, and the plaintext is returned once in `webhookSecret`. It is
 * never logged and cannot be read back; use `rotateWebhookSecret`.
 */
export const createMetricProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/metrics",
		tags: ["Projects", "Metrics"],
		summary: "Create success metric",
		description:
			"Create a customer success metric. Webhook metrics return their secret exactly once.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			name: z.string().trim().min(1).max(120),
			description: z.string().trim().max(2000).optional(),
			direction: metricDirectionSchema.default("UP"),
			target: z.number().finite().nullable().optional(),
			sourceKind: metricSourceKindSchema.default("MANUAL"),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await loadProjectTenant(input.projectId);
		const tenant = metricTenantFor(project, context.user.id);

		let webhookSecret: ShownOnceSecret | undefined;
		let webhookSecretHash: string | null = null;
		if (input.sourceKind === "WEBHOOK") {
			const secret = generateMetricWebhookSecret();
			webhookSecretHash = hashMetricWebhookSecret(secret);
			webhookSecret = { value: secret, shownOnce: true };
		}

		const row = await db.projectSuccessMetric.create({
			data: {
				projectId: project.id,
				userId: tenant.userId,
				organizationId: tenant.organizationId,
				name: input.name,
				description: input.description?.length
					? input.description
					: null,
				direction: input.direction,
				target: input.target ?? null,
				sourceKind: input.sourceKind,
				webhookSecretHash,
			},
			select: METRIC_SELECT,
		});

		return { metric: toMetricDto(row), webhookSecret };
	});
