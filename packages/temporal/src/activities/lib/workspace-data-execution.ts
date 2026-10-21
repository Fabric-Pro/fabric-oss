import {
	canEditProject,
	canRunOrganizationWorkflows,
	canUpdateOrganizationFrames,
	getAccessibleFrameById,
	getWorkflowById,
	getWorkspaceWorkflowGrant,
	hasProjectAccess,
	type WorkspaceWorkflowRunGuard,
} from "@repo/database";
import {
	readPublishedWorkspaceDataNode,
	WorkspaceDataReadConfigSchema,
	WorkspaceDataWriteConfigSchema,
} from "../../lib/workspace-data-config";
import {
	WORKSPACE_DATA_READ_NODE_TYPE,
	WORKSPACE_DATA_WRITE_NODE_TYPE,
} from "../../lib/workflow-node-types";
import type { StepParams } from "../types";
import { loadPublishedExecutionConfig } from "./workflow-execution-definition";

export async function loadWorkspaceDataExecution(
	params: StepParams,
	nodeType:
		| typeof WORKSPACE_DATA_READ_NODE_TYPE
		| typeof WORKSPACE_DATA_WRITE_NODE_TYPE,
) {
	const {
		userId,
		organizationId,
		workflowId,
		executionId,
		nodeId,
		projectId,
	} = params;
	if (
		!organizationId ||
		!workflowId ||
		!executionId ||
		!nodeId ||
		!projectId
	) {
		throw new Error(
			"Workspace data requires an organization and project workflow execution",
		);
	}
	const writing = nodeType === WORKSPACE_DATA_WRITE_NODE_TYPE;
	if (
		!(await canRunOrganizationWorkflows(userId, organizationId)) ||
		!(await hasProjectAccess(projectId, userId)) ||
		(writing &&
			(!(await canEditProject(projectId, userId)) ||
				!(await canUpdateOrganizationFrames(userId, organizationId))))
	) {
		throw new Error("No permission to access this Workspace data");
	}
	const schema = writing
		? WorkspaceDataWriteConfigSchema
		: WorkspaceDataReadConfigSchema;
	const { config, execution } = await loadPublishedExecutionConfig({
		scope: { userId, organizationId, workflowId, executionId, projectId },
		nodeId,
		nodeConfig: params.nodeConfig,
		readConfig: (nodes, id) => {
			const node = readPublishedWorkspaceDataNode(nodes, id);
			if (node.type !== nodeType) {
				throw new Error(
					"Workspace data node type differs from its published version",
				);
			}
			return node.data.config;
		},
		parseConfig: (value) => schema.parse(value),
	});
	const workflow = await getWorkflowById(workflowId, userId, organizationId);
	const context = await getWorkspaceWorkflowGrant({
		frameId: config.frameId,
		workflowId,
		userId,
		organizationId,
	});
	const frame = await getAccessibleFrameById({
		id: config.frameId,
		userId,
		organizationId,
	});
	if (
		!workflow ||
		!context ||
		!frame ||
		workflow.projectId !== projectId ||
		context.frame.projectId !== projectId ||
		frame.userId !== userId ||
		frame.projectId !== projectId ||
		(workflow.status !== "PUBLISHED" && workflow.status !== "ACTIVE") ||
		workflow.version !== execution.version ||
		workflow.publishedVersion !== execution.version ||
		context.grant.authorizedWorkflowVersion !== execution.version ||
		context.grant.authorizedWorkflowUpdatedAt !==
			workflow.updatedAt.toISOString()
	) {
		throw new Error(
			"Workspace data requires a current grant to this published workflow version",
		);
	}
	const binding: WorkspaceWorkflowRunGuard = {
		workflowId,
		userId,
		organizationId,
		projectId,
		workspaceFrameId: context.frame.id,
		workflowUpdatedAt: workflow.updatedAt,
		frameUpdatedAt: context.frame.updatedAt,
		status: workflow.status,
		requirement: { kind: "bound-run", workflowVersion: execution.version },
	};
	return { config, binding };
}
