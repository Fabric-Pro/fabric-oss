import { ORPCError } from "@orpc/server";
import { getAgentImplementationAvailability } from "@repo/agent-types/agent-implementation";
import {
	db,
	getAgentTemplateInstanceForExecution,
	getAgentTemplateInstanceForRead,
} from "@repo/database";

export interface RunControlActor {
	userId: string;
	organizationId: string;
}
export async function resolveRunControlInstance(
	identifier: string,
	actor: RunControlActor,
	write = false,
	options: { requireRunnable?: boolean } = {},
) {
	const instance = await db.agentTemplateInstance.findFirst({
		where: {
			organizationId: actor.organizationId,
			OR: [{ id: identifier }, { sId: identifier }],
		},
		orderBy: [{ version: "desc" }, { id: "desc" }],
		select: {
			id: true,
			userId: true,
			organizationId: true,
			status: true,
			name: true,
			customInstructions: true,
		},
	});
	if (!instance || instance.organizationId !== actor.organizationId) {
		throw new ORPCError("NOT_FOUND", {
			message: "Agent not found or access denied",
		});
	}
	const scoped = await (write
		? getAgentTemplateInstanceForExecution
		: getAgentTemplateInstanceForRead)({
		instanceId: instance.id,
		...actor,
	});
	if (!scoped) {
		throw new ORPCError("NOT_FOUND", {
			message: "Agent not found or access denied",
		});
	}
	if (instance.userId !== actor.userId) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"Background runs use the agent owner's saved connections and credentials. Only its owner can manage them.",
		});
	}
	if (write && options.requireRunnable !== false) {
		if (instance.status !== "ACTIVE") {
			throw new ORPCError("CONFLICT", {
				message:
					"Restore this agent before starting or scheduling background work.",
			});
		}
		const available = getAgentImplementationAvailability(
			instance.customInstructions,
		);
		if (!available.available) {
			throw new ORPCError("CONFLICT", { message: available.reason });
		}
	}
	return { ...instance, projectId: scoped.projectId };
}
export async function getOwnedRunDeployment(
	instanceId: string,
	actor: RunControlActor,
) {
	return db.agentDeployment.findFirst({
		where: { instanceId, ...actor },
		select: {
			id: true,
			status: true,
			userId: true,
			organizationId: true,
			instanceId: true,
			supervisorWorkflowId: true,
			taskQueue: true,
		},
	});
}
