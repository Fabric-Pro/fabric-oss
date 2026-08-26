/**
 * Get Agent Metadata
 *
 * Returns full metadata for a specific API-exposed agent instance,
 * including input schema and example values from apiConfig.
 * Deployment data is included if present but not required.
 */

import { db } from "@repo/database";
import type { ExternalApiContext } from "../types";

export async function getExposedAgent(
	instanceId: string,
	ctx: ExternalApiContext,
) {
	const tenantFilter = ctx.organizationId
		? { organizationId: ctx.organizationId }
		: { userId: ctx.userId, organizationId: null };

	// The identifier may be an sId (stable across versions) or a record id.
	// Try sId first since the UI now emits stable identifiers.
	const instance =
		(await db.agentTemplateInstance.findFirst({
			where: {
				sId: instanceId,
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
				goal: true,
				maxIterations: true,
				apiConfig: true,
				version: true,
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
						rateLimitPerMinute: true,
						rateLimitPerHour: true,
						dailyExecutionLimit: true,
						monthlyExecutionLimit: true,
					},
				},
			},
		})) ??
		(await db.agentTemplateInstance.findFirst({
			where: {
				id: instanceId,
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
				goal: true,
				maxIterations: true,
				apiConfig: true,
				version: true,
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
						rateLimitPerMinute: true,
						rateLimitPerHour: true,
						dailyExecutionLimit: true,
						monthlyExecutionLimit: true,
					},
				},
			},
		}));

	if (!instance) {
		return null;
	}

	const apiConfig = (instance.apiConfig as Record<string, unknown>) || {};

	return {
		id: instance.id,
		sId: instance.sId,
		name: instance.name,
		description: instance.description || apiConfig.description,
		executionMode: instance.executionMode,
		version: instance.version,
		template: {
			slug: instance.template.slug,
			displayName: instance.template.displayName,
			category: instance.template.category,
		},
		inputSchema: apiConfig.inputSchema || {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Input message or query for the agent",
				},
			},
		},
		exampleInput: apiConfig.exampleInput || null,
		exampleOutput: apiConfig.exampleOutput || null,
		deployment: instance.deployment
			? {
					id: instance.deployment.id,
					status: instance.deployment.status,
					limits: {
						rateLimitPerMinute:
							instance.deployment.rateLimitPerMinute,
						rateLimitPerHour: instance.deployment.rateLimitPerHour,
						dailyExecutionLimit:
							instance.deployment.dailyExecutionLimit,
						monthlyExecutionLimit:
							instance.deployment.monthlyExecutionLimit,
					},
				}
			: null,
	};
}
