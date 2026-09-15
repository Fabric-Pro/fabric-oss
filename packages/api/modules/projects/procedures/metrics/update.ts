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
	metricDirectionSchema,
	metricScope,
	metricSourceKindSchema,
	type ShownOnceSecret,
	toMetricDto,
} from "./shared";

/**
 * AUTHORIZATION: `requireProjectPermission(PROJECT_UPDATE)` — editors and up.
 *
 * Switching a MANUAL metric to WEBHOOK mints a secret (returned once);
 * switching back to MANUAL discards the hash so the ingress stops accepting
 * the old token. An existing WEBHOOK secret is never touched here — that is
 * `rotateWebhookSecret` (governance).
 */
export const updateMetricProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/metrics/{metricId}",
		tags: ["Projects", "Metrics"],
		summary: "Update success metric",
		description: "Update a customer success metric's definition",
	})
	.input(
		z.object({
			projectId: z.string(),
			metricId: z.string(),
			organizationId: z.string().nullable().optional(),
			name: z.string().trim().min(1).max(120).optional(),
			description: z.string().trim().max(2000).nullable().optional(),
			direction: metricDirectionSchema.optional(),
			target: z.number().finite().nullable().optional(),
			sourceKind: metricSourceKindSchema.optional(),
		}),
	)
	.handler(async ({ input }) => {
		const project = await loadProjectTenant(input.projectId);
		const existing = await loadMetricOrThrow(input.metricId, project);

		let webhookSecret: ShownOnceSecret | undefined;
		let webhookSecretHash: string | null | undefined;
		if (input.sourceKind === "WEBHOOK" && !existing.webhookSecretHash) {
			const secret = generateMetricWebhookSecret();
			webhookSecretHash = hashMetricWebhookSecret(secret);
			webhookSecret = { value: secret, shownOnce: true };
		} else if (input.sourceKind === "MANUAL") {
			webhookSecretHash = null;
		}

		await db.projectSuccessMetric.updateMany({
			where: { id: existing.id, ...metricScope(project) },
			data: {
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.description !== undefined
					? {
							description: input.description?.length
								? input.description
								: null,
						}
					: {}),
				...(input.direction !== undefined
					? { direction: input.direction }
					: {}),
				...(input.target !== undefined ? { target: input.target } : {}),
				...(input.sourceKind !== undefined
					? { sourceKind: input.sourceKind }
					: {}),
				...(webhookSecretHash !== undefined
					? { webhookSecretHash }
					: {}),
			},
		});

		const row = await db.projectSuccessMetric.findFirst({
			where: { id: existing.id, ...metricScope(project) },
			select: METRIC_SELECT,
		});
		return { metric: toMetricDto(row ?? existing), webhookSecret };
	});
