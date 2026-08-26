import { db } from "@repo/database";
import { getTemporalClient } from "../client";

type LifecycleResource = "story" | "task" | "comment" | "coding_run";
type LifecycleEvent = "created" | "updated" | "status_changed" | "completed";

export interface DispatchLifecycleEventInput {
	resource: LifecycleResource;
	event: LifecycleEvent;
	projectId?: string;
	userId: string;
	organizationId?: string | null;
	entityId: string;
	data?: Record<string, unknown>;
}

function matchesConditions(
	conditions: Record<string, unknown> | undefined,
	data: Record<string, unknown>,
) {
	if (!conditions) {
		return true;
	}
	return Object.entries(conditions).every(
		([key, value]) => data[key] === value,
	);
}

export async function dispatchLifecycleEvent(
	input: DispatchLifecycleEventInput,
) {
	const triggers = await db.agentDeploymentTrigger.findMany({
		where: {
			type: "LIFECYCLE_EVENT",
			isActive: true,
			organizationId: input.organizationId ?? null,
			...(input.organizationId ? {} : { userId: input.userId }),
		},
		include: { deployment: true },
	});

	const data = {
		projectId: input.projectId,
		entityId: input.entityId,
		...input.data,
	};
	const matchingTriggers = triggers.filter((trigger) => {
		const config = trigger.config as Record<string, unknown>;
		return (
			config.resource === input.resource &&
			config.event === input.event &&
			matchesConditions(
				config.conditions as Record<string, unknown> | undefined,
				data,
			)
		);
	});

	if (matchingTriggers.length === 0) {
		return { matched: 0, started: 0 };
	}

	const temporalClient = await getTemporalClient();
	// Workflow starts are independent gRPC calls — fire them in parallel
	// rather than awaiting each in sequence. Failures are logged per
	// trigger and don't abort the rest.
	const results = await Promise.all(
		matchingTriggers.map(async (trigger) => {
			const eventId = `lifecycle-${input.resource}-${input.event}-${input.entityId}-${trigger.id}`;
			try {
				await temporalClient.workflow.start("triggerEventWorkflow", {
					workflowId: `trigger-event-${eventId}`,
					taskQueue: "trigger-system",
					args: [
						{
							triggerId: trigger.id,
							event: {
								id: eventId,
								triggerId: trigger.id,
								triggerType: "LIFECYCLE_EVENT",
								rawInput: data,
								message: `Lifecycle event: ${input.resource}.${input.event}`,
								context: {
									sourceId: input.entityId,
									sourceName: input.resource,
									triggeredBy: {
										id: input.userId,
										name: "Fabric",
									},
									metadata: data,
								},
								receivedAt: new Date(),
								status: "pending",
							},
							userId: input.userId,
							organizationId: input.organizationId ?? undefined,
						},
					],
				});
				return true;
			} catch (error) {
				console.warn("[LifecycleDispatcher] Failed to start trigger", {
					triggerId: trigger.id,
					error:
						error instanceof Error ? error.message : String(error),
				});
				return false;
			}
		}),
	);

	return {
		matched: matchingTriggers.length,
		started: results.filter(Boolean).length,
	};
}
