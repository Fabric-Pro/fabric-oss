import {
	canRunOrganizationWorkflows,
	getWorkspaceWorkflowGrant,
	hasProjectAccess,
	type Workflow,
	workspaceWorkflowRunProvenanceSchema,
} from "@repo/database";
import { WorkspaceDataNodeSchema } from "../../lib/workspace-data-config";
import {
	WORKSPACE_DATA_READ_NODE_TYPE,
	WORKSPACE_DATA_WRITE_NODE_TYPE,
} from "../../lib/workflow-node-types";
import type { loadOwnedWorkflowExecution } from "./workflow-execution-definition";

type UsageWorkflow = Pick<
	Workflow,
	| "id"
	| "userId"
	| "organizationId"
	| "projectId"
	| "status"
	| "version"
	| "publishedVersion"
	| "updatedAt"
>;

function publishedWorkspaceFrameId(nodes: unknown): string | undefined {
	if (!Array.isArray(nodes)) {
		return undefined;
	}
	const frameIds = new Set<string>();
	for (const node of nodes) {
		if (
			!node ||
			typeof node !== "object" ||
			(node.type !== WORKSPACE_DATA_READ_NODE_TYPE &&
				node.type !== WORKSPACE_DATA_WRITE_NODE_TYPE)
		) {
			continue;
		}
		const parsed = WorkspaceDataNodeSchema.safeParse(node);
		if (!parsed.success) {
			return undefined;
		}
		frameIds.add(parsed.data.data.config.frameId);
	}
	return frameIds.size === 1 ? frameIds.values().next().value : undefined;
}

/** Attribution describes a bound run; it never grants access to a Workspace. */
export async function resolveWorkspaceWorkflowUsageOrigin(input: {
	userId: string;
	organizationId?: string;
	workflow: UsageWorkflow;
	execution: Awaited<ReturnType<typeof loadOwnedWorkflowExecution>>;
	publishedNodes?: unknown;
}): Promise<string | undefined> {
	const { userId, organizationId, workflow, execution } = input;
	if (
		!organizationId ||
		!workflow.projectId ||
		workflow.userId !== userId ||
		workflow.organizationId !== organizationId ||
		execution.workflowId !== workflow.id ||
		workflow.version !== execution.version ||
		workflow.publishedVersion !== execution.version ||
		(workflow.status !== "PUBLISHED" && workflow.status !== "ACTIVE")
	) {
		return undefined;
	}

	let frameId: string | undefined;
	const trigger = execution.triggerInput;
	const claimedLaunch =
		trigger &&
		typeof trigger === "object" &&
		!Array.isArray(trigger) &&
		(trigger.source === "workspace-workflow" ||
			"workspaceWorkflowBinding" in trigger);
	if (claimedLaunch) {
		const provenance = workspaceWorkflowRunProvenanceSchema.safeParse(
			trigger.workspaceWorkflowBinding,
		);
		if (
			execution.triggerType !== "MANUAL" ||
			trigger.source !== "workspace-workflow" ||
			!provenance.success ||
			provenance.data.workflowId !== workflow.id ||
			provenance.data.projectId !== workflow.projectId ||
			provenance.data.workflowVersion !== execution.version ||
			provenance.data.workflowUpdatedAt !==
				workflow.updatedAt.toISOString()
		) {
			return undefined;
		}
		frameId = provenance.data.workspaceFrameId;
	} else {
		frameId = publishedWorkspaceFrameId(input.publishedNodes);
	}
	if (!frameId) {
		return undefined;
	}
	if (
		!(await canRunOrganizationWorkflows(userId, organizationId)) ||
		!(await hasProjectAccess(workflow.projectId, userId))
	) {
		return undefined;
	}
	const context = await getWorkspaceWorkflowGrant({
		frameId,
		workflowId: workflow.id,
		userId,
		organizationId,
	});
	if (
		!context ||
		context.frame.id !== frameId ||
		context.frame.userId !== userId ||
		context.frame.organizationId !== organizationId ||
		context.frame.projectId !== workflow.projectId ||
		context.grant.authorizedWorkflowVersion !== execution.version ||
		context.grant.authorizedWorkflowUpdatedAt !==
			workflow.updatedAt.toISOString()
	) {
		return undefined;
	}
	return context.frame.id;
}
