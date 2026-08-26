/**
 * List Exposed Agents
 *
 * Returns all agent template instances that are API-exposed and
 * active for the authenticated tenant. Deployments are auto-created
 * on first execution, so no deployment is required to be listed.
 */

import { db } from "@repo/database";
import type { ExternalApiContext } from "../types";

export async function listExposedAgents(ctx: ExternalApiContext) {
	const tenantFilter = ctx.organizationId
		? { organizationId: ctx.organizationId }
		: { userId: ctx.userId, organizationId: null };

	const instances = await db.agentTemplateInstance.findMany({
		where: {
			...tenantFilter,
			isApiExposed: true,
			status: "ACTIVE",
		},
		select: {
			id: true,
			sId: true,
			name: true,
			description: true,
			executionMode: true,
			apiConfig: true,
			template: {
				select: {
					slug: true,
					displayName: true,
					category: true,
					description: true,
				},
			},
			deployment: {
				select: {
					id: true,
					status: true,
				},
			},
		},
		orderBy: { name: "asc" },
	});

	return instances.map((instance) => ({
		id: instance.id,
		sId: instance.sId,
		name: instance.name,
		description: instance.description,
		executionMode: instance.executionMode,
		template: {
			slug: instance.template.slug,
			displayName: instance.template.displayName,
			category: instance.template.category,
		},
		apiConfig: instance.apiConfig
			? {
					description: (instance.apiConfig as Record<string, unknown>)
						.description,
					inputSchema: (instance.apiConfig as Record<string, unknown>)
						.inputSchema,
				}
			: null,
		deploymentId: instance.deployment?.id,
	}));
}
