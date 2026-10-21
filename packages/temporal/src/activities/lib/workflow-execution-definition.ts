import { isDeepStrictEqual } from "node:util";
import { db } from "@repo/database";
import {
	NATIVE_PLATFORM_READ_NODE_TYPE,
	SCRIPT_TRANSFORM_NODE_TYPE,
	WORKSPACE_DATA_READ_NODE_TYPE,
	WORKSPACE_DATA_WRITE_NODE_TYPE,
} from "../../lib/workflow-node-types";

interface ExecutionScope {
	workflowId: string;
	executionId: string;
	userId: string;
	organizationId?: string;
	projectId: string | null;
}

function requiresPublishedGraph(nodes: unknown): boolean {
	return (
		Array.isArray(nodes) &&
		nodes.some(
			(node) =>
				node &&
				typeof node === "object" &&
				(node.type === SCRIPT_TRANSFORM_NODE_TYPE ||
					node.type === NATIVE_PLATFORM_READ_NODE_TYPE ||
					node.type === WORKSPACE_DATA_READ_NODE_TYPE ||
					node.type === WORKSPACE_DATA_WRITE_NODE_TYPE),
		)
	);
}

export async function loadOwnedWorkflowExecution(input: ExecutionScope) {
	const execution = await db.workflowExecution.findFirst({
		where: {
			id: input.executionId,
			workflowId: input.workflowId,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			workflow: {
				userId: input.userId,
				organizationId: input.organizationId ?? null,
				projectId: input.projectId,
			},
		},
		select: {
			id: true,
			workflowId: true,
			version: true,
			triggerType: true,
			triggerInput: true,
		},
	});
	if (!execution) {
		throw new Error("Workflow execution not found");
	}
	return execution;
}

export async function loadPublishedExecutionGraph(
	input: ExecutionScope,
	version: number,
) {
	const snapshot = await db.workflowVersion.findFirst({
		where: {
			workflowId: input.workflowId,
			version,
			isPublished: true,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
		},
		select: { nodes: true, edges: true, variables: true },
	});
	if (!snapshot) {
		throw new Error(
			"This execution requires its immutable published workflow version",
		);
	}
	return snapshot;
}

export async function resolveExecutionGraph(
	input: ExecutionScope & {
		nodes: unknown;
		edges: unknown;
		variables: unknown;
		override?: { nodes: unknown[]; edges: unknown[] };
	},
) {
	const execution = await loadOwnedWorkflowExecution(input);
	const needsPublishedGraph =
		execution.triggerType === "SCHEDULE" ||
		requiresPublishedGraph(input.nodes) ||
		requiresPublishedGraph(input.override?.nodes);
	if (!needsPublishedGraph) {
		return {
			graph: {
				nodes: input.override?.nodes ?? input.nodes,
				edges: input.override?.edges ?? input.edges,
				variables: input.variables,
			},
			execution,
			published: false,
		};
	}
	const snapshot = await loadPublishedExecutionGraph(
		input,
		execution.version,
	);
	if (
		input.override &&
		(!isDeepStrictEqual(input.override.nodes, snapshot.nodes) ||
			!isDeepStrictEqual(input.override.edges, snapshot.edges))
	) {
		throw new Error("Publish script workflow changes before running them");
	}
	return { graph: snapshot, execution, published: true };
}

export async function loadPublishedExecutionConfig<T>(input: {
	scope: ExecutionScope;
	nodeId: string;
	nodeConfig: unknown;
	readConfig: (nodes: unknown, nodeId: string) => T;
	parseConfig: (config: unknown) => T;
}) {
	const execution = await loadOwnedWorkflowExecution(input.scope);
	const snapshot = await loadPublishedExecutionGraph(
		input.scope,
		execution.version,
	);
	const config = input.readConfig(snapshot.nodes, input.nodeId);
	if (!isDeepStrictEqual(config, input.parseConfig(input.nodeConfig))) {
		throw new Error(
			"Node configuration differs from its published workflow version",
		);
	}
	return { config, execution };
}
