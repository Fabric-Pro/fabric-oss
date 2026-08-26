/**
 * Database queries for Workflow model
 * Handles CRUD operations with multi-tenancy support
 */

import {
	db,
	type Prisma,
	type WorkflowBuilderStatus,
	type WorkflowTriggerType,
} from "../../client";

// Default empty nodes/edges for new workflows
const DEFAULT_NODES: Prisma.InputJsonValue = [];
const DEFAULT_EDGES: Prisma.InputJsonValue = [];

/**
 * Create a new workflow
 */
export async function createWorkflow(data: {
	name: string;
	description?: string;
	triggerType?: WorkflowTriggerType;
	triggerConfig?: Prisma.InputJsonValue;
	nodes?: Prisma.InputJsonValue;
	edges?: Prisma.InputJsonValue;
	variables?: Prisma.InputJsonValue;
	settings?: Prisma.InputJsonValue;
	isTemplate?: boolean;
	templateId?: string;
	userId: string;
	organizationId?: string;
	projectId?: string;
}) {
	return await db.workflow.create({
		data: {
			name: data.name,
			description: data.description,
			triggerType: data.triggerType || "MANUAL",
			triggerConfig: data.triggerConfig,
			nodes: data.nodes || DEFAULT_NODES,
			edges: data.edges || DEFAULT_EDGES,
			variables: data.variables,
			settings: data.settings,
			isTemplate: data.isTemplate || false,
			templateId: data.templateId,
			userId: data.userId,
			organizationId: data.organizationId,
			projectId: data.projectId,
			status: "DRAFT",
			version: 1,
		},
	});
}

/**
 * Get workflow by ID with authorization check
 * Enforces strict isolation between personal and organizational workflows
 */
export async function getWorkflowById(
	workflowId: string,
	userId: string,
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only allow fetching personal workflows
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.workflow.findFirst({
		where: {
			id: workflowId,
			userId,
			...orgFilter,
		},
		include: {
			_count: {
				select: {
					executions: true,
					versions: true,
				},
			},
		},
	});
}

/**
 * List workflows for a user with pagination
 * Enforces strict isolation between personal and organizational workflows:
 * - When organizationId is provided: only show workflows for that organization
 * - When organizationId is NOT provided: only show personal workflows (organizationId = null)
 */
export async function listWorkflows(options: {
	userId: string;
	organizationId?: string;
	limit?: number;
	offset?: number;
	status?: WorkflowBuilderStatus;
	triggerType?: WorkflowTriggerType;
	search?: string;
	isTemplate?: boolean;
	projectId?: string;
}) {
	const {
		userId,
		organizationId,
		limit = 20,
		offset = 0,
		status,
		triggerType,
		search,
		isTemplate,
		projectId,
	} = options;

	// Strict isolation: if no organizationId, only show personal workflows (null org)
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const where: Prisma.WorkflowWhereInput = {
		userId,
		...orgFilter,
		...(status ? { status } : {}),
		...(triggerType ? { triggerType } : {}),
		...(isTemplate !== undefined ? { isTemplate } : {}),
		...(projectId ? { projectId } : {}),
		...(search
			? {
					OR: [
						{ name: { contains: search, mode: "insensitive" } },
						{
							description: {
								contains: search,
								mode: "insensitive",
							},
						},
					],
				}
			: {}),
	};

	const [workflows, total] = await Promise.all([
		db.workflow.findMany({
			where,
			include: {
				_count: {
					select: {
						executions: true,
						versions: true,
					},
				},
			},
			orderBy: { updatedAt: "desc" },
			take: limit,
			skip: offset,
		}),
		db.workflow.count({ where }),
	]);

	return {
		workflows,
		total,
		hasMore: offset + limit < total,
		nextOffset: offset + limit < total ? offset + limit : undefined,
	};
}

/**
 * Update workflow
 * Enforces strict isolation between personal and organizational workflows
 */
export async function updateWorkflow(
	workflowId: string,
	userId: string,
	data: {
		name?: string;
		description?: string;
		status?: WorkflowBuilderStatus;
		triggerType?: WorkflowTriggerType;
		triggerConfig?: Prisma.InputJsonValue;
		nodes?: Prisma.InputJsonValue;
		edges?: Prisma.InputJsonValue;
		variables?: Prisma.InputJsonValue;
		settings?: Prisma.InputJsonValue;
	},
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only allow updating personal workflows
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.workflow.update({
		where: {
			id: workflowId,
			userId,
			...orgFilter,
		},
		data,
	});
}

/**
 * Delete workflow (cascade deletes executions, versions, integrations)
 * Enforces strict isolation between personal and organizational workflows
 */
export async function deleteWorkflow(
	workflowId: string,
	userId: string,
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only allow deleting personal workflows
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.workflow.delete({
		where: {
			id: workflowId,
			userId,
			...orgFilter,
		},
	});
}

/**
 * Create a new version of a workflow (for version history)
 * Enforces strict isolation between personal and organizational workflows
 *
 * TENANT ISOLATION: userId and organizationId are included on the version record
 * for proper tenant filtering on child tables.
 */
export async function createWorkflowVersion(
	workflowId: string,
	userId: string,
	changelog?: string,
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only allow versioning personal workflows
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const workflow = await db.workflow.findFirst({
		where: {
			id: workflowId,
			userId,
			...orgFilter,
		},
	});

	if (!workflow) {
		throw new Error("Workflow not found");
	}

	const version = await db.workflowVersion.create({
		data: {
			workflowId: workflow.id,
			version: workflow.version,
			nodes: workflow.nodes as Prisma.InputJsonValue,
			edges: workflow.edges as Prisma.InputJsonValue,
			variables: workflow.variables as Prisma.InputJsonValue | undefined,
			settings: workflow.settings as Prisma.InputJsonValue | undefined,
			changelog,
			createdBy: userId,
			userId,
			organizationId,
		},
	});

	await db.workflow.update({
		where: { id: workflowId },
		data: { version: workflow.version + 1 },
	});

	return version;
}

/**
 * Get workflow version history
 * Enforces strict isolation between personal and organizational workflows
 */
export async function getWorkflowVersions(
	workflowId: string,
	userId: string,
	organizationId?: string,
	limit = 20,
	offset = 0,
) {
	// Strict isolation: if no organizationId, only allow fetching personal workflow versions
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const workflow = await db.workflow.findFirst({
		where: {
			id: workflowId,
			userId,
			...orgFilter,
		},
		select: { id: true },
	});

	if (!workflow) {
		throw new Error("Workflow not found");
	}

	const [versions, total] = await Promise.all([
		db.workflowVersion.findMany({
			where: { workflowId },
			orderBy: { version: "desc" },
			take: limit,
			skip: offset,
		}),
		db.workflowVersion.count({ where: { workflowId } }),
	]);

	return { versions, total };
}

/**
 * Duplicate a workflow
 * Enforces strict isolation between personal and organizational workflows
 */
export async function duplicateWorkflow(
	workflowId: string,
	userId: string,
	newName?: string,
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only allow duplicating personal workflows
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const workflow = await db.workflow.findFirst({
		where: {
			id: workflowId,
			userId,
			...orgFilter,
		},
	});

	if (!workflow) {
		throw new Error("Workflow not found");
	}

	return await db.workflow.create({
		data: {
			name: newName || `${workflow.name} (Copy)`,
			description: workflow.description,
			triggerType: workflow.triggerType,
			triggerConfig:
				(workflow.triggerConfig as Prisma.InputJsonValue) || undefined,
			nodes: workflow.nodes as Prisma.InputJsonValue,
			edges: workflow.edges as Prisma.InputJsonValue,
			variables:
				(workflow.variables as Prisma.InputJsonValue) || undefined,
			settings: (workflow.settings as Prisma.InputJsonValue) || undefined,
			isTemplate: false,
			templateId: workflow.isTemplate ? workflow.id : workflow.templateId,
			userId,
			organizationId,
			projectId: workflow.projectId,
			status: "DRAFT",
			version: 1,
		},
	});
}

/**
 * Get workflow statistics
 * Enforces strict isolation between personal and organizational workflows
 */
export async function getWorkflowStats(
	userId: string,
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only count personal workflows
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const where: Prisma.WorkflowWhereInput = {
		userId,
		...orgFilter,
	};

	const [total, active, draft, paused] = await Promise.all([
		db.workflow.count({ where }),
		db.workflow.count({ where: { ...where, status: "ACTIVE" } }),
		db.workflow.count({ where: { ...where, status: "DRAFT" } }),
		db.workflow.count({ where: { ...where, status: "PAUSED" } }),
	]);

	return {
		total,
		active,
		draft,
		paused,
		archived: total - active - draft - paused,
	};
}

/**
 * Check if user has access to workflow
 * Enforces strict isolation between personal and organizational workflows
 *
 * SECURITY: For organization workflows, we verify org membership first.
 * This ensures users removed from an org lose access to all org workflows.
 */
export async function hasWorkflowAccess(
	workflowId: string,
	userId: string,
	_organizationId?: string,
): Promise<boolean> {
	const workflow = await db.workflow.findFirst({
		where: {
			id: workflowId,
		},
		select: {
			id: true,
			userId: true,
			organizationId: true,
		},
	});

	if (!workflow) {
		return false;
	}

	// Personal workflows (no organizationId) - only owner can access
	if (!workflow.organizationId) {
		return workflow.userId === userId;
	}

	// Organization workflow - MUST verify org membership first
	const orgMembership = await db.member.findFirst({
		where: {
			organizationId: workflow.organizationId,
			userId,
		},
		select: { id: true },
	});

	if (!orgMembership) {
		// User is not a member of the organization - no access
		return false;
	}

	// User is org member - check if they own the workflow
	// (Workflows are user-owned, even in org context)
	return workflow.userId === userId;
}
