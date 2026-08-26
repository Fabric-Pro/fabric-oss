/**
 * Database queries for Workspace model
 * Handles CRUD operations with multi-tenancy support and fixed group permissions
 */

import {
	db,
	type Prisma,
	type WorkspaceStatus,
	type WorkspaceType,
} from "../../client";

// ============================================================================
// Types
// ============================================================================

export interface CreateWorkspaceInput {
	name: string;
	description?: string;
	userId: string;
	organizationId?: string;
	type?: WorkspaceType;
	documentLimit?: number;
}

export interface UpdateWorkspaceInput {
	name?: string;
	description?: string;
	status?: WorkspaceStatus;
	documentLimit?: number;
}

export interface ListWorkspacesOptions {
	userId: string;
	organizationId?: string;
	limit?: number;
	offset?: number;
	status?: WorkspaceStatus;
	type?: WorkspaceType;
	search?: string;
	includeShared?: boolean;
}

// ============================================================================
// Create
// ============================================================================

/**
 * Create a new workspace
 * The creator is automatically added as an administrator
 */
export async function createWorkspace(input: CreateWorkspaceInput) {
	const {
		name,
		description,
		userId,
		organizationId,
		type = "CUSTOM",
		documentLimit = 20,
	} = input;

	return await db.$transaction(async (tx) => {
		// Create the workspace
		const workspace = await tx.workspace.create({
			data: {
				name,
				description,
				userId,
				organizationId,
				type,
				documentLimit,
				status: "ACTIVE",
			},
		});

		// Add creator as administrator
		await tx.workspaceAdministrator.create({
			data: {
				workspaceId: workspace.id,
				userId,
				addedBy: userId,
			},
		});

		// Create default RAG settings
		await tx.workspaceRagSettings.create({
			data: {
				workspaceId: workspace.id,
			},
		});

		return workspace;
	});
}

/**
 * Get or create a personal workspace for a user
 * Each user has exactly one personal workspace per context (personal or org)
 */
export async function getOrCreatePersonalWorkspace(
	userId: string,
	organizationId?: string,
) {
	// XOR pattern: explicit null for personal context, org ID for org context
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	// Try to find existing personal workspace in this context
	const existing = await db.workspace.findFirst({
		where: {
			userId,
			type: "PERSONAL",
			...orgFilter,
		},
	});

	if (existing) {
		return existing;
	}

	// Create new personal workspace in this context
	return await createWorkspace({
		name: "My Workspace",
		description: "Your personal document workspace",
		userId,
		organizationId,
		type: "PERSONAL",
	});
}

// ============================================================================
// Read
// ============================================================================

/**
 * Get workspace by ID with authorization check
 * Returns null if workspace doesn't exist or user has no access
 */
export async function getWorkspaceById(
	workspaceId: string,
	userId: string,
	organizationId?: string,
) {
	const workspace = await db.workspace.findFirst({
		where: { id: workspaceId },
		include: {
			documents: {
				orderBy: { createdAt: "desc" },
				// Include ALL documents - let UI show status (including FAILED for retry)
			},
			ragSettings: true,
			_count: {
				select: {
					documents: true,
					administrators: true,
					contributors: true,
					stakeholders: true,
					agents: true,
				},
			},
		},
	});

	if (!workspace) {
		return null;
	}

	// Check access
	const hasAccess = await hasWorkspaceAccess(
		workspaceId,
		userId,
		organizationId,
	);
	if (!hasAccess) {
		return null;
	}

	return workspace;
}

/**
 * List workspaces accessible to a user
 * Includes personal, owned, and shared workspaces
 * Enforces strict isolation between personal and organizational workspaces:
 * - When organizationId is provided: only show workspaces for that organization
 * - When organizationId is NOT provided: only show personal workspaces (organizationId = null)
 */
export async function listWorkspaces(options: ListWorkspacesOptions) {
	const {
		userId,
		organizationId,
		limit = 20,
		offset = 0,
		status,
		type,
		search,
		includeShared = true,
	} = options;

	// Strict isolation: if no organizationId, only show personal workspaces (null org)
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	// Build condition for workspaces user can access
	const accessConditions: Prisma.WorkspaceWhereInput[] = [
		// User owns the workspace
		{ userId },
	];

	if (includeShared) {
		// User is an administrator
		accessConditions.push({
			administrators: { some: { userId } },
		});
		// User is a contributor
		accessConditions.push({
			contributors: { some: { userId } },
		});
		// User is a stakeholder
		accessConditions.push({
			stakeholders: { some: { userId } },
		});
	}

	const where: Prisma.WorkspaceWhereInput = {
		AND: [
			{ OR: accessConditions },
			...(search
				? [
						{
							OR: [
								{
									name: {
										contains: search,
										mode: "insensitive" as const,
									},
								},
								{
									description: {
										contains: search,
										mode: "insensitive" as const,
									},
								},
							],
						},
					]
				: []),
		],
		...orgFilter,
		...(status ? { status } : {}),
		...(type ? { type } : {}),
	};

	const [workspaces, total] = await Promise.all([
		db.workspace.findMany({
			where,
			include: {
				_count: {
					select: {
						documents: true,
						conversations: true,
					},
				},
				user: {
					select: {
						id: true,
						name: true,
						image: true,
					},
				},
			},
			orderBy: [{ type: "asc" }, { updatedAt: "desc" }],
			take: limit,
			skip: offset,
		}),
		db.workspace.count({ where }),
	]);

	return {
		workspaces,
		total,
		hasMore: offset + limit < total,
		nextOffset: offset + limit < total ? offset + limit : undefined,
	};
}

/**
 * Get workspace statistics for a user
 * Enforces strict isolation between personal and organizational workspaces
 */
export async function getWorkspaceStats(
	userId: string,
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only count personal workspaces
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const baseWhere: Prisma.WorkspaceWhereInput = {
		OR: [
			{ userId },
			{ administrators: { some: { userId } } },
			{ contributors: { some: { userId } } },
			{ stakeholders: { some: { userId } } },
		],
		...orgFilter,
	};

	const [total, personal, custom, active, archived, documentCount] =
		await Promise.all([
			db.workspace.count({ where: baseWhere }),
			db.workspace.count({ where: { ...baseWhere, type: "PERSONAL" } }),
			db.workspace.count({ where: { ...baseWhere, type: "CUSTOM" } }),
			db.workspace.count({ where: { ...baseWhere, status: "ACTIVE" } }),
			db.workspace.count({ where: { ...baseWhere, status: "ARCHIVED" } }),
			db.workspaceDocument.count({
				where: {
					workspace: baseWhere,
					status: "READY",
				},
			}),
		]);

	return {
		total,
		personal,
		custom,
		active,
		archived,
		documentCount,
	};
}

// ============================================================================
// Update
// ============================================================================

/**
 * Update workspace details
 * Only administrators can update workspaces
 */
export async function updateWorkspace(
	workspaceId: string,
	userId: string,
	data: UpdateWorkspaceInput,
) {
	// Verify user is an administrator
	const canManage = await canManageWorkspace(workspaceId, userId);
	if (!canManage) {
		throw new Error("Only administrators can update workspace settings");
	}

	return await db.workspace.update({
		where: { id: workspaceId },
		data,
	});
}

/**
 * Archive a workspace
 * Only administrators can archive workspaces
 */
export async function archiveWorkspace(workspaceId: string, userId: string) {
	return await updateWorkspace(workspaceId, userId, { status: "ARCHIVED" });
}

/**
 * Reactivate an archived workspace
 */
export async function reactivateWorkspace(workspaceId: string, userId: string) {
	return await updateWorkspace(workspaceId, userId, { status: "ACTIVE" });
}

// ============================================================================
// Delete
// ============================================================================

/**
 * Delete a workspace and all associated data
 * Only the owner can delete a workspace
 * Personal workspaces cannot be deleted
 */
export async function deleteWorkspace(workspaceId: string, userId: string) {
	const workspace = await db.workspace.findFirst({
		where: { id: workspaceId },
		select: { userId: true, type: true },
	});

	if (!workspace) {
		throw new Error("Workspace not found");
	}

	if (workspace.type === "PERSONAL") {
		throw new Error("Personal workspaces cannot be deleted");
	}

	if (workspace.userId !== userId) {
		throw new Error("Only the workspace owner can delete it");
	}

	// Cascade delete handles documents, members, and settings
	return await db.workspace.delete({
		where: { id: workspaceId },
	});
}

// ============================================================================
// Access Control
// ============================================================================

export type WorkspaceRole =
	| "owner"
	| "administrator"
	| "contributor"
	| "stakeholder"
	| null;

/**
 * Check if a user has any access to a workspace
 *
 * SECURITY: For organization workspaces, we verify org membership first.
 * This ensures users removed from an org lose access to all org workspaces.
 */
export async function hasWorkspaceAccess(
	workspaceId: string,
	userId: string,
	_organizationId?: string,
	agentId?: string,
): Promise<boolean> {
	const workspace = await db.workspace.findFirst({
		where: { id: workspaceId },
		select: {
			id: true,
			userId: true,
			organizationId: true,
		},
	});

	if (!workspace) {
		return false;
	}

	// Personal workspaces (no organizationId) - only owner can access
	if (!workspace.organizationId) {
		return workspace.userId === userId;
	}

	// Organization workspace - MUST verify org membership first
	const orgMembership = await db.member.findFirst({
		where: {
			organizationId: workspace.organizationId,
			userId,
		},
		select: { id: true },
	});

	if (!orgMembership) {
		// User is not a member of the organization - no access
		return false;
	}

	// User is org member - now check workspace-level access
	// Owner has access
	if (workspace.userId === userId) {
		return true;
	}

	// Check membership in any group
	const [isAdmin, isContributor, isStakeholder] = await Promise.all([
		db.workspaceAdministrator.findFirst({
			where: { workspaceId, userId },
			select: { id: true },
		}),
		db.workspaceContributor.findFirst({
			where: { workspaceId, userId },
			select: { id: true },
		}),
		db.workspaceStakeholder.findFirst({
			where: { workspaceId, userId },
			select: { id: true },
		}),
	]);

	if (isAdmin || isContributor || isStakeholder) {
		return true;
	}

	// Check agent access if agentId provided
	if (agentId) {
		const isAgent = await db.workspaceAgent.findFirst({
			where: { workspaceId, agentId },
			select: { id: true },
		});
		return !!isAgent;
	}

	return false;
}

/**
 * Get user's role in a workspace
 *
 * SECURITY: For organization workspaces, we verify org membership first.
 * This ensures users removed from an org have no role in org workspaces.
 */
export async function getWorkspaceRole(
	workspaceId: string,
	userId: string,
): Promise<WorkspaceRole> {
	const workspace = await db.workspace.findFirst({
		where: { id: workspaceId },
		select: { userId: true, organizationId: true },
	});

	if (!workspace) {
		return null;
	}

	// Personal workspaces - only owner has access
	if (!workspace.organizationId) {
		return workspace.userId === userId ? "owner" : null;
	}

	// Organization workspace - MUST verify org membership first
	const orgMembership = await db.member.findFirst({
		where: {
			organizationId: workspace.organizationId,
			userId,
		},
		select: { id: true },
	});

	if (!orgMembership) {
		// User is not a member of the organization - no role
		return null;
	}

	// User is org member - check workspace-level role
	// Check owner first
	if (workspace.userId === userId) {
		return "owner";
	}

	// Check administrator
	const isAdmin = await db.workspaceAdministrator.findFirst({
		where: { workspaceId, userId },
		select: { id: true },
	});
	if (isAdmin) {
		return "administrator";
	}

	// Check contributor
	const isContributor = await db.workspaceContributor.findFirst({
		where: { workspaceId, userId },
		select: { id: true },
	});
	if (isContributor) {
		return "contributor";
	}

	// Check stakeholder
	const isStakeholder = await db.workspaceStakeholder.findFirst({
		where: { workspaceId, userId },
		select: { id: true },
	});
	if (isStakeholder) {
		return "stakeholder";
	}

	return null;
}

/**
 * Check if user can edit workspace content (upload/modify documents)
 * Owner, administrators, and contributors can edit
 */
export async function canEditWorkspace(
	workspaceId: string,
	userId: string,
): Promise<boolean> {
	const role = await getWorkspaceRole(workspaceId, userId);
	return (
		role === "owner" || role === "administrator" || role === "contributor"
	);
}

/**
 * Check if user can delete content in workspace
 * Only owner and administrators can delete
 */
export async function canDeleteInWorkspace(
	workspaceId: string,
	userId: string,
): Promise<boolean> {
	const role = await getWorkspaceRole(workspaceId, userId);
	return role === "owner" || role === "administrator";
}

/**
 * Check if user can manage workspace (settings, members)
 * Only owner and administrators can manage
 */
export async function canManageWorkspace(
	workspaceId: string,
	userId: string,
): Promise<boolean> {
	const role = await getWorkspaceRole(workspaceId, userId);
	return role === "owner" || role === "administrator";
}

/**
 * Check if workspace has capacity for more documents
 */
export async function hasDocumentCapacity(
	workspaceId: string,
): Promise<boolean> {
	const workspace = await db.workspace.findFirst({
		where: { id: workspaceId },
		select: {
			documentLimit: true,
			_count: {
				select: { documents: true },
			},
		},
	});

	if (!workspace) {
		return false;
	}

	return workspace._count.documents < workspace.documentLimit;
}
